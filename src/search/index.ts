/**
 * Full-text search over every past session's transcript (SQLite FTS5).
 *
 * The index is derived data: three kinds of document per finished turn (what the operator asked, what the
 * agent answered, the tool calls it made), stored in `transcript_fts`, with `transcript_index` remembering
 * which turns are done. It is built lazily and incrementally before each search, never touches `turns` or
 * `events`, and can be dropped at any time (it rebuilds). A finished turn never changes, so a row is written
 * once. Tables are created here, `IF NOT EXISTS`, so an older build opens a newer database untouched.
 */
import type { Database } from "bun:sqlite";
import { db } from "../db";

const MAX_DOC_CHARS = 100_000;
const prepared = new WeakSet<Database>();

function ensure(conn: Database): void {
  if (prepared.has(conn)) return;
  conn.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(text, session_id UNINDEXED, seq UNINDEXED, role UNINDEXED, tokenize = 'porter unicode61')`);
  conn.exec(`CREATE TABLE IF NOT EXISTS transcript_index (turn_id TEXT PRIMARY KEY)`);
  prepared.add(conn);
}

export type Role = "user" | "assistant" | "tool";

/** Index turns that finished since the last call. Returns how many were added. */
export function syncIndex(limit = 2000): number {
  const conn = db();
  ensure(conn);
  const todo = conn
    .prepare(
      `SELECT t.id, t.session_id, t.seq, t.prompt, t.output FROM turns t
       WHERE t.status != 'running' AND NOT EXISTS (SELECT 1 FROM transcript_index i WHERE i.turn_id = t.id)
       ORDER BY t.started_at LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; session_id: string; seq: number; prompt: string; output: string | null }>;
  if (!todo.length) return 0;
  const add = conn.prepare("INSERT INTO transcript_fts (text, session_id, seq, role) VALUES (?, ?, ?, ?)");
  const mark = conn.prepare("INSERT OR IGNORE INTO transcript_index (turn_id) VALUES (?)");
  const tools = conn.prepare("SELECT text FROM events WHERE turn_id = ? AND kind = 'tool' ORDER BY id");
  conn.transaction(() => {
    for (const t of todo) {
      if (t.prompt) add.run(t.prompt.slice(0, MAX_DOC_CHARS), t.session_id, t.seq, "user");
      if (t.output) add.run(t.output.slice(0, MAX_DOC_CHARS), t.session_id, t.seq, "assistant");
      const lines = (tools.all(t.id) as Array<{ text: string }>).map((r) => r.text).join("\n");
      if (lines) add.run(lines.slice(0, MAX_DOC_CHARS), t.session_id, t.seq, "tool");
      mark.run(t.id);
    }
  })();
  return todo.length;
}

/** Drop the derived index; the next search rebuilds it. */
export function resetIndex(): void {
  const conn = db();
  ensure(conn);
  conn.exec("DELETE FROM transcript_fts; DELETE FROM transcript_index;");
}

/**
 * Words from free text, as a query FTS5 cannot choke on: every word quoted, the last one a prefix (so a
 * half-typed word still finds things). Operators and punctuation the operator typed are just separators.
 */
export function ftsQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!words.length) return null;
  return words.slice(0, 12).map((w, i, a) => `"${w}"${i === a.length - 1 ? "*" : ""}`).join(" ");
}

export interface SearchFilters {
  /** A workspace's directory (matches the session's `base_cwd`). */
  workspace?: string | null;
  engine?: string | null;
  /** `YYYY-MM-DD`: turns started on or after / on or before this day (UTC). */
  since?: string | null;
  until?: string | null;
  limit?: number;
}

export interface SearchHit {
  session_id: string;
  root_id: string;
  seq: number;
  role: Role;
  /** Excerpt with the matched words wrapped in U+0001 and U+0002. */
  snippet: string;
  title: string;
  engine: string;
  base_cwd: string;
  started_at: string;
  depth: number;
}

const day = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

export function searchTranscripts(query: string, f: SearchFilters = {}): { hits: SearchHit[]; indexed: number } {
  const q = ftsQuery(query);
  const indexed = syncIndex();
  if (!q) return { hits: [], indexed };
  const limit = Math.min(Math.max(f.limit ?? 40, 1), 200);
  const where = ["transcript_fts MATCH ?"];
  const args: Array<string | number> = [q];
  if (f.workspace) (where.push("s.base_cwd = ?"), args.push(f.workspace));
  if (f.engine) (where.push("s.engine = ?"), args.push(f.engine));
  const since = day(f.since);
  const until = day(f.until);
  if (since) (where.push("substr(t.started_at, 1, 10) >= ?"), args.push(since));
  if (until) (where.push("substr(t.started_at, 1, 10) <= ?"), args.push(until));
  // Three documents per turn can match; fetch extra, then keep the best per turn.
  args.push(limit * 3);
  const rows = db()
    .prepare(
      `SELECT f.session_id AS session_id, s.root_id AS root_id, f.seq AS seq, f.role AS role,
              snippet(transcript_fts, 0, char(1), char(2), '…', 24) AS snippet,
              s.title AS title, s.engine AS engine, s.base_cwd AS base_cwd, t.started_at AS started_at, s.depth AS depth
       FROM transcript_fts f
       JOIN sessions s ON s.id = f.session_id
       JOIN turns t ON t.session_id = f.session_id AND t.seq = f.seq
       WHERE ${where.join(" AND ")}
       ORDER BY bm25(transcript_fts), t.started_at DESC
       LIMIT ?`,
    )
    .all(...args) as SearchHit[];
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const r of rows) {
    const key = `${r.session_id}:${r.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(r);
    if (hits.length >= limit) break;
  }
  return { hits, indexed };
}

export interface ReplayItem {
  kind: "text" | "tool" | "tool_ok" | "tool_err" | "done" | "fail" | "stderr";
  text: string;
  name?: string;
  arg?: string;
  detail?: string;
}

export interface ReplayTurn {
  seq: number;
  id: string;
  status: string;
  mode: string | null;
  started_at: string;
  finished_at: string | null;
  cost_usd: number | null;
  prompt: string;
  output: string | null;
  items: ReplayItem[];
}

export interface Replay {
  session: { id: string; title: string; engine: string; model: string | null; role: string | null; base_cwd: string; status: string; created_at: string; parent_id: string | null };
  turns: ReplayTurn[];
}

const REPLAY_KINDS = new Set(["text", "tool", "tool_ok", "tool_err", "done", "fail", "stderr"]);

/** A session's whole conversation, read-only: each turn with its logged lines in order. */
export function replaySession(sessionId: string): Replay | null {
  const conn = db();
  const s = conn.prepare("SELECT id, title, engine, model, role, base_cwd, status, created_at, parent_id FROM sessions WHERE id = ?").get(sessionId) as Replay["session"] | undefined;
  if (!s) return null;
  const turns = conn.prepare("SELECT id, seq, status, mode, started_at, finished_at, cost_usd, prompt, output FROM turns WHERE session_id = ? ORDER BY seq").all(sessionId) as Array<Omit<ReplayTurn, "items">>;
  const events = conn.prepare("SELECT turn_id, kind, text, data FROM events WHERE session_id = ? AND turn_id IS NOT NULL ORDER BY id").all(sessionId) as Array<{ turn_id: string; kind: string; text: string; data: string | null }>;
  const by = new Map<string, ReplayItem[]>();
  for (const e of events) {
    if (!REPLAY_KINDS.has(e.kind)) continue;
    let meta: any = null;
    try {
      meta = e.data ? JSON.parse(e.data) : null;
    } catch {}
    const list = by.get(e.turn_id) ?? [];
    list.push({ kind: e.kind as ReplayItem["kind"], text: e.text, name: meta?.name, arg: meta?.arg, detail: meta?.detail });
    by.set(e.turn_id, list);
  }
  return { session: s, turns: turns.map((t) => ({ ...t, items: by.get(t.id) ?? [] })) };
}
