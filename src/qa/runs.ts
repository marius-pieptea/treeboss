/**
 * QA runs: one row per run in `qa_runs` (db.ts). A run freezes the plan's steps when it starts, so editing the plan
 * later changes the next run and leaves this one's text alone. Progress, finished and the current step are computed
 * from the steps, never stored.
 */
import { db } from "../db";
import { newId, UserError } from "../util";
import { readFinding } from "../lab/findings";
import { realOf } from "../lab/tables";
import type { Outcome, OutcomeState, Plan, PlanSlug, Run, RunCounts, RunId, RunStep, RunSummary, StepId } from "./types";

const STATES: readonly OutcomeState[] = ["pending", "pass", "fail", "skip", "blocked"];

interface Row {
  id: string;
  root_dir: string;
  plan: string;
  started_at: number;
  steps: string;
}

const toRun = (r: Row): Run => ({ id: r.id as RunId, plan: r.plan as PlanSlug, root: r.root_dir, startedAt: r.started_at, steps: JSON.parse(r.steps) as RunStep[] });

export function runId(raw: unknown): RunId {
  if (typeof raw !== "string" || !/^qa_[a-z0-9]+$/.test(raw)) throw new UserError(`"${String(raw)}" is not a run id.`);
  return raw as RunId;
}

/** An outcome from the API, stamped with the time it was recorded. */
export function parseOutcome(raw: unknown, now: number = Date.now()): Outcome {
  const o = (raw ?? {}) as Record<string, unknown>;
  const state = o.state as OutcomeState;
  if (!STATES.includes(state)) throw new UserError(`Unknown outcome "${String(o.state)}": use ${STATES.join(", ")}.`);
  const text = (v: unknown, what: string): string => {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") throw new UserError(`${what} must be text.`);
    return v.trim();
  };
  switch (state) {
    case "pending":
      return { state };
    case "fail": {
      const bug = o.bug === undefined || o.bug === null || o.bug === "" ? null : text(o.bug, "bug");
      return { state, at: now, actual: text(o.actual, "actual"), bug };
    }
    default:
      return { state, at: now, note: text(o.note, "note") };
  }
}

function checkOutcome(o: Outcome): void {
  if (o.state === "blocked" && !o.note.trim()) throw new UserError("A blocked step needs a note: say what blocks it.");
}

/** Starts a run from the plan's current steps. */
export function startRun(root: string, plan: Plan): Run {
  if (plan.problem) throw new UserError(`The plan file cannot be read (${plan.problem}).`);
  if (!plan.steps.length) throw new UserError("The plan has no steps to run.");
  const run: Run = { id: newId("qa") as RunId, plan: plan.slug, root: realOf(root), startedAt: Date.now(), steps: plan.steps.map((s) => ({ ...s, outcome: { state: "pending" } })) };
  db().prepare("INSERT INTO qa_runs (id, root_dir, plan, started_at, steps) VALUES (?, ?, ?, ?, ?)").run(run.id, run.root, run.plan, run.startedAt, JSON.stringify(run.steps));
  return run;
}

export function getRun(id: RunId): Run | null {
  const r = db().prepare("SELECT * FROM qa_runs WHERE id = ?").get(id) as Row | null;
  return r ? toRun(r) : null;
}

export function setOutcome(id: RunId, step: StepId, o: Outcome): Run {
  checkOutcome(o);
  const run = getRun(id);
  if (!run) throw new UserError(`No run "${id}".`);
  const target = run.steps.find((s) => s.id === step);
  if (!target) throw new UserError(`Step ${step} is not in run ${id}.`);
  if (o.state === "fail" && o.bug !== null) readFinding(run.root, o.bug);
  target.outcome = o;
  db().prepare("UPDATE qa_runs SET steps = ? WHERE id = ?").run(JSON.stringify(run.steps), id);
  return run;
}

export function countsOf(steps: Array<{ outcome: Outcome }>): RunCounts {
  const c: RunCounts = { pending: 0, pass: 0, fail: 0, skip: 0, blocked: 0 };
  for (const s of steps) c[s.outcome.state]++;
  return c;
}

export function summarize(run: Run): RunSummary {
  const counts = countsOf(run.steps);
  return { id: run.id, plan: run.plan, startedAt: run.startedAt, counts, finished: counts.pending === 0, states: Object.fromEntries(run.steps.map((s) => [s.id, s.outcome.state])) };
}

/** The first step still waiting for an outcome: where the panel resumes. */
export const currentStep = (run: Run): RunStep | null => run.steps.find((s) => s.outcome.state === "pending") ?? null;

/** A plan's runs, newest first. */
export function listRuns(root: string, slug: PlanSlug, limit = 50): RunSummary[] {
  const rows = db().prepare("SELECT * FROM qa_runs WHERE root_dir = ? AND plan = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(realOf(root), slug, limit) as Row[];
  return rows.map((r) => summarize(toRun(r)));
}

export function lastRunSummary(root: string, slug: PlanSlug): RunSummary | null {
  return listRuns(root, slug, 1)[0] ?? null;
}

export interface StepHistory {
  run: RunId;
  at: number;
  outcome: Exclude<Outcome, { state: "pending" }>;
}

/** For each step id, its newest outcome across the plan's runs (a pending one does not count). */
export function lastOutcomes(root: string, slug: PlanSlug, limit = 50): Record<string, StepHistory> {
  const rows = db().prepare("SELECT * FROM qa_runs WHERE root_dir = ? AND plan = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(realOf(root), slug, limit) as Row[];
  const out: Record<string, StepHistory> = {};
  for (const r of rows) {
    const run = toRun(r);
    for (const s of run.steps) {
      if (s.outcome.state === "pending" || out[s.id]) continue;
      out[s.id] = { run: run.id, at: s.outcome.at, outcome: s.outcome };
    }
  }
  return out;
}

export function removeRuns(root: string, slug: PlanSlug): void {
  db().prepare("DELETE FROM qa_runs WHERE root_dir = ? AND plan = ?").run(realOf(root), slug);
}
