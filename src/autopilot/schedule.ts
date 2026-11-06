/**
 * Scheduled jobs: a cron expression per job, run by the daemon while it is up.
 *
 * Kinds:
 *   prompt       a session with the job's own prompt
 *   deps_update  a session with a built-in prompt to update dependencies (verification then runs on its turn)
 *   lab_sweep    a Lab sweep of one lens over the workspace's modules (the same start as `trb lab sweep`)
 *   verify       the project's checks, run in the workspace; the result is kept on the job
 *   signals_sync pull the workspace's signal sources (Sentry, PostHog) now; the result is kept on the job
 *
 * A ticker wakes every minute and starts the jobs that are due. A job that missed its time (the daemon was
 * down) runs once when the daemon is back, not once per missed slot. `next_run_at` is epoch milliseconds, set
 * before the job runs, so a job that fails does not come round again in the same minute.
 */
import { db } from "../db";
import { runAll } from "../verify/run";
import { detectVerifyCommands, type VerifyCommand } from "../verify/detect";
import { resolveConfig } from "../verify/store";
import { createLead } from "../sessions/manager";
import { startSweep } from "../lab/sweeps";
import { syncSignals } from "../signals/sync";
import { resolveEnv } from "../secrets/store";
import { newId, UserError } from "../util";
import { Workspaces } from "../workspaces";
import { nextRun, parseCron } from "./cron";

export const KINDS = ["prompt", "lab_sweep", "verify", "deps_update", "signals_sync"] as const;
export type ScheduleKind = (typeof KINDS)[number];

export const DEPS_PROMPT =
  "Update this project's dependencies to the newest versions that still fit their declared ranges, using the project's own package manager and lockfile. " +
  "Do not make breaking changes. If an update needs code changes to keep working, make them and say so. " +
  "Then run the project's checks. Finish with a short summary: what was updated (name, from, to), what was left alone and why, and the result of the checks.";

const TICK_MS = 60_000;

export interface Schedule {
  id: string;
  workspace_id: string;
  name: string;
  cron: string;
  kind: ScheduleKind;
  payload: Record<string, any>;
  engine: string | null;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_session_id: string | null;
  last_result: Record<string, any> | null;
  created_at: string;
}

interface Row {
  id: string;
  workspace_id: string;
  name: string;
  cron: string;
  kind: ScheduleKind;
  payload: string;
  engine: string | null;
  enabled: number;
  last_run_at: string | null;
  next_run_at: number | null;
  last_session_id: string | null;
  last_result: string | null;
  created_at: string;
}

let ready = false;
function tables(): void {
  if (ready) return;
  db().exec(`CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, cron TEXT NOT NULL, kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}', engine TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT, next_run_at INTEGER, last_session_id TEXT, last_result TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db().exec(`CREATE INDEX IF NOT EXISTS schedules_ws ON schedules (workspace_id)`);
  ready = true;
}

const fromRow = (r: Row): Schedule => ({
  id: r.id,
  workspace_id: r.workspace_id,
  name: r.name,
  cron: r.cron,
  kind: r.kind,
  payload: JSON.parse(r.payload || "{}"),
  engine: r.engine,
  enabled: r.enabled === 1,
  last_run_at: r.last_run_at,
  next_run_at: r.next_run_at == null ? null : new Date(r.next_run_at).toISOString(),
  last_session_id: r.last_session_id,
  last_result: r.last_result ? JSON.parse(r.last_result) : null,
  created_at: r.created_at,
});

export function getSchedule(id: string): Schedule | null {
  tables();
  const r = db().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function listSchedules(workspaceId?: string | null): Schedule[] {
  tables();
  const rows = workspaceId
    ? (db().prepare("SELECT * FROM schedules WHERE workspace_id = ? ORDER BY created_at, rowid").all(workspaceId) as Row[])
    : (db().prepare("SELECT * FROM schedules ORDER BY created_at, rowid").all() as Row[]);
  return rows.map(fromRow);
}

/** The next time a job is due after `from`, as epoch ms. Throws the cron parser's message when the expression is wrong. */
function dueAfter(cron: string, from: Date): number {
  return nextRun(cron, from).getTime();
}

function cleanPayload(kind: ScheduleKind, raw: unknown): Record<string, any> {
  const p: Record<string, any> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as object) } : {};
  if (kind === "prompt" && (typeof p.prompt !== "string" || !p.prompt.trim())) throw new UserError("A prompt job needs a prompt.");
  if (kind === "prompt") p.prompt = p.prompt.trim();
  if (kind === "lab_sweep" && (typeof p.lens !== "string" || !p.lens.trim())) throw new UserError("A lab sweep job needs a lens (features, ui, ai, perf, dx or review).");
  if (kind === "verify" && p.commands !== undefined && (!Array.isArray(p.commands) || p.commands.some((c: any) => typeof c?.name !== "string" || typeof c?.cmd !== "string"))) {
    throw new UserError("Verify commands are a list of { name, cmd }.");
  }
  return p;
}

const cleanCron = (cron: unknown): string => {
  const c = String(cron ?? "").trim().replace(/\s+/g, " ");
  try {
    parseCron(c);
  } catch (err: any) {
    throw new UserError(err?.message ?? "The cron expression is not valid.");
  }
  return c;
};

const cleanKind = (kind: unknown): ScheduleKind => {
  if (!(KINDS as readonly string[]).includes(String(kind))) throw new UserError(`Unknown kind "${kind}": use ${KINDS.join(", ")}.`);
  return kind as ScheduleKind;
};

export interface ScheduleInput {
  workspace_id: string;
  name: string;
  cron: string;
  kind: ScheduleKind | string;
  payload?: Record<string, any> | null;
  engine?: string | null;
  enabled?: boolean;
}

export function createSchedule(input: ScheduleInput): Schedule {
  tables();
  if (!Workspaces.get(input.workspace_id)) throw new UserError(`No workspace "${input.workspace_id}".`);
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw new UserError("A schedule needs a name.");
  const cron = cleanCron(input.cron);
  const kind = cleanKind(input.kind);
  const enabled = input.enabled !== false;
  const id = newId("sc");
  db()
    .prepare("INSERT INTO schedules (id, workspace_id, name, cron, kind, payload, engine, enabled, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.workspace_id, name, cron, kind, JSON.stringify(cleanPayload(kind, input.payload)), input.engine?.trim() || null, enabled ? 1 : 0, enabled ? dueAfter(cron, new Date()) : null);
  return getSchedule(id)!;
}

export interface SchedulePatch {
  name?: string;
  cron?: string;
  kind?: string;
  payload?: Record<string, any> | null;
  engine?: string | null;
  enabled?: boolean;
}

export function updateSchedule(id: string, patch: SchedulePatch): Schedule {
  const cur = getSchedule(id);
  if (!cur) throw new UserError(`No schedule "${id}".`);
  const name = patch.name === undefined ? cur.name : String(patch.name).trim().slice(0, 80);
  if (!name) throw new UserError("A schedule needs a name.");
  const cron = patch.cron === undefined ? cur.cron : cleanCron(patch.cron);
  const kind = patch.kind === undefined ? cur.kind : cleanKind(patch.kind);
  const payload = cleanPayload(kind, patch.payload === undefined ? cur.payload : patch.payload);
  const engine = patch.engine === undefined ? cur.engine : patch.engine?.trim() || null;
  const enabled = patch.enabled === undefined ? cur.enabled : patch.enabled;
  // A job that is switched on, or whose time changed, is due at its next slot from now (not from its old time).
  const rescheduled = patch.cron !== undefined || (enabled && !cur.enabled);
  const nextAt = !enabled ? null : rescheduled || cur.next_run_at === null ? dueAfter(cron, new Date()) : new Date(cur.next_run_at).getTime();
  db()
    .prepare("UPDATE schedules SET name = ?, cron = ?, kind = ?, payload = ?, engine = ?, enabled = ?, next_run_at = ? WHERE id = ?")
    .run(name, cron, kind, JSON.stringify(payload), engine, enabled ? 1 : 0, nextAt, id);
  return getSchedule(id)!;
}

export function deleteSchedule(id: string): boolean {
  tables();
  return db().prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
}

function setResult(id: string, result: Record<string, any>): void {
  db().prepare("UPDATE schedules SET last_result = ? WHERE id = ?").run(JSON.stringify(result), id);
}

/**
 * Start a job now. Its next slot is not moved. Returns what it started: a session, a sweep, or a check run
 * whose result lands on the job when it finishes.
 */
export function runSchedule(id: string, now = new Date()): { session_id: string | null; sweep_id: string | null; detail: string } {
  const s = getSchedule(id);
  if (!s) throw new UserError(`No schedule "${id}".`);
  const ws = Workspaces.get(s.workspace_id);
  if (!ws) throw new UserError("The schedule's workspace is no longer registered.");
  db().prepare("UPDATE schedules SET last_run_at = ? WHERE id = ?").run(now.toISOString(), id);

  let out: { session_id: string | null; sweep_id: string | null; detail: string };
  try {
    if (s.kind === "prompt" || s.kind === "deps_update") {
      const prompt = s.kind === "prompt" ? String(s.payload.prompt) : DEPS_PROMPT;
      const session = createLead({
        prompt,
        title: s.name.slice(0, 100),
        cwd: ws.path,
        engine: s.engine ?? (s.payload.engine as string | undefined) ?? null,
        model: (s.payload.model as string | undefined) ?? null,
        effort: (s.payload.effort as string | undefined) ?? null,
      });
      out = { session_id: session.id, sweep_id: null, detail: `Started session ${session.id}.` };
    } else if (s.kind === "lab_sweep") {
      const r = startSweep(ws.path, String(s.payload.lens), Array.isArray(s.payload.scopes) ? s.payload.scopes : null, {
        engine: s.engine ?? (s.payload.engine as string | undefined) ?? null,
        model: (s.payload.model as string | undefined) ?? null,
        effort: (s.payload.effort as string | undefined) ?? null,
        limit: typeof s.payload.limit === "number" ? s.payload.limit : null,
        parallel: typeof s.payload.parallel === "number" ? s.payload.parallel : null,
      });
      out = { session_id: r.sessions[0]?.id ?? null, sweep_id: r.sweepId, detail: `Sweep ${r.sweepId}: ${r.plan.modules.length} module(s), ${r.sessions.length} started now.` };
      setResult(id, { ok: true, sweep_id: r.sweepId, modules: r.plan.modules.length, at: now.toISOString() });
    } else if (s.kind === "signals_sync") {
      out = { session_id: null, sweep_id: null, detail: "Syncing signals." };
      void runSignalsSync(id, s.workspace_id);
    } else {
      out = { session_id: null, sweep_id: null, detail: "Running the checks." };
      void runChecks(id, ws.path, s.payload.commands as VerifyCommand[] | undefined);
    }
  } catch (err: any) {
    setResult(id, { ok: false, error: err?.message ?? String(err), at: now.toISOString() });
    throw err;
  }
  if (out.session_id) db().prepare("UPDATE schedules SET last_session_id = ? WHERE id = ?").run(out.session_id, id);
  return out;
}

/** Pull the signal sources now, outside any session. The per-source outcome is kept on the job. */
async function runSignalsSync(id: string, workspaceId: string): Promise<void> {
  try {
    const report = await syncSignals(workspaceId, { envProvider: (w) => resolveEnv(w, "prod") });
    setResult(id, {
      ok: report.sources.every((s) => !s.error),
      sources: report.sources.map((s) => ({ source: s.source, configured: s.configured, upserted: s.upserted, error: s.error })),
      at: report.at,
    });
  } catch (err: any) {
    setResult(id, { ok: false, error: err?.message ?? String(err), at: new Date().toISOString() });
  }
}

/** The project's checks in the workspace, outside any session. The result is kept on the job. */
async function runChecks(id: string, dir: string, configured?: VerifyCommand[]): Promise<void> {
  try {
    const cfg = resolveConfig("", dir);
    const commands = configured?.length ? configured : cfg.commands?.length ? cfg.commands : detectVerifyCommands(dir);
    if (!commands.length) return setResult(id, { ok: false, error: "No checks were found for this project.", at: new Date().toISOString() });
    const results = await runAll(commands, dir, { timeoutMs: cfg.timeout_sec * 1000 });
    setResult(id, {
      ok: results.every((r) => r.ok),
      results: results.map((r) => ({ name: r.name, ok: r.ok, exit: r.exit, duration_ms: r.duration_ms })),
      at: new Date().toISOString(),
    });
  } catch (err: any) {
    setResult(id, { ok: false, error: err?.message ?? String(err), at: new Date().toISOString() });
  }
}

/** One pass of the ticker: start every enabled job whose time has come. Returns how many it started. */
export function tickSchedules(now = Date.now()): number {
  tables();
  const due = db().prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now) as Row[];
  let started = 0;
  for (const row of due) {
    // Move the slot first: a job that fails must not come round again in this minute.
    db().prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(dueAfter(row.cron, new Date(now)), row.id);
    try {
      runSchedule(row.id, new Date(now));
      started++;
    } catch (err: any) {
      console.warn(`[trb] schedule ${row.name}: ${err?.message ?? err}`);
    }
  }
  return started;
}

let ticker: ReturnType<typeof setInterval> | null = null;

/** Start the ticker. Enabled jobs that have no next slot yet get one. */
export function startScheduler(): void {
  if (ticker) return;
  tables();
  for (const r of db().prepare("SELECT id, cron FROM schedules WHERE enabled = 1 AND next_run_at IS NULL").all() as Array<{ id: string; cron: string }>) {
    try {
      db().prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(dueAfter(r.cron, new Date()), r.id);
    } catch {}
  }
  ticker = setInterval(() => {
    try {
      tickSchedules();
    } catch (err: any) {
      console.warn(`[trb] scheduler failed: ${err?.message ?? err}`);
    }
  }, TICK_MS);
  (ticker as any).unref?.();
}

export function stopScheduler(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}
