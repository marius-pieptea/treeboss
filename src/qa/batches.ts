/**
 * End-to-end batches: several plans run by an agent one after another, in `qa_batches` (db.ts). One at a time on
 * purpose: the runs share the app and its data, so two at once would trip over each other and report each other's
 * state as bugs. When a run's turn ends the driver (sessions.ts) calls `advanceBatch`, which starts the next plan; a plan
 * that cannot start (no steps, a session already on it) is recorded in `errors` and skipped.
 *
 * Nothing here imports the session manager: starting a run is passed in, so there is no import cycle.
 */
import { db } from "../db";
import { newId } from "../util";
import { realOf } from "../lab/tables";
import type { LabOpts } from "../lab/sessions";
import type { PlanSlug } from "./types";

export interface BatchRow {
  id: string;
  root_dir: string;
  plans: string;
  next: number;
  current: string | null;
  base_url: string | null;
  opts: string;
  cancelled: number;
  errors: string;
  created_at: number;
}

export interface Batch {
  id: string;
  root: string;
  plans: PlanSlug[];
  next: number;
  current: PlanSlug | null;
  baseUrl: string | null;
  opts: LabOpts;
  cancelled: boolean;
  errors: Array<{ plan: string; error: string }>;
  createdAt: number;
}

const toBatch = (r: BatchRow): Batch => ({
  id: r.id,
  root: r.root_dir,
  plans: JSON.parse(r.plans) as PlanSlug[],
  next: r.next,
  current: r.current as PlanSlug | null,
  baseUrl: r.base_url,
  opts: JSON.parse(r.opts) as LabOpts,
  cancelled: r.cancelled === 1,
  errors: JSON.parse(r.errors) as Batch["errors"],
  createdAt: r.created_at,
});

export type StartPlanRun = (root: string, slug: PlanSlug, baseUrl: string | null, opts: LabOpts, batchId: string) => void;

export function getBatch(id: string): Batch | null {
  const r = db().prepare("SELECT * FROM qa_batches WHERE id = ?").get(id) as BatchRow | null;
  return r ? toBatch(r) : null;
}

export function latestBatch(root: string): Batch | null {
  const r = db().prepare("SELECT * FROM qa_batches WHERE root_dir = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(realOf(root)) as BatchRow | null;
  return r ? toBatch(r) : null;
}

export function createBatch(root: string, plans: PlanSlug[], baseUrl: string | null, opts: LabOpts): Batch {
  const id = newId("qab");
  // The session to send into is not carried: every run of a batch is its own session.
  const { sessionId: _s, ...keep } = opts;
  db()
    .prepare("INSERT INTO qa_batches (id, root_dir, plans, next, current, base_url, opts, cancelled, errors, created_at) VALUES (?, ?, ?, 0, NULL, ?, ?, 0, '[]', ?)")
    .run(id, realOf(root), JSON.stringify(plans), baseUrl, JSON.stringify(keep), Date.now());
  return getBatch(id)!;
}

const save = (b: Batch): void =>
  void db().prepare("UPDATE qa_batches SET next = ?, current = ?, cancelled = ?, errors = ? WHERE id = ?").run(b.next, b.current, b.cancelled ? 1 : 0, JSON.stringify(b.errors), b.id);

/** Starts the batch's next plan that can start, or ends the batch when none is left or it was cancelled. */
export function advanceBatch(id: string, start: StartPlanRun): Batch | null {
  const b = getBatch(id);
  if (!b) return null;
  b.current = null;
  while (!b.cancelled && b.next < b.plans.length) {
    const slug = b.plans[b.next]!;
    b.next++;
    try {
      // Saved first: the run's session is registered with this batch, and the next turn end must find `current` set.
      b.current = slug;
      save(b);
      start(b.root, slug, b.baseUrl, b.opts, b.id);
      return b;
    } catch (e) {
      b.current = null;
      b.errors.push({ plan: slug, error: (e as Error).message });
    }
  }
  save(b);
  return b;
}

/** Stops starting plans. The run going now finishes. */
export function cancelBatch(id: string): Batch | null {
  const b = getBatch(id);
  if (!b) return null;
  b.cancelled = true;
  save(b);
  return b;
}
