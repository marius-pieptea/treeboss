/**
 * The QA pipeline's data. The wire half is what crosses HTTP (docs/design/qa-pipeline.md §3): the web copies it byte for
 * byte, with plain strings. The domain half is the server's own, with branded ids.
 */

export const STAGES = ["map", "plan", "test", "fix"] as const;


export type Stage = "map" | "plan" | "test" | "fix";
export type Batching = "each" | "together";
export type Pace = "auto" | "step";
export type OutcomeState = "pending" | "pass" | "fail" | "skip" | "blocked";

/** Who runs the jobs. A pair's lead picks engine/model/effort; with a pair the agent fields do not exist. */
export type Driver =
  | { kind: "agent"; engine?: string | null; model?: string | null; effort?: string | null; agent?: string | null }
  | { kind: "pair"; pairId: string };

export type Scope =
  | { kind: "all" }
  | { kind: "features"; ids: string[] }
  | { kind: "bugs"; ids: string[] };

/** Absent key = stage skipped. At least one key (400 otherwise). Order is always STAGES order. */
export interface StageSettings {
  map?: Record<string, never>;
  plan?: { batching: Batching; replan?: boolean };
  test?: { batching: Batching };
  fix?: { batching: Batching };
}

/** POST /api/qa/:root/pipelines body. */
export interface PipelineRequest {
  stages: StageSettings;
  scope: Scope;
  pace: Pace;
  driver: Driver;
  note?: string;
  baseUrl?: string | null;
}

/** The config as the server stored it: defaults resolved (replan is always a boolean). */
export interface PipelineConfig {
  stages: {
    map?: Record<string, never>;
    plan?: { batching: Batching; replan: boolean };
    test?: { batching: Batching };
    fix?: { batching: Batching };
  };
  scope: Scope;
  pace: Pace;
  driver: Driver;
  note: string;
  baseUrl: string | null;
}

export type Control =
  | { kind: "running"; stage: Stage }
  | { kind: "held"; after: Stage; next: Stage }
  | { kind: "stopping"; stage: Stage }
  | { kind: "ended"; reason: "done" | "stopped" | "superseded"; at: number };

export interface JobView {
  id: string;
  stage: Stage;
  units: string[];
  sessionId: string | null;
  pair: boolean;
  state: "running" | "merging" | "settled";
  problem: string | null;
  error: string | null;
  startedAt: number;
  settledAt: number | null;
}

export type StageState = "done" | "current" | "held" | "next" | "skipped";

export interface PipelineView {
  id: string;
  config: PipelineConfig;
  control: Control;
  stages: Array<{ stage: Stage; state: StageState; done: number; total: number; problems: number }>;
  jobs: JobView[];
  createdAt: number;
}

export type Activity =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "working"; sessionId: string; pair: boolean }
  | { kind: "problem"; text: string; sessionId: string | null };

export type PlanCell = { kind: "missing" } | { kind: "ready"; steps: number; updatedAt: number } | { kind: "broken"; problem: string };

export interface RunSummary {
  id: string;
  feature: string;
  startedAt: number;
  counts: Record<OutcomeState, number>;
  finished: boolean;
  sessionId: string | null;
}

export type TestCell = { kind: "never" } | { kind: "ran"; run: RunSummary };

export type BugState = "open" | "fixing" | "needs-check" | "fixed" | "dismissed";

export interface BoardBug {
  id: string;
  title: string;
  kind: "functional" | "visual" | "logic" | "content" | "performance";
  impact: "high" | "medium" | "low";
  status: "new" | "accepted" | "dismissed" | "shipped";
  state: BugState;
  url: string;
  capture: string | null;
  shot: "desktop" | "rerender" | "agent" | "none";
  byAgent: boolean;
  feature: string | null;
  featureSource: "stored" | "url" | null;
  summary: string;
  problem: string | null;
  fixSession: string | null;
  updatedAt: number;
}

export interface BoardFeature {
  id: string;
  title: string;
  where: string[];
  parent: string | null;
  depth: 0 | 1;
  summary: string;
  plan: PlanCell;
  test: TestCell;
  bugs: BoardBug[];
  activity: { plan: Activity; test: Activity; fix: Activity };
}

export interface QaBoard {
  browser: boolean;
  map: { exists: boolean; problem: string | null; updatedAt: number | null; activity: Activity };
  features: BoardFeature[];
  bugsWithoutFeature: BoardBug[];
  plansWithoutFeature: Array<{ slug: string; title: string; steps: number; problem: string | null; path: string }>;
  pipeline: PipelineView | null;
}

export interface PlanStepView { id: string; action: string; expected: string; path: string | null; last: OutcomeState | null }

export type Outcome =
  | { state: "pending" }
  | { state: "pass" | "skip"; at: number; note: string }
  | { state: "blocked"; at: number; note: string }
  | { state: "fail"; at: number; actual: string; bug: string | null };

export interface Run {
  id: string;
  feature: string;
  startedAt: number;
  sessionId: string | null;
  steps: Array<{ id: string; action: string; expected: string; path: string | null; outcome: Outcome }>;
}

/** GET /api/qa/:root/features/:id */
export interface FeatureDetail {
  feature: BoardFeature;
  plan: { title: string; intro: string; path: string; steps: PlanStepView[]; problem: string | null } | null;
  runs: RunSummary[];
  lastRun: Run | null;
}

/** GET /api/qa/:root/runs/:id */
export interface RunReply { run: Run; summary: RunSummary }

export interface ErrorBody { error: string }


export type FeatureId = string & { readonly __brand: "FeatureId" };
export type BugId = string & { readonly __brand: "BugId" };
export type PipelineId = string & { readonly __brand: "PipelineId" };
export type JobId = string & { readonly __brand: "JobId" };
export type RunId = string & { readonly __brand: "RunId" };
export type StepId = string & { readonly __brand: "StepId" };
export type StepPath = string & { readonly __brand: "StepPath" };
export type NonEmpty<T> = readonly [T, ...T[]];

export type Unit = "map" | FeatureId | BugId;

export interface Feature { id: FeatureId; title: string; where: string[]; parent: FeatureId | null; summary: string }
export interface PlanStep { id: StepId; action: string; expected: string; path: StepPath | null }
export interface Plan { feature: FeatureId; title: string; intro: string; steps: PlanStep[]; problem: string | null }

/** A qa_pipelines row, parsed. `units` are the units of control's stage, fixed when that stage opened (null while held or ended). */
export interface Pipeline { id: PipelineId; root: string; config: PipelineConfig; control: Control; units: Unit[] | null; createdAt: number }

/** A qa_jobs row, parsed. Written at launch; afterwards only nudged_turns, problem and settled_at change (jobs.ts only). */
export interface Job {
  id: JobId; pipeline: PipelineId; root: string; stage: Stage; units: NonEmpty<Unit>;
  session: string | null; error: string | null;
  /** Artifact signatures at launch: map → { map: sig|null }; plan → { [featureId]: sig|null }; else {}. */
  sigs: Record<string, string | null>;
  /** lead.turns when the merge nudge was sent; null = not nudged. */
  nudgedTurns: number | null;
  problem: string | null; startedAt: number; settledAt: number | null;
}

export interface Snapshot {
  features: readonly Feature[];
  mapExists: boolean;
  plans: ReadonlyMap<FeatureId, { steps: number; problem: string | null }>;
  /** Open = status new|accepted. feature = stored ?? featureForUrl ?? null (same rule as the board). */
  openBugs: ReadonlyArray<{ id: BugId; feature: FeatureId | null }>;
  /** This pipeline's jobs; active = settledAt === null && session !== null. */
  jobs: ReadonlyArray<Job & { active: boolean }>;
  /** runningFix(root) names a session that is not a job of this pipeline. */
  fixBusyElsewhere: boolean;
}

export type Launch =
  | { stage: "map"; units: readonly ["map"] }
  | { stage: "plan" | "test"; units: NonEmpty<FeatureId> }
  | { stage: "fix"; units: NonEmpty<BugId> };

export type Decision =
  | { kind: "wait" }
  | { kind: "launch"; launches: NonEmpty<Launch> }
  /** units: present exactly when control becomes running(stage): that stage's frozen units. */
  | { kind: "control"; control: Control; units: Unit[] | null };
