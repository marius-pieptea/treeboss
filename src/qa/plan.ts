/**
 * QA plans as files. `lab/qa/<slug>.md` is the plan, `lab/qa/<slug>.proposals.md` holds the steps the agent suggests:
 *
 *   ---
 *   title: Checkout with saved card
 *   source: spec:specs/121-checkout     spec:<dir> | diff:<base>..<head> | page:/path | text | manual
 *   ---
 *   Intro text.
 *   ## Steps
 *   1. [s-7k2p] Open the cart with two items
 *      path: /cart
 *      expect: Both items listed, total 42.00
 *
 * A proposal has the same shape with a `p-` id plus `after: s-xxxx|start` and `why:`. Several proposals with one anchor
 * keep their file order. Everything is parsed here, once; callers get the typed model. A file that cannot be parsed is
 * listed with a problem and never dropped.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { LAB_DIR } from "../lab/findings";
import { lastRunSummary, removeRuns } from "./runs";
import type { Decision, NewStep, Plan, PlanEdit, PlanSlug, PlanSource, PlanStep, PlanSummary, Proposal, ProposalId, StepId, StepPath } from "./types";

export const QA_DIR = `${LAB_DIR}/qa`;
const MAX_BYTES = 512 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const STEP_ID = /^s-[a-z0-9]+$/;
const PROPOSAL_ID = /^p-[a-z0-9]+$/;

export class QaNotFound extends UserError {}

/* -------------------------------------------------------------------------- */
/* Boundary parsers                                                           */
/* -------------------------------------------------------------------------- */

const oneLine = (s: string): string => s.replace(/\s*\r?\n\s*/g, " ").trim();

export function planSlug(raw: unknown): PlanSlug {
  if (typeof raw !== "string" || !SLUG.test(raw)) throw new UserError(`"${String(raw)}" is not a plan name: use lowercase letters, digits and dashes.`);
  return raw as PlanSlug;
}

export function stepId(raw: unknown): StepId {
  if (typeof raw !== "string" || !STEP_ID.test(raw)) throw new UserError(`"${String(raw)}" is not a step id.`);
  return raw as StepId;
}

export function proposalId(raw: unknown): ProposalId {
  if (typeof raw !== "string" || !PROPOSAL_ID.test(raw)) throw new UserError(`"${String(raw)}" is not a proposal id.`);
  return raw as ProposalId;
}

/** A path on the app under test: "/cart", or a localhost URL reduced to its path. */
export function stepPath(raw: unknown): StepPath {
  const s = typeof raw === "string" ? raw.trim() : "";
  const url = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/\S*)?$/i.exec(s);
  if (url) return (url[1] ?? "/") as StepPath;
  if (/^\/(?!\/)\S*$/.test(s)) return s as StepPath;
  throw new UserError(`"${s}" is not a path: write it as /cart, or a localhost URL.`);
}

const text1 = (v: unknown, what: string, required: boolean): string => {
  if (v === undefined || v === null) {
    if (required) throw new UserError(`${what} is required.`);
    return "";
  }
  if (typeof v !== "string") throw new UserError(`${what} must be text.`);
  const s = oneLine(v);
  if (required && !s) throw new UserError(`${what} is required.`);
  return s;
};

const pathOrNull = (v: unknown): StepPath | null => (v === null || v === undefined || (typeof v === "string" && !v.trim()) ? null : stepPath(v));

export function parseNewStep(raw: unknown): NewStep {
  const o = (raw ?? {}) as Record<string, unknown>;
  return { action: text1(o.action, "A step's action", true), expected: text1(o.expected, "A step's expected result", false), path: pathOrNull(o.path) };
}

export function parsePlanSource(raw: unknown): PlanSource {
  const o = (raw ?? {}) as Record<string, unknown>;
  switch (o.kind) {
    case "spec":
      return { kind: "spec", dir: text1(o.dir, "A spec source's dir", true) };
    case "diff":
      return { kind: "diff", base: text1(o.base, "A diff source's base", true), head: text1(o.head, "A diff source's head", true) };
    case "page":
      return { kind: "page", path: stepPath(o.path) };
    case "text":
    case "manual":
      return { kind: o.kind };
    default:
      throw new UserError(`Unknown source "${String(o.kind)}": use spec, diff, page, text or manual.`);
  }
}

const anchorOf = (v: unknown): StepId | "start" => (v === "start" ? "start" : stepId(v));

export function parsePlanEdit(raw: unknown): PlanEdit {
  const o = (raw ?? {}) as Record<string, any>;
  switch (o.op) {
    case "add":
      return { op: "add", step: parseNewStep(o.step), after: anchorOf(o.after) };
    case "update": {
      const f = (o.fields ?? {}) as Record<string, unknown>;
      const fields: Partial<NewStep> = {};
      if ("action" in f) fields.action = text1(f.action, "A step's action", true);
      if ("expected" in f) fields.expected = text1(f.expected, "A step's expected result", false);
      if ("path" in f) fields.path = pathOrNull(f.path);
      return { op: "update", id: stepId(o.id), fields };
    }
    case "move":
      return { op: "move", id: stepId(o.id), after: anchorOf(o.after) };
    case "remove":
      return { op: "remove", id: stepId(o.id) };
    default:
      throw new UserError(`Unknown edit "${String(o.op)}": use add, update, move or remove.`);
  }
}

/* -------------------------------------------------------------------------- */
/* The file format                                                            */
/* -------------------------------------------------------------------------- */

export function formatSource(s: PlanSource): string {
  switch (s.kind) {
    case "spec":
      return `spec:${s.dir}`;
    case "diff":
      return `diff:${s.base}..${s.head}`;
    case "page":
      return `page:${s.path}`;
    default:
      return s.kind;
  }
}

function parseSource(raw: string): PlanSource {
  if (raw === "text" || raw === "manual") return { kind: raw };
  const i = raw.indexOf(":");
  const kind = i < 0 ? raw : raw.slice(0, i);
  const rest = i < 0 ? "" : raw.slice(i + 1).trim();
  if (kind === "spec" && rest) return { kind, dir: rest };
  if (kind === "diff") {
    const d = /^(.+?)\.\.(.+)$/.exec(rest);
    if (d) return { kind, base: d[1]!, head: d[2]! };
  }
  if (kind === "page") return { kind, path: stepPath(rest) };
  throw new Error(`source "${raw}" is not spec:<dir>, diff:<base>..<head>, page:/path, text or manual`);
}

interface RawStep {
  id: string | null;
  action: string;
  expected: string;
  path: StepPath | null;
  after: string | null;
  why: string;
}

type Ided = RawStep & { id: string };

const eolOf = (t: string): string => (t.includes("\r\n") ? "\r\n" : "\n");

function parseSteps(lines: string[], from: number, prefix: "s" | "p"): RawStep[] {
  const out: RawStep[] = [];
  let cur: RawStep | null = null;
  let seen = new Set<string>();
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const head = /^\d+\.\s+(?:\[([sp]-[a-z0-9]+)\]\s+)?(.+?)\s*$/.exec(line);
    if (head) {
      if (head[1] && !head[1].startsWith(`${prefix}-`)) throw new Error(`line ${i + 1}: id ${head[1]} should start with ${prefix}-`);
      cur = { id: head[1] ?? null, action: head[2]!, expected: "", path: null, after: null, why: "" };
      out.push(cur);
      seen = new Set();
      continue;
    }
    const kv = /^\s+(path|expect|after|why):\s*(.*?)\s*$/.exec(line);
    if (!kv || !cur) throw new Error(`line ${i + 1}: not a step or a step field: "${line.trim().slice(0, 60)}"`);
    const key = kv[1]!;
    if (seen.has(key)) throw new Error(`line ${i + 1}: "${key}" appears twice in one step`);
    seen.add(key);
    const v = kv[2]!;
    if (key === "path") {
      try {
        cur.path = v ? stepPath(v) : null;
      } catch (e) {
        throw new Error(`line ${i + 1}: ${(e as Error).message}`);
      }
    } else if (key === "expect") cur.expected = v;
    else if (key === "why") cur.why = v;
    else {
      if (!/^(start|s-[a-z0-9]+)$/.test(v)) throw new Error(`line ${i + 1}: after must be start or a step id, not "${v}"`);
      cur.after = v;
    }
  }
  const ids = out.map((s) => s.id).filter((x): x is string => !!x);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new Error(`the id ${dup} is used twice`);
  return out;
}

const stepLines = (n: number, s: Ided, extra: boolean): string[] => {
  const l = [`${n}. [${s.id}] ${oneLine(s.action)}`];
  if (s.path) l.push(`   path: ${s.path}`);
  if (s.expected) l.push(`   expect: ${oneLine(s.expected)}`);
  if (extra) {
    if (s.after) l.push(`   after: ${s.after}`);
    if (s.why) l.push(`   why: ${oneLine(s.why)}`);
  }
  return l;
};

const asRaw = (s: PlanStep): Ided => ({ ...s, after: null, why: "" });

interface PlanFile {
  title: string;
  source: PlanSource;
  intro: string;
  steps: RawStep[];
}

function parsePlanFile(text: string): PlanFile {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") throw new Error("the file must start with a --- front matter block");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("the front matter is never closed with ---");
  const fm: Record<string, string> = {};
  for (const l of lines.slice(1, end)) {
    const m = /^(\w+):\s*(.*?)\s*$/.exec(l);
    if (m) fm[m[1]!] = m[2]!;
  }
  if (!fm.title) throw new Error("the front matter has no title");
  const rest = lines.slice(end + 1);
  const h = rest.findIndex((l) => /^##\s+Steps\s*$/.test(l));
  if (h < 0) throw new Error("there is no ## Steps heading");
  return { title: fm.title, source: fm.source ? parseSource(fm.source) : { kind: "manual" }, intro: rest.slice(0, h).join("\n").trim(), steps: parseSteps(lines, end + 1 + h + 1, "s") };
}

function serializePlanFile(p: { title: string; source: PlanSource; intro: string; steps: Ided[] }, eol: string): string {
  const lines = ["---", `title: ${oneLine(p.title)}`, `source: ${formatSource(p.source)}`, "---"];
  if (p.intro) lines.push(...p.intro.split("\n"));
  lines.push("## Steps");
  p.steps.forEach((s, i) => lines.push(...stepLines(i + 1, s, false)));
  return lines.join(eol) + eol;
}

function parseProposalsFile(text: string): RawStep[] {
  const lines = text.split(/\r?\n/);
  const h = lines.findIndex((l) => /^##\s+Steps\s*$/.test(l));
  if (h < 0) throw new Error("there is no ## Steps heading");
  return parseSteps(lines, h + 1, "p");
}

function serializeProposals(steps: Ided[], eol: string): string {
  const lines = ["## Steps"];
  steps.forEach((s, i) => lines.push(...stepLines(i + 1, s, true)));
  return lines.join(eol) + eol;
}

/* -------------------------------------------------------------------------- */
/* Files                                                                      */
/* -------------------------------------------------------------------------- */

const planFile = (root: string, slug: string): string => path.join(root, QA_DIR, `${slug}.md`);
const proposalsFile = (root: string, slug: string): string => path.join(root, QA_DIR, `${slug}.proposals.md`);

export const proposalsExist = (root: string, slug: PlanSlug): boolean => fs.existsSync(proposalsFile(root, slug));

/** The proposals file's content hash, or null when there is no file: what a QA turn compares to see whether it wrote anything. */
export function proposalsSignature(root: string, slug: PlanSlug): string | null {
  try {
    return new Bun.CryptoHasher("sha1").update(fs.readFileSync(proposalsFile(root, slug))).digest("hex");
  } catch {
    return null;
  }
}

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** The file's text, or null when there is none. A file too big to be a plan is an error. */
function readText(file: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (st.size > MAX_BYTES) throw new Error(`the file is ${Math.round(st.size / 1024)} KB, more than the ${MAX_BYTES / 1024} KB a plan may be`);
  return fs.readFileSync(file, "utf-8");
}

const mtime = (file: string): number => {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function freshId(prefix: "s" | "p", taken: Set<string>): string {
  for (;;) {
    const id = `${prefix}-${Array.from(crypto.randomBytes(4), (b) => ALPHABET[b % ALPHABET.length]).join("")}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** Gives every step without an id one. Returns whether anything changed. */
function assignIds(steps: RawStep[], prefix: "s" | "p", taken: Set<string>): boolean {
  let changed = false;
  for (const s of steps) {
    if (s.id) continue;
    s.id = freshId(prefix, taken);
    changed = true;
  }
  return changed;
}

interface Loaded {
  plan: Plan;
  eol: string;
  raw: PlanFile | null;
  proposals: Ided[];
}

function loadProposals(root: string, slug: PlanSlug, stepIds: Iterable<string>): { proposals: Ided[]; problem: string | null; eol: string } {
  let text: string | null;
  try {
    text = readText(proposalsFile(root, slug));
  } catch (e) {
    return { proposals: [], problem: (e as Error).message, eol: "\n" };
  }
  if (text === null || !text.trim()) return { proposals: [], problem: null, eol: "\n" };
  const eol = eolOf(text);
  try {
    const raw = parseProposalsFile(text);
    const taken = new Set<string>(stepIds);
    for (const p of raw) if (p.id) taken.add(p.id);
    if (assignIds(raw, "p", taken)) write(proposalsFile(root, slug), serializeProposals(raw as Ided[], eol));
    return { proposals: raw as Ided[], problem: null, eol };
  } catch (e) {
    return { proposals: [], problem: (e as Error).message, eol };
  }
}

function load(root: string, slug: PlanSlug): Loaded {
  const file = planFile(root, slug);
  let text: string | null = null;
  let problem: string | null = null;
  let parsed: PlanFile | null = null;
  try {
    text = readText(file);
    if (text === null) throw new QaNotFound(`No QA plan "${slug}".`);
    parsed = parsePlanFile(text);
  } catch (e) {
    if (e instanceof QaNotFound) throw e;
    problem = (e as Error).message;
  }
  const eol = text ? eolOf(text) : "\n";
  if (!parsed) {
    const prop = loadProposals(root, slug, []);
    return { plan: { slug, title: slug, source: { kind: "manual" }, intro: "", steps: [], proposals: [], problem: problem ?? "unreadable", proposalsProblem: prop.problem }, eol, raw: null, proposals: [] };
  }
  const prop = loadProposals(root, slug, parsed.steps.flatMap((s) => (s.id ? [s.id] : [])));
  const taken = new Set<string>(prop.proposals.map((p) => p.id));
  for (const s of parsed.steps) if (s.id) taken.add(s.id);
  if (assignIds(parsed.steps, "s", taken)) write(file, serializePlanFile({ ...parsed, steps: parsed.steps as Ided[] }, eol));
  const steps: PlanStep[] = (parsed.steps as Ided[]).map((s) => ({ id: s.id as StepId, action: s.action, expected: s.expected, path: s.path }));
  const last: StepId | "start" = steps.length ? steps[steps.length - 1]!.id : "start";
  const ids = new Set<string>(steps.map((s) => s.id));
  const view: Proposal[] = prop.proposals.map((p) => {
    const orphan = p.after !== null && p.after !== "start" && !ids.has(p.after);
    const after: StepId | "start" = p.after === "start" ? "start" : p.after !== null && !orphan ? (p.after as StepId) : last;
    return { id: p.id as ProposalId, step: { action: p.action, expected: p.expected, path: p.path }, after, why: p.why, orphan };
  });
  return { plan: { slug, title: parsed.title, source: parsed.source, intro: parsed.intro, steps, proposals: view, problem: null, proposalsProblem: prop.problem }, eol, raw: parsed, proposals: prop.proposals };
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                 */
/* -------------------------------------------------------------------------- */

/** Reads a plan with its proposals. Steps without an id get one, and the file is written back only when that changed it. */
export function readPlan(root: string, slug: PlanSlug): Plan {
  return load(root, slug).plan;
}

export function listPlans(root: string): PlanSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(root, QA_DIR));
  } catch {
    return [];
  }
  const out: PlanSummary[] = [];
  for (const n of names.sort()) {
    const m = /^(.+)\.md$/.exec(n);
    if (!m || m[1]!.endsWith(".proposals")) continue;
    const slug = m[1]!;
    const updatedAt = Math.max(mtime(planFile(root, slug)), mtime(proposalsFile(root, slug)));
    if (!SLUG.test(slug)) {
      out.push({ slug: slug as PlanSlug, title: slug, steps: 0, proposals: 0, problem: "the file name is not a plan name: use lowercase letters, digits and dashes", updatedAt, lastRun: null });
      continue;
    }
    const p = load(root, slug as PlanSlug).plan;
    out.push({ slug: p.slug, title: p.title, steps: p.steps.length, proposals: p.proposals.length, problem: p.problem, updatedAt, lastRun: lastRunSummary(root, p.slug) });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createPlan(root: string, title: string, source: PlanSource): Plan {
  const t = oneLine(String(title ?? ""));
  if (!t) throw new UserError("A plan needs a title.");
  const base = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "") || "plan";
  let slug = base;
  for (let n = 2; fs.existsSync(planFile(root, slug)); n++) slug = `${base}-${n}`;
  write(planFile(root, slug), serializePlanFile({ title: t, source, intro: "", steps: [] }, "\n"));
  return readPlan(root, slug as PlanSlug);
}

function loadEditable(root: string, slug: PlanSlug): Loaded & { raw: PlanFile } {
  const l = load(root, slug);
  if (!l.raw) throw new UserError(`The plan file cannot be read (${l.plan.problem}). Fix it in ${QA_DIR}/${slug}.md first.`);
  return l as Loaded & { raw: PlanFile };
}

const save = (root: string, l: Loaded & { raw: PlanFile }, steps: PlanStep[]): Plan => {
  write(planFile(root, l.plan.slug), serializePlanFile({ ...l.raw, steps: steps.map(asRaw) }, l.eol));
  return readPlan(root, l.plan.slug);
};

function insertAt(steps: PlanStep[], after: StepId | "start"): number {
  if (after === "start") return 0;
  const i = steps.findIndex((s) => s.id === after);
  if (i < 0) throw new UserError(`No step ${after} in this plan.`);
  return i + 1;
}

const indexOfStep = (steps: PlanStep[], id: StepId): number => {
  const i = steps.findIndex((s) => s.id === id);
  if (i < 0) throw new UserError(`No step ${id} in this plan.`);
  return i;
};

export function editPlan(root: string, slug: PlanSlug, e: PlanEdit): Plan {
  const l = loadEditable(root, slug);
  const steps = [...l.plan.steps];
  switch (e.op) {
    case "add": {
      const taken = new Set<string>([...steps.map((s) => s.id as string), ...l.plan.proposals.map((p) => p.id as string)]);
      steps.splice(insertAt(steps, e.after), 0, { id: freshId("s", taken) as StepId, ...e.step });
      break;
    }
    case "update": {
      const i = indexOfStep(steps, e.id);
      steps[i] = { ...steps[i]!, ...e.fields };
      break;
    }
    case "move": {
      const i = indexOfStep(steps, e.id);
      if (e.after === e.id) throw new UserError("A step cannot be moved after itself.");
      const [moved] = steps.splice(i, 1);
      steps.splice(insertAt(steps, e.after), 0, moved!);
      break;
    }
    case "remove":
      steps.splice(indexOfStep(steps, e.id), 1);
      break;
  }
  return save(root, l, steps);
}

/**
 * Accepts or rejects one proposal or all of them. An accepted step joins the plan with a fresh step id, after its anchor
 * (proposals sharing an anchor keep their file order when accepted together). Decided proposals leave the file.
 */
export function decide(root: string, slug: PlanSlug, which: ProposalId | "all", d: Decision): Plan {
  const l = loadEditable(root, slug);
  const targets = which === "all" ? l.plan.proposals : l.plan.proposals.filter((p) => p.id === which);
  if (which !== "all" && !targets.length) throw new QaNotFound(`No proposal ${which} in "${slug}".`);
  if (d === "accept" && targets.length) {
    const steps = [...l.plan.steps];
    const taken = new Set<string>([...steps.map((s) => s.id as string), ...l.plan.proposals.map((p) => p.id as string)]);
    const placed = new Map<string, number>();
    for (const p of targets) {
      const n = placed.get(p.after) ?? 0;
      placed.set(p.after, n + 1);
      steps.splice(insertAt(steps, p.after) + n, 0, { id: freshId("s", taken) as StepId, ...p.step });
    }
    save(root, l, steps);
  }
  const gone = new Set<string>(targets.map((p) => p.id));
  const keep = l.proposals.filter((p) => !gone.has(p.id));
  if (!keep.length) fs.rmSync(proposalsFile(root, slug), { force: true });
  else write(proposalsFile(root, slug), serializeProposals(keep, l.eol));
  return readPlan(root, slug);
}

/** Deletes the plan and its proposals file. Its runs go with it. */
export function removePlan(root: string, slug: PlanSlug): void {
  if (!fs.existsSync(planFile(root, slug))) throw new QaNotFound(`No QA plan "${slug}".`);
  fs.rmSync(planFile(root, slug), { force: true });
  fs.rmSync(proposalsFile(root, slug), { force: true });
  removeRuns(root, slug);
}
