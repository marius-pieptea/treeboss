/**
 * The QA layer's data. A plan is a markdown file in the repo (lab/qa/<slug>.md); a proposal is a step the agent
 * suggests (lab/qa/<slug>.proposals.md); a run is a frozen copy of a plan's steps with an outcome per step (SQLite).
 */
export type PlanSlug = string & { __brand: "PlanSlug" };
export type StepId = string & { __brand: "StepId" };
export type ProposalId = string & { __brand: "ProposalId" };
export type RunId = string & { __brand: "RunId" };
/** "/..." only: a localhost URL is stored as its path. */
export type StepPath = string & { __brand: "StepPath" };

export interface PlanStep {
  id: StepId;
  action: string;
  expected: string;
  path: StepPath | null;
}

export type NewStep = Omit<PlanStep, "id">;

export type PlanSource = { kind: "spec"; dir: string } | { kind: "diff"; base: string; head: string } | { kind: "page"; path: StepPath } | { kind: "text" } | { kind: "manual" };

export interface Proposal {
  id: ProposalId;
  step: NewStep;
  after: StepId | "start";
  why: string;
  /** The step it was anchored to is gone: `after` is the end of the plan instead. */
  orphan: boolean;
}

export interface Plan {
  slug: PlanSlug;
  title: string;
  source: PlanSource;
  intro: string;
  steps: PlanStep[];
  proposals: Proposal[];
  /** The plan file cannot be read as a plan. Its steps are empty and it cannot be edited. */
  problem: string | null;
  /** The proposals file cannot be read: the plan itself is fine. */
  proposalsProblem: string | null;
}

export type PlanEdit =
  | { op: "add"; step: NewStep; after: StepId | "start" }
  | { op: "update"; id: StepId; fields: Partial<NewStep> }
  | { op: "move"; id: StepId; after: StepId | "start" }
  | { op: "remove"; id: StepId };

export type Outcome =
  | { state: "pending" }
  | { state: "pass" | "skip"; at: number; note: string }
  | { state: "blocked"; at: number; note: string }
  | { state: "fail"; at: number; actual: string; bug: string | null };

export type OutcomeState = Outcome["state"];

export interface RunStep extends PlanStep {
  outcome: Outcome;
}

/** Progress, finished and the current step are computed from `steps`, never stored. */
export interface Run {
  id: RunId;
  plan: PlanSlug;
  root: string;
  startedAt: number;
  steps: RunStep[];
}

export type RunCounts = Record<OutcomeState, number>;

export interface RunSummary {
  id: RunId;
  plan: PlanSlug;
  startedAt: number;
  counts: RunCounts;
  finished: boolean;
  /** Each step's outcome state in this run. */
  states: Record<string, OutcomeState>;
  /** The session of the agent that walked this run; null for a run a person did. Set by listRuns. */
  agentSession?: string | null;
}

export interface PlanSummary {
  slug: PlanSlug;
  title: string;
  steps: number;
  proposals: number;
  problem: string | null;
  updatedAt: number;
  lastRun: RunSummary | null;
}

export const FOCUS = ["errors", "edge-cases", "mobile", "accessibility", "empty-states", "permissions"] as const;
export type Focus = (typeof FOCUS)[number];

/**
 * What a QA session is asked to do. draft and suggest write proposals; explore drives the app like a user, logs the bugs
 * it meets and writes its walk as proposals; run walks one run's steps in the browser and records each outcome; map
 * writes the feature map (features.ts).
 */
export type QaAsk =
  | { kind: "draft"; from: PlanSource; note: string }
  | { kind: "suggest"; focus: Focus[]; note: string }
  | { kind: "explore"; from: PlanSource; note: string; baseUrl: string | null }
  | { kind: "run"; run: RunId; note: string; baseUrl: string | null; batch: string | null }
  | { kind: "map"; note: string; baseUrl: string | null };

export type QaKind = QaAsk["kind"];

export type Decision = "accept" | "reject";

/** The QA session of a plan (or of the feature map), as the panel shows it. */
export interface QaSessionInfo {
  sessionId: string;
  kind: QaKind;
  running: boolean;
  /** Set when the turn ended without the work it was asked for: proposals missing or malformed, steps left unrecorded. */
  problem: string | null;
  /** The run an agent run walks (kind "run"). */
  runId: RunId | null;
  /** The end-to-end batch that started it, if any. */
  batchId: string | null;
}

/** One feature of the product, from `lab/features.md`: what a user can do, where, and the plans that test it. */
export interface Feature {
  id: string;
  title: string;
  /** The pages it lives on ("/..."), as written. */
  where: string[];
  /** Plan slugs, as written: one that does not exist is shown as missing. */
  plans: string[];
  summary: string;
}

/** How well a feature is tested, from its plans' last runs. */
export type Coverage = "no-plan" | "not-run" | "failing" | "partial" | "passing";

export interface FeaturePlan {
  slug: string;
  title: string | null;
  exists: boolean;
  steps: number;
  lastRun: RunSummary | null;
}

export interface FeatureView extends Feature {
  planInfo: FeaturePlan[];
  coverage: Coverage;
}

export interface BatchView {
  id: string;
  plans: string[];
  /** How many plans were started (or skipped) so far. */
  next: number;
  /** The plan whose run is going now, or null. */
  current: string | null;
  running: boolean;
  cancelled: boolean;
  /** Plans that could not start, with why. */
  errors: Array<{ plan: string; error: string }>;
  createdAt: number;
}
