/**
 * QA runs: one row per run in `qa_runs` (db.ts). A run freezes the plan's steps when it starts, so editing the plan
 * later changes the next run and leaves this one's text alone. Progress, finished and the current step are computed
 * from the steps, never stored. `plan` holds a feature id (or a plan slug); `session_id` is the session that walks it.
 */
import { db } from "../db";
import { newId, UserError } from "../util";
import { readFinding } from "../lab/findings";
import { realOf } from "../lab/tables";
import type { Outcome, OutcomeState, Plan, Run, RunId, RunSummary, StepId } from "./types";

const STATES: readonly OutcomeState[] = ["pending", "pass", "fail", "skip", "blocked"];

interface Row {
  id: string;
  root_dir: string;
  plan: string;
  started_at: number;
  steps: string;
  session_id: string | null;
}

const toRun = (r: Row): Run => ({ id: r.id, feature: r.plan, startedAt: r.started_at, sessionId: r.session_id, steps: JSON.parse(r.steps) as Run["steps"] });

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

/** Starts a run from the plan's current steps. `sessionId` is null when the session is not created yet (setRunSession fills it). */
export function startRun(root: string, plan: Plan, sessionId: string | null): Run {
  if (plan.problem) throw new UserError(`The plan file cannot be read (${plan.problem}).`);
  if (!plan.steps.length) throw new UserError("The plan has no steps to run.");
  const run: Run = { id: newId("qa"), feature: plan.feature, startedAt: Date.now(), sessionId, steps: plan.steps.map((s) => ({ ...s, outcome: { state: "pending" } })) };
  db().prepare("INSERT INTO qa_runs (id, root_dir, plan, started_at, steps, session_id) VALUES (?, ?, ?, ?, ?, ?)").run(run.id, realOf(root), run.feature, run.startedAt, JSON.stringify(run.steps), sessionId);
  return run;
}

export function setRunSession(id: RunId, sessionId: string): void {
  db().prepare("UPDATE qa_runs SET session_id = ? WHERE id = ?").run(sessionId, id);
}

export function getRun(id: RunId): Run | null {
  const r = db().prepare("SELECT * FROM qa_runs WHERE id = ?").get(id) as Row | null;
  return r ? toRun(r) : null;
}

/** The project a run belongs to, or null when there is no such run. */
export function runRoot(id: RunId): string | null {
  return (db().prepare("SELECT root_dir FROM qa_runs WHERE id = ?").get(id) as { root_dir: string } | null)?.root_dir ?? null;
}

/** The runs a session walks, oldest first. */
export function runsOfSession(sessionId: string): Run[] {
  return (db().prepare("SELECT * FROM qa_runs WHERE session_id = ? ORDER BY started_at, rowid").all(sessionId) as Row[]).map(toRun);
}

export function setOutcome(id: RunId, step: StepId, o: Outcome): Run {
  checkOutcome(o);
  const run = getRun(id);
  const root = runRoot(id);
  if (!run || root === null) throw new UserError(`No run "${id}".`);
  const target = run.steps.find((s) => s.id === step);
  if (!target) throw new UserError(`Step ${step} is not in run ${id}.`);
  if (o.state === "fail" && o.bug !== null) readFinding(root, o.bug);
  target.outcome = o;
  db().prepare("UPDATE qa_runs SET steps = ? WHERE id = ?").run(JSON.stringify(run.steps), id);
  return run;
}

export function countsOf(steps: Array<{ outcome: Outcome }>): RunSummary["counts"] {
  const c: RunSummary["counts"] = { pending: 0, pass: 0, fail: 0, skip: 0, blocked: 0 };
  for (const s of steps) c[s.outcome.state]++;
  return c;
}

export function summarize(run: Run): RunSummary {
  const counts = countsOf(run.steps);
  return { id: run.id, feature: run.feature, startedAt: run.startedAt, counts, finished: counts.pending === 0, sessionId: run.sessionId };
}

/** The first step still waiting for an outcome. */
export const currentStep = (run: Run): Run["steps"][number] | null => run.steps.find((s) => s.outcome.state === "pending") ?? null;

/** A feature's runs, newest first. */
export function listRuns(root: string, feature: string, limit = 20): RunSummary[] {
  const rows = db().prepare("SELECT * FROM qa_runs WHERE root_dir = ? AND plan = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(realOf(root), feature, limit) as Row[];
  return rows.map((r) => summarize(toRun(r)));
}

/** Drops one run: a test job that could not start. */
export function removeRun(id: RunId): void {
  db().prepare("DELETE FROM qa_runs WHERE id = ?").run(id);
}

/** For each step id, its newest outcome state across the feature's runs (a pending one does not count). */
export function lastOutcomes(root: string, feature: string, limit = 50): Record<string, OutcomeState> {
  const rows = db().prepare("SELECT * FROM qa_runs WHERE root_dir = ? AND plan = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(realOf(root), feature, limit) as Row[];
  const out: Record<string, OutcomeState> = {};
  for (const r of rows) for (const s of toRun(r).steps) if (s.outcome.state !== "pending" && !out[s.id]) out[s.id] = s.outcome.state;
  return out;
}

export function removeRuns(root: string, slug: string): void {
  db().prepare("DELETE FROM qa_runs WHERE root_dir = ? AND plan = ?").run(realOf(root), slug);
}
