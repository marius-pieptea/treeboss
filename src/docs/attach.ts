/**
 * Documentation pages attached to a session, and what the next turn is told because of them.
 *
 * The database holds only the link (which session has which page attached, and how); the text stays in the
 * files. Two modes, like attached specs:
 *   ref     (default)  a short block per page: where it is, its title, how fresh it is, one summary line,
 *                      and the instruction to read the page when it is needed. Cheap on every session.
 *   inline             the page text itself, up to a size cap, for a short page the agent must not miss.
 *
 * An attachment is delivered once: the next turn after attaching carries the block, a resumed engine
 * session already has it after that. Re-attaching (or changing the mode) delivers it again.
 *
 * A page that is stale says so in the block: an agent told "this describes older code" checks it against
 * the repository instead of repeating it.
 */
import fs from "fs";
import path from "path";
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { UserError } from "../util";
import { getSession, type SessionRecord } from "../sessions/manager";
import { Hub } from "../sessions/hub";
import { type DocMeta, docMeta, firstHeading, parseFrontMatter, summaryLine } from "./frontmatter";
import { pageStaleness, type Staleness } from "./staleness";
import { docsDirOf, guardDocsPath } from "./store";

export type DocAttachMode = "ref" | "inline";
export type DocAttachPurpose = "context" | "generate";

export interface SessionDoc {
  session_id: string;
  doc_path: string;
  mode: DocAttachMode;
  purpose: DocAttachPurpose;
  delivered: boolean;
  created_at: string;
}

export const INLINE_FILE_CAP = 24_000;
export const INLINE_TOTAL_CAP = 60_000;

const prepared = new WeakSet<Database>();
function table(): Database {
  const conn = db();
  if (!prepared.has(conn)) {
    conn.exec(`CREATE TABLE IF NOT EXISTS session_docs (
      session_id TEXT NOT NULL,
      doc_path TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'ref',
      purpose TEXT NOT NULL DEFAULT 'context',
      delivered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, doc_path)
    )`);
    prepared.add(conn);
  }
  return conn;
}

const rowOf = (r: any): SessionDoc => ({ ...r, delivered: !!r.delivered });

/** The registered workspace holding `dir`, straight from the table (workspaces.ts imports the session manager). */
function workspaceIdFor(dir: string): string | null {
  const real = (p: string) => {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  const target = real(dir);
  let best: { id: string; len: number } | null = null;
  for (const w of db().prepare("SELECT id, path FROM workspaces").all() as Array<{ id: string; path: string }>) {
    const rel = path.relative(w.path, target);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) if (!best || w.path.length > best.len) best = { id: w.id, len: w.path.length };
  }
  return best?.id ?? null;
}

/** The docs folder a session's workspace uses. */
export function docsDirForSession(s: Pick<SessionRecord, "base_cwd">): string {
  return docsDirOf(workspaceIdFor(s.base_cwd)).dir;
}

export function listAttached(sessionId: string): SessionDoc[] {
  return (table().prepare("SELECT * FROM session_docs WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId) as any[]).map(rowOf);
}

export function attach(sessionId: string, docPath: string, opts: { mode?: DocAttachMode; purpose?: DocAttachPurpose; delivered?: boolean } = {}): SessionDoc {
  const s = getSession(sessionId);
  if (!s) throw new UserError(`No session "${sessionId}".`);
  if (s.status === "closed") throw new UserError(`Session ${sessionId} is closed.`);
  const mode = opts.mode ?? "ref";
  if (mode !== "ref" && mode !== "inline") throw new UserError(`Unknown attach mode "${mode}". Use "ref" or "inline".`);
  const p = guardDocsPath(s.base_cwd, docsDirForSession(s), docPath);
  if (opts.purpose !== "generate" && !fs.existsSync(path.join(s.base_cwd, p))) throw new UserError(`${p} does not exist.`);
  table()
    .prepare(
      `INSERT INTO session_docs (session_id, doc_path, mode, purpose, delivered) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, doc_path) DO UPDATE SET mode = excluded.mode, purpose = excluded.purpose, delivered = excluded.delivered`,
    )
    .run(sessionId, p, mode, opts.purpose ?? "context", opts.delivered ? 1 : 0);
  Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: s.status });
  return listAttached(sessionId).find((a) => a.doc_path === p)!;
}

export function detach(sessionId: string, docPath: string): boolean {
  const s = getSession(sessionId);
  const ok = table().prepare("DELETE FROM session_docs WHERE session_id = ? AND doc_path = ?").run(sessionId, docPath.replace(/\/+$/, "")).changes > 0;
  if (ok && s) Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: s.status });
  return ok;
}

/** A handoff carries the context attachments over. `delivered`: the new session was already told about them. */
export function copyAttachments(fromId: string, toId: string, delivered = true): number {
  let n = 0;
  for (const a of listAttached(fromId)) {
    if (a.purpose !== "context") continue; // a generation run belongs to its own session
    try {
      attach(toId, a.doc_path, { mode: a.mode, purpose: "context", delivered });
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

function read(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

function freshnessNote(st: Staleness): string {
  switch (st.state) {
    case "fresh":
      return "";
    case "drifting":
      return ` [drifting: ${st.filesChanged} covered file${st.filesChanged === 1 ? "" : "s"} changed in ${st.commitsBehind} commit${st.commitsBehind === 1 ? "" : "s"} since it was written, check the details against the code]`;
    case "stale":
      return ` [STALE: ${st.filesChanged} covered files changed in ${st.commitsBehind} commits since it was written: treat it as a lead, not as fact]`;
    case "unknown":
      return " [freshness unknown]";
    default:
      return "";
  }
}

interface Rendered {
  text: string;
  chars: number;
  inline: boolean;
}

async function renderOne(s: SessionRecord, a: SessionDoc, head?: string | null): Promise<Rendered> {
  const abs = path.join(s.base_cwd, a.doc_path);
  const raw = read(abs);
  if (raw === null) return { text: `- \`${shown(s, a.doc_path)}\`: no longer exists.`, chars: 40, inline: false };
  const fm = parseFrontMatter(raw);
  const meta: DocMeta = docMeta(fm.data);
  const title = meta.title ?? firstHeading(fm.body) ?? path.basename(a.doc_path);
  const st = meta.generated?.commit ? await pageStaleness(s.base_cwd, meta, head) : null;
  if (a.mode === "inline") {
    const room = INLINE_FILE_CAP;
    const truncated = raw.length > room;
    const text = (truncated ? raw.slice(0, room) : raw).replace(/```/g, "ˋˋˋ");
    const block = [`### \`${shown(s, a.doc_path)}\`${st ? freshnessNote(st) : ""}`, "", "```markdown", text, "```", ...(truncated ? ["(truncated here: read the file for the rest)"] : []), ""].join("\n");
    return { text: block, chars: Math.min(raw.length, room), inline: true };
  }
  const lines = [`- \`${shown(s, a.doc_path)}\`: ${title}${st ? freshnessNote(st) : ""}`];
  const sum = summaryLine(fm.body, 160);
  if (sum) lines.push(`  ${sum}`);
  if (meta.covers.length) lines.push(`  Covers: ${meta.covers.slice(0, 6).join(", ")}${meta.covers.length > 6 ? ", …" : ""}`);
  return { text: lines.join("\n"), chars: lines.join("\n").length, inline: false };
}

export interface DocItem {
  path: string;
  mode: DocAttachMode;
  text: string;
}

/**
 * The rendered pieces for a session's next turn: every context attachment not yet delivered, or all of
 * them with `all`. Pasted pages share a size budget: one past it falls back to a pointer.
 */
export async function docsItems(sessionId: string, opts: { all?: boolean } = {}): Promise<DocItem[]> {
  const s = getSession(sessionId);
  if (!s) return [];
  const items = listAttached(sessionId).filter((a) => a.purpose === "context" && (opts.all || !a.delivered));
  const out: DocItem[] = [];
  let pasted = 0;
  for (const a of items) {
    const r = await renderOne(s, a);
    if (r.inline) {
      if (pasted + r.chars > INLINE_TOTAL_CAP) {
        out.push({ path: a.doc_path, mode: "ref", text: `- \`${shown(s, a.doc_path)}\`: too large to paste along with the others, read it from the file.` });
        continue;
      }
      pasted += r.chars;
      out.push({ path: a.doc_path, mode: "inline", text: r.text });
    } else out.push({ path: a.doc_path, mode: "ref", text: r.text });
  }
  return out;
}

/** The block on its own (the attachments module builds the one block a session actually receives). Null when there is nothing to say. */
export async function docsBlock(sessionId: string, opts: { all?: boolean } = {}): Promise<string | null> {
  const items = await docsItems(sessionId, opts);
  if (!items.length) return null;
  const refs = items.filter((i) => i.mode !== "inline").map((i) => i.text);
  const inline = items.filter((i) => i.mode === "inline").map((i) => i.text);
  const parts = ["# Project documentation", ""];
  parts.push("These pages describe the project and are attached to this session. Use them as a starting point. Where a page is marked stale or drifting, or the code contradicts it, believe the code and say so.");
  if (refs.length) parts.push("", "Read the ones you need with your file tools, they are not pasted here:", "", ...refs);
  if (inline.length) parts.push("", "Pasted in full:", "", ...inline);
  return parts.join("\n");
}

export function markDelivered(sessionId: string): void {
  table().prepare("UPDATE session_docs SET delivered = 1 WHERE session_id = ?").run(sessionId);
}

/** One line for a handoff summary. */
export function attachedLine(sessionId: string): string | null {
  const items = listAttached(sessionId).filter((a) => a.purpose === "context");
  if (!items.length) return null;
  return `Attached documentation (read the pages from the repository): ${items.map((a) => `\`${a.doc_path}\``).join(", ")}.`;
}

/* -------------------------------------------------------------------------- */
/* Token cost                                                                 */
/* -------------------------------------------------------------------------- */

export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export async function estimatePath(rootDir: string, rel: string, mode: DocAttachMode, docsDir: string): Promise<{ tokens: number; truncated: boolean }> {
  const p = guardDocsPath(rootDir, docsDir, rel);
  const raw = read(path.join(rootDir, p));
  if (raw === null) throw new UserError(`${p} does not exist.`);
  if (mode === "inline") return { tokens: estimateTokens(Math.min(raw.length, INLINE_FILE_CAP) + 120), truncated: raw.length > INLINE_FILE_CAP };
  const fake = { id: "estimate", base_cwd: rootDir, depth: 0, isolation: "none" } as unknown as SessionRecord;
  const r = await renderOne(fake, { session_id: "", doc_path: p, mode: "ref", purpose: "context", delivered: false, created_at: "" }, null);
  return { tokens: estimateTokens(r.chars + 120), truncated: false };
}

export async function estimateSession(sessionId: string): Promise<{ tokens: number; items: Array<{ path: string; mode: DocAttachMode; tokens: number }> }> {
  const s = getSession(sessionId);
  const items: Array<{ path: string; mode: DocAttachMode; tokens: number }> = [];
  if (s) {
    const docsDir = docsDirForSession(s);
    for (const a of listAttached(sessionId)) {
      if (a.purpose !== "context") continue;
      try {
        items.push({ path: a.doc_path, mode: a.mode, tokens: (await estimatePath(s.base_cwd, a.doc_path, a.mode, docsDir)).tokens });
      } catch {
        items.push({ path: a.doc_path, mode: a.mode, tokens: 0 });
      }
    }
  }
  return { tokens: items.reduce((n, i) => n + i.tokens, 0), items };
}
