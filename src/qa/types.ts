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

export type QaAsk = { kind: "draft"; from: PlanSource; note: string } | { kind: "suggest"; focus: Focus[]; note: string };

export type Decision = "accept" | "reject";

/** The QA session of a plan, as the panel shows it. */
export interface QaSessionInfo {
  sessionId: string;
  kind: QaAsk["kind"];
  running: boolean;
  /** Set when the turn ended and the proposals file was missing, empty or malformed. */
  problem: string | null;
}
