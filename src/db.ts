import { Database } from "bun:sqlite";
import { paths } from "./paths";

let instance: Database | null = null;
let openedAt: string | null = null;

/**
 * The single SQLite handle. Lazy, so `TRB_HOME` is read when first used rather
 * than at import, and resettable so a test can point it somewhere else.
 */
export function db(): Database {
  const target = paths.db();
  if (instance && openedAt === target) return instance;
  if (instance) closeDb();
  const conn = new Database(target, { create: true });
  conn.exec("PRAGMA journal_mode = WAL");
  conn.exec("PRAGMA busy_timeout = 5000");
  conn.exec("PRAGMA foreign_keys = ON");
  migrate(conn);
  instance = conn;
  openedAt = target;
  return conn;
}

export function closeDb(): void {
  try {
    instance?.close();
  } catch {}
  instance = null;
  openedAt = null;
}

/**
 * Schema. Additive only: every statement is `IF NOT EXISTS`, and columns are
 * only ever added via `addColumn`, so an older database opens under a newer
 * build and a newer one is never rewritten by an older build.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Hydra pairs: which engine/model leads, and what its heads (subagents) run on.
CREATE TABLE IF NOT EXISTS pairs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'heads' CHECK(mode IN ('heads','roles')),
  lead_engine TEXT, lead_model TEXT, lead_effort TEXT,
  heads_engine TEXT, heads_model TEXT, heads_effort TEXT,
  roles_json TEXT,
  max_heads INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One table for leads (depth 0, opened by the operator) and subagents (depth >= 1,
-- opened by a running session). A session is a CLI conversation that can take turns.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brief TEXT,
  parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  root_id TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  engine TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  role TEXT,
  pair_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','failed','closed')),
  -- The engine's own session id, so a follow-up resumes with full context.
  cli_session_id TEXT,
  -- cwd: where the engine runs. base_cwd: the operator's workspace it was cut from.
  cwd TEXT NOT NULL,
  base_cwd TEXT NOT NULL,
  isolation TEXT NOT NULL DEFAULT 'none' CHECK(isolation IN ('none','worktree')),
  worktree_root TEXT, worktree_git_root TEXT, branch TEXT,
  base_sha TEXT, head_sha TEXT, merged_at TEXT,
  subagents INTEGER NOT NULL DEFAULT 1,
  last_output TEXT, last_error TEXT, last_turn_id TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_root ON sessions(root_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),
  output TEXT, error TEXT, usage_json TEXT, cost_usd REAL,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, seq);

-- Readable run log, one row per line, replayed by \`trb logs\` and the event stream.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  ts TEXT DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
-- Per-turn lookups (the fromTurn cursor in daemon/live.ts, the gate's text read in treeboss/gate.ts) filter on turn_id alone.
CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn_id, id);

-- The plan windows an engine last reported in its own stream (see engines/limits.ts), one row per engine.
CREATE TABLE IF NOT EXISTS engine_limits (
  engine TEXT PRIMARY KEY,
  windows TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Directories the UI works in. A workspace is a project root; sessions started from it are listed under it.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  last_opened TEXT DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Specialized agents: a named profile (instructions, defaults, the skills and MCP servers it may use).
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  engine TEXT, model TEXT, effort TEXT,
  -- NULL: every enabled skill / MCP server. A JSON array: only those.
  skills_json TEXT,
  mcp_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  name TEXT PRIMARY KEY,
  transport TEXT NOT NULL CHECK(transport IN ('stdio','http')),
  command TEXT, args_json TEXT, env_json TEXT,
  url TEXT, headers_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Evidence: pages captured from the agent browser and the findings agents wrote about them. Bulky parts live in
-- files under <trb home>/evidence/<id>/; this is the index. workspace is the real path of the project root.
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('page','note','bug')),
  title TEXT NOT NULL,
  url TEXT,
  summary TEXT NOT NULL DEFAULT '',
  refs_json TEXT,
  files_json TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  sha TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_evidence_workspace ON evidence(workspace, created_at);

-- Investigations: one reverse-engineering run on a target. The captures, saved results and findings made while it
-- ran are evidence rows that name it (evidence.investigation_id); closing it keeps them.
CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  title TEXT NOT NULL,
  target TEXT,
  target_kind TEXT NOT NULL DEFAULT 'other' CHECK(target_kind IN ('web','electron','binary','android','other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  session_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_investigations_workspace ON investigations(workspace, created_at);

-- Runs: each time an investigation is run, the lead session that did the work. Several runs per investigation are kept.
CREATE TABLE IF NOT EXISTS investigation_runs (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_investigation_runs_investigation ON investigation_runs(investigation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_investigation_runs_session ON investigation_runs(session_id);

CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  source TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

function addColumn(conn: Database, table: string, column: string, ddl: string): void {
  const cols = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/** A CHECK cannot be altered, so the table is rebuilt once with the wider one; the columns and rows are unchanged. */
function widenEvidenceKind(conn: Database): void {
  const row = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'evidence'").get() as { sql: string } | undefined;
  const old = "kind IN ('page','note')";
  if (!row || !row.sql.includes(old)) return;
  const indexes = (conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'evidence' AND sql IS NOT NULL").all() as Array<{ sql: string }>).map((r) => r.sql);
  conn.transaction(() => {
    conn.exec("ALTER TABLE evidence RENAME TO evidence_old");
    for (const r of conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'evidence_old' AND sql IS NOT NULL").all() as Array<{ name: string }>) conn.exec(`DROP INDEX "${r.name}"`);
    conn.exec(row.sql.replace(old, "kind IN ('page','note','bug')"));
    conn.exec("INSERT INTO evidence SELECT * FROM evidence_old");
    conn.exec("DROP TABLE evidence_old");
    for (const sql of indexes) conn.exec(sql);
  })();
}

/** Create what is missing and add the columns newer builds need. Exported so a test can open an older file and check it. */
export function migrate(conn: Database): void {
  conn.exec(SCHEMA);
  // Columns added after the first release. Never drop or rewrite: an older build must still open the file.
  addColumn(conn, "events", "data", "TEXT");
  addColumn(conn, "sessions", "agent", "TEXT");
  // A per-session override of which skills the session may use (NULL: whatever its agent, else all, allows).
  addColumn(conn, "sessions", "skills_json", "TEXT");
  // plan: read-only until the operator approves a plan; build: the agent may edit.
  addColumn(conn, "sessions", "mode", "TEXT NOT NULL DEFAULT 'build'");
  // How full the engine's context is (latest reading), its window, and how often it compacted. handoff_from: the session this one continues.
  addColumn(conn, "sessions", "context_tokens", "INTEGER");
  addColumn(conn, "sessions", "context_max", "INTEGER");
  addColumn(conn, "sessions", "context_json", "TEXT");
  addColumn(conn, "sessions", "context_at", "TEXT");
  addColumn(conn, "sessions", "compactions", "INTEGER NOT NULL DEFAULT 0");
  addColumn(conn, "sessions", "handoff_from", "TEXT");
  // A model picked by the operator between turns: wins over ask mode's cheap-model override; pending until the next turn starts.
  addColumn(conn, "sessions", "model_manual", "INTEGER NOT NULL DEFAULT 0");
  addColumn(conn, "sessions", "model_pending", "INTEGER NOT NULL DEFAULT 0");
  // Pinned to the top of the sessions list, across workspaces. Set to the time of pinning; NULL: not pinned.
  addColumn(conn, "sessions", "pinned_at", "TEXT");
  // Evidence within investigations (see evidence/investigations.ts). finding is set only on a note; finding_status only on a finding.
  addColumn(conn, "evidence", "investigation_id", "TEXT");
  addColumn(conn, "evidence", "finding", "TEXT CHECK(finding IN ('feature','ui'))");
  addColumn(conn, "evidence", "finding_status", "TEXT CHECK(finding_status IN ('new','planned','built','dismissed'))");
  addColumn(conn, "evidence", "source", "TEXT CHECK(source IN ('browser','rea','agent','operator'))");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_evidence_investigation ON evidence(investigation_id)");
  widenEvidenceKind(conn);
  // Why an investigation's kind is what it is, when the kind was worked out from its target (NULL: the operator chose it).
  addColumn(conn, "investigations", "kind_reason", "TEXT");
  // Turn end and head finalization are separate: a turn is recorded as ended at once; its commit, checkpoint and
  // diff summary come after (sessions/finalize.ts). finalized_at is NULL while that is pending, and merge-readiness
  // waits for it. Sessions that predate the column have nothing pending: they are finalized now, and keep their diff
  // computed live (changes_json NULL) until they are next finalized.
  if (!(conn.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some((c) => c.name === "finalized_at")) {
    addColumn(conn, "sessions", "finalized_at", "TEXT");
    conn.exec("UPDATE sessions SET finalized_at = COALESCE(updated_at, CURRENT_TIMESTAMP) WHERE finalized_at IS NULL");
  }
  // When the operator last had a workspace on screen. A lead whose turn completed after it is "done, not seen" in the
  // workspace switcher. Workspaces that predate the column start seen, so an upgrade does not light up every old turn.
  if (!(conn.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).some((c) => c.name === "seen_at")) {
    addColumn(conn, "workspaces", "seen_at", "TEXT");
    conn.exec("UPDATE workspaces SET seen_at = CURRENT_TIMESTAMP");
  }
  // The diff summary as of the last finalization (JSON; "null" when there were no changes; NULL: not finalized yet).
  addColumn(conn, "sessions", "changes_json", "TEXT");
  // The files a head said it will touch (JSON array of repo-relative paths or directory prefixes; NULL: none named). Used
  // to warn when two open heads of one lead overlap (sessions/manager.ts overlappingHeads).
  addColumn(conn, "sessions", "files_json", "TEXT");
  addColumn(conn, "turns", "mode", "TEXT");
  // The "natural next step" chips the agent suggested at the end of the turn (JSON: [{label, prompt}]).
  addColumn(conn, "turns", "next_json", "TEXT");
  // A head's launch is recorded before its engine starts ('launching'), so a daemon that dies in between can tell it never ran.
  // Cleared when its first turn starts (see sessions/manager.ts startTurn and recoverOnStartup).
  addColumn(conn, "sessions", "launch_state", "TEXT CHECK(launch_state IN ('launching'))");
  // The standing brief for a Hydra pair's lead (NULL: none). Read into every lead turn's preamble (hydra/pairs.ts leadTurnPreamble).
  addColumn(conn, "pairs", "lead_instructions", "TEXT");
  // A lead's subagent_wait while it is open, so a daemon restart can flag a wait it cut short (interrupted_at). Rows are
  // dropped when the wait ends, and an interrupted one when its session starts a new turn.
  conn.exec(`CREATE TABLE IF NOT EXISTS session_waits (
    id TEXT PRIMARY KEY, caller_id TEXT NOT NULL, ids_json TEXT NOT NULL, mode TEXT NOT NULL,
    since TEXT NOT NULL, interrupted_at TEXT
  )`);
  // The summary a handoff carried over, kept so the lineage can show what the new session was told.
  conn.exec(`CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY, from_session TEXT NOT NULL, to_session TEXT, summary TEXT NOT NULL, method TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  migrateCommandReceipts(conn);
  // A session parked on a usage limit until its reset (see sessions/parks.ts). Its own table, not a sessions column: the
  // sessions status CHECK cannot grow without rebuilding that table. resume_at is epoch ms; resume 1: resume the engine session.
  conn.exec(`CREATE TABLE IF NOT EXISTS session_parks (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    resume_at INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    resume INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    parked_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  // The process group each engine turn ran in (its pid, which is the pgid on POSIX), kept while anything is still running
  // in it after the turn ended: a dev server or watcher the agent started. Reaped on close, on restart and when idle (sessions/leftovers.ts).
  conn.exec(`CREATE TABLE IF NOT EXISTS turn_groups (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    pgid INTEGER NOT NULL,
    started_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  conn.exec("CREATE INDEX IF NOT EXISTS idx_turn_groups_session ON turn_groups(session_id)");
  // QA runs (qa/runs.ts): one row per run, the steps it froze with their outcomes as JSON. qa_sessions (qa/sessions.ts):
  // the agent session working on a plan, so a turn end can find the plan and a second one is refused.
  conn.exec(`CREATE TABLE IF NOT EXISTS qa_runs (
    id TEXT PRIMARY KEY, root_dir TEXT NOT NULL, plan TEXT NOT NULL, started_at INTEGER NOT NULL, steps TEXT NOT NULL
  )`);
  conn.exec("CREATE INDEX IF NOT EXISTS idx_qa_runs_plan ON qa_runs(root_dir, plan, started_at)");
  conn.exec(`CREATE TABLE IF NOT EXISTS qa_sessions (
    session_id TEXT PRIMARY KEY, root_dir TEXT NOT NULL, plan TEXT NOT NULL, kind TEXT NOT NULL, problem TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  addColumn(conn, "qa_sessions", "proposals_sig", "TEXT");
  // An agent run (kind 'run') walks one run of the plan: run_id. A run started by an end-to-end batch names it: batch_id.
  addColumn(conn, "qa_sessions", "run_id", "TEXT");
  addColumn(conn, "qa_sessions", "batch_id", "TEXT");
  // End-to-end batches (qa/batches.ts): plans run by an agent one after another. `next` is the index of the plan to start
  // when the current run's turn ends; `opts` is the engine choice as JSON.
  conn.exec(`CREATE TABLE IF NOT EXISTS qa_batches (
    id TEXT PRIMARY KEY, root_dir TEXT NOT NULL, plans TEXT NOT NULL, next INTEGER NOT NULL DEFAULT 0, current TEXT,
    base_url TEXT, opts TEXT NOT NULL DEFAULT '{}', cancelled INTEGER NOT NULL DEFAULT 0, errors TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`);
}

/**
 * Receipts for subagent tool calls that carried a `command_id`: the response that call got, keyed by the calling
 * session, tool and command id. A retried call with the same key returns the stored response instead of doing the
 * work again (see sessions/receipts.ts). Pruned at daemon start.
 */
function migrateCommandReceipts(conn: Database): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS command_receipts (
    command_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    session_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, tool, command_id)
  )`);
  conn.exec("CREATE INDEX IF NOT EXISTS idx_command_receipts_created ON command_receipts(created_at)");
}

export function nowIso(): string {
  return new Date().toISOString();
}
