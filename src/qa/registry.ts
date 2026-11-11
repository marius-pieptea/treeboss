/**
 * Which sessions belong to a QA job, read from `qa_jobs` (db.ts). Nothing here imports the session manager, so the
 * manager can ask "does this session get the QA tools?" without a cycle (qa/jobs.ts imports the manager).
 */
import { db } from "../db";
import type { Job, JobId, NonEmpty, PipelineId, Stage, Unit } from "./types";

export interface JobRow {
  id: string;
  pipeline_id: string;
  root_dir: string;
  stage: string;
  units: string;
  session_id: string | null;
  error: string | null;
  sigs: string;
  nudged_turns: number | null;
  problem: string | null;
  started_at: number;
  settled_at: number | null;
}

export const toJob = (r: JobRow): Job => ({
  id: r.id as JobId,
  pipeline: r.pipeline_id as PipelineId,
  root: r.root_dir,
  stage: r.stage as Stage,
  units: JSON.parse(r.units) as NonEmpty<Unit>,
  session: r.session_id,
  error: r.error,
  sigs: JSON.parse(r.sigs) as Job["sigs"],
  nudgedTurns: r.nudged_turns,
  problem: r.problem,
  startedAt: r.started_at,
  settledAt: r.settled_at,
});

export const jobsOfPipeline = (id: string): Job[] => (db().prepare("SELECT * FROM qa_jobs WHERE pipeline_id = ? ORDER BY started_at, rowid").all(id) as JobRow[]).map(toJob);

export const jobOfSession = (sessionId: string): Job | null => {
  const r = db().prepare("SELECT * FROM qa_jobs WHERE session_id = ?").get(sessionId) as JobRow | null;
  return r ? toJob(r) : null;
};

export interface QaContext {
  job: Job;
  /** The caller is a head of the job's lead, not the lead itself. */
  head: boolean;
}

export function qaContext(sessionId: string): QaContext | null {
  const r = db().prepare("SELECT j.* FROM qa_jobs j WHERE j.session_id = (SELECT root_id FROM sessions WHERE id = ?)").get(sessionId) as JobRow | null;
  return r ? { job: toJob(r), head: r.session_id !== sessionId } : null;
}

/** Sessions that drive the app and get qa_record and bug_log: map, plan and test jobs and their heads (a fix job edits code). */
export function usesQaTools(sessionId: string): boolean {
  const c = qaContext(sessionId);
  return !!c && c.job.stage !== "fix";
}
