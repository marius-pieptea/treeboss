/**
 * Verify: settings and results.
 *
 * Settings resolve session > workspace > global > built-in default, with an off switch at each level.
 * Tables are created lazily and idempotently here, so this feature adds nothing to db.ts.
 */
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { newId } from "../util";
import type { VerifyCommand } from "./detect";
import type { VerifyResult } from "./run";

export type VerifyState = "unknown" | "off" | "none" | "running" | "passed" | "failed" | "fixing";

export const DEFAULTS = { enabled: false, max_retries: 2, timeout_sec: 300 };
export const MAX_RETRIES_LIMIT = 10;

export interface VerifyConfigRow {
  scope: string;
  enabled: number | null;
  commands_json: string | null;
  max_retries: number | null;
  timeout_sec: number | null;
}

/** What one scope (global, or a workspace) sets; null means "not set here". */
export interface VerifyConfig {
  enabled: boolean | null;
  commands: VerifyCommand[] | null;
  max_retries: number | null;
  timeout_sec: number | null;
}

export interface SessionVerifyRow {
  session_id: string;
  enabled: number | null;
  state: VerifyState;
  fix_attempts: number;
  auto_turn: number;
  last_fp: string | null;
  note: string | null;
  updated_at: string;
}

export interface VerifyRun {
  id: string;
  session_id: string;
  turn_id: string | null;
  attempt: number;
  state: "running" | "passed" | "failed" | "stale";
  trigger: "turn" | "manual";
  results: VerifyResult[];
  fingerprint: string | null;
  started_at: string;
  finished_at: string | null;
}

const prepared = new WeakSet<Database>();
export function table(): Database {
  const conn = db();
  if (!prepared.has(conn)) {
    conn.exec(`CREATE TABLE IF NOT EXISTS verify_config (
      scope TEXT PRIMARY KEY,
      enabled INTEGER,
      commands_json TEXT,
      max_retries INTEGER,
      timeout_sec INTEGER
    )`);
    conn.exec(`CREATE TABLE IF NOT EXISTS session_verify (
      session_id TEXT PRIMARY KEY,
      enabled INTEGER,
      state TEXT NOT NULL DEFAULT 'unknown',
      fix_attempts INTEGER NOT NULL DEFAULT 0,
      auto_turn INTEGER NOT NULL DEFAULT 0,
      last_fp TEXT,
      note TEXT,
      updated_at TEXT NOT NULL
    )`);
    conn.exec(`CREATE TABLE IF NOT EXISTS verify_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      trigger TEXT NOT NULL,
      results_json TEXT,
      fingerprint TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )`);
    conn.exec("CREATE INDEX IF NOT EXISTS idx_verify_runs_session ON verify_runs(session_id, started_at)");
    prepared.add(conn);
  }
  return conn;
}

const GLOBAL = "global";

function parseCommands(raw: string | null): VerifyCommand[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((c) => c && typeof c.cmd === "string").map((c) => ({ name: String(c.name || "check"), cmd: c.cmd })) : null;
  } catch {
    return null;
  }
}

export function getConfig(scope: string): VerifyConfig {
  const row = table().prepare("SELECT * FROM verify_config WHERE scope = ?").get(scope) as VerifyConfigRow | undefined;
  return { enabled: row?.enabled == null ? null : row.enabled === 1, commands: parseCommands(row?.commands_json ?? null), max_retries: row?.max_retries ?? null, timeout_sec: row?.timeout_sec ?? null };
}

export const getGlobalConfig = () => getConfig(GLOBAL);

export function setConfig(scope: string, patch: Partial<VerifyConfig>): VerifyConfig {
  const cur = getConfig(scope);
  const next: VerifyConfig = { ...cur, ...patch };
  const int = (v: number | null, lo: number, hi: number, label: string) => {
    if (v === null || v === undefined) return null;
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${label} must be a whole number from ${lo} to ${hi}.`);
    return v;
  };
  next.max_retries = int(next.max_retries, 0, MAX_RETRIES_LIMIT, "max retries");
  next.timeout_sec = int(next.timeout_sec, 5, 7200, "timeout");
  table()
    .prepare(
      `INSERT INTO verify_config (scope, enabled, commands_json, max_retries, timeout_sec) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET enabled = excluded.enabled, commands_json = excluded.commands_json, max_retries = excluded.max_retries, timeout_sec = excluded.timeout_sec`,
    )
    .run(scope, next.enabled === null ? null : next.enabled ? 1 : 0, next.commands ? JSON.stringify(next.commands) : null, next.max_retries, next.timeout_sec);
  return getConfig(scope);
}

export const setGlobalConfig = (patch: Partial<VerifyConfig>) => setConfig(GLOBAL, patch);

export interface Resolved {
  enabled: boolean;
  /** Why it is off (or on), for the UI. */
  enabled_from: "session" | "workspace" | "global" | "default";
  /** The operator's command list for the workspace, or null to auto-detect. */
  commands: VerifyCommand[] | null;
  max_retries: number;
  timeout_sec: number;
}

export function resolveConfig(sessionId: string, workspacePath: string): Resolved {
  const sv = getSessionRow(sessionId);
  const ws = getConfig(workspacePath);
  const gl = getGlobalConfig();
  let enabled: boolean = DEFAULTS.enabled;
  let from: Resolved["enabled_from"] = "default";
  if (gl.enabled !== null) [enabled, from] = [gl.enabled, "global"];
  if (ws.enabled !== null) [enabled, from] = [ws.enabled, "workspace"];
  if (sv?.enabled != null) [enabled, from] = [sv.enabled === 1, "session"];
  return {
    enabled,
    enabled_from: from,
    commands: ws.commands ?? gl.commands,
    max_retries: ws.max_retries ?? gl.max_retries ?? DEFAULTS.max_retries,
    timeout_sec: ws.timeout_sec ?? gl.timeout_sec ?? DEFAULTS.timeout_sec,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-session state                                                          */
/* -------------------------------------------------------------------------- */

export function getSessionRow(sessionId: string): SessionVerifyRow | null {
  return (table().prepare("SELECT * FROM session_verify WHERE session_id = ?").get(sessionId) as SessionVerifyRow | undefined) ?? null;
}

export function patchSession(sessionId: string, patch: Partial<Omit<SessionVerifyRow, "session_id" | "updated_at">>): SessionVerifyRow {
  const cur = getSessionRow(sessionId) ?? { session_id: sessionId, enabled: null, state: "unknown" as VerifyState, fix_attempts: 0, auto_turn: 0, last_fp: null, note: null, updated_at: "" };
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  table()
    .prepare(
      `INSERT INTO session_verify (session_id, enabled, state, fix_attempts, auto_turn, last_fp, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET enabled = excluded.enabled, state = excluded.state, fix_attempts = excluded.fix_attempts, auto_turn = excluded.auto_turn, last_fp = excluded.last_fp, note = excluded.note, updated_at = excluded.updated_at`,
    )
    .run(next.session_id, next.enabled, next.state, next.fix_attempts, next.auto_turn, next.last_fp, next.note, next.updated_at);
  return next;
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

function rowToRun(r: any): VerifyRun {
  let results: VerifyResult[] = [];
  try {
    results = r.results_json ? JSON.parse(r.results_json) : [];
  } catch {}
  return { id: r.id, session_id: r.session_id, turn_id: r.turn_id, attempt: r.attempt, state: r.state, trigger: r.trigger, results, fingerprint: r.fingerprint, started_at: r.started_at, finished_at: r.finished_at };
}

export function startRun(sessionId: string, turnId: string | null, attempt: number, trigger: VerifyRun["trigger"]): string {
  const id = newId("vr");
  table().prepare("INSERT INTO verify_runs (id, session_id, turn_id, attempt, state, trigger, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?)").run(id, sessionId, turnId, attempt, trigger, new Date().toISOString());
  return id;
}

export function finishRun(id: string, state: VerifyRun["state"], results: VerifyResult[], fingerprint: string | null): void {
  table().prepare("UPDATE verify_runs SET state = ?, results_json = ?, fingerprint = ?, finished_at = ? WHERE id = ?").run(state, JSON.stringify(results), fingerprint, new Date().toISOString(), id);
}

export function listRuns(sessionId: string, limit = 10): VerifyRun[] {
  return (table().prepare("SELECT * FROM verify_runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(sessionId, limit) as any[]).map(rowToRun);
}

export function lastRun(sessionId: string): VerifyRun | null {
  const r = table().prepare("SELECT * FROM verify_runs WHERE session_id = ? AND state IN ('passed','failed','running') ORDER BY started_at DESC, rowid DESC LIMIT 1").get(sessionId);
  return r ? rowToRun(r) : null;
}

/** A run is a daemon-lifetime thing: one left "running" at startup was cut off. */
export function recoverRuns(): number {
  const t = table();
  const n = (t.prepare("SELECT COUNT(*) AS n FROM verify_runs WHERE state = 'running'").get() as { n: number }).n;
  t.prepare("UPDATE verify_runs SET state = 'stale', finished_at = ? WHERE state = 'running'").run(new Date().toISOString());
  t.prepare("UPDATE session_verify SET state = 'unknown', auto_turn = 0, note = 'the daemon restarted during verification' WHERE state IN ('running','fixing')").run();
  return n;
}
