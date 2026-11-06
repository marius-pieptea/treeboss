/**
 * The plan questionnaire: how a plan-mode agent asks the operator questions and hands back a plan.
 *
 * Two tools reach it through the `trb` MCP shim, only for sessions in plan mode:
 *
 *   plan_ask     one question with 2-6 options (one recommended) and an optional free-text answer.
 *                It BLOCKS until the operator answers in the UI, `trb plan <id> answer`, or the API.
 *   plan_submit  the finished plan: title, summary, steps, risks. It is stored as a draft the operator
 *                approves, edits or sends back with a note.
 *
 * Waiting is bounded in two places. The daemon holds a request for at most `WAIT_MS` (the HTTP server drops
 * a silent connection after 255s), then answers `pending` and the shim asks again for the SAME question:
 * the question lives in the database and the waiters in memory, so nothing is lost between polls. The
 * engine's own tool timeout is the outer ceiling (claude: hours; codex: raised to a day in its overrides;
 * other engines use their default, so a long unanswered question can time out there, which comes back to
 * the agent as a tool error and is recorded as a cancelled question).
 *
 * A pending question is cancelled when its turn ends for any reason (interrupt, close, failure) and when the
 * daemon restarts: nobody is listening for the answer any more.
 */
import { randomBytes } from "crypto";
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { UserError } from "../util";
import { Hub } from "./hub";
import { appendLog, getSession, send, SessionError, type SessionRecord } from "./manager";
import { setMode } from "./plan";
import { attach, beginSpecWrite } from "../specs/attach";
import { architectureApproval } from "../specs/prompts";
import { findFeature } from "../specs/store";
import { planDepthOf, storePlanDepth } from "./plansdir";
import { safeJoin } from "../workspaces";
import fs from "fs";
import { bodySha, changelogOf, newPlanPath, parsePlanText, readPlanFile, renderPlanFile, setMeta, sha, writePlanFile, type PlanContent, type PlanDepth, type PlanMeta } from "./planfile";
import { createSpecFeature, writeSpecFeature } from "./planspec";

export interface PlanOption {
  label: string;
  description?: string;
  recommended?: boolean;
  reason?: string;
}

export interface PlanQuestion {
  id: string;
  session_id: string;
  seq: number;
  turn_id: string | null;
  question: string;
  options: PlanOption[];
  allow_custom: boolean;
  multi: boolean;
  status: "pending" | "answered" | "cancelled";
  answer: PlanAnswer | null;
  asked_at: string;
  answered_at: string | null;
}

export interface PlanAnswer {
  choices: string[];
  custom: string | null;
  skipped: boolean;
  /** Why a question was cancelled instead of answered. */
  note?: string;
}

export interface PlanStep {
  title: string;
  detail: string;
  files?: string[];
}

export interface PlanRecord {
  id: string;
  session_id: string;
  version: number;
  title: string;
  summary: string;
  steps: PlanStep[];
  risks: string[];
  open_questions: string[];
  status: "draft" | "approved" | "rejected" | "superseded";
  note: string | null;
  created_at: string;
  decided_at: string | null;
  /** The markdown file that holds the plan (workspace-relative). Null on a plan from before plans were files. */
  path: string | null;
  /** "quick": plans/…md. "spec": specs/NNN-name/plan.md beside a spec.md. */
  depth: PlanDepth;
  /** The spec feature this plan wrote (depth "spec") or was promoted into. */
  feature: string | null;
  promoted: string | null;
  /** Only filled for the plan the operator is deciding on: the file changed since the daemon wrote it. */
  edited?: boolean;
  /** Only filled for the current plan: the file is gone, so the stored text is all there is. */
  file_missing?: boolean;
}

export interface PlanState {
  mode: "build" | "plan";
  questions: PlanQuestion[];
  pending: PlanQuestion | null;
  plan: PlanRecord | null;
  plans: PlanRecord[];
  /** How many questions the agent may still ask, for the "Question 2 of ~4" indicator. */
  expected_total: number;
  /** What the next plan_submit produces: a plans/ file ("quick") or a spec feature ("spec"). */
  depth: PlanDepth;
}

export const MAX_OPTIONS = 6;
export const MIN_OPTIONS = 2;
export const SOFT_QUESTION_LIMIT = 6;
const MAX_STEPS = 40;
/** How long one HTTP request waits for an answer before saying `pending`. Under the server's 255s idle limit. */
const WAIT_MS = () => Number(process.env.TRB_PLAN_WAIT_MS) || 180_000;

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

const prepared = new WeakSet<Database>();
function table(): Database {
  const conn = db();
  if (!prepared.has(conn)) {
    conn.exec(`CREATE TABLE IF NOT EXISTS plan_questions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      turn_id TEXT,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      allow_custom INTEGER NOT NULL DEFAULT 1,
      multi INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      answer_json TEXT,
      asked_at TEXT NOT NULL,
      answered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS plan_questions_session ON plan_questions (session_id, seq);
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      risks_json TEXT NOT NULL,
      open_questions_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS plans_session ON plans (session_id, version);`);
    // The plan is a file now; the row keeps the metadata. Older databases gain the columns here, older rows keep their inline content.
    for (const col of ["path TEXT", "depth TEXT NOT NULL DEFAULT 'quick'", "feature TEXT", "promoted TEXT", "file_sha TEXT", "aux_sha TEXT", "approved_sha TEXT", "snapshot TEXT"]) {
      try {
        conn.exec(`ALTER TABLE plans ADD COLUMN ${col}`);
      } catch {}
    }
    prepared.add(conn);
  }
  return conn;
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function questionOf(r: any): PlanQuestion {
  return {
    id: r.id,
    session_id: r.session_id,
    seq: r.seq,
    turn_id: r.turn_id,
    question: r.question,
    options: parse<PlanOption[]>(r.options_json, []),
    allow_custom: !!r.allow_custom,
    multi: !!r.multi,
    status: r.status,
    answer: parse<PlanAnswer | null>(r.answer_json, null),
    asked_at: r.asked_at,
    answered_at: r.answered_at,
  };
}

function planOf(r: any): PlanRecord {
  return {
    id: r.id,
    session_id: r.session_id,
    version: r.version,
    title: r.title,
    summary: r.summary,
    steps: parse<PlanStep[]>(r.steps_json, []),
    risks: parse<string[]>(r.risks_json, []),
    open_questions: parse<string[]>(r.open_questions_json, []),
    status: r.status,
    note: r.note,
    created_at: r.created_at,
    decided_at: r.decided_at,
    path: r.path ?? null,
    depth: r.depth === "spec" ? "spec" : "quick",
    feature: r.feature ?? null,
    promoted: r.promoted ?? null,
  };
}

interface PlanRow {
  file_sha: string | null;
  aux_sha: string | null;
  approved_sha: string | null;
  snapshot: string | null;
}
const rowExtras = (id: string): PlanRow => (table().prepare("SELECT file_sha, aux_sha, approved_sha, snapshot FROM plans WHERE id = ?").get(id) as PlanRow | undefined) ?? { file_sha: null, aux_sha: null, approved_sha: null, snapshot: null };

/** The current plan with what only the file can tell: was it edited since the daemon wrote it, is it gone. */
function decorate(s: SessionRecord, p: PlanRecord | null): PlanRecord | null {
  if (!p || !p.path) return p;
  const file = readPlanFile(s.base_cwd, p.path);
  if (!file) return { ...p, file_missing: true, edited: false };
  const written = rowExtras(p.id).file_sha;
  // Bookkeeping rewrites one front matter line, so compare the body: only the operator's own edits count.
  return { ...p, file_missing: false, edited: !!written && bodySha(file.text) !== written };
}

export { planDepthOf };

export function setPlanDepth(sessionId: string, depth: unknown): PlanDepth {
  if (depth !== "quick" && depth !== "spec") throw new SessionError('depth must be "quick" or "spec".');
  const s = requireSession(sessionId);
  storePlanDepth(sessionId, depth);
  Hub.publish({ type: "plan", sessionId, rootId: s.root_id, what: "plan" });
  return depth;
}

export function getQuestion(id: string): PlanQuestion | null {
  const r = table().prepare("SELECT * FROM plan_questions WHERE id = ?").get(id);
  return r ? questionOf(r) : null;
}

export function listQuestions(sessionId: string): PlanQuestion[] {
  return (table().prepare("SELECT * FROM plan_questions WHERE session_id = ? ORDER BY seq").all(sessionId) as any[]).map(questionOf);
}

export function getPlan(id: string): PlanRecord | null {
  const r = table().prepare("SELECT * FROM plans WHERE id = ?").get(id);
  return r ? planOf(r) : null;
}

export function listPlans(sessionId: string): PlanRecord[] {
  return (table().prepare("SELECT * FROM plans WHERE session_id = ? ORDER BY version").all(sessionId) as any[]).map(planOf);
}

/** The plan the operator is deciding on, or the approved one. Superseded and rejected plans are history. */
export function currentPlan(sessionId: string): PlanRecord | null {
  const all = listPlans(sessionId).filter((p) => p.status === "draft" || p.status === "approved");
  return all.length ? all[all.length - 1] : null;
}

export function approvedPlan(sessionId: string): PlanRecord | null {
  const r = table().prepare("SELECT * FROM plans WHERE session_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1").get(sessionId);
  return r ? planOf(r) : null;
}

export function planState(sessionId: string): PlanState {
  const s = requireSession(sessionId);
  const questions = listQuestions(sessionId);
  // Only this round's questions count toward the indicator: a plan sent back for changes starts a new round.
  const lastPlan = listPlans(sessionId).slice(-1)[0];
  const round = lastPlan && lastPlan.status !== "approved" && lastPlan.status !== "draft" ? questions.filter((q) => q.asked_at > (lastPlan.decided_at ?? "")) : questions;
  return {
    mode: s.mode === "plan" ? "plan" : "build",
    questions,
    pending: questions.find((q) => q.status === "pending") ?? null,
    plan: decorate(s, currentPlan(sessionId)),
    plans: listPlans(sessionId),
    depth: planDepthOf(sessionId),
    expected_total: Math.max(round.length, Math.min(SOFT_QUESTION_LIMIT, Math.max(4, round.length))),
  };
}

function requireSession(id: string): SessionRecord {
  const s = getSession(id);
  if (!s) throw new SessionError(`No session "${id}".`);
  return s;
}

const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
const now = () => new Date().toISOString();

function announce(s: SessionRecord, what: "question" | "answered" | "plan" | "decided" | "cancelled"): void {
  Hub.publish({ type: "plan", sessionId: s.id, rootId: s.root_id, what });
}

/* -------------------------------------------------------------------------- */
/* Waiting                                                                    */
/* -------------------------------------------------------------------------- */

const waiters = new Map<string, Set<() => void>>();

function waitFor(id: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      waiters.get(id)?.delete(done);
      resolve();
    };
    timer = setTimeout(done, ms);
    let set = waiters.get(id);
    if (!set) waiters.set(id, (set = new Set()));
    set.add(done);
  });
}

function wake(id: string): void {
  for (const w of [...(waiters.get(id) ?? [])]) w();
  waiters.delete(id);
}

/* -------------------------------------------------------------------------- */
/* plan_ask                                                                   */
/* -------------------------------------------------------------------------- */

function cleanOptions(raw: unknown): PlanOption[] {
  if (!Array.isArray(raw)) throw new UserError("options must be a list of 2 to 6 choices: [{label, description?, recommended?, reason?}].");
  const out: PlanOption[] = [];
  for (const o of raw) {
    const item = typeof o === "string" ? { label: o } : (o as Record<string, unknown>);
    const label = String(item?.label ?? "").trim();
    if (!label) throw new UserError("every option needs a label.");
    if (out.some((x) => x.label === label)) throw new UserError(`two options share the label "${label}".`);
    out.push({
      label: label.slice(0, 200),
      ...(item.description ? { description: String(item.description).slice(0, 600) } : {}),
      ...(item.recommended === true ? { recommended: true } : {}),
      ...(item.reason ? { reason: String(item.reason).slice(0, 300) } : {}),
    });
  }
  if (out.length < MIN_OPTIONS || out.length > MAX_OPTIONS) throw new UserError(`give ${MIN_OPTIONS} to ${MAX_OPTIONS} options (got ${out.length}). The user can always type their own answer.`);
  // At most one recommendation: the first one wins, so the UI never shows two badges.
  let seen = false;
  for (const o of out) {
    if (o.recommended && seen) delete o.recommended, delete o.reason;
    if (o.recommended) seen = true;
  }
  return out;
}

export interface AskResult {
  text: string;
  /** Set when the wait window ended with no answer: the shim asks again with this id. */
  pending?: string;
}

function answerText(q: PlanQuestion): string {
  const a = q.answer;
  if (q.status === "cancelled" || !a) return `Error: the question was cancelled (${a?.note ?? "no answer"}). Do not wait for it: continue with your best judgement, or ask a different question.`;
  if (a.skipped) return "The user skipped this question. Use your recommended option, or the safest default, and say so in the plan.";
  const parts: string[] = [];
  if (a.choices.length) parts.push(`User chose: ${a.choices.join("; ")}`);
  if (a.custom) parts.push(`User wrote: ${a.custom}`);
  return parts.join("\n") || "The user answered without choosing anything. Treat it as skipped.";
}

/** Start (or, with `resume`, rejoin) a question and wait for its answer for up to one window. */
export async function askQuestion(sessionId: string, args: Record<string, unknown>): Promise<AskResult> {
  const s = requireSession(sessionId);
  const resume = typeof args._resume === "string" ? args._resume : null;
  let q: PlanQuestion | null;
  if (resume) {
    q = getQuestion(resume);
    if (!q || q.session_id !== sessionId) throw new UserError(`no question "${resume}" on this session.`);
  } else {
    if (s.mode !== "plan") throw new UserError("plan mode is off, so there is nobody to ask. Continue with the task.");
    const question = String(args.question ?? "").trim();
    if (!question) throw new UserError("question is required.");
    const options = cleanOptions(args.options);
    const existing = listQuestions(sessionId);
    const open = existing.find((x) => x.status === "pending");
    if (open) throw new UserError(`question ${open.id} is still waiting for the user. Ask one question at a time.`);
    const id = newId("pq");
    table()
      .prepare("INSERT INTO plan_questions (id, session_id, seq, turn_id, question, options_json, allow_custom, multi, status, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(id, sessionId, existing.length + 1, s.last_turn_id, question.slice(0, 1500), JSON.stringify(options), args.allow_custom === false ? 0 : 1, args.multi === true ? 1 : 0, now());
    q = getQuestion(id)!;
    appendLog(s, s.last_turn_id, `[plan] question ${q.seq}: ${q.question}`, "info");
    announce(s, "question");
  }
  if (q.status === "pending") await waitFor(q.id, WAIT_MS());
  q = getQuestion(q.id)!;
  if (q.status === "pending") return { text: "", pending: q.id };
  return { text: answerText(q) };
}

/* -------------------------------------------------------------------------- */
/* Answering                                                                  */
/* -------------------------------------------------------------------------- */

export interface AnswerInput {
  question_id?: string | null;
  choice?: string | null;
  choices?: string[] | null;
  custom?: string | null;
  skip?: boolean;
}

export function answerQuestion(sessionId: string, input: AnswerInput): PlanQuestion {
  const s = requireSession(sessionId);
  const q = input.question_id ? getQuestion(input.question_id) : listQuestions(sessionId).find((x) => x.status === "pending") ?? null;
  if (!q || q.session_id !== sessionId) throw new SessionError("There is no such question on this session.");
  if (q.status !== "pending") throw new SessionError(`Question ${q.id} is already ${q.status}.`);

  const wanted = [...(input.choices ?? []), ...(input.choice ? [input.choice] : [])].map((c) => String(c).trim()).filter(Boolean);
  const custom = String(input.custom ?? "").trim() || null;
  const skipped = input.skip === true;
  if (!skipped && !wanted.length && !custom) throw new SessionError("Pick an option, write an answer, or skip.");
  if (custom && !q.allow_custom) throw new SessionError("This question does not take a written answer.");
  for (const c of wanted) if (!q.options.some((o) => o.label === c)) throw new SessionError(`"${c}" is not one of the options.`);
  if (!q.multi && wanted.length > 1) throw new SessionError("This question takes one choice.");

  const answer: PlanAnswer = { choices: skipped ? [] : wanted, custom: skipped ? null : custom, skipped };
  table().prepare("UPDATE plan_questions SET status = 'answered', answer_json = ?, answered_at = ? WHERE id = ?").run(JSON.stringify(answer), now(), q.id);
  const done = getQuestion(q.id)!;
  appendLog(s, q.turn_id, `[plan] answered ${q.seq}: ${skipped ? "skipped" : [...answer.choices, answer.custom].filter(Boolean).join("; ")}`, "info");
  announce(s, "answered");
  wake(q.id);
  return done;
}

/** Nobody is listening any more (turn over, session closed, daemon restarted): settle what is still open. */
export function cancelPendingQuestions(sessionId: string, reason: string): number {
  const open = (table().prepare("SELECT id FROM plan_questions WHERE session_id = ? AND status = 'pending'").all(sessionId) as Array<{ id: string }>).map((r) => r.id);
  if (!open.length) return 0;
  const answer: PlanAnswer = { choices: [], custom: null, skipped: false, note: reason };
  for (const id of open) {
    table().prepare("UPDATE plan_questions SET status = 'cancelled', answer_json = ?, answered_at = ? WHERE id = ?").run(JSON.stringify(answer), now(), id);
    wake(id);
  }
  const s = getSession(sessionId);
  if (s) {
    appendLog(s, s.last_turn_id, `[plan] ${open.length === 1 ? "question" : "questions"} cancelled: ${reason}`, "info");
    announce(s, "cancelled");
  }
  return open.length;
}

/** Daemon start: every question still pending belongs to a turn that died with the old process. */
export function recoverPlanQuestions(): number {
  const rows = table().prepare("SELECT DISTINCT session_id FROM plan_questions WHERE status = 'pending'").all() as Array<{ session_id: string }>;
  let n = 0;
  for (const r of rows) n += cancelPendingQuestions(r.session_id, "the daemon restarted");
  return n;
}

/* -------------------------------------------------------------------------- */
/* plan_submit                                                                */
/* -------------------------------------------------------------------------- */

function cleanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new UserError("steps must be a non-empty list: [{title, detail, files?}].");
  if (raw.length > MAX_STEPS) throw new UserError(`too many steps (${raw.length}); keep it to ${MAX_STEPS} or fewer.`);
  return raw.map((r, i) => {
    const item = typeof r === "string" ? { title: r } : (r as Record<string, unknown>);
    const title = String(item?.title ?? "").trim();
    if (!title) throw new UserError(`step ${i + 1} needs a title.`);
    const files = Array.isArray(item.files) ? item.files.map((f) => String(f).trim()).filter(Boolean).slice(0, 30) : [];
    return { title: title.slice(0, 300), detail: String(item.detail ?? "").trim().slice(0, 4000), ...(files.length ? { files } : {}) };
  });
}

const cleanList = (raw: unknown, max = 20): string[] => (Array.isArray(raw) ? raw.map((x) => String(x).trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, 600)) : []);

/** "Question: answer" for every question the operator answered, for the Decisions section and the spec's Assumptions. */
function decisionLines(sessionId: string): string[] {
  return listQuestions(sessionId)
    .filter((q) => q.status === "answered" && q.answer && !q.answer.skipped)
    .map((q) => `${q.question.replace(/\s+/g, " ").trim()} ${[...q.answer!.choices, q.answer!.custom].filter(Boolean).join("; ")}`);
}

const today = () => new Date().toISOString().slice(0, 10);

function contentOf(sessionId: string, p: Pick<PlanRecord, "title" | "summary" | "steps" | "risks" | "open_questions">, extra: { requirements?: string[]; success_criteria?: string[]; changelog?: string[] } = {}): PlanContent {
  return { title: p.title, summary: p.summary, steps: p.steps, risks: p.risks, open_questions: p.open_questions, decisions: decisionLines(sessionId), changelog: extra.changelog ?? [], ...(extra.requirements?.length ? { requirements: extra.requirements } : {}), ...(extra.success_criteria?.length ? { success_criteria: extra.success_criteria } : {}) };
}

const metaOf = (sessionId: string, p: { title: string; version: number; status: PlanRecord["status"]; depth: PlanDepth; promoted?: string | null; created_at: string }): PlanMeta => ({ title: p.title, session: sessionId, created: p.created_at, status: p.status, mode: p.depth, version: p.version, promoted: p.promoted ?? null });

/**
 * The plan has landed: write it to the workspace. A revision (the operator asked for changes, or the agent
 * submitted again before a decision) rewrites the SAME file as version N+1 with a changelog line; a first plan
 * gets a new `plans/<date>-<name>.md`, or, at depth "spec", a spec feature folder.
 */
function writePlanArtifacts(s: SessionRecord, plan: PlanRecord, prev: PlanRecord | null, args: Record<string, unknown>): PlanRecord {
  const root = s.base_cwd;
  const depth = planDepthOf(s.id);
  const reuse = prev && prev.path && prev.depth === depth && !prev.promoted && prev.status !== "approved" && fs.existsSync(safeJoin(root, prev.path)) ? prev : null;
  const requirements = cleanList(args.requirements, 20);
  const success = cleanList(args.success_criteria, 20);
  const existing = reuse?.path ? readPlanFile(root, reuse.path)?.text ?? "" : "";
  const changelog = reuse ? [...changelogOf(existing), `v${plan.version}, ${today()}: ${reuse.note ? reuse.note.replace(/\s+/g, " ").slice(0, 200) : "revised"}`] : [];
  const content = contentOf(s.id, plan, { requirements, success_criteria: success, changelog });
  const meta = metaOf(s.id, { ...plan, depth });
  let relPath: string;
  let feature: string | null = null;
  let bodyHash: string;
  let auxHash: string | null = null;
  if (depth === "spec") {
    if (reuse?.feature) {
      const f = findFeature(root, reuse.feature);
      if (!f) throw new UserError(`The spec feature ${reuse.feature} is gone: ask for a fresh plan.`);
      // spec.md may have been edited in the Specs view since: only rewrite it while it is still what we wrote.
      const specAbs = safeJoin(root, `${f.dir}/spec.md`);
      const untouched = !fs.existsSync(specAbs) || sha(fs.readFileSync(specAbs, "utf-8")) === rowExtras(reuse.id).aux_sha;
      const r = writeSpecFeature(root, f, meta, content, { writeSpec: untouched });
      relPath = r.planPath;
      feature = f.id;
      bodyHash = bodySha(fs.readFileSync(safeJoin(root, r.planPath), "utf-8"));
      auxHash = r.specSha ?? rowExtras(reuse.id).aux_sha;
    } else {
      const r = createSpecFeature(root, meta, content);
      relPath = r.planPath;
      feature = r.feature.id;
      bodyHash = bodySha(fs.readFileSync(safeJoin(root, r.planPath), "utf-8"));
      auxHash = r.specSha;
    }
  } else {
    relPath = reuse?.path ?? newPlanPath(root, plan.title);
    const text = renderPlanFile(meta, content);
    writePlanFile(root, relPath, text);
    bodyHash = bodySha(text);
  }
  table().prepare("UPDATE plans SET path = ?, depth = ?, feature = ?, file_sha = ?, aux_sha = ? WHERE id = ?").run(relPath, depth, feature, bodyHash, auxHash, plan.id);
  return getPlan(plan.id)!;
}

export function submitPlan(sessionId: string, args: Record<string, unknown>): PlanRecord {
  const s = requireSession(sessionId);
  if (s.mode !== "plan") throw new UserError("plan mode is off, so there is nobody to approve a plan. Continue with the task.");
  const title = String(args.title ?? "").trim();
  if (!title) throw new UserError("title is required.");
  const steps = cleanSteps(args.steps);
  const prior = listPlans(sessionId);
  const prev = prior.slice(-1)[0] ?? null;
  // A new plan replaces any draft the operator has not decided on.
  table().prepare("UPDATE plans SET status = 'superseded', decided_at = ? WHERE session_id = ? AND status = 'draft'").run(now(), sessionId);
  const id = newId("pl");
  table()
    .prepare("INSERT INTO plans (id, session_id, version, title, summary, steps_json, risks_json, open_questions_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)")
    .run(id, sessionId, (prev?.version ?? 0) + 1, title.slice(0, 300), String(args.summary ?? "").trim().slice(0, 4000), JSON.stringify(steps), JSON.stringify(cleanList(args.risks)), JSON.stringify(cleanList(args.open_questions)), now());
  let plan = getPlan(id)!;
  try {
    plan = writePlanArtifacts(s, plan, prev, args);
  } catch (err) {
    // Nothing was decided on a plan nobody can open: take the row back so the agent can try again.
    table().prepare("DELETE FROM plans WHERE id = ?").run(id);
    if (prev && prev.status === "superseded" && !prev.decided_at) table().prepare("UPDATE plans SET status = 'draft' WHERE id = ?").run(prev.id);
    throw err;
  }
  appendLog(s, s.last_turn_id, `[plan] plan v${plan.version} ready: ${plan.title} (${steps.length} steps) → ${plan.path}`, "info");
  announce(s, "plan");
  return plan;
}

/* -------------------------------------------------------------------------- */
/* Deciding                                                                   */
/* -------------------------------------------------------------------------- */

export function planToText(p: Pick<PlanRecord, "title" | "summary" | "steps" | "risks" | "open_questions">): string {
  const lines = [`# ${p.title}`];
  if (p.summary) lines.push("", p.summary);
  lines.push("", "## Steps");
  p.steps.forEach((st, i) => {
    lines.push(`${i + 1}. ${st.title}${st.detail ? `\n   ${st.detail.replace(/\n/g, "\n   ")}` : ""}${st.files?.length ? `\n   Files: ${st.files.join(", ")}` : ""}`);
  });
  if (p.risks.length) lines.push("", "## Risks", ...p.risks.map((r) => `- ${r}`));
  if (p.open_questions.length) lines.push("", "## Open questions", ...p.open_questions.map((r) => `- ${r}`));
  return lines.join("\n");
}

/** Answers given during planning, for the build prompt: the agent should not re-ask or contradict them. */
function decisionsText(sessionId: string): string {
  const lines = decisionLines(sessionId);
  return lines.length ? ["## Decisions made while planning", ...lines.map((l) => `- ${l}`)].join("\n") : "";
}

function requireDraft(sessionId: string, planId: string): PlanRecord {
  const p = getPlan(planId);
  if (!p || p.session_id !== sessionId) throw new SessionError("There is no such plan on this session.");
  if (p.status !== "draft") throw new SessionError(`That plan is already ${p.status}.`);
  const latest = listPlans(sessionId).slice(-1)[0];
  if (latest && latest.id !== p.id) throw new SessionError("A newer plan replaced that one.");
  return p;
}

/** Change the status line of a plan's file, nothing else, and return the file's text afterwards (null: no file). */
function stampFile(s: SessionRecord, p: PlanRecord, status: PlanRecord["status"]): string | null {
  if (!p.path) return null;
  const file = readPlanFile(s.base_cwd, p.path);
  if (!file) return null;
  const text = setMeta(file.text, "status", status);
  if (text !== file.text) fs.writeFileSync(safeJoin(s.base_cwd, p.path), text);
  return text;
}

/**
 * Give a plan that predates plan files a file, from its stored text. Needed before the viewer can open it and
 * before it can be promoted. A no-op when it already has one.
 */
export function materializePlan(sessionId: string, planId: string): PlanRecord {
  const s = requireSession(sessionId);
  const p = getPlan(planId);
  if (!p || p.session_id !== sessionId) throw new SessionError("There is no such plan on this session.");
  if (p.path && readPlanFile(s.base_cwd, p.path)) return p;
  const rel = p.path ?? newPlanPath(s.base_cwd, p.title);
  const text = renderPlanFile(metaOf(sessionId, { ...p, depth: "quick" }), contentOf(sessionId, p));
  writePlanFile(s.base_cwd, rel, text);
  table().prepare("UPDATE plans SET path = ?, depth = 'quick', file_sha = ? WHERE id = ?").run(rel, bodySha(text), p.id);
  return getPlan(p.id)!;
}

/** The plan file's text as it stands now (the operator may have edited it), with the plan it belongs to. */
export function readPlan(sessionId: string, planId?: string | null): { plan: PlanRecord; path: string | null; text: string; mtime: number | null; fromFile: boolean } {
  const s = requireSession(sessionId);
  const p = planId ? getPlan(planId) : currentPlan(sessionId) ?? listPlans(sessionId).slice(-1)[0] ?? null;
  if (!p || p.session_id !== sessionId) throw new SessionError("There is no plan on this session.");
  const file = p.path ? readPlanFile(s.base_cwd, p.path) : null;
  if (file) return { plan: p, path: p.path, text: file.text, mtime: file.mtime, fromFile: true };
  // A plan from before plan files, or a file that was deleted: what the row stored.
  return { plan: p, path: p.path, text: rowExtras(p.id).snapshot ?? planToText(p), mtime: null, fromFile: false };
}

/** Save an edit made in the viewer. Refused when the file changed underneath the editor. */
export function savePlanFile(sessionId: string, planId: string, text: string, expectedMtime?: number | null): { plan: PlanRecord; mtime: number } {
  const s = requireSession(sessionId);
  const p = getPlan(planId);
  if (!p || p.session_id !== sessionId) throw new SessionError("There is no such plan on this session.");
  if (p.status !== "draft") throw new SessionError(`That plan is already ${p.status}: edit it before approving.`);
  const mat = materializePlan(sessionId, planId);
  const rel = mat.path!;
  const abs = safeJoin(s.base_cwd, rel);
  if (expectedMtime != null && Math.abs(fs.statSync(abs).mtimeMs - expectedMtime) > 1) throw new SessionError("The plan file changed since you opened it. Reload it first.");
  if (Buffer.byteLength(text) > 1_000_000) throw new SessionError("That plan is too large (1 MB at most).");
  fs.writeFileSync(abs, text);
  announce(s, "plan");
  return { plan: getPlan(mat.id)!, mtime: fs.statSync(abs).mtimeMs };
}

function stepTitles(p: PlanRecord): string {
  return p.steps.map((st, i) => `${i + 1}. ${st.title}`).join("\n");
}

export interface ApproveResult {
  plan: PlanRecord;
  session: SessionRecord;
  /** Depth "spec": the feature to open in the Specs view. No build turn is started, its tasks come next. */
  feature: string | null;
}

export function approvePlanRecord(sessionId: string, planId: string, edits?: { title?: string; summary?: string; steps?: unknown } | null): ApproveResult {
  let s = requireSession(sessionId);
  let p = requireDraft(sessionId, planId);
  if (s.status === "running") throw new SessionError("The agent is still finishing its turn. Approve in a moment.");
  if (s.mode !== "plan") throw new SessionError(`Session ${s.id} is not in plan mode.`);
  if (edits && (edits.steps !== undefined || edits.title || edits.summary !== undefined)) {
    // Structured edits (the API and CLI take them) rewrite the file from the edited plan. In the viewer, edits are made in the file itself.
    const steps = edits.steps !== undefined ? cleanSteps(edits.steps) : p.steps;
    table()
      .prepare("UPDATE plans SET title = ?, summary = ?, steps_json = ? WHERE id = ?")
      .run(String(edits.title ?? p.title).trim().slice(0, 300) || p.title, String(edits.summary ?? p.summary).trim().slice(0, 4000), JSON.stringify(steps), p.id);
    p = getPlan(p.id)!;
    if (p.path && readPlanFile(s.base_cwd, p.path) && p.depth === "quick") {
      const text = renderPlanFile(metaOf(sessionId, p), contentOf(sessionId, p, { changelog: changelogOf(readPlanFile(s.base_cwd, p.path)!.text) }));
      writePlanFile(s.base_cwd, p.path, text);
    }
  }
  // The text the operator is approving is the file as it stands now, including their own edits.
  const stamped = stampFile(s, p, "approved");
  const approvedText = stamped ?? rowExtras(p.id).snapshot ?? planToText(p);
  table().prepare("UPDATE plans SET status = 'approved', decided_at = ?, approved_sha = ?, snapshot = ? WHERE id = ?").run(now(), sha(approvedText), approvedText, p.id);
  p = getPlan(p.id)!;
  if (p.path) {
    try {
      // By reference: the plan travels with the session (and a handoff) as a pointer, not as pasted text.
      attach(sessionId, p.depth === "spec" && p.feature ? (findFeature(s.base_cwd, p.feature)?.dir ?? p.path) : p.path, { mode: "ref", purpose: "context", delivered: true });
    } catch {}
  }

  if (p.depth === "spec" && p.feature) {
    // The spec and plan are written: the rest of the pipeline (tasks, then implement) lives in the Specs view.
    setMode(sessionId, "build");
    appendLog(requireSession(sessionId), null, `[plan] plan v${p.version} approved: spec ${p.feature} is ready for tasks`, "info");
    announce(requireSession(sessionId), "decided");
    return { plan: p, session: requireSession(sessionId), feature: p.feature };
  }

  // An architecture discussion may write the spec files and nothing else (specs/attach.ts).
  const specWrite = beginSpecWrite(sessionId);
  setMode(sessionId, "build");
  const where = p.path && stamped ? `\`${p.path}\`` : null;
  const lead = specWrite
    ? `${architectureApproval()} Apply the approved plan${where ? ` in ${where}` : " below"}.`
    : `Plan mode is off: you may edit files and run commands now. Implement the approved plan${where ? ` in ${where}` : " below"}, in order.${where ? " Read that file first: it is the source of truth, including any edits I made to it after you wrote it." : ""} Tell me if reality contradicts a step instead of working around it silently.`;
  const body = where ? [`Plan: ${p.title}`, stepTitles(p)].join("\n") : planToText(p);
  const prompt = [lead, "", body, decisionsText(sessionId)].filter((x) => x !== "").join("\n");
  appendLog(requireSession(sessionId), null, `[plan] plan v${p.version} approved: building`, "info");
  s = send({ operator: true }, sessionId, prompt);
  announce(s, "decided");
  return { plan: p, session: s, feature: null };
}

export function requestChanges(sessionId: string, planId: string, note: string): { plan: PlanRecord; session: SessionRecord } {
  const s = requireSession(sessionId);
  const p = requireDraft(sessionId, planId);
  const text = String(note ?? "").trim();
  if (!text) throw new SessionError("Say what to change.");
  if (s.status === "running") throw new SessionError("The agent is still finishing its turn. Send the note in a moment.");
  if (s.mode !== "plan") throw new SessionError(`Session ${s.id} is not in plan mode.`);
  const stamped = stampFile(s, p, "superseded");
  table().prepare("UPDATE plans SET status = 'superseded', note = ?, decided_at = ?, snapshot = COALESCE(?, snapshot) WHERE id = ?").run(text.slice(0, 2000), now(), stamped, p.id);
  appendLog(s, null, `[plan] changes requested on v${p.version}`, "info");
  const where = p.path ? ` The plan is in \`${p.path}\` (read it: it may hold edits I made, keep them unless they conflict with what I ask).` : "";
  const next = send({ operator: true }, sessionId, `Revise the plan. Still in plan mode: change nothing yet.${where} Ask with plan_ask if something is unclear, then call plan_submit again with the whole revised plan: it is saved over the same file as version ${p.version + 1}.\n\nWhat to change: ${text}`);
  announce(next, "decided");
  return { plan: getPlan(p.id)!, session: next };
}

/** Leave plan mode without building the plan: it stays on file as superseded, and the agent is told to carry on. */
export function skipPlan(sessionId: string, planId: string): { plan: PlanRecord; session: SessionRecord } {
  const s = requireSession(sessionId);
  const p = requireDraft(sessionId, planId);
  if (s.status === "running") throw new SessionError("The agent is still finishing its turn. Skip in a moment.");
  if (s.mode !== "plan") throw new SessionError(`Session ${s.id} is not in plan mode.`);
  const stamped = stampFile(s, p, "superseded");
  table().prepare("UPDATE plans SET status = 'superseded', note = 'skipped', decided_at = ?, snapshot = COALESCE(?, snapshot) WHERE id = ?").run(now(), stamped, p.id);
  setMode(sessionId, "build");
  appendLog(requireSession(sessionId), null, `[plan] plan v${p.version} skipped`, "info");
  const next = send({ operator: true }, sessionId, "Proceed without the plan. Plan mode is off: you may edit files and run commands now. Use your own judgement.");
  announce(next, "decided");
  return { plan: getPlan(p.id)!, session: next };
}

/**
 * Turn a plan into a spec feature: spec.md from its summary and decisions, plan.md from its steps, through the
 * specs module. The plan file is marked `promoted: specs/NNN-name` and keeps its status. Works on any plan with
 * content, drafts and approved ones alike.
 */
export function promotePlan(sessionId: string, planId: string): { plan: PlanRecord; feature: string; dir: string } {
  const s = requireSession(sessionId);
  let p = getPlan(planId);
  if (!p || p.session_id !== sessionId) throw new SessionError("There is no such plan on this session.");
  if (p.promoted) throw new SessionError(`That plan was already promoted to ${p.promoted}.`);
  if (p.depth === "spec") throw new SessionError("That plan is already a spec: its files are in the feature folder.");
  p = materializePlan(sessionId, planId);
  const file = readPlanFile(s.base_cwd, p.path!);
  const changelog = file ? changelogOf(file.text) : [];
  const meta = metaOf(sessionId, { ...p, depth: "spec" });
  const r = createSpecFeature(s.base_cwd, meta, contentOf(sessionId, p, { changelog }));
  if (file) fs.writeFileSync(safeJoin(s.base_cwd, p.path!), setMeta(file.text, "promoted", r.feature.dir));
  table().prepare("UPDATE plans SET promoted = ?, feature = ? WHERE id = ?").run(r.feature.dir, r.feature.id, p.id);
  appendLog(s, null, `[plan] plan v${p.version} promoted to ${r.feature.dir}`, "info");
  announce(s, "plan");
  return { plan: getPlan(p.id)!, feature: r.feature.id, dir: r.feature.dir };
}

/**
 * For a handoff, and for goal prompts: where the approved plan lives. A pointer when the file is there, the
 * stored text only when it is not (a plan from before plan files, or a deleted file).
 */
export function approvedPlanText(sessionId: string): string | null {
  const p = approvedPlan(sessionId);
  if (!p) return null;
  const s = getSession(sessionId);
  if (s && p.path && readPlanFile(s.base_cwd, p.path)) {
    const where = p.depth === "spec" && p.feature ? `${findFeature(s.base_cwd, p.feature)?.dir ?? p.path}/` : p.path;
    return [`${p.title} (${p.steps.length} step${p.steps.length === 1 ? "" : "s"}). The plan is in \`${where}\`: read it before continuing, it is the source of truth.`, stepTitles(p)].join("\n");
  }
  return rowExtras(p.id).snapshot ?? planToText(p);
}

/** The file an approved plan lives in, for prompts that should point at it. */
export function approvedPlanPath(sessionId: string): string | null {
  const p = approvedPlan(sessionId);
  const s = getSession(sessionId);
  return p?.path && s && readPlanFile(s.base_cwd, p.path) ? p.path : null;
}

/* -------------------------------------------------------------------------- */
/* Tool surface                                                               */
/* -------------------------------------------------------------------------- */

export const PLAN_TOOL_NAMES = ["plan_ask", "plan_submit"] as const;

export interface PlanToolDef {
  name: (typeof PLAN_TOOL_NAMES)[number];
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export function planToolDefs(): PlanToolDef[] {
  return [
    {
      name: "plan_ask",
      description:
        "Ask the user ONE question and wait for their answer. Use it only for what the code cannot tell you and that changes the plan. " +
        `Give ${MIN_OPTIONS} to 4 options, mark exactly one recommended with a one-line reason, and keep each description short. ` +
        "The user may also type their own answer, or skip. Blocks until they respond, which can take minutes: that is normal. " +
        "Ask at most six questions in total, one at a time, then call plan_submit.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question, specific to this codebase and task. One sentence if you can." },
          options: {
            type: "array",
            description: "The choices, each {label, description?, recommended?, reason?}. Exactly one has recommended: true.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short, 1-6 words." },
                description: { type: "string", description: "What choosing this means, in one line." },
                recommended: { type: "boolean" },
                reason: { type: "string", description: "Why you recommend it. Only on the recommended option." },
              },
              required: ["label"],
            },
          },
          allow_custom: { type: "boolean", description: "Let the user type their own answer (default true)." },
          multi: { type: "boolean", description: "Let the user pick more than one option (default false)." },
        },
        required: ["question", "options"],
      },
    },
    {
      name: "plan_submit",
      description:
        "Hand the user the finished plan for approval. Call it exactly once, after your questions, then stop and write nothing more: do not implement anything. The daemon saves it as a markdown file in the workspace for the user to review; you never write that file. " +
        "The user can approve it (you then get a message to build it), edit it, or send it back with a note, in which case call plan_submit again with the whole revised plan.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "One line: what will be built." },
          summary: { type: "string", description: "The approach and why, in a short paragraph. Mention the decisions the user made." },
          steps: {
            type: "array",
            description: "Ordered steps, each small enough to verify.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                detail: { type: "string", description: "What changes and how." },
                files: { type: "array", items: { type: "string" }, description: "Paths this step touches." },
              },
              required: ["title"],
            },
          },
          risks: { type: "array", items: { type: "string" }, description: "What could go wrong, and how you will verify." },
          open_questions: { type: "array", items: { type: "string" }, description: "Anything still unresolved that the user should know." },
          requirements: { type: "array", items: { type: "string" }, description: "Only when the plan becomes a spec: what the system MUST do, one line each." },
          success_criteria: { type: "array", items: { type: "string" }, description: "Only when the plan becomes a spec: measurable outcomes, one line each." },
        },
        required: ["title", "steps"],
      },
    },
  ];
}

/** Run a plan tool for the session behind the shim. Text for the agent, plus `pending` when the shim should poll again. */
export async function executePlanTool(name: string, args: Record<string, unknown>, sessionId: string): Promise<AskResult> {
  try {
    if (name === "plan_ask") return await askQuestion(sessionId, args);
    if (name === "plan_submit") {
      const p = submitPlan(sessionId, args);
      return { text: `Plan v${p.version} saved to ${p.path} and waiting for the user's approval. Stop now: do not implement anything, do not write the file yourself and do not repeat the plan. If the user wants changes you will get a message.` };
    }
    return { text: `Error: unknown plan tool "${name}".` };
  } catch (err: any) {
    if (err instanceof UserError || err instanceof SessionError) return { text: `Error: ${err.message}` };
    return { text: `Error: plan tool "${name}" failed: ${err?.message ?? String(err)}` };
  }
}
