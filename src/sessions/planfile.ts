/**
 * A plan, as a file. `plan_submit` hands the daemon the plan; the daemon writes it to the workspace as markdown
 * (the agent never does: it is read-only while planning), and from then on the FILE is the source of truth.
 * The database row keeps only metadata about it (path, version, status, a hash of what was written).
 *
 *   plans/2026-10-08-add-csv-export.md
 *
 *   ---
 *   title: "Add CSV export"
 *   session: s_ab12cd
 *   created: 2026-10-08T09:30:00.000Z
 *   status: draft            draft | approved | rejected | superseded
 *   mode: quick              quick | spec
 *   version: 1
 *   promoted: specs/003-add-csv-export      (only once promoted)
 *   ---
 *   # Add CSV export
 *   <summary> ## Decisions ## Steps ## Risks ## Open questions ## Changelog
 *
 * Status changes rewrite one front matter line and leave everything else byte for byte, so a person's edits
 * to the body are never touched by bookkeeping.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { UserError } from "../util";
import { safeJoin, RootError } from "../workspaces";
import { plansDirOf } from "./plansdir";
import type { PlanStep } from "./planq";

export type PlanStatus = "draft" | "approved" | "rejected" | "superseded";
export type PlanDepth = "quick" | "spec";

export interface PlanMeta {
  title: string;
  session: string;
  created: string;
  status: PlanStatus;
  mode: PlanDepth;
  version: number;
  promoted?: string | null;
}

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/* -------------------------------------------------------------------------- */
/* Front matter                                                               */
/* -------------------------------------------------------------------------- */

const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface Parsed {
  meta: Record<string, string>;
  /** Everything after the front matter, untouched. */
  body: string;
  hasFrontMatter: boolean;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {}
  }
  return t;
}

export function parsePlanText(text: string): Parsed {
  const m = FM.exec(text);
  if (!m) return { meta: {}, body: text, hasFrontMatter: false };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    // A trailing "  # comment" is ours to ignore; JSON-quoted values keep theirs.
    let val = line.slice(i + 1).trim();
    if (!val.startsWith('"')) val = val.replace(/\s+#.*$/, "");
    meta[key] = unquote(val);
  }
  return { meta, body: text.slice(m[0].length), hasFrontMatter: true };
}

const needsQuotes = (v: string) => v === "" || /[:#"'\n]|^\s|\s$/.test(v);
const fmValue = (v: string | number): string => (typeof v === "number" ? String(v) : needsQuotes(v) ? JSON.stringify(v) : v);

export function frontMatter(meta: PlanMeta): string {
  const lines = [`title: ${JSON.stringify(meta.title)}`, `session: ${fmValue(meta.session)}`, `created: ${fmValue(meta.created)}`, `status: ${meta.status}`, `mode: ${meta.mode}`, `version: ${meta.version}`];
  if (meta.promoted) lines.push(`promoted: ${fmValue(meta.promoted)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Change (or add, or with null remove) one front matter key and touch nothing else. A file with no front matter is returned as is. */
export function setMeta(text: string, key: string, value: string | number | null): string {
  const m = FM.exec(text);
  if (!m) return text;
  const eol = m[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => l.slice(0, Math.max(0, l.indexOf(":"))).trim() === key);
  if (value === null) {
    if (at >= 0) lines.splice(at, 1);
  } else {
    const line = `${key}: ${key === "title" ? JSON.stringify(String(value)) : fmValue(value)}`;
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  const tail = m[0].endsWith("\n") ? eol : "";
  return `---${eol}${lines.join(eol)}${eol}---${tail}${text.slice(m[0].length)}`;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

export interface PlanContent {
  title: string;
  summary: string;
  steps: PlanStep[];
  risks: string[];
  open_questions: string[];
  /** "Question: answer" lines from the questionnaire. */
  decisions: string[];
  /** Spec depth: carried into spec.md, shown here too so plan.md stands alone. */
  requirements?: string[];
  success_criteria?: string[];
  changelog: string[];
}

export function renderPlanBody(p: PlanContent): string {
  const out: string[] = [`# ${p.title}`];
  if (p.summary) out.push("", p.summary);
  if (p.decisions.length) out.push("", "## Decisions", "", ...p.decisions.map((d) => `- ${d}`));
  out.push("", "## Steps", "");
  p.steps.forEach((st, i) => {
    out.push(`${i + 1}. **${st.title}**`);
    if (st.detail) out.push(...st.detail.split("\n").map((l) => (l.trim() ? `   ${l}` : "")));
    if (st.files?.length) out.push(`   Files: ${st.files.map((f) => `\`${f}\``).join(", ")}`);
  });
  if (p.requirements?.length) out.push("", "## Requirements", "", ...p.requirements.map((r) => `- ${r}`));
  if (p.success_criteria?.length) out.push("", "## Success criteria", "", ...p.success_criteria.map((r) => `- ${r}`));
  if (p.risks.length) out.push("", "## Risks", "", ...p.risks.map((r) => `- ${r}`));
  if (p.open_questions.length) out.push("", "## Open questions", "", ...p.open_questions.map((r) => `- ${r}`));
  if (p.changelog.length) out.push("", "## Changelog", "", ...p.changelog.map((c) => `- ${c}`));
  return `${out.join("\n")}\n`;
}

export function renderPlanFile(meta: PlanMeta, content: PlanContent): string {
  return frontMatter(meta) + renderPlanBody(content);
}

/** Hash of the body alone: bookkeeping that rewrites a front matter line must not look like an edit. */
export const bodySha = (text: string): string => sha(parsePlanText(text).body);

/** The entries under `## Changelog`, so a revision in place keeps the history. */
export function changelogOf(text: string): string[] {
  const body = parsePlanText(text).body;
  const m = /^##\s+Changelog\s*$/im.exec(body);
  if (!m) return [];
  const rest = body.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest)
    .split(/\r?\n/)
    .map((l) => /^[-*]\s+(.*)$/.exec(l.trim())?.[1]?.trim() ?? "")
    .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/* Files                                                                      */
/* -------------------------------------------------------------------------- */

const SPEC_PLAN = /^specs\/[^/]+\/plan\.md$/;

/** A plan file lives under the plans folder, or is a spec feature's plan.md. Anything else is refused. */
export function guardPlanPath(rootDir: string, rel: string): string {
  const cleaned = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned) throw new RootError("A plan path is required.");
  const parts = cleaned.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) throw new RootError("Path escapes the plans folder.", 403);
  const dir = plansDirOf(rootDir);
  if (!(cleaned.startsWith(`${dir}/`) && cleaned.endsWith(".md")) && !SPEC_PLAN.test(cleaned)) throw new RootError(`Plans live in ${dir}/ (or a spec feature's plan.md).`, 403);
  safeJoin(rootDir, cleaned);
  return cleaned;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

/** `plans/YYYY-MM-DD-short-name.md`, with -2, -3… when the name is taken. Nothing is created. */
export function newPlanPath(rootDir: string, title: string, date = new Date()): string {
  const dir = plansDirOf(rootDir);
  const day = date.toISOString().slice(0, 10);
  const base = `${day}-${slug(title) || "plan"}`;
  for (let n = 1; n < 1000; n++) {
    const rel = `${dir}/${base}${n === 1 ? "" : `-${n}`}.md`;
    if (!fs.existsSync(safeJoin(rootDir, rel))) return rel;
  }
  throw new UserError("Too many plans with that name.");
}

export function readPlanFile(rootDir: string, rel: string): { text: string; mtime: number } | null {
  try {
    const abs = safeJoin(rootDir, guardPlanPath(rootDir, rel));
    return { text: fs.readFileSync(abs, "utf-8"), mtime: fs.statSync(abs).mtimeMs };
  } catch {
    return null;
  }
}

/** Write (creating the folder the first time a plan lands). Returns the hash of what was written. */
export function writePlanFile(rootDir: string, rel: string, text: string): { path: string; sha: string; mtime: number } {
  const p = guardPlanPath(rootDir, rel);
  const abs = safeJoin(rootDir, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return { path: p, sha: sha(text), mtime: fs.statSync(abs).mtimeMs };
}
