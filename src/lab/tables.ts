/**
 * The Lab's SQLite tables, and the registry of checklist audit sessions. Nothing here imports the session manager, so the
 * manager can ask "is this session a checklist audit?" without a cycle (sessions.ts imports the manager).
 *
 *   lab_sessions            every Lab run: its lens, its scope, its sweep, and what changed outside lab/ meanwhile
 *   lab_sweeps              a sweep's queue of scopes still to start
 *   lab_checklist_sessions  the sessions that may call checklist_record, and the workspace each one answers for
 */
import fs from "fs";
import path from "path";
import { db } from "../db";

let ready = false;
/** For tests: forget that the tables were checked, so the next use checks (and upgrades) them again. */
export const resetLabTables = (): void => void (ready = false);

/** The Lab tables, created on first use. A table made by an earlier version is upgraded in place. */
export function tables(): void {
  if (ready) return;
  db().exec(`CREATE TABLE IF NOT EXISTS lab_sessions (
    session_id TEXT PRIMARY KEY, root_dir TEXT NOT NULL, lens TEXT NOT NULL, scope TEXT NOT NULL, sweep_id TEXT,
    baseline TEXT NOT NULL DEFAULT '[]', touched TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  // A table made by an earlier version lacks the newer columns: `IF NOT EXISTS` leaves it as it was.
  const have = new Set((db().prepare("PRAGMA table_info(lab_sessions)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!have.has("baseline")) db().exec(`ALTER TABLE lab_sessions ADD COLUMN baseline TEXT NOT NULL DEFAULT '[]'`);
  if (!have.has("touched")) db().exec(`ALTER TABLE lab_sessions ADD COLUMN touched TEXT NOT NULL DEFAULT '[]'`);
  // The run's window (when it started, ms) and the findings that existed then, with their status: what the run may have written.
  if (!have.has("started_ms")) db().exec(`ALTER TABLE lab_sessions ADD COLUMN started_ms INTEGER NOT NULL DEFAULT 0`);
  if (!have.has("known")) db().exec(`ALTER TABLE lab_sessions ADD COLUMN known TEXT NOT NULL DEFAULT '{}'`);
  db().exec(`CREATE INDEX IF NOT EXISTS lab_sessions_root ON lab_sessions (root_dir, created_at)`);
  db().exec(`CREATE TABLE IF NOT EXISTS lab_sweeps (
    id TEXT PRIMARY KEY, root_dir TEXT NOT NULL, lens TEXT NOT NULL, opts TEXT NOT NULL, pending TEXT NOT NULL,
    total INTEGER NOT NULL, parallel INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  const sweepCols = new Set((db().prepare("PRAGMA table_info(lab_sweeps)").all() as Array<{ name: string }>).map((c) => c.name));
  // The last reason a module could not be started, shown on the sweep: a failure is no longer only a count.
  if (!sweepCols.has("last_error")) db().exec(`ALTER TABLE lab_sweeps ADD COLUMN last_error TEXT`);
  // Cancels fix sweeps saved by older versions.
  if (!sweepCols.has("kind")) db().exec(`ALTER TABLE lab_sweeps ADD COLUMN kind TEXT NOT NULL DEFAULT 'run'`);
  db().exec(`UPDATE lab_sweeps SET cancelled = 1 WHERE kind = 'fix' AND cancelled = 0`);
  db().exec(`CREATE TABLE IF NOT EXISTS lab_checklist_sessions (
    session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  ready = true;
}

export const realOf = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/* -------------------------------------------------------------------------- */
/* Checklist audit registry                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Marks a session as a checklist audit of a workspace. Called by the launch before the session's first turn, so the turn's
 * tools are set up for it. checklist_record (checklists/tools.ts) accepts a call only from a session listed here, and the
 * trb MCP server offers the tool only to one.
 */
export function registerChecklistSession(sessionId: string, workspaceId: string): void {
  tables();
  db().prepare("INSERT OR REPLACE INTO lab_checklist_sessions (session_id, workspace_id) VALUES (?, ?)").run(sessionId, workspaceId);
}

/** The workspace a session answers for as a checklist audit, or null when it is not one. */
export function checklistSessionWorkspace(sessionId: string): string | null {
  tables();
  const r = db().prepare("SELECT workspace_id FROM lab_checklist_sessions WHERE session_id = ?").get(sessionId) as { workspace_id: string } | null;
  return r?.workspace_id ?? null;
}

export const isChecklistAudit = (sessionId: string): boolean => checklistSessionWorkspace(sessionId) !== null;
