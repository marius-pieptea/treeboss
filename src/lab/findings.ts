/**
 * Lab findings: one markdown file each under `lab/findings/`, written by the agent that ran a Lab pass.
 *
 *   ---
 *   title: Debounce the session search box
 *   lens: perf
 *   scope: web/src/features/search
 *   impact: medium            high | medium | low
 *   effort: s                 s | m | l
 *   status: new               new | accepted | dismissed | shipped
 *   evidence:
 *     - web/src/features/search/SearchPanel.tsx:84
 *   unmeasured: true          perf only: a reading of the code, no number behind it
 *   roadmap: r12              set when the finding was sent to the roadmap
 *   spec: specs/106-search    set when a spec was started from it
 *   checklist: marketing-site/meta-title   set on a finding raised by a failing launch checklist item (lens: checklist)
 *   session: s_3f2a…          stamped by the run that wrote or changed the file
 *   fix_session: s_9b1c…      the fix session started from it
 *   evidence_hashes:          written at the end of a run: "path:line=hash8", so a moved or edited line shows as drifted
 *     - "web/src/features/search/SearchPanel.tsx:84=1a2b3c4d"
 *   ---
 *   What is wrong, why it matters, and the first step. Free markdown.
 *
 * The file is the data (like ROADMAP.md): a person can edit it, commit it or delete it. Writing one key goes
 * through `setKey`, which leaves every other byte alone. A file that cannot be read or is too big is still listed,
 * flagged as a problem, so nothing disappears silently.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { parseFrontMatter, setKey, summaryLine, yamlScalar } from "../docs/frontmatter";

export const LAB_DIR = "lab";
export const FINDINGS_DIR = `${LAB_DIR}/findings`;
/** A finding file bigger than this is not read: it is listed with a problem instead. */
export const MAX_FINDING_BYTES = 200_000;

/** `checklist` is a pass that verifies launch checklist items (checklists/plan.ts). It is not picked by hand: the checklist panel starts it. */
export const LENSES = ["features", "ui", "ux", "ai", "perf", "dx", "review", "security", "checklist", "bug"] as const;
export type Lens = (typeof LENSES)[number];
export const IMPACTS = ["high", "medium", "low"] as const;
export const EFFORTS = ["s", "m", "l"] as const;
export const STATUSES = ["new", "accepted", "dismissed", "shipped"] as const;
export type Impact = (typeof IMPACTS)[number];
export type Effort = (typeof EFFORTS)[number];
export type Status = (typeof STATUSES)[number];
/** `bug` findings are logged from the built-in browser (lab/capture.ts), not found by a run. */
export const SHOT_KINDS = ["desktop", "rerender", "none"] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];
/** functional: something does not work; visual: layout or styling; logic: wrong data or result; content: copy, text, images; performance: slow or janky. */
export const BUG_KINDS = ["functional", "visual", "logic", "content", "performance"] as const;
export type BugKind = (typeof BUG_KINDS)[number];

export interface BugInfo {
  url: string;
  /** The evidence item id of the page capture, when one was saved. */
  capture: string | null;
  shot: ShotKind;
  kind: BugKind;
}

export interface Finding {
  /** The file's name without `.md`. */
  id: string;
  /** Workspace-relative path. */
  path: string;
  title: string;
  lens: Lens | null;
  scope: string | null;
  impact: Impact;
  effort: Effort;
  status: Status;
  evidence: string[];
  /** Evidence that points at a file which no longer exists: the code moved on, so the finding may be out of date. */
  missing: string[];
  /** Evidence whose line changed since the run that cited it (its hash no longer matches). */
  drifted: string[];
  /** "path:line" -> hash of that line, as the last run that cited it saw it. */
  evidenceHashes: Record<string, string>;
  unmeasured: boolean;
  roadmap: string | null;
  spec: string | null;
  /** `<checklistId>/<itemId>` for a finding raised by a failing checklist item: one finding per item. */
  checklist: string | null;
  /** Set exactly when `lens` is `bug`. */
  bug: BugInfo | null;
  /** The session that wrote or last changed the file during a run. */
  session: string | null;
  /** The fix session started from this finding. */
  fixSession: string | null;
  /** The first line of the body. */
  summary: string;
  body: string;
  /** Modified time of the file, ms. */
  updatedAt: number;
  /** Why the file is flagged: the front matter does not parse, a value is wrong, or the file could not be read. */
  problem: string | null;
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (typeof v === "string" && (list as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as T) : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

export function findingsDir(rootDir: string): string {
  return path.join(rootDir, FINDINGS_DIR);
}

/** The file part of `path/to/file.ts:84`, or null when the evidence is prose ("bundle is 2.1 MB") or leaves the project. */
export function evidencePath(e: string): string | null {
  const m = /^([^\s:#][^\s:#]*?)(?:[:#]L?\d+)?(?::\d+)?(?:-\d+)?$/.exec(e.trim());
  return m && /[./]/.test(m[1]!) && !path.isAbsolute(m[1]!) && !m[1]!.split(/[\\/]/).includes("..") ? m[1]! : null;
}

/** The file and line an evidence entry points at, or null when it names no line. */
export function lineOf(e: string): { file: string; line: number } | null {
  const m = /^(.+?)[:#]L?(\d+)(?:-\d+)?$/.exec(e.trim());
  const file = m ? evidencePath(m[1]!) : null;
  return m && file ? { file, line: Number(m[2]) } : null;
}

/** Eight hex digits of a line's content, surrounding whitespace ignored: enough to tell that a line changed. */
export const hashText = (s: string): string => crypto.createHash("sha1").update(s.trim()).digest("hex").slice(0, 8);

/** The current hash of the line an evidence entry names, or null when the file or the line is not there. */
function currentHash(rootDir: string, e: string): string | null {
  const ref = lineOf(e);
  if (!ref) return null;
  try {
    const text = fs.readFileSync(path.join(rootDir, ref.file), "utf8").split(/\r?\n/)[ref.line - 1];
    return text === undefined ? null : hashText(text);
  } catch {
    return null;
  }
}

/** "path:line=hash" for each evidence line that exists now: what a run stores when it ends. */
export function evidenceHashesNow(rootDir: string, evidence: string[]): string[] {
  return evidence.flatMap((e) => {
    const h = currentHash(rootDir, e);
    return h ? [`${e}=${h}`] : [];
  });
}

/** Fills in what depends on the project's files: which evidence is gone, and which evidence line changed since it was cited. */
function withState(f: Finding, rootDir: string): Finding {
  const missing: string[] = [];
  const drifted: string[] = [];
  for (const e of f.evidence) {
    const p = evidencePath(e);
    if (p === null) continue;
    if (!fs.existsSync(path.join(rootDir, p))) {
      missing.push(e);
      continue;
    }
    const was = f.evidenceHashes[e];
    if (was && currentHash(rootDir, e) !== was) drifted.push(e);
  }
  return { ...f, missing, drifted };
}

/** A listing entry for a file that is not read (too big, unreadable): it is shown, flagged, and never edited. */
function problemEntry(rel: string, problem: string, updatedAt = 0): Finding {
  const id = path.basename(rel, ".md");
  return { id, path: rel, title: id, lens: null, scope: null, impact: "medium", effort: "m", status: "new", evidence: [], missing: [], drifted: [], evidenceHashes: {}, unmeasured: false, roadmap: null, spec: null, checklist: null, bug: null, session: null, fixSession: null, summary: "", body: "", updatedAt, problem };
}

export function parseFinding(rel: string, text: string, updatedAt = 0, rootDir?: string): Finding {
  const fm = parseFrontMatter(text);
  const d = fm.data;
  const id = path.basename(rel, ".md");
  const warnings: string[] = [];
  // An absent key is the default; a present key the parser cannot read falls back, and the file says so in `problem`.
  const pick = <T extends string>(list: readonly T[], key: string, fallback: T): T => {
    const v = d[key];
    if (v === undefined || v === null || v === "") return fallback;
    const got = oneOf(list, v, fallback);
    if (got === fallback && String(v).trim().toLowerCase() !== fallback) warnings.push(`${key} "${String(v).trim()}" is not one of ${list.join(", ")}: read as ${fallback}.`);
    return got;
  };
  const evidence = Array.isArray(d.evidence) ? d.evidence.map((x) => String(x).trim()).filter(Boolean) : typeof d.evidence === "string" && d.evidence.trim() ? [d.evidence.trim()] : [];
  const title = strOrNull(d.title);
  const lensRaw = strOrNull(d.lens);
  const lens = lensRaw && (LENSES as readonly string[]).includes(lensRaw) ? (lensRaw as Lens) : null;
  if (lensRaw && !lens) warnings.push(`lens "${lensRaw}" is not one of ${LENSES.join(", ")}.`);
  const url = strOrNull(d.url);
  const bug: BugInfo | null = lens === "bug" ? { url: url ?? "", capture: strOrNull(d.capture), shot: pick(SHOT_KINDS, "shot", "none"), kind: oneOf(BUG_KINDS, d.kind, "functional") } : null;
  if (bug && !url) warnings.push("A bug needs a url in the front matter.");
  const evidenceHashes: Record<string, string> = {};
  for (const h of Array.isArray(d.evidence_hashes) ? d.evidence_hashes : []) {
    const m = /^(.*)=([0-9a-f]{8})$/.exec(String(h).trim());
    if (m) evidenceHashes[m[1]!] = m[2]!;
  }
  const base: Finding = {
    id,
    path: rel,
    title: title ?? id,
    lens,
    scope: strOrNull(d.scope),
    impact: pick(IMPACTS, "impact", "medium"),
    effort: pick(EFFORTS, "effort", "m"),
    status: pick(STATUSES, "status", "new"),
    evidence,
    missing: [],
    drifted: [],
    evidenceHashes,
    unmeasured: d.unmeasured === true,
    roadmap: strOrNull(d.roadmap),
    spec: strOrNull(d.spec),
    checklist: strOrNull(d.checklist),
    bug,
    session: strOrNull(d.session),
    fixSession: strOrNull(d.fix_session),
    summary: summaryLine(fm.body),
    body: fm.body.trim(),
    updatedAt,
    problem: null,
  };
  // After the fields: the picks above add their warnings as they read.
  const problems = [fm.error ? `The front matter does not parse: ${fm.error}` : null, title ? null : "No title in the front matter.", ...warnings].filter((p): p is string => !!p);
  base.problem = problems.length ? problems.join(" ") : null;
  return rootDir ? withState(base, rootDir) : base;
}

/** Parsed files by absolute path, kept while their mtime and size stay the same: a poll reads only what changed. */
const parsed = new Map<string, { mtimeMs: number; size: number; base: Finding }>();

/** Every finding in the project, best first: open before closed, then impact over effort, then newest. */
export function listFindings(rootDir: string): Finding[] {
  const dir = findingsDir(rootDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".md") && !n.startsWith("."));
  } catch {
    return [];
  }
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const abs = path.join(dir, n);
    const rel = `${FINDINGS_DIR}/${n}`;
    seen.add(abs);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch (err) {
      out.push(problemEntry(rel, `The file could not be read: ${(err as Error).message.split("\n")[0]}.`));
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FINDING_BYTES) {
      out.push(problemEntry(rel, `The file is ${Math.round(st.size / 1000)} KB, over the ${MAX_FINDING_BYTES / 1000} KB limit, so it is not read.`, st.mtimeMs));
      continue;
    }
    const hit = parsed.get(abs);
    let base: Finding;
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) base = hit.base;
    else {
      try {
        base = parseFinding(rel, fs.readFileSync(abs, "utf8"), st.mtimeMs);
      } catch (err) {
        out.push(problemEntry(rel, `The file could not be read: ${(err as Error).message.split("\n")[0]}.`, st.mtimeMs));
        continue;
      }
      parsed.set(abs, { mtimeMs: st.mtimeMs, size: st.size, base });
    }
    out.push(withState(base, rootDir));
  }
  for (const k of [...parsed.keys()]) if (k.startsWith(dir) && !seen.has(k)) parsed.delete(k);
  return out.sort(compareFindings);
}

export const CLOSED: Status[] = ["dismissed", "shipped"];
const IMPACT_W: Record<Impact, number> = { high: 3, medium: 2, low: 1 };
const EFFORT_W: Record<Effort, number> = { s: 1, m: 2, l: 3 };

/** Higher is better: what pays off most for the least work. */
export const payoff = (f: Pick<Finding, "impact" | "effort">): number => IMPACT_W[f.impact] / EFFORT_W[f.effort];

export function compareFindings(a: Finding, b: Finding): number {
  const closed = Number(CLOSED.includes(a.status)) - Number(CLOSED.includes(b.status));
  if (closed) return closed;
  return payoff(b) - payoff(a) || IMPACT_W[b.impact] - IMPACT_W[a.impact] || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

function fileOf(rootDir: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(id) || id.includes("..")) throw new UserError(`"${id}" is not a finding id.`);
  return path.join(findingsDir(rootDir), `${id}.md`);
}

export function readFinding(rootDir: string, id: string): Finding {
  const abs = fileOf(rootDir, id);
  let text: string;
  let mtime: number;
  try {
    text = fs.readFileSync(abs, "utf8");
    mtime = fs.statSync(abs).mtimeMs;
  } catch {
    throw new UserError(`There is no finding "${id}".`);
  }
  return parseFinding(`${FINDINGS_DIR}/${id}.md`, text, mtime, rootDir);
}

export interface FindingPatch {
  status?: Status;
  impact?: Impact;
  effort?: Effort;
  roadmap?: string | null;
  spec?: string | null;
  session?: string | null;
  fix_session?: string | null;
  evidence_hashes?: string[] | null;
}

function writeText(abs: string, text: string): void {
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, abs);
}

/**
 * Ships the open findings (not shipped, not dismissed) raised by a checklist's items, for items that no longer fail or no longer
 * exist. `keep` names the items whose findings stay open. A dismissal is the operator's and is left as it is.
 */
export function shipChecklistFindings(rootDir: string, checklistId: string, keep: (itemId: string) => boolean = () => false): void {
  for (const f of listFindings(rootDir)) {
    const [cid, ...item] = (f.checklist ?? "").split("/");
    if (cid !== checklistId || f.status === "shipped" || f.status === "dismissed" || keep(item.join("/"))) continue;
    patchFinding(rootDir, f.id, { status: "shipped" });
  }
}

/** Change a few keys of a finding in place. `null` removes a link. */
export function patchFinding(rootDir: string, id: string, patch: FindingPatch): Finding {
  const abs = fileOf(rootDir, id);
  readFinding(rootDir, id);
  if (patch.status !== undefined && !(STATUSES as readonly string[]).includes(patch.status)) throw new UserError(`Status must be one of ${STATUSES.join(", ")}.`);
  if (patch.impact !== undefined && !(IMPACTS as readonly string[]).includes(patch.impact)) throw new UserError(`Impact must be one of ${IMPACTS.join(", ")}.`);
  if (patch.effort !== undefined && !(EFFORTS as readonly string[]).includes(patch.effort)) throw new UserError(`Effort must be one of ${EFFORTS.join(", ")}.`);
  let text = fs.readFileSync(abs, "utf8");
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) text = setKey(text, k, v === null ? undefined : v);
  writeText(abs, text);
  return readFinding(rootDir, id);
}

/** Appends a note to the body of a finding, once: a note already there is not added again. */
export function noteFinding(rootDir: string, id: string, note: string): void {
  const abs = fileOf(rootDir, id);
  const text = fs.readFileSync(abs, "utf8");
  if (text.includes(note)) return;
  writeText(abs, `${text.replace(/\s*$/, "")}\n\n${note}\n`);
}

export interface FindingFields {
  title: string;
  lens: Lens;
  scope: string;
  impact: Impact;
  effort: Effort;
  status: Status;
  evidence: string[];
  checklist?: string | null;
  roadmap?: string | null;
  spec?: string | null;
  bug?: BugInfo;
}

/**
 * Writes a whole finding file from typed fields, for a finding a tool raises (a failing checklist item) rather than an agent
 * writing its own file. The values are the ones the parser accepts, so the file always reads back with no problem.
 */
export function writeFinding(rootDir: string, id: string, f: FindingFields, body: string): Finding {
  const abs = fileOf(rootDir, id);
  const head = [
    "---",
    `title: ${yamlScalar(f.title)}`,
    `lens: ${f.lens}`,
    `scope: ${yamlScalar(f.scope)}`,
    `impact: ${f.impact}`,
    `effort: ${f.effort}`,
    `status: ${f.status}`,
    ...(f.evidence.length ? ["evidence:", ...f.evidence.map((e) => `  - ${yamlScalar(e)}`)] : ["evidence: []"]),
    ...(f.checklist ? [`checklist: ${yamlScalar(f.checklist)}`] : []),
    ...(f.roadmap ? [`roadmap: ${yamlScalar(f.roadmap)}`] : []),
    ...(f.spec ? [`spec: ${yamlScalar(f.spec)}`] : []),
    ...(f.bug ? [`url: ${yamlScalar(f.bug.url)}`, ...(f.bug.capture ? [`capture: ${yamlScalar(f.bug.capture)}`] : []), `shot: ${f.bug.shot}`, `kind: ${f.bug.kind}`] : []),
    "---",
  ];
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  writeText(abs, `${head.join("\n")}\n${body.trim()}\n`);
  return readFinding(rootDir, id);
}

export interface BugInput {
  title: string;
  body: string;
  bug: BugInfo;
  impact: Impact;
  effort: Effort;
}

/** Writes a new `bug` finding under a fresh id made from the title, and returns it as read back. */
export function createBugFinding(rootDir: string, i: BugInput): Finding {
  const slug = i.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "bug";
  let id = `bug-${slug}`;
  for (let n = 2; fs.existsSync(fileOf(rootDir, id)); n++) id = `bug-${slug}-${n}`;
  return writeFinding(rootDir, id, { title: i.title, lens: "bug", scope: i.bug.url, impact: i.impact, effort: i.effort, status: "new", evidence: [], bug: i.bug }, i.body);
}

/** Delete a finding file. */
export function removeFinding(rootDir: string, id: string): void {
  readFinding(rootDir, id);
  fs.rmSync(fileOf(rootDir, id));
}

/** Enough of the prior findings for a run's prompt. Dismissed and shipped ones are listed in full, under a character budget. */
export const PRIOR_BUDGET = { dismissed: 6000, shipped: 3000 };

/** Lines from `list` (in order) that fit the budget; the rest are counted, not listed. */
function within(list: Finding[], budget: number, line: (f: Finding) => string): { text: string; omitted: number } {
  const out: string[] = [];
  let used = 0;
  for (const f of list) {
    const l = line(f);
    if (used + l.length > budget) break;
    out.push(l);
    used += l.length + 1;
  }
  return { text: out.join("\n"), omitted: list.length - out.length };
}

/**
 * What a run is told about earlier findings, so it does not propose them again. Open ones by id and title (capped); dismissed
 * and shipped ones as one line each (title and first evidence path), most recent first, under PRIOR_BUDGET. A repeat matches
 * a finding by its title or its evidence, not only its id.
 */
export function priorFindingsBlock(rootDir: string, max = 60): string {
  const all = listFindings(rootDir);
  if (!all.length) return "";
  const line = (f: Finding) => `- ${f.id}: ${f.title}${f.scope ? ` (${f.scope})` : ""}`;
  const brief = (f: Finding) => `- ${f.title}${f.evidence[0] ? ` — ${f.evidence[0]}` : ""}`;
  const byRecent = (a: Finding, b: Finding) => b.updatedAt - a.updatedAt;
  const open = all.filter((f) => !CLOSED.includes(f.status));
  const dismissed = within(all.filter((f) => f.status === "dismissed").sort(byRecent), PRIOR_BUDGET.dismissed, brief);
  const shipped = within(all.filter((f) => f.status === "shipped").sort(byRecent), PRIOR_BUDGET.shipped, brief);
  const more = (n: number) => (n ? `\n…and ${n} older, not listed.` : "");
  const parts: string[] = [];
  if (open.length) parts.push(`Already open, do not repeat (add to the file only if you have new evidence):\n${open.slice(0, max).map(line).join("\n")}`);
  if (dismissed.text) parts.push(`Dismissed by the operator, never propose these again or anything close to them. A repeat matches a title or an evidence path below:\n${dismissed.text}${more(dismissed.omitted)}`);
  if (shipped.text) parts.push(`Already shipped. Do not propose these again either:\n${shipped.text}${more(shipped.omitted)}`);
  return parts.join("\n\n");
}
