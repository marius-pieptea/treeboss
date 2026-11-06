/**
 * The agent's part of QA: drafting a plan from a source and suggesting missing steps. Both are one session that writes
 * `lab/qa/<slug>.proposals.md` and nothing else; the operator then accepts or rejects each proposal (plan.ts `decide`).
 * A draft is a suggestion against a plan with no steps yet. At most one QA session works on a plan at a time.
 */
import { db } from "../db";
import { UserError } from "../util";
import { realOf } from "../lab/tables";
import type { LabOpts } from "../lab/sessions";
import { withInstructions } from "../design/sessions";
import { Hub } from "../sessions/hub";
import { createLead, getSession, send, type SessionRecord } from "../sessions/manager";
import { setMode } from "../sessions/plan";
import { formatSource, parsePlanSource, proposalsExist, proposalsSignature, QA_DIR, readPlan } from "./plan";
import { FOCUS, type Focus, type Plan, type PlanSlug, type PlanSource, type QaAsk, type QaSessionInfo } from "./types";

const FOCUS_HINT: Record<Focus, string> = {
  errors: "failures: bad input, rejected requests, server errors, offline, what the user sees and whether they can recover",
  "edge-cases": "boundaries: empty, huge, duplicate and unusual input, double clicks, back button, reload mid-flow",
  mobile: "a narrow screen and touch: layout, tap targets, keyboard overlap, rotation",
  accessibility: "keyboard only, focus order, labels, contrast, screen reader names",
  "empty-states": "no data yet: first-time user, empty lists, zero results",
  permissions: "who may do this: signed out, wrong role, expired session",
};

export function parseQaAsk(kind: unknown, b: Record<string, unknown>): QaAsk {
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (kind === "draft") {
    const from = parsePlanSource(b.from);
    if (from.kind === "text" && !note) throw new UserError("Describe what to test: a draft from text needs a note.");
    return { kind: "draft", from, note };
  }
  const raw = b.focus === undefined ? [] : b.focus;
  if (!Array.isArray(raw)) throw new UserError("focus must be a list.");
  const bad = raw.find((f) => !(FOCUS as readonly unknown[]).includes(f));
  if (bad !== undefined) throw new UserError(`Unknown focus "${String(bad)}": use ${FOCUS.join(", ")}.`);
  return { kind: "suggest", focus: [...new Set(raw as Focus[])], note };
}

function sourceBlock(s: PlanSource, note: string): string {
  switch (s.kind) {
    case "spec":
      return `Source: the spec in \`${s.dir}\`. Read every file in that folder (the spec, its tasks, its acceptance criteria) and test what it promises.`;
    case "diff":
      return `Source: the change \`${s.base}..${s.head}\`. Run \`git diff ${s.base}..${s.head}\` and \`git log ${s.base}..${s.head}\`, then read the changed files. Test what a user can see or do differently, plus what the change could have broken nearby.`;
    case "page":
      return `Source: the page \`${s.path}\` of the running app. Open it in the browser with the browser tools (browser_navigate, then browser_snapshot to read it, browser_click to try it) and write the checks a person would do on it. If the app is not running, say so in your last message and write nothing.`;
    default:
      return `Source: the operator's description below (${s.kind}). Read the code the description points at when it helps.`;
  }
}

function stepsBlock(plan: Plan): string {
  if (!plan.steps.length) return "The plan has no steps yet.";
  return `The plan already has these steps. Do not repeat any of them, not even reworded:\n${plan.steps.map((s) => `- ${s.id}: ${s.action}${s.expected ? ` (expect: ${s.expected})` : ""}`).join("\n")}`;
}

export function qaPrompt(plan: Plan, ask: QaAsk): { visible: string; instructions: string; label: string } {
  const file = `${QA_DIR}/${plan.slug}.proposals.md`;
  const focus = ask.kind === "suggest" && ask.focus.length ? `\nFocus on these, each one a separate kind of check:\n${ask.focus.map((f) => `- ${f}: ${FOCUS_HINT[f]}`).join("\n")}\n` : "";
  const source = ask.kind === "draft" ? sourceBlock(ask.from, ask.note) : `Source: the plan "${plan.title}" (${formatSource(plan.source)}). Find what it misses.`;
  const instructions = `You are writing a manual QA plan for "${plan.title}". A person will run each step by hand in the browser and mark it pass or fail, so each step is one thing to do and one thing to check.

${source}
${focus}
${stepsBlock(plan)}

Write ONLY the file \`${file}\`. Change nothing else in the repository. If the file already holds proposals, keep them and add yours after them. Use exactly this format:

## Steps
1. Open the cart with two items
   path: /cart
   expect: Both items are listed and the total reads 42.00
   after: start
   why: The plan has no cart check yet

Rules:
- Number the steps 1, 2, 3 in the order they should appear. Do not write ids; they are added for you.
- \`after:\` is \`start\` or the id of an existing plan step. Several steps with the same \`after:\` stay in the order you wrote them, so give a run of new steps the same anchor.
- \`path:\` is the page to open, starting with /. Leave the line out when no page applies.
- \`expect:\` is concrete and checkable: a visible text, a number, a state, an error message. Never "works correctly" or "looks fine".
- \`why:\` is one short line: what this step guards against.
- One line per field. No other text in the file.
- Write ${ask.kind === "draft" ? "the steps a thorough tester would run, ordered as a user would walk through them" : "only steps that are missing. If nothing is missing, write the file with the ## Steps heading and no steps"}.
${ask.note ? `\nThe operator's note:\n${ask.note}\n` : ""}`;
  const visible = ask.kind === "draft" ? `Draft a QA plan from ${ask.from.kind === "text" || ask.from.kind === "manual" ? "this description" : formatSource(ask.from)}.` : `Suggest missing QA steps${ask.kind === "suggest" && ask.focus.length ? ` (${ask.focus.join(", ")})` : ""}.`;
  return { visible: ask.note || visible, instructions, label: ask.kind === "draft" ? "QA · draft" : "QA · suggest" };
}

interface Row {
  session_id: string;
  root_dir: string;
  plan: string;
  kind: QaAsk["kind"];
  problem: string | null;
  /** The proposals file as the turn started, so a file left by an earlier turn is not mistaken for this turn's work. */
  proposals_sig: string | null;
}

const latest = (root: string, slug: PlanSlug): Row | null => db().prepare("SELECT * FROM qa_sessions WHERE root_dir = ? AND plan = ? ORDER BY rowid DESC LIMIT 1").get(realOf(root), slug) as Row | null;

/** The newest QA session of a plan, whether it is still working, and why its proposals are unusable if they are. */
export function qaSession(root: string, slug: PlanSlug): QaSessionInfo | null {
  const r = latest(root, slug);
  if (!r) return null;
  const s = getSession(r.session_id);
  return { sessionId: r.session_id, kind: r.kind, running: s?.status === "running", problem: r.problem };
}

/** Starts the draft or suggest session of a plan. The agent runs in the project itself, never a worktree: the file must appear where the operator is looking. */
export function startQaSession(root: string, slug: PlanSlug, ask: QaAsk, o: LabOpts = {}): SessionRecord {
  const plan = readPlan(root, slug);
  if (plan.problem) throw new UserError(`The plan file cannot be read (${plan.problem}).`);
  if (qaSession(root, slug)?.running) throw new UserError(`A QA session is already working on "${slug}". Wait for it to finish.`);
  const t = qaPrompt(plan, ask);
  const prompt = withInstructions(t.visible, t.label, t.instructions);
  let session: SessionRecord;
  if (o.sessionId) {
    const s = getSession(o.sessionId);
    if (!s) throw new UserError(`No session "${o.sessionId}".`);
    setMode(s.id, "build");
    session = send({ operator: true }, s.id, prompt);
  } else {
    session = createLead({ prompt, title: `${t.label} · ${plan.title}`.slice(0, 100), cwd: root, engine: o.engine, model: o.model, effort: o.effort, agent: o.agent, pairId: o.pairId, isolate: false, mode: "build" });
  }
  db().prepare("INSERT OR REPLACE INTO qa_sessions (session_id, root_dir, plan, kind, problem, proposals_sig) VALUES (?, ?, ?, ?, NULL, ?)").run(session.id, realOf(root), slug, ask.kind, proposalsSignature(root, slug));
  return session;
}

/** A QA turn ended: read the proposals it wrote (which gives them ids) and record why they are unusable, if they are. */
export function finishQaTurn(sessionId: string): void {
  const r = db().prepare("SELECT * FROM qa_sessions WHERE session_id = ?").get(sessionId) as Row | null;
  if (!r) return;
  let problem: string | null = null;
  try {
    const plan = readPlan(r.root_dir, r.plan as PlanSlug);
    if (plan.proposalsProblem) problem = `The proposals file is malformed: ${plan.proposalsProblem}.`;
    else if (!proposalsExist(r.root_dir, plan.slug)) problem = `The agent did not write ${QA_DIR}/${plan.slug}.proposals.md.`;
    else if (r.proposals_sig !== null && proposalsSignature(r.root_dir, plan.slug) === r.proposals_sig) problem = `The agent did not add to ${QA_DIR}/${plan.slug}.proposals.md.`;
    else if (!plan.proposals.length && r.kind === "draft" && !plan.steps.length) problem = "The agent wrote no steps.";
  } catch (e) {
    problem = (e as Error).message;
  }
  db().prepare("UPDATE qa_sessions SET problem = ? WHERE session_id = ?").run(problem, sessionId);
}

let unsubscribe: (() => void) | null = null;

export function startQaDriver(): void {
  if (unsubscribe) return;
  unsubscribe = Hub.subscribe((e) => {
    if (e.type === "turn_end") finishQaTurn(e.sessionId);
  });
}

export function stopQaDriver(): void {
  unsubscribe?.();
  unsubscribe = null;
}
