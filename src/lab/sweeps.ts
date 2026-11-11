/**
 * Sweeps: one Lab run per module, with a bounded number running at once.
 *
 * The daemon runs them. A sweep is a row in `lab_sweeps` holding the modules still to start; the daemon starts
 * up to `parallel` sessions and starts the next one whenever one of them stops. The queue is in the database,
 * so a daemon restart picks it up where it was (sessions that were mid-turn are interrupted and not retried).
 * Starting them a few at a time also means a later module's run is told about the findings an earlier one wrote.
 */
import { db } from "../db";
import { Hub } from "../sessions/hub";
import { type SessionRecord } from "../sessions/manager";
import { finishRun, labTurn, launch, planSweep, realOf, tables, type LabOpts, type SweepPlan } from "./sessions";

export const DEFAULT_PARALLEL = 3;
export const MAX_PARALLEL = 6;

/** What a sweep keeps for every session it starts. A checklist pass also keeps its fix flag and the workspace it answers for. */
type Opts = Pick<LabOpts, "engine" | "model" | "effort" | "agent" | "pairId" | "note" | "fix" | "workspaceId">;

interface Row {
  id: string;
  root_dir: string;
  lens: string;
  kind: SweepKind;
  opts: string;
  pending: string;
  total: number;
  parallel: number;
  failed: number;
  cancelled: number;
  last_error: string | null;
  created_at: string;
}

export type SweepKind = "run";

export interface SweepView {
  id: string;
  kind: SweepKind;
  lens: string;
  total: number;
  /** Not started yet. */
  queued: number;
  running: number;
  /** Stopped: finished, failed or interrupted. */
  done: number;
  /** A module that could not be started (it was deleted, say). */
  failed: number;
  /** The reason the last module could not be started, so a failure is not only a count. */
  lastError: string | null;
  cancelled: boolean;
  at: string;
}

const running = (sweepId: string): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM lab_sessions l JOIN sessions s ON s.id = l.session_id WHERE l.sweep_id = ? AND s.status = 'running'").get(sweepId) as { n: number }).n;

const started = (sweepId: string): number => (db().prepare("SELECT COUNT(*) AS n FROM lab_sessions WHERE sweep_id = ?").get(sweepId) as { n: number }).n;

/** Start as many queued modules as the sweep has room for. Returns the sessions it started. */
export function pumpSweep(sweepId: string): SessionRecord[] {
  tables();
  const row = db().prepare("SELECT * FROM lab_sweeps WHERE id = ?").get(sweepId) as Row | null;
  if (!row || row.cancelled) return [];
  const pending: string[] = JSON.parse(row.pending);
  if (!pending.length) return [];
  const opts: Opts = JSON.parse(row.opts);
  const out: SessionRecord[] = [];
  let room = row.parallel - running(sweepId);
  let failed = row.failed;
  let lastError = row.last_error;
  while (room > 0 && pending.length) {
    const scope = pending.shift()!;
    try {
      out.push(launch(row.root_dir, labTurn(row.root_dir, row.lens, scope, opts.note, opts.fix), { ...opts, sessionId: null }, sweepId));
      room--;
    } catch (err) {
      failed++;
      lastError = `${scope}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    }
  }
  db().prepare("UPDATE lab_sweeps SET pending = ?, failed = ?, last_error = ? WHERE id = ?").run(JSON.stringify(pending), failed, lastError, sweepId);
  return out;
}

export function startSweep(rootDir: string, lens: string, scopes: string[] | null | undefined, o: LabOpts & { limit?: number | null; parallel?: number | null } = {}): { sweepId: string; sessions: SessionRecord[]; plan: SweepPlan } {
  tables();
  const plan = planSweep(rootDir, lens, scopes, o.limit);
  const sweepId = `sw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const parallel = Math.min(Math.max(1, Math.floor(o.parallel ?? DEFAULT_PARALLEL)), MAX_PARALLEL);
  const opts: Opts = { engine: o.engine, model: o.model, effort: o.effort, agent: o.agent, pairId: o.pairId, note: o.note, fix: o.fix ?? null, workspaceId: o.workspaceId ?? null };
  db()
    .prepare("INSERT INTO lab_sweeps (id, root_dir, lens, opts, pending, total, parallel) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(sweepId, realOf(rootDir), plan.lens, JSON.stringify(opts), JSON.stringify(plan.modules.map((m) => m.path)), plan.modules.length, parallel);
  return { sweepId, sessions: pumpSweep(sweepId), plan };
}

/** Stop starting new modules. The ones already running finish. */
export function cancelSweep(rootDir: string, sweepId: string): SweepView | null {
  tables();
  db().prepare("UPDATE lab_sweeps SET cancelled = 1 WHERE id = ? AND root_dir = ?").run(sweepId, realOf(rootDir));
  return listSweeps(rootDir).find((s) => s.id === sweepId) ?? null;
}

export function listSweeps(rootDir: string, limit = 10): SweepView[] {
  tables();
  const rows = db().prepare("SELECT * FROM lab_sweeps WHERE root_dir = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(realOf(rootDir), limit) as Row[];
  return rows.map((r) => {
    const queued = r.cancelled ? 0 : (JSON.parse(r.pending) as string[]).length;
    const run = running(r.id);
    return { id: r.id, kind: r.kind, lens: r.lens, total: r.total, queued, running: run, done: Math.max(0, started(r.id) - run), failed: r.failed, lastError: r.last_error, cancelled: !!r.cancelled, at: r.created_at };
  });
}

/** Sweeps with modules still queued: what a restart has to continue. */
function openSweeps(): string[] {
  tables();
  return (db().prepare("SELECT id FROM lab_sweeps WHERE cancelled = 0 AND pending != '[]'").all() as Array<{ id: string }>).map((r) => r.id);
}

let unsubscribe: (() => void) | null = null;

/** Keep sweeps moving: when a session of a sweep stops, start the next module. Also continues the sweeps a restart left half done. */
export function startSweepDriver(): void {
  if (unsubscribe) return;
  tables();
  unsubscribe = Hub.subscribe((e) => {
    if (e.type !== "turn_end" && !(e.type === "state" && e.status !== "running")) return;
    const r = db().prepare("SELECT sweep_id FROM lab_sessions WHERE session_id = ?").get(e.sessionId) as { sweep_id: string | null } | null;
    if (!r) return;
    if (e.type === "turn_end") finishRun(e.sessionId);
    if (r.sweep_id) pumpSweep(r.sweep_id);
  });
  for (const id of openSweeps()) pumpSweep(id);
}

export function stopSweepDriver(): void {
  unsubscribe?.();
  unsubscribe = null;
}
