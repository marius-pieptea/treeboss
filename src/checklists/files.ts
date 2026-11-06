/**
 * An attached checklist's state, as one file in the project: `lab/checklists/<id>.md`, the same spirit as ROADMAP.md. The
 * file is the data: a person can edit it, commit it or delete it (deleting it detaches the checklist).
 *
 *   ---
 *   id: marketing-site
 *   title: Marketing site
 *   attached_at: "2026-10-28T09:00:00.000Z"
 *   last_run: "2026-10-28T09:12:44.000Z"
 *   ---
 *   ## Metadata
 *   - [x] Meta title {#meta-title} (status: pass) (source: auto) (evidence: app/layout.tsx:12)
 *   - [ ] Meta description {#meta-description} (status: fail) (source: auto) (evidence: app/layout.tsx:14)
 *   - [x] Privacy page {#privacy-page} (status: na) (source: agent) (evidence: app/page.tsx:3) (reason: a single-page site)
 *   - [ ] Cookie banner {#cookie-banner} (status: unknown)
 *   - [ ] Staging smoke test {#staging-smoke} (status: unknown) (custom) (category: Metadata) (severity: required) (kind: agent) (hint: Hit /health on staging)
 *
 * The item lines are the answers. The checkbox mirrors the status (pass and na are ticked); the status field is what is read.
 * source says who answered: auto (a check), agent (checklist_record), manual (a person). The text, severity and hint come from
 * the catalog, so an item's line may be edited or left as it is. Ids are matched on {#id}, so a line can move under its heading.
 *
 * A `(custom)` line is a project-only item: it is not in the catalog, so its definition (category, severity, kind, hint) is on
 * the line. A line from before custom items parses as it always did; the fields are optional.
 *
 * Edits touch only the lines and keys they change: a run rewrites the lines of the items it answered and last_run, and
 * nothing else; a person's notes and lines it does not know stay as they are. reconcileChecklistFile() brings the file to a
 * changed definition: a removed item's line is dropped, a renamed or moved one is rewritten, and its answer is kept.
 * Writes go through a temporary file and a rename.
 */
import fs from "fs";
import path from "path";
import { parseFrontMatter, setKey, yamlScalar } from "../docs/frontmatter";
import { LAB_DIR } from "../lab/findings";
import type { Checklist, ChecklistItem, Severity } from "./catalog";

export const CHECKLIST_DIR = `${LAB_DIR}/checklists`;

export type FileStatus = "pass" | "fail" | "na" | "unknown";
export type FileSource = "auto" | "agent" | "manual";

/**
 * One item's answer as the file holds it. `message` is what a check or the screen judge said (one line); an agent's or a person's
 * answer has none. `reason` is what an agent said (why n/a, or what it saw); `note` is the operator's own, so neither overwrites the other.
 */
export interface ItemAnswer {
  status: FileStatus;
  source: FileSource | null;
  evidence: string | null;
  message: string | null;
  reason: string | null;
  note: string | null;
}

export const UNANSWERED: ItemAnswer = { status: "unknown", source: null, evidence: null, message: null, reason: null, note: null };

/** A project-only item's definition, as its line holds it. An agent or manual item: an auto item needs a check in the catalog. */
export type ProjectDef = Pick<ChecklistItem, "category" | "severity" | "hint"> & { kind: "agent" | "manual" };

export interface ChecklistFile {
  /** The checklist id (the file's name without .md). */
  id: string;
  attachedAt: string;
  lastRun: string | null;
  /** Answers by item id, for the items that have a line in the file (catalog and project-only). */
  answers: Map<string, ItemAnswer>;
  /** The project-only items, by id: their definitions. */
  projectItems: Map<string, ChecklistItem>;
  /** The items whose lines the read that returned this file removed (reconcile): no longer in the definition. Empty otherwise. */
  dropped: string[];
}

export const fileOf = (root: string, id: string): string => path.join(root, CHECKLIST_DIR, `${id}.md`);

const STATUSES: readonly FileStatus[] = ["pass", "fail", "na", "unknown"];
const SOURCES: readonly FileSource[] = ["auto", "agent", "manual"];
const PROJECT_KINDS: readonly string[] = ["agent", "manual"];
const SEVERITY_OF: readonly Severity[] = ["required", "recommended"];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** `- [x] Title {#id} (status: …) …`: the title and the id, then the fields in any order. */
const ITEM = /^- \[([ xX])\] (.*?) \{#([A-Za-z0-9._-]+)\}(.*)$/;
const KEYS = "status|source|evidence|message|reason|note|category|severity|kind|hint";
const FIELD_START = new RegExp(`^ \\((${KEYS}): `);
const CUSTOM_FLAG = /^ \(custom\)/;
/** A field ends at the `)` that comes before the next field or the end of the line, so a path may hold brackets. */
const FIELD_END = new RegExp(`\\)(?= \\((?:${KEYS}): | \\(custom\\)|\\s*$)`);

/** One line, with its newlines flattened: a field holds one line of text. */
const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** Splits the fields after `{#id}`. Unknown or malformed fields are ignored, so a hand edit never makes a line unreadable. */
function fieldsOf(tail: string): { fields: Record<string, string>; custom: boolean } {
  const fields: Record<string, string> = {};
  let custom = false;
  let rest = tail;
  for (;;) {
    const flag = CUSTOM_FLAG.exec(rest);
    if (flag) {
      custom = true;
      rest = rest.slice(flag[0].length);
      continue;
    }
    const m = FIELD_START.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
    const end = rest.search(FIELD_END);
    fields[m[1]!] = end < 0 ? rest.replace(/\)\s*$/, "") : rest.slice(0, end);
    if (end < 0) break;
    rest = rest.slice(end + 1);
  }
  return { fields, custom };
}

/** The definition a `(custom)` line carries. Missing parts get safe defaults, so a hand-written line still reads. */
function defOf(f: Record<string, string>): ProjectDef {
  return {
    category: str(f.category) ?? "Project",
    severity: (SEVERITY_OF as readonly string[]).includes(f.severity ?? "") ? (f.severity as Severity) : "recommended",
    kind: (PROJECT_KINDS as readonly string[]).includes(f.kind ?? "") ? (f.kind as ProjectDef["kind"]) : "manual",
    hint: str(f.hint) ?? "",
  };
}

/** The project-only definition of an item (a project item, as the checklist holds it). */
export const projectDefOf = (item: ChecklistItem): ProjectDef => ({ category: item.category, severity: item.severity, kind: item.kind === "agent" ? "agent" : "manual", hint: item.hint });

export interface ParsedItem {
  id: string;
  text: string;
  answer: ItemAnswer;
  /** Set on a project-only item's line only. */
  custom?: ProjectDef;
}

/** A line with no reason key keeps an agent's reason in its note: it reads as the reason. */
const answerOf = (a: ItemAnswer, hasReasonKey: boolean): ItemAnswer => (a.source === "agent" && !hasReasonKey && a.note ? { ...a, reason: a.note, note: null } : a);

/** The item a line answers, or null when the line is not an item (a heading, a blank line, prose). */
export function parseItemLine(line: string): ParsedItem | null {
  const m = ITEM.exec(line);
  if (!m) return null;
  const { fields: f, custom } = fieldsOf(m[4] ?? "");
  const status = (STATUSES as readonly string[]).includes(f.status ?? "") ? (f.status as FileStatus) : "unknown";
  const source = (SOURCES as readonly string[]).includes(f.source ?? "") ? (f.source as FileSource) : null;
  return {
    id: m[3]!,
    text: m[2]!.trim(),
    answer: answerOf({ status, source, evidence: str(f.evidence), message: str(f.message), reason: str(f.reason), note: str(f.note) }, f.reason !== undefined),
    ...(custom ? { custom: defOf(f) } : {}),
  };
}

/** The line for one item. Fields that are empty are left out. A project-only item carries its definition at the end. */
export function renderItemLine(text: string, id: string, a: ItemAnswer, custom: ProjectDef | null = null): string {
  const ticked = a.status === "pass" || a.status === "na" ? "x" : " ";
  let line = `- [${ticked}] ${oneLine(text)} {#${id}} (status: ${a.status})`;
  if (a.source) line += ` (source: ${a.source})`;
  if (a.evidence) line += ` (evidence: ${oneLine(a.evidence)})`;
  if (a.message) line += ` (message: ${oneLine(a.message)})`;
  if (a.reason) line += ` (reason: ${oneLine(a.reason)})`;
  if (a.note) line += ` (note: ${oneLine(a.note)})`;
  if (custom) {
    line += ` (custom) (category: ${oneLine(custom.category)}) (severity: ${custom.severity}) (kind: ${custom.kind})`;
    if (custom.hint) line += ` (hint: ${oneLine(custom.hint)})`;
  }
  return line;
}

/** A new file for a checklist: every item, unanswered unless `answers` says otherwise, under its category. */
export function renderChecklistFile(c: Checklist, attachedAt: string, answers: Map<string, ItemAnswer> = new Map(), lastRun: string | null = null): string {
  const out = ["---", `id: ${c.id}`, `title: ${yamlScalar(c.title)}`, `attached_at: ${yamlScalar(attachedAt)}`, `last_run: ${lastRun ? yamlScalar(lastRun) : ""}`, "---"];
  let category: string | null = null;
  for (const it of c.items) {
    if (it.category !== category) {
      category = it.category;
      out.push("", `## ${category}`);
    }
    out.push(renderItemLine(it.text, it.id, answers.get(it.id) ?? UNANSWERED, it.custom ? projectDefOf(it) : null));
  }
  return out.join("\n") + "\n";
}

/** The state of an attached checklist's file, or null when the checklist has no file (it is not attached). */
export function readChecklistFile(root: string, id: string): ChecklistFile | null {
  let text: string;
  try {
    text = fs.readFileSync(fileOf(root, id), "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontMatter(text);
  const answers = new Map<string, ItemAnswer>();
  const projectItems = new Map<string, ChecklistItem>();
  for (const line of fm.body.split(/\r?\n/)) {
    const p = parseItemLine(line);
    if (!p || answers.has(p.id)) continue;
    answers.set(p.id, p.answer);
    if (p.custom) projectItems.set(p.id, { id: p.id, text: p.text, custom: true, ...p.custom });
  }
  return { id, attachedAt: str(fm.data.attached_at) ?? "", lastRun: str(fm.data.last_run), answers, projectItems, dropped: [] };
}

/** Writes a file through a temporary name and a rename, so a crash never leaves half a checklist. */
export function writeAtomic(abs: string, text: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, abs);
}

/** Creates the file for a newly attached checklist. A file that is already there (a person made it, or committed it) is kept. */
export function createChecklistFile(root: string, c: Checklist, attachedAt: string, answers: Map<string, ItemAnswer> = new Map()): boolean {
  if (fs.existsSync(fileOf(root, c.id))) return false;
  writeAtomic(fileOf(root, c.id), renderChecklistFile(c, attachedAt, answers));
  return true;
}

export function removeChecklistFile(root: string, id: string): boolean {
  try {
    fs.rmSync(fileOf(root, id));
    return true;
  } catch {
    return false;
  }
}

const trimEnd = (lines: string[]): string[] => {
  const out = [...lines];
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out;
};

/** A line goes under its category's heading, after the last item of that category (or after the heading). A new heading goes at the end. */
function insertUnder(lines: string[], category: string, line: string): string[] {
  const heading = lines.findIndex((l) => l.trim() === `## ${category}`);
  if (heading < 0) return [...trimEnd(lines), "", `## ${category}`, line, ""];
  let end = heading;
  for (let i = heading + 1; i < lines.length && !lines[i]!.startsWith("## "); i++) if (parseItemLine(lines[i]!)) end = i;
  lines.splice(end + 1, 0, line);
  return lines;
}

/**
 * Writes new answers for some items, changing only their lines (and last_run when given). An item whose line is missing
 * (a person removed it) gets a new line under its category. Lines of other items, and everything else in the file, are kept.
 */
export function patchChecklistFile(root: string, c: Checklist, updates: Map<string, ItemAnswer>, lastRun?: string): void {
  const abs = fileOf(root, c.id);
  const raw = fs.readFileSync(abs, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  let lines = raw.split(/\r?\n/);
  for (const [id, answer] of updates) {
    const item = c.items.find((i) => i.id === id);
    if (!item) continue;
    const at = lines.findIndex((l) => parseItemLine(l)?.id === id);
    if (at >= 0) {
      const p = parseItemLine(lines[at]!)!;
      lines[at] = renderItemLine(p.text || item.text, id, answer, p.custom);
      continue;
    }
    lines = insertUnder(lines, item.category, renderItemLine(item.text, id, answer, item.custom ? projectDefOf(item) : null));
  }
  let text = lines.join(eol);
  if (lastRun) text = setKey(text, "last_run", lastRun);
  writeAtomic(abs, text.endsWith("\n") ? text : text + eol);
}

/** Adds the line of an item the file does not have yet (a project-only item, or a catalog item a person removed). */
export function addItemLine(root: string, checklistId: string, item: ChecklistItem): void {
  const abs = fileOf(root, checklistId);
  const raw = fs.readFileSync(abs, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const line = renderItemLine(item.text, item.id, UNANSWERED, item.custom ? projectDefOf(item) : null);
  const text = insertUnder(raw.split(/\r?\n/), item.category, line).join(eol);
  writeAtomic(abs, text.endsWith("\n") ? text : text + eol);
}

/** Drops one item's line. Returns false when the file has no such line. */
export function removeItemLine(root: string, checklistId: string, itemId: string): boolean {
  const abs = fileOf(root, checklistId);
  const raw = fs.readFileSync(abs, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const at = lines.findIndex((l) => parseItemLine(l)?.id === itemId);
  if (at < 0) return false;
  lines.splice(at, 1);
  writeAtomic(abs, lines.join(eol));
  return true;
}

/**
 * Brings a file in line with the checklist's definition, changing only the lines that need it. A catalog item the definition no
 * longer has is dropped, and so is a second line for the same item. A changed text is rewritten and a changed category moves the
 * line under its new heading, both keeping the answer. A new item gets an unanswered line. Project-only lines are kept as they are.
 * The title follows the definition. Writes only when something changed. Returns the file as it reads after; null when there is none.
 */
export function reconcileChecklistFile(root: string, c: Checklist): ChecklistFile | null {
  const abs = fileOf(root, c.id);
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const want = new Map(c.items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const moved: Array<{ line: string; category: string }> = [];
  let lines: string[] = [];
  let heading: string | null = null;
  let changed = false;
  const dropped: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const h = /^## (.*)$/.exec(line);
    if (h) {
      heading = h[1]!.trim();
      lines.push(line);
      continue;
    }
    const p = parseItemLine(line);
    if (!p || p.custom) {
      lines.push(line);
      continue;
    }
    const item = want.get(p.id);
    if (!item || seen.has(p.id)) {
      changed = true;
      if (!item) dropped.push(p.id);
      continue;
    }
    seen.add(p.id);
    if (heading !== item.category) {
      changed = true;
      moved.push({ line: renderItemLine(item.text, p.id, p.answer), category: item.category });
    } else if (p.text !== oneLine(item.text)) {
      changed = true;
      lines.push(renderItemLine(item.text, p.id, p.answer));
    } else lines.push(line);
  }
  for (const item of c.items) {
    if (seen.has(item.id)) continue;
    changed = true;
    moved.push({ line: renderItemLine(item.text, item.id, UNANSWERED), category: item.category });
  }
  for (const m of moved) lines = insertUnder(lines, m.category, m.line);
  let text = lines.join(eol);
  if (parseFrontMatter(raw).data.title !== c.title) {
    text = setKey(text, "title", c.title);
    changed = true;
  }
  if (changed) writeAtomic(abs, text.endsWith("\n") ? text : text + eol);
  const file = readChecklistFile(root, c.id);
  return file && { ...file, dropped };
}
