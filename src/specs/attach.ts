/**
 * Specs attached to a session, and what happens around its turns because of them.
 *
 * The database holds only the link (which session has which path attached, and how); the content stays in
 * the files. Two modes:
 *   ref     (default)  a short block per attachment: where it is, its title, task progress, a few lines of
 *                      summary, and the instruction to read the files on demand. Cheap on every session.
 *   inline             the file text itself, up to a size cap, for a short spec the agent must not miss.
 *
 * An attachment is delivered once: the next turn after attaching carries the block, a resumed engine
 * session already has it after that. Re-attaching (or changing the mode) delivers it again.
 *
 * After a turn, `specsAfterTurn` keeps the checkboxes honest: ids the agent reports as done
 * (`TASKS_DONE: T001, T002`) are ticked in tasks.md if the agent did not tick them itself, and an
 * architecture discussion that was just approved is put back into plan mode with a check that only spec
 * files changed.
 */
import fs from "fs";
import path from "path";
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { UserError } from "../util";
import { appendLog, getSession, type SessionRecord } from "../sessions/manager";
import { Hub } from "../sessions/hub";
import { CONSTITUTION_PATH } from "./templates";
import { plansDirOf } from "../sessions/plansdir";
import { type FeatureInfo, guardSpecPath, listFeatures } from "./store";
import { parseTasks, reportedDone, tickIds } from "./tasks";

export type AttachMode = "ref" | "inline";
export type AttachPurpose = "context" | "architecture" | "implement" | "head" | "step";

export interface SessionSpec {
  session_id: string;
  spec_path: string;
  mode: AttachMode;
  purpose: AttachPurpose;
  delivered: boolean;
  /** architecture sessions: "discussing" | "writing" */
  state: string | null;
  created_at: string;
}

export const INLINE_FILE_CAP = 24_000;
export const INLINE_TOTAL_CAP = 60_000;
const SUMMARY_LINES = 10;

const prepared = new WeakSet<Database>();
function table(): Database {
  const conn = db();
  if (!prepared.has(conn)) {
    conn.exec(`CREATE TABLE IF NOT EXISTS session_specs (
      session_id TEXT NOT NULL,
      spec_path TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'ref',
      purpose TEXT NOT NULL DEFAULT 'context',
      delivered INTEGER NOT NULL DEFAULT 0,
      state TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, spec_path)
    )`);
    prepared.add(conn);
  }
  return conn;
}

const rowOf = (r: any): SessionSpec => ({ ...r, delivered: !!r.delivered });

export function listAttached(sessionId: string): SessionSpec[] {
  return (table().prepare("SELECT * FROM session_specs WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId) as any[]).map(rowOf);
}

/** Resolve what an attachment path points at, relative to the workspace. */
function target(rootDir: string, rel: string): { abs: string; kind: "file" | "dir" } {
  const p = guardSpecPath(rootDir, rel);
  const abs = path.join(rootDir, p);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new UserError(`${p} does not exist.`);
  }
  return { abs, kind: st.isDirectory() ? "dir" : "file" };
}

export function attach(sessionId: string, specPath: string, opts: { mode?: AttachMode; purpose?: AttachPurpose; delivered?: boolean; state?: string | null } = {}): SessionSpec {
  const s = getSession(sessionId);
  if (!s) throw new UserError(`No session "${sessionId}".`);
  if (s.status === "closed") throw new UserError(`Session ${sessionId} is closed.`);
  const mode = opts.mode ?? "ref";
  if (mode !== "ref" && mode !== "inline") throw new UserError(`Unknown attach mode "${mode}". Use "ref" or "inline".`);
  const p = guardSpecPath(s.base_cwd, specPath);
  target(s.base_cwd, p);
  table()
    .prepare(
      `INSERT INTO session_specs (session_id, spec_path, mode, purpose, delivered, state) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, spec_path) DO UPDATE SET mode = excluded.mode, purpose = excluded.purpose, delivered = excluded.delivered, state = excluded.state`,
    )
    .run(sessionId, p, mode, opts.purpose ?? "context", opts.delivered ? 1 : 0, opts.state ?? null);
  Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: s.status });
  return listAttached(sessionId).find((a) => a.spec_path === p)!;
}

export function detach(sessionId: string, specPath: string): boolean {
  const s = getSession(sessionId);
  const ok = table().prepare("DELETE FROM session_specs WHERE session_id = ? AND spec_path = ?").run(sessionId, specPath.replace(/\/+$/, "")).changes > 0;
  if (ok && s) Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: s.status });
  return ok;
}

/** A handoff carries the attachments over. `delivered`: the new session was already told about them. */
export function copyAttachments(fromId: string, toId: string, delivered = true): number {
  let n = 0;
  for (const a of listAttached(fromId)) {
    if (a.purpose === "architecture") continue; // that discussion belongs to its session
    try {
      attach(toId, a.spec_path, { mode: a.mode, purpose: a.purpose === "implement" ? "implement" : "context", delivered });
      n++;
    } catch {}
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/* The block                                                                  */
/* -------------------------------------------------------------------------- */

/** The path as the agent should write it: relative for a session working in the workspace, absolute for a scratch-dir head. */
function shown(s: SessionRecord, rel: string): string {
  return s.depth > 0 && s.isolation !== "worktree" ? path.join(s.base_cwd, rel) : rel;
}

function clip(line: string, n = 160): string {
  const t = line.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Up to ten lines that say what a spec file is about: its input line, its stories, its first requirements. */
export function summarizeSpec(text: string, max = SUMMARY_LINES): string[] {
  const out: string[] = [];
  const input = /^\*\*Input\*\*:\s*(.+)$/m.exec(text)?.[1];
  if (input) out.push(`Input: ${clip(input)}`);
  for (const m of text.matchAll(/^###\s+(User Story\s+\d+.*)$/gim)) {
    if (out.length >= 4) break;
    out.push(clip(m[1]));
  }
  for (const m of text.matchAll(/^[-*]\s+\*\*(FR-\d+)\*\*:\s*(.+)$/gm)) {
    if (out.length >= max) break;
    out.push(`${m[1]}: ${clip(m[2], 120)}`);
  }
  if (out.length === 0) {
    for (const l of text.split(/\r?\n/)) {
      const t = l.trim();
      if (!t || t.startsWith("#") || t.startsWith("<!--") || t.startsWith("**")) continue;
      out.push(clip(t));
      if (out.length >= max) break;
    }
  }
  return out.slice(0, max);
}

function titleOf(text: string): string | null {
  return /^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? null;
}

function read(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

const INLINE_ORDER = ["spec.md", "plan.md", "tasks.md", "data-model.md", "research.md", "quickstart.md"];

/** The text pasted for an inline attachment, capped. */
function inlineText(rootDir: string, rel: string, kind: "file" | "dir"): { parts: Array<{ rel: string; text: string; truncated: boolean }>; chars: number } {
  const files = kind === "file" ? [rel] : INLINE_ORDER.map((f) => `${rel}/${f}`).filter((f) => fs.existsSync(path.join(rootDir, f)));
  const parts: Array<{ rel: string; text: string; truncated: boolean }> = [];
  let chars = 0;
  for (const f of files) {
    const raw = read(path.join(rootDir, f));
    if (raw === null) continue;
    const room = Math.min(INLINE_FILE_CAP, INLINE_TOTAL_CAP - chars);
    if (room <= 200) break;
    const truncated = raw.length > room;
    const text = truncated ? raw.slice(0, room) : raw;
    parts.push({ rel: f, text, truncated });
    chars += text.length;
  }
  return { parts, chars };
}

interface Rendered {
  text: string;
  chars: number;
}

function renderOne(s: SessionRecord, a: SessionSpec): Rendered | null {
  let t: ReturnType<typeof target>;
  try {
    t = target(s.base_cwd, a.spec_path);
  } catch {
    return { text: `- \`${shown(s, a.spec_path)}\`: no longer exists.`, chars: 40 };
  }
  const lines: string[] = [];
  if (a.mode === "inline") {
    const { parts, chars } = inlineText(s.base_cwd, a.spec_path, t.kind);
    for (const p of parts) {
      lines.push(`### \`${shown(s, p.rel)}\``, "", "```markdown", p.text.replace(/```/g, "ˋˋˋ"), "```", ...(p.truncated ? ["(truncated here: read the file for the rest)"] : []), "");
    }
    return { text: lines.join("\n").trimEnd(), chars };
  }
  if (a.spec_path === CONSTITUTION_PATH) {
    const text = read(t.abs) ?? "";
    lines.push(`- Constitution: \`${shown(s, a.spec_path)}\`${titleOf(text) ? ` (${clip(titleOf(text)!, 80)})` : ""}. The principles every change must respect.`);
    const heads = [...text.matchAll(/^###\s+(.+)$/gm)].map((m) => clip(m[1], 60)).slice(0, 6);
    if (heads.length) lines.push(`  Principles: ${heads.join("; ")}`);
    return { text: lines.join("\n"), chars: lines.join("\n").length };
  }
  if (t.kind === "dir") {
    const feat = listFeatures(s.base_cwd).find((f) => f.dir === a.spec_path);
    if (feat) return { text: renderFeature(s, feat), chars: renderFeature(s, feat).length };
    lines.push(`- Folder \`${shown(s, a.spec_path)}\`.`);
    return { text: lines.join("\n"), chars: 40 };
  }
  // A plan file opens with front matter (status, version…): it is not what the file is about.
  const text = (read(t.abs) ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
  lines.push(`- \`${shown(s, a.spec_path)}\`${titleOf(text) ? `: ${clip(titleOf(text)!, 100)}` : ""}`);
  for (const l of summarizeSpec(text)) lines.push(`  ${l}`);
  return { text: lines.join("\n"), chars: lines.join("\n").length };
}

function renderFeature(s: SessionRecord, f: FeatureInfo): string {
  const lines = [`- Feature \`${shown(s, f.dir)}\`: ${f.title} (${f.status}${f.tasks.total ? `, tasks ${f.tasks.done}/${f.tasks.total}` : ""})`];
  const have = [f.files.spec && "spec.md", f.files.plan && "plan.md", f.files.tasks && "tasks.md", f.files.research && "research.md", f.files.dataModel && "data-model.md", f.files.quickstart && "quickstart.md", f.files.contracts.length ? "contracts/" : false].filter(Boolean);
  lines.push(`  Files: ${have.join(", ") || "(none yet)"}`);
  const spec = f.files.spec ? read(path.join(s.base_cwd, f.dir, "spec.md")) : null;
  if (spec) for (const l of summarizeSpec(spec)) lines.push(`  ${l}`);
  if (f.files.tasks) {
    const parsed = parseTasks(read(path.join(s.base_cwd, f.dir, "tasks.md")) ?? "");
    const open = parsed.tasks.filter((t) => !t.done).slice(0, 3);
    if (open.length) lines.push(`  Next open: ${open.map((t) => `${t.id ?? `line ${t.line + 1}`} ${clip(t.text, 70)}`).join(" | ")}`);
  }
  return lines.join("\n");
}

export interface SpecItem {
  path: string;
  mode: AttachMode;
  /** A file under the plans folder reads as a plan, everything else as a spec. */
  kind: "spec" | "plan";
  text: string;
}

/** The rendered pieces for a session's next turn: every attachment not yet delivered, or all with `all`. */
export function specsItems(sessionId: string, opts: { all?: boolean } = {}): SpecItem[] {
  const s = getSession(sessionId);
  if (!s) return [];
  const plansDir = plansDirOf(s.base_cwd);
  const out: SpecItem[] = [];
  for (const a of listAttached(sessionId)) {
    if (!(opts.all || !a.delivered)) continue;
    const r = renderOne(s, a);
    if (r) out.push({ path: a.spec_path, mode: a.mode, kind: a.spec_path === plansDir || a.spec_path.startsWith(`${plansDir}/`) ? "plan" : "spec", text: r.text });
  }
  return out;
}

/**
 * The block for a session's next turn on its own (the attachments module builds the one block a session
 * actually receives, out of `specsItems` and the docs equivalent). Returns null when there is nothing to say.
 */
export function specsBlock(sessionId: string, opts: { all?: boolean } = {}): string | null {
  const items = specsItems(sessionId, opts);
  if (!items.length) return null;
  const refs = items.filter((i) => i.mode !== "inline").map((i) => i.text);
  const inline = items.filter((i) => i.mode === "inline").map((i) => i.text);
  const parts = ["# Project specifications", ""];
  parts.push("This project keeps its specifications as files, and these are attached to this session. They are the source of truth for what to build: follow them, and if the code or the request contradicts them, say so instead of picking silently.");
  if (refs.length) parts.push("", "Read the files you need with your file tools, they are not pasted here:", "", ...refs);
  if (inline.length) parts.push("", "Pasted in full:", "", ...inline);
  return parts.join("\n");
}

export function markDelivered(sessionId: string): void {
  table().prepare("UPDATE session_specs SET delivered = 1 WHERE session_id = ?").run(sessionId);
}

/** One line for a handoff summary. */
export function attachedLine(sessionId: string): string | null {
  const items = listAttached(sessionId).filter((a) => a.purpose !== "architecture");
  if (!items.length) return null;
  return `Attached specifications (read them from the repository): ${items.map((a) => `\`${a.spec_path}\``).join(", ")}.`;
}

/* -------------------------------------------------------------------------- */
/* Token cost                                                                 */
/* -------------------------------------------------------------------------- */

/** Rough: four characters a token. Good enough to tell a 300-token pointer from a 15k-token paste. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export function estimatePath(rootDir: string, rel: string, mode: AttachMode): { tokens: number; truncated: boolean } {
  const t = target(rootDir, rel);
  if (mode === "inline") {
    const { parts, chars } = inlineText(rootDir, guardSpecPath(rootDir, rel), t.kind);
    return { tokens: estimateTokens(chars + 120), truncated: parts.some((p) => p.truncated) };
  }
  const fake = { id: "estimate", base_cwd: rootDir, depth: 0, isolation: "none" } as unknown as SessionRecord;
  const r = renderOne(fake, { session_id: "", spec_path: guardSpecPath(rootDir, rel), mode: "ref", purpose: "context", delivered: false, state: null, created_at: "" });
  return { tokens: estimateTokens((r?.chars ?? 0) + 120), truncated: false };
}

export function estimateSession(sessionId: string): { tokens: number; items: Array<{ path: string; mode: AttachMode; tokens: number }> } {
  const s = getSession(sessionId);
  const items: Array<{ path: string; mode: AttachMode; tokens: number }> = [];
  if (s) {
    for (const a of listAttached(sessionId)) {
      try {
        items.push({ path: a.spec_path, mode: a.mode, tokens: estimatePath(s.base_cwd, a.spec_path, a.mode).tokens });
      } catch {
        items.push({ path: a.spec_path, mode: a.mode, tokens: 0 });
      }
    }
  }
  return { tokens: items.reduce((n, i) => n + i.tokens, 0), items };
}

/* -------------------------------------------------------------------------- */
/* After a turn                                                               */
/* -------------------------------------------------------------------------- */

function note(s: SessionRecord, text: string): void {
  appendLog(s, s.last_turn_id, text, "info");
}

/** Files that differ from HEAD (or are untracked), as a set of paths. Empty outside a git repository. */
function dirtyFiles(dir: string): Set<string> {
  const r = Bun.spawnSync(["git", "status", "--porcelain", "-z", "--untracked-files=all"], { cwd: dir, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const out = new Set<string>();
  if (r.exitCode !== 0) return out;
  for (const rec of r.stdout.toString().split("\0")) if (rec.length > 3) out.add(rec.slice(3));
  return out;
}

const writeGuard = new Map<string, Set<string>>();

/** The architecture plan was approved: allow writing the spec files, and remember what was already dirty. */
export function beginSpecWrite(sessionId: string): string | null {
  const row = listAttached(sessionId).find((a) => a.purpose === "architecture");
  if (!row) return null;
  const s = getSession(sessionId);
  if (!s) return null;
  table().prepare("UPDATE session_specs SET state = 'writing' WHERE session_id = ? AND purpose = 'architecture'").run(sessionId);
  writeGuard.set(sessionId, dirtyFiles(s.base_cwd));
  return row.spec_path;
}

export function isArchitecture(sessionId: string): boolean {
  return listAttached(sessionId).some((a) => a.purpose === "architecture");
}

/**
 * Called when a turn has settled, before the goal check runs (so a ticked box counts toward it).
 * Never throws: bookkeeping must not fail a turn.
 */
export async function specsAfterTurn(sessionId: string, info: { interrupted: boolean; success: boolean }): Promise<void> {
  try {
    const s = getSession(sessionId);
    if (!s) return;
    const items = listAttached(sessionId);
    if (!items.length) return;

    // 1. Tick what the agent says it finished. Heads tick in the workspace's tasks.md, where the lead reads it.
    if (!info.interrupted && info.success) {
      const ids = reportedDone(s.last_output);
      for (const a of items) {
        // Heads never tick: their lead does, after merging what really landed.
        if (a.purpose !== "implement" && a.purpose !== "step") continue;
        const tasksRel = a.spec_path.endsWith(".md") ? a.spec_path : `${a.spec_path}/tasks.md`;
        const abs = path.join(s.base_cwd, tasksRel);
        if (!tasksRel.endsWith("tasks.md") || !fs.existsSync(abs)) continue;
        const before = fs.readFileSync(abs, "utf-8");
        const { text, ticked } = ids.length ? tickIds(before, ids) : { text: before, ticked: [] as string[] };
        if (ticked.length) {
          fs.writeFileSync(abs, text);
          note(s, `[spec] ticked ${ticked.join(", ")} in ${tasksRel} (the agent reported them done)`);
        }
        const p = parseTasks(text);
        if (p.total > 0) {
          note(s, `[spec] ${tasksRel.replace(/\/tasks\.md$/, "")}: ${p.done}/${p.total} tasks done`);
          Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: s.status });
        }
      }
    }

    // 2. An approved architecture discussion has written its files: back to read-only, and say if anything else changed.
    const arch = items.find((a) => a.purpose === "architecture" && a.state === "writing");
    if (arch) {
      const before = writeGuard.get(sessionId) ?? new Set<string>();
      writeGuard.delete(sessionId);
      table().prepare("UPDATE session_specs SET state = 'discussing' WHERE session_id = ? AND purpose = 'architecture'").run(sessionId);
      const stray = [...dirtyFiles(s.base_cwd)].filter((f) => !before.has(f) && !f.startsWith("specs/") && !f.startsWith(".specify/"));
      if (stray.length) note(s, `[spec] warning: files outside specs/ and .specify/ changed during the spec write: ${stray.slice(0, 8).join(", ")}${stray.length > 8 ? ", …" : ""}. Review them in Source Control.`);
      // Dynamic import: plan.ts imports the manager, which imports this module.
      const { setMode } = await import("../sessions/plan");
      if (getSession(sessionId)?.status !== "closed") setMode(sessionId, "plan");
    }
  } catch (err: any) {
    try {
      const s = getSession(sessionId);
      if (s) note(s, `[spec] bookkeeping failed: ${err?.message ?? err}`);
    } catch {}
  }
}
