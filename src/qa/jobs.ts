/**
 * The shell around the pure pipeline (pipeline.ts): it stores pipelines and jobs, builds the snapshot `reconcile` reads,
 * launches the sessions it asks for, settles a job when its whole session tree is idle, and builds the board. Every
 * decision comes from pipeline.ts. `tickProject` is the only place a session is launched; it is synchronous, and a job
 * row is written before the session's first turn, so two ticks racing (a turn end and a restart) cannot launch a unit twice.
 */
import { db } from "../db";
import { browserEnabled } from "../browser/chrome";
import { withInstructions } from "../design/sessions";
import { HydraPairs } from "../hydra/pairs";
import { listFindings, patchFinding, readFinding, type Finding } from "../lab/findings";
import { runningFix } from "../lab/sessions";
import { realOf } from "../lab/tables";
import { Hub } from "../sessions/hub";
import { createLead, getSession, send, treeIdle, unmergedHeads } from "../sessions/manager";
import { newId, UserError } from "../util";
import { FEATURES_FILE, featuresSignature, readFeatures } from "./features";
import { activityOf, bugFeature, jobViewOf, mergeActivity, PAIR_HEAD_CAP, parseConfig, pipelineView, reconcile, unitsFor } from "./pipeline";
import { listPlans, planSignature, QA_DIR, QaConflict, QaNotFound, readPlan, removePlan } from "./plan";
import { jobOfSession, jobsOfPipeline, type JobRow } from "./registry";
import { jobPrompt, qaLabel } from "./prompts";
import { getRun, lastOutcomes, listRuns, removeRun, runId, runRoot, runsOfSession, setRunSession, startRun, summarize } from "./runs";
import {
  STAGES,
  type Activity,
  type BoardBug,
  type BoardFeature,
  type BugId,
  type BugState,
  type Control,
  type Feature,
  type FeatureDetail,
  type FeatureId,
  type Job,
  type JobId,
  type Launch,
  type Pipeline,
  type PipelineConfig,
  type PipelineId,
  type PipelineView,
  type Plan,
  type QaBoard,
  type Run,
  type RunId,
  type RunReply,
  type Snapshot,
  type Stage,
  type Unit,
} from "./types";

const MAX_ROUNDS = 20;
const SWEEP_MS = 5000;

const NUDGE = (ids: string[]): string =>
  `Your heads ${ids.join(", ")} finished with commits that are not merged. Merge each one with subagent_merge, one at a time, check the result, finish the job you were given, then end your turn.`;

/* -------------------------------------------------------------------------- */
/* Pipelines                                                                  */
/* -------------------------------------------------------------------------- */

interface PipelineRow {
  id: string;
  root_dir: string;
  config: string;
  control: string;
  units: string | null;
  created_at: number;
}

const toPipeline = (r: PipelineRow): Pipeline => ({
  id: r.id as PipelineId,
  root: r.root_dir,
  config: JSON.parse(r.config) as PipelineConfig,
  control: JSON.parse(r.control) as Control,
  units: r.units === null ? null : (JSON.parse(r.units) as Unit[]),
  createdAt: r.created_at,
});

const newest = (root: string): Pipeline | null => {
  const r = db().prepare("SELECT * FROM qa_pipelines WHERE root_dir = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(root) as PipelineRow | null;
  return r ? toPipeline(r) : null;
};

/** The pipeline that is not ended. There is at most one per project, and it is the newest. */
const openPipeline = (root: string): Pipeline | null => {
  const p = newest(root);
  return p && p.control.kind !== "ended" ? p : null;
};

function pipelineOf(root: string, id: string): Pipeline {
  const r = db().prepare("SELECT * FROM qa_pipelines WHERE id = ? AND root_dir = ?").get(id, realOf(root)) as PipelineRow | null;
  if (!r) throw new QaNotFound(`No pipeline "${id}".`);
  return toPipeline(r);
}

const setControl = (id: string, control: Control, units: Unit[] | null): void => {
  db().prepare("UPDATE qa_pipelines SET control = ?, units = ? WHERE id = ?").run(JSON.stringify(control), units === null ? null : JSON.stringify(units), id);
};

const isPair = (session: string | null): boolean => !!session && !!getSession(session)?.pair_id;

function viewOf(p: Pipeline): PipelineView {
  const jobs = jobsOfPipeline(p.id);
  return { ...pipelineView(p, jobs), jobs: jobs.map((j) => jobViewOf(j, isPair(j.session))) };
}

/* -------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* -------------------------------------------------------------------------- */

const isBug = (f: Finding): f is Finding & { bug: NonNullable<Finding["bug"]> } => f.lens === "bug" && f.bug !== null;
const isOpen = (f: Finding): boolean => f.status === "new" || f.status === "accepted";

function snapshotOf(root: string, p: Pipeline | null): Snapshot {
  const map = readFeatures(root);
  const plans = new Map<FeatureId, { steps: number; problem: string | null }>();
  for (const [id, plan] of listPlans(root).byFeature) plans.set(id, { steps: plan.steps.length, problem: plan.problem });
  const openBugs = listFindings(root)
    .filter((f) => isBug(f) && !f.problem && isOpen(f))
    .map((f) => ({ id: f.id as BugId, feature: bugFeature(f.bug?.feature, f.bug?.url ?? "", map.features).feature }));
  const jobs = (p ? jobsOfPipeline(p.id) : []).map((j) => ({ ...j, active: j.settledAt === null && j.session !== null }));
  const fix = runningFix(root);
  const ours = new Set(jobs.map((j) => j.session));
  return { features: map.features, mapExists: map.exists, plans, openBugs, jobs, fixBusyElsewhere: !!fix && !ours.has(fix.sessionId) };
}

/* -------------------------------------------------------------------------- */
/* Launching                                                                  */
/* -------------------------------------------------------------------------- */

function needBrowser(): void {
  if (!browserEnabled()) throw new UserError("The agent browser is off, and this QA run drives the app through it. Turn it on in Settings (or trb config set agent_browser on) and make sure Chrome is installed.");
}

const insertJob = (j: { id: JobId; p: Pipeline; stage: Stage; units: readonly Unit[]; session: string | null; error: string | null; sigs: Job["sigs"]; at: number; settled: boolean }): void => {
  db()
    .prepare("INSERT INTO qa_jobs (id, pipeline_id, root_dir, stage, units, session_id, error, sigs, nudged_turns, problem, started_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)")
    .run(j.id, j.p.id, j.p.root, j.stage, JSON.stringify(j.units), j.session, j.error, JSON.stringify(j.sigs), j.at, j.settled ? j.at : null);
};

function signaturesOf(root: string, l: Launch): Job["sigs"] {
  if (l.stage === "map") return { map: featuresSignature(root) };
  if (l.stage === "plan") return Object.fromEntries(l.units.map((u) => [u, planSignature(root, u)]));
  return {};
}

/** Starts the session of one launch. A throw before the session exists is recorded on the job and never retried. */
function launchJob(p: Pipeline, l: Launch, now: number): void {
  const root = p.root;
  const jobId = newId("qaj") as JobId;
  const runs = new Map<FeatureId, Run>();
  let session: ReturnType<typeof createLead>;
  try {
    if (l.stage !== "fix") needBrowser();
    const features = readFeatures(root).features;
    const plans = new Map<FeatureId, Plan>();
    if (l.stage === "plan" || l.stage === "test") {
      for (const u of l.units) {
        try {
          plans.set(u, readPlan(root, u));
        } catch (e) {
          if (!(e instanceof QaNotFound)) throw e;
        }
      }
    }
    if (l.stage === "test") {
      for (const u of l.units) {
        const plan = plans.get(u);
        if (!plan) throw new UserError(`${u}: no plan to run.`);
        runs.set(u, startRun(root, plan, null));
      }
    }
    const bugs = new Map<BugId, { id: BugId; path: string; title: string; url: string; kind: string; capture: string | null; body: string }>();
    if (l.stage === "fix") {
      for (const u of l.units) {
        const f = readFinding(root, u);
        bugs.set(u, { id: u, path: f.path, title: f.title, url: f.bug?.url ?? "", kind: f.bug?.kind ?? "functional", capture: f.bug?.capture ?? null, body: f.body });
      }
    }
    const driver = p.config.driver;
    const pair = driver.kind === "pair" ? HydraPairs.find(driver.pairId) : null;
    if (driver.kind === "pair" && !pair) throw new UserError(`No Hydra pair "${driver.pairId}". See \`trb pair list\`.`);
    const asPair = !!pair && l.stage !== "test";
    const open = listFindings(root).filter((f) => isBug(f) && !f.problem && isOpen(f)).map((f) => ({ id: f.id, title: f.title, url: f.bug?.url ?? "" }));
    const text = jobPrompt({
      launch: l,
      batching: l.stage === "map" ? "each" : (p.config.stages[l.stage]?.batching ?? "each"),
      driver,
      pairCap: asPair ? Math.min(PAIR_HEAD_CAP, pair!.max_heads ?? PAIR_HEAD_CAP) : null,
      note: p.config.note,
      baseUrl: p.config.baseUrl,
      features,
      plans,
      runs,
      bugs,
      openBugs: open,
    });
    const sigs = signaturesOf(root, l);
    const lead = driver.kind === "agent" ? { engine: driver.engine, model: driver.model, effort: driver.effort, agent: driver.agent } : asPair ? { pairId: driver.pairId } : { engine: pair!.lead_engine, model: pair!.lead_model, effort: pair!.lead_effort };
    session = createLead({
      prompt: withInstructions(text.visible, qaLabel(l.stage), text.instructions),
      title: text.title,
      cwd: root,
      isolate: false,
      mode: "build",
      ...lead,
      onCreated: (id) => {
        insertJob({ id: jobId, p, stage: l.stage, units: l.units, session: id, error: null, sigs, at: now, settled: false });
        for (const r of runs.values()) setRunSession(r.id as RunId, id);
      },
    });
  } catch (e) {
    for (const r of runs.values()) removeRun(r.id as RunId);
    const error = (e as Error).message;
    const marked = db().prepare("UPDATE qa_jobs SET error = ?, settled_at = ? WHERE id = ?").run(error, now, jobId);
    if (!marked.changes) insertJob({ id: jobId, p, stage: l.stage, units: l.units, session: null, error, sigs: {}, at: now, settled: true });
    return;
  }
  if (l.stage === "fix") {
    for (const bug of l.units) {
      try {
        patchFinding(root, bug, { status: "accepted", fix_session: session.id });
      } catch {
        // the finding file vanished: the job's check reports it
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* tickProject                                                                */
/* -------------------------------------------------------------------------- */

const ticking = new Set<string>();
const rerun = new Set<string>();

/**
 * Snapshot, reconcile, apply, until there is nothing left to do. Synchronous and idempotent: a call made while one is
 * running (an event a launch published) only asks the running one for another round.
 */
export function tickProject(root: string): void {
  const key = realOf(root);
  if (ticking.has(key)) {
    rerun.add(key);
    return;
  }
  ticking.add(key);
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      rerun.delete(key);
      const p = openPipeline(key);
      if (!p) return;
      const now = Date.now();
      const d = reconcile(p, snapshotOf(key, p), now);
      if (d.kind === "wait") {
        if (rerun.has(key)) continue;
        return;
      }
      if (d.kind === "control") setControl(p.id, d.control, d.units);
      else for (const l of d.launches) launchJob(p, l, now);
    }
  } finally {
    ticking.delete(key);
    rerun.delete(key);
  }
}

/* -------------------------------------------------------------------------- */
/* Start, continue, stop                                                      */
/* -------------------------------------------------------------------------- */

export function startPipeline(root: string, body: unknown): PipelineView {
  const key = realOf(root);
  const features = readFeatures(key).features;
  const config = parseConfig(body, { features, pairExists: (id) => HydraPairs.find(id) !== null });
  if (config.stages.map || config.stages.plan || config.stages.test) needBrowser();
  const open = openPipeline(key);
  if (open && open.control.kind !== "held") throw new QaConflict("A QA pipeline is already running in this project. Stop it or wait for it.");
  if (open) setControl(open.id, { kind: "ended", reason: "superseded", at: Date.now() }, null);
  const first = STAGES.find((s) => config.stages[s] !== undefined)!;
  const id = newId("qap") as PipelineId;
  const units = unitsFor(first, config, snapshotOf(key, null));
  db().prepare("INSERT INTO qa_pipelines (id, root_dir, config, control, units, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, key, JSON.stringify(config), JSON.stringify({ kind: "running", stage: first }), JSON.stringify(units), Date.now());
  tickProject(key);
  return viewOf(pipelineOf(key, id));
}

export function continuePipeline(root: string, id: string): PipelineView {
  const key = realOf(root);
  const p = pipelineOf(key, id);
  if (p.control.kind !== "held") throw new QaConflict("The pipeline is not waiting to continue.");
  const next = p.control.next;
  setControl(p.id, { kind: "running", stage: next }, unitsFor(next, p.config, snapshotOf(key, p)));
  tickProject(key);
  return viewOf(pipelineOf(key, id));
}

export function stopPipeline(root: string, id: string): PipelineView {
  const key = realOf(root);
  const p = pipelineOf(key, id);
  if (p.control.kind === "running") setControl(p.id, { kind: "stopping", stage: p.control.stage }, p.units);
  else if (p.control.kind === "held") setControl(p.id, { kind: "ended", reason: "stopped", at: Date.now() }, null);
  tickProject(key);
  return viewOf(pipelineOf(key, id));
}

/* -------------------------------------------------------------------------- */
/* Settling                                                                   */
/* -------------------------------------------------------------------------- */

const join = (problems: string[]): string | null => (problems.length ? problems.join("; ") : null);

/** What is wrong with the job's work, or null. Runs against the project folder. */
function checkJob(job: Job): string | null {
  const root = job.root;
  const problems: string[] = [];
  const units = job.units as readonly Unit[];
  switch (job.stage) {
    case "map": {
      const map = readFeatures(root);
      if (!map.exists) problems.push(`The agent did not write ${FEATURES_FILE}.`);
      else if (job.sigs.map !== null && job.sigs.map !== undefined && featuresSignature(root) === job.sigs.map) problems.push(`The agent did not change ${FEATURES_FILE}.`);
      else if (!map.features.length) problems.push(`${FEATURES_FILE} lists no features: each starts with "## ".`);
      else if (map.problem) problems.push(map.problem);
      break;
    }
    case "plan":
      for (const u of units as readonly FeatureId[]) {
        let plan: Plan;
        try {
          plan = readPlan(root, u);
        } catch {
          problems.push(`${u}: no plan written.`);
          continue;
        }
        if (plan.problem) problems.push(`${u}: ${plan.problem}`);
        else if (!plan.steps.length) problems.push(`${u}: the plan has no steps.`);
        else if (job.sigs[u] !== null && job.sigs[u] !== undefined && planSignature(root, u) === job.sigs[u]) problems.push(`${u}: the plan was not changed.`);
      }
      break;
    case "test": {
      const runs = job.session ? runsOfSession(job.session) : [];
      for (const u of units) {
        const run = runs.find((r) => r.feature === u);
        if (!run) problems.push(`${u}: the run is gone.`);
        else {
          const left = run.steps.filter((s) => s.outcome.state === "pending").length;
          if (left) problems.push(`${u}: ${left} of ${run.steps.length} steps not recorded.`);
        }
      }
      break;
    }
    case "fix":
      for (const u of units) {
        try {
          const status = readFinding(root, u).status;
          if (status !== "shipped" && status !== "dismissed") problems.push(`${u}: still open.`);
        } catch {
          problems.push(`${u}: the bug file is gone.`);
        }
      }
      if (job.session && getSession(job.session)?.pair_id) {
        const heads = unmergedHeads(job.session);
        if (heads.length) problems.push(`heads not merged: ${heads.map((h) => h.id).join(", ")}.`);
      }
      break;
  }
  return join(problems);
}

const settle = (id: JobId, problem: string | null): void => {
  db().prepare("UPDATE qa_jobs SET problem = ?, settled_at = ? WHERE id = ? AND settled_at IS NULL").run(problem, Date.now(), id);
};

/**
 * Settles the job when its lead's whole tree is idle: first one nudge turn when a head finished with commits nobody
 * merged, then the artifact check. A crashed head counts idle (treeIdle ignores status), so it cannot stall this.
 */
export function settleJob(session: string): void {
  const job = jobOfSession(session);
  if (!job || job.settledAt !== null || !job.session) return;
  const lead = getSession(job.session);
  if (!lead) return settle(job.id, "The session is gone.");
  if (!treeIdle(job.session)) return;
  if (job.nudgedTurns === null) {
    const heads = lead.status === "failed" || lead.status === "closed" ? [] : unmergedHeads(lead.id);
    if (heads.length) {
      try {
        send({ operator: true }, lead.id, NUDGE(heads.map((h) => h.id)));
      } catch {
        return;
      }
      db().prepare("UPDATE qa_jobs SET nudged_turns = ? WHERE id = ?").run(lead.turns, job.id);
      return;
    }
  } else if (lead.turns <= job.nudgedTurns && lead.status !== "failed" && lead.status !== "closed") return;
  settle(job.id, checkJob(job));
}

function settleProject(root: string): void {
  for (const r of db().prepare("SELECT * FROM qa_jobs WHERE root_dir = ? AND settled_at IS NULL AND session_id IS NOT NULL").all(root) as JobRow[]) settleJob(r.session_id!);
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                     */
/* -------------------------------------------------------------------------- */

let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function sweep(): void {
  const roots = db().prepare("SELECT DISTINCT root_dir FROM qa_pipelines WHERE json_extract(control, '$.kind') != 'ended'").all() as Array<{ root_dir: string }>;
  for (const { root_dir } of roots) {
    try {
      settleProject(root_dir);
      tickProject(root_dir);
    } catch (e) {
      console.warn(`[trb] QA pipeline sweep failed: ${(e as Error).message}`);
    }
  }
}

export function startQaDriver(): void {
  if (unsubscribe) return;
  unsubscribe = Hub.subscribe((e) => {
    if (e.type !== "turn_end" && !(e.type === "state" && e.status !== "running")) return;
    const job = jobOfSession(e.rootId);
    try {
      if (job) {
        settleJob(e.rootId);
        tickProject(job.root);
      } else if (e.type === "turn_end") {
        // A Lab fix ending frees the fix lock a fix stage may be waiting on.
        for (const r of db().prepare("SELECT root_dir FROM qa_pipelines WHERE json_extract(control, '$.kind') = 'running' AND json_extract(control, '$.stage') = 'fix'").all() as Array<{ root_dir: string }>) tickProject(r.root_dir);
      }
    } catch (err) {
      console.warn(`[trb] QA driver failed: ${(err as Error).message}`);
    }
  });
  timer = setInterval(sweep, SWEEP_MS);
  timer.unref?.();
  sweep();
}

export function stopQaDriver(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (timer) clearInterval(timer);
  timer = null;
}

/* -------------------------------------------------------------------------- */
/* The board                                                                  */
/* -------------------------------------------------------------------------- */

function boardBugs(root: string, features: readonly Feature[]): BoardBug[] {
  return listFindings(root)
    .filter(isBug)
    .map((f): BoardBug => {
      const where = bugFeature(f.bug.feature, f.bug.url, features);
      const fixing = f.status === "accepted" && !!f.fixSession && getSession(f.fixSession)?.status === "running";
      const state: BugState = f.status === "shipped" ? "fixed" : f.status === "dismissed" ? "dismissed" : f.status === "accepted" ? (fixing ? "fixing" : "needs-check") : "open";
      return {
        id: f.id,
        title: f.title,
        kind: f.bug.kind,
        impact: f.impact,
        status: f.status,
        state,
        url: f.bug.url,
        capture: f.bug.capture,
        shot: f.bug.shot,
        byAgent: f.bug.by === "agent",
        feature: where.feature,
        featureSource: where.source,
        summary: f.summary,
        problem: f.problem,
        fixSession: f.fixSession,
        updatedAt: f.updatedAt,
      };
    });
}

const closed = (b: BoardBug): number => (b.state === "fixed" || b.state === "dismissed" ? 1 : 0);
const bugOrder = (a: BoardBug, b: BoardBug): number => closed(a) - closed(b) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/** Everything the board shows, read once: features.md, the plans, the runs, the bugs and the pipeline. */
function boardData(root: string) {
  const key = realOf(root);
  const map = readFeatures(key);
  const { byFeature, loose } = listPlans(key);
  const bugs = boardBugs(key, map.features);
  const shown = newest(key);
  const jobs: Job[] = shown ? jobsOfPipeline(shown.id) : [];
  const pair = (s: string): boolean => isPair(s);

  const feature = (f: Feature): BoardFeature => {
    const plan = byFeature.get(f.id);
    const run = listRuns(key, f.id, 1)[0];
    const own = bugs.filter((b) => b.feature === f.id).sort(bugOrder);
    return {
      id: f.id,
      title: f.title,
      where: f.where,
      parent: f.parent,
      depth: f.parent ? 1 : 0,
      summary: f.summary,
      plan: !plan ? { kind: "missing" } : plan.problem ? { kind: "broken", problem: plan.problem } : { kind: "ready", steps: plan.steps.length, updatedAt: plan.updatedAt },
      test: run ? { kind: "ran", run } : { kind: "never" },
      bugs: own,
      activity: {
        plan: activityOf("plan", f.id, shown, jobs, pair),
        test: activityOf("test", f.id, shown, jobs, pair),
        fix: mergeActivity(own.map((b): Activity => activityOf("fix", b.id as BugId, shown, jobs, pair))),
      },
    };
  };

  const roots = map.features.filter((f) => !f.parent);
  const ordered = roots.flatMap((r) => [r, ...map.features.filter((c) => c.parent === r.id)]);
  return { key, map, byFeature, loose, bugs, shown, jobs, pair, feature, ordered };
}

export function qaBoard(root: string): QaBoard {
  const d = boardData(root);
  return {
    browser: browserEnabled(),
    map: { exists: d.map.exists, problem: d.map.problem, updatedAt: d.map.updatedAt, activity: activityOf("map", "map", d.shown, d.jobs, d.pair) },
    features: d.ordered.map(d.feature),
    bugsWithoutFeature: d.bugs.filter((b) => b.feature === null).sort(bugOrder),
    plansWithoutFeature: d.loose,
    pipeline: d.shown ? viewOf(d.shown) : null,
  };
}

export function featureDetail(root: string, id: string): FeatureDetail {
  const d = boardData(root);
  const f = d.map.features.find((x) => x.id === id);
  if (!f) throw new QaNotFound(`No feature "${id}".`);
  const plan = d.byFeature.get(f.id);
  const last = lastOutcomes(d.key, f.id);
  const runs = listRuns(d.key, f.id, 20);
  return {
    feature: d.feature(f),
    plan: plan
      ? { title: plan.title, intro: plan.intro, path: `${QA_DIR}/${f.id}.md`, steps: plan.steps.map((s) => ({ id: s.id, action: s.action, expected: s.expected, path: s.path, last: last[s.id] ?? null })), problem: plan.problem }
      : null,
    runs,
    lastRun: runs[0] ? getRun(runs[0].id as RunId) : null,
  };
}

export function runReply(root: string, id: string): RunReply {
  const rid = runId(id);
  const run = getRun(rid);
  if (!run || runRoot(rid) !== realOf(root)) throw new QaNotFound(`No run "${id}".`);
  return { run, summary: summarize(run) };
}

/** Removes a feature's plan and its runs. Refused while a plan or test job that covers it is working. */
export function deletePlan(root: string, slug: string): void {
  const key = realOf(root);
  const p = openPipeline(key);
  const busy = p ? jobsOfPipeline(p.id).some((j) => j.settledAt === null && j.session !== null && (j.stage === "plan" || j.stage === "test") && (j.units as readonly string[]).includes(slug)) : false;
  if (busy) throw new QaConflict(`A job is working on "${slug}". Wait for it.`);
  removePlan(key, slug);
}
