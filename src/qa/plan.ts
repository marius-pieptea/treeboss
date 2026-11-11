/**
 * QA plans as files: `lab/qa/<feature id>.md`, the flow that tests one feature.
 *
 *   ---
 *   title: Checkout with saved card
 *   ---
 *   Intro text.
 *   ## Steps
 *   1. [s-7k2p] Open the cart with two items
 *      path: /cart
 *      expect: Both items listed, total 42.00
 *
 * Everything is parsed here, once; callers get the typed model. A file that cannot be parsed is listed with a problem
 * and never dropped. A step written without an id gets one, and the file is written back once with it.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { LAB_DIR } from "../lab/findings";
import { readFeatures } from "./features";
import { removeRuns } from "./runs";
import type { FeatureId, Plan, PlanStep, QaBoard, StepId, StepPath } from "./types";

export const QA_DIR = `${LAB_DIR}/qa`;
const MAX_BYTES = 512 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const STEP_ID = /^s-[a-z0-9]+$/;

export class QaNotFound extends UserError {}
export class QaConflict extends UserError {}

const oneLine = (s: string): string => s.replace(/\s*\r?\n\s*/g, " ").trim();

export function planSlug(raw: unknown): string {
  if (typeof raw !== "string" || !SLUG.test(raw)) throw new UserError(`"${String(raw)}" is not a plan name: use lowercase letters, digits and dashes.`);
  return raw;
}

export function stepId(raw: unknown): StepId {
  if (typeof raw !== "string" || !STEP_ID.test(raw)) throw new UserError(`"${String(raw)}" is not a step id.`);
  return raw as StepId;
}

/** A path on the app under test: "/cart", or a localhost URL reduced to its path. */
function stepPath(raw: string): StepPath {
  const s = raw.trim();
  const url = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/\S*)?$/i.exec(s);
  if (url) return (url[1] ?? "/") as StepPath;
  if (/^\/(?!\/)\S*$/.test(s)) return s as StepPath;
  throw new Error(`"${s}" is not a path: write it as /cart, or a localhost URL`);
}

/* -------------------------------------------------------------------------- */
/* The file format                                                            */
/* -------------------------------------------------------------------------- */

interface RawStep {
  id: string | null;
  action: string;
  expected: string;
  path: StepPath | null;
}
type Ided = RawStep & { id: string };

const eolOf = (t: string): string => (t.includes("\r\n") ? "\r\n" : "\n");

function parseSteps(lines: string[], from: number): RawStep[] {
  const out: RawStep[] = [];
  let cur: RawStep | null = null;
  let seen = new Set<string>();
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const head = /^\d+\.\s+(?:\[(s-[a-z0-9]+)\]\s+)?(.+?)\s*$/.exec(line);
    if (head) {
      cur = { id: head[1] ?? null, action: head[2]!, expected: "", path: null };
      out.push(cur);
      seen = new Set();
      continue;
    }
    const kv = /^\s+(path|expect):\s*(.*?)\s*$/.exec(line);
    if (!kv || !cur) throw new Error(`line ${i + 1}: not a step or a step field: "${line.trim().slice(0, 60)}"`);
    const key = kv[1]!;
    if (seen.has(key)) throw new Error(`line ${i + 1}: "${key}" appears twice in one step`);
    seen.add(key);
    if (key === "path") {
      try {
        cur.path = kv[2]! ? stepPath(kv[2]!) : null;
      } catch (e) {
        throw new Error(`line ${i + 1}: ${(e as Error).message}`);
      }
    } else cur.expected = kv[2]!;
  }
  const ids = out.map((s) => s.id).filter((x): x is string => !!x);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new Error(`the id ${dup} is used twice`);
  return out;
}

interface PlanFile {
  title: string;
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
  return { title: fm.title, intro: rest.slice(0, h).join("\n").trim(), steps: parseSteps(lines, end + 1 + h + 1) };
}

function serializePlanFile(p: { title: string; intro: string; steps: Ided[] }, eol: string): string {
  const lines = ["---", `title: ${oneLine(p.title)}`, "---"];
  if (p.intro) lines.push(...p.intro.split("\n"));
  lines.push("## Steps");
  p.steps.forEach((s, i) => {
    lines.push(`${i + 1}. [${s.id}] ${oneLine(s.action)}`);
    if (s.path) lines.push(`   path: ${s.path}`);
    if (s.expected) lines.push(`   expect: ${oneLine(s.expected)}`);
  });
  return lines.join(eol) + eol;
}

/* -------------------------------------------------------------------------- */
/* Files                                                                      */
/* -------------------------------------------------------------------------- */

const planFile = (root: string, slug: string): string => path.join(root, QA_DIR, `${slug}.md`);

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
function freshId(taken: Set<string>): string {
  for (;;) {
    const id = `s-${Array.from(crypto.randomBytes(4), (b) => ALPHABET[b % ALPHABET.length]).join("")}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

function load(root: string, slug: string): Plan {
  const file = planFile(root, slug);
  const id = slug as FeatureId;
  let text: string | null;
  try {
    text = readText(file);
  } catch (e) {
    return { feature: id, title: slug, intro: "", steps: [], problem: (e as Error).message };
  }
  if (text === null) throw new QaNotFound(`No plan "${slug}".`);
  let parsed: PlanFile;
  try {
    parsed = parsePlanFile(text);
  } catch (e) {
    return { feature: id, title: slug, intro: "", steps: [], problem: (e as Error).message };
  }
  const taken = new Set<string>(parsed.steps.flatMap((s) => (s.id ? [s.id] : [])));
  let changed = false;
  for (const s of parsed.steps) {
    if (s.id) continue;
    s.id = freshId(taken);
    changed = true;
  }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializePlanFile({ ...parsed, steps: parsed.steps as Ided[] }, eolOf(text)));
  }
  const steps: PlanStep[] = (parsed.steps as Ided[]).map((s) => ({ id: s.id as StepId, action: s.action, expected: s.expected, path: s.path }));
  return { feature: id, title: parsed.title, intro: parsed.intro, steps, problem: null };
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                 */
/* -------------------------------------------------------------------------- */

/** Reads a plan. Steps without an id get one, and the file is written back only when that changed it. */
export function readPlan(root: string, id: FeatureId): Plan {
  return load(root, id);
}

export function planText(root: string, id: FeatureId): string | null {
  try {
    return readText(planFile(root, id));
  } catch {
    return null;
  }
}

/** The plan of each feature in features.md that has one, and the plan files that belong to no feature. `*.proposals.md` is never read. */
export function listPlans(root: string): { byFeature: Map<FeatureId, Plan & { updatedAt: number }>; loose: QaBoard["plansWithoutFeature"] } {
  const byFeature = new Map<FeatureId, Plan & { updatedAt: number }>();
  const loose: QaBoard["plansWithoutFeature"] = [];
  let names: string[];
  try {
    names = fs.readdirSync(path.join(root, QA_DIR));
  } catch {
    return { byFeature, loose };
  }
  const known = new Set(readFeatures(root).features.map((f) => f.id as string));
  for (const n of names.sort()) {
    const m = /^(.+)\.md$/.exec(n);
    if (!m || m[1]!.endsWith(".proposals")) continue;
    const slug = m[1]!;
    const rel = `${QA_DIR}/${n}`;
    if (!SLUG.test(slug)) {
      loose.push({ slug, title: slug, steps: 0, problem: "the file name is not a plan name: use lowercase letters, digits and dashes", path: rel });
      continue;
    }
    const plan = load(root, slug);
    if (known.has(slug)) byFeature.set(slug as FeatureId, { ...plan, updatedAt: mtime(planFile(root, slug)) });
    else loose.push({ slug, title: plan.title, steps: plan.steps.length, problem: plan.problem, path: rel });
  }
  return { byFeature, loose };
}

/** The plan file's content hash, or null when there is none: what a plan job compares to see whether it wrote anything. */
export function planSignature(root: string, id: FeatureId): string | null {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(planFile(root, id))).digest("hex");
  } catch {
    return null;
  }
}

/** Deletes the plan file. Its runs go with it. */
export function removePlan(root: string, slug: string): void {
  if (!fs.existsSync(planFile(root, slug))) throw new QaNotFound(`No plan "${slug}".`);
  fs.rmSync(planFile(root, slug), { force: true });
  removeRuns(root, slug);
}
