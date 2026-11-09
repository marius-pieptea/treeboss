import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, patch, post, put } from "@/lib/api";

/** Web copy of the QA types the daemon serves under /api/qa. */
export type StepPath = string;

export interface PlanStep {
  id: string;
  action: string;
  expected: string;
  path: StepPath | null;
}

export type PlanSource = { kind: "spec"; dir: string } | { kind: "diff"; base: string; head: string } | { kind: "page"; path: StepPath } | { kind: "text" } | { kind: "manual" };

export interface Proposal {
  id: string;
  step: Omit<PlanStep, "id">;
  /** The step id it goes after, or "start". */
  after: string | "start";
  why: string;
  /** The step it was anchored to is gone: it sits at the end of the plan. */
  orphan: boolean;
}

export interface Plan {
  slug: string;
  title: string;
  source: PlanSource;
  intro: string;
  steps: PlanStep[];
  proposals: Proposal[];
  problem: string | null;
  proposalsProblem: string | null;
}

export type StepFields = { action: string; expected?: string; path?: StepPath | null };
export type PlanEdit = { op: "add"; step: StepFields; after: string | "start" } | { op: "update"; id: string; fields: Partial<StepFields> } | { op: "move"; id: string; after: string | "start" } | { op: "remove"; id: string };

export type OutcomeState = "pending" | "pass" | "fail" | "skip" | "blocked";
export type Outcome =
  | { state: "pending" }
  | { state: "pass" | "skip"; at: number; note: string }
  | { state: "blocked"; at: number; note: string }
  | { state: "fail"; at: number; actual: string; bug: string | null };

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
/** What the panel sends: the daemon stamps `at`. `{ state: "pending" }` undoes a mark. */
export type OutcomeInput = DistributiveOmit<Outcome, "at">;

export interface RunStep extends PlanStep {
  outcome: Outcome;
}

export interface Run {
  id: string;
  plan: string;
  root: string;
  startedAt: number;
  steps: RunStep[];
}

export type RunCounts = Record<OutcomeState, number>;

export interface RunSummary {
  id: string;
  plan: string;
  startedAt: number;
  counts: RunCounts;
  finished: boolean;
  states: Record<string, OutcomeState>;
  /** The session of the agent that walked this run; null for a run a person did. */
  agentSession?: string | null;
}

/** A step's newest marked outcome across the plan's runs. */
export interface StepHistory {
  run: string;
  at: number;
  outcome: Exclude<Outcome, { state: "pending" }>;
}

export type Focus = "errors" | "edge-cases" | "mobile" | "accessibility" | "empty-states" | "permissions";
export const FOCUSES: Array<{ id: Focus; label: string }> = [
  { id: "errors", label: "Errors" },
  { id: "edge-cases", label: "Edge cases" },
  { id: "mobile", label: "Mobile" },
  { id: "accessibility", label: "Accessibility" },
  { id: "empty-states", label: "Empty states" },
  { id: "permissions", label: "Permissions" },
];

export interface PlanSummary {
  slug: string;
  title: string;
  steps: number;
  proposals: number;
  problem: string | null;
  updatedAt: number;
  lastRun: RunSummary | null;
}

/** draft and suggest write proposals; explore drives the app and logs bugs; run walks a run's steps; map writes the feature map. */
export interface QaSession {
  sessionId: string;
  kind: "draft" | "suggest" | "explore" | "run" | "map";
  running: boolean;
  /** The turn ended without its work: no usable proposals, steps left unrecorded, no feature map. */
  problem: string | null;
  /** The run an agent run walks. */
  runId: string | null;
  batchId: string | null;
}

export type Coverage = "no-plan" | "not-run" | "failing" | "partial" | "passing";

export interface FeaturePlan {
  slug: string;
  title: string | null;
  exists: boolean;
  steps: number;
  lastRun: RunSummary | null;
}

/** A feature from lab/features.md, with how well its plans test it. */
export interface Feature {
  id: string;
  title: string;
  where: string[];
  plans: string[];
  summary: string;
  planInfo: FeaturePlan[];
  coverage: Coverage;
}

/** An end-to-end run: plans run by an agent one after another. */
export interface BatchView {
  id: string;
  plans: string[];
  next: number;
  current: string | null;
  running: boolean;
  cancelled: boolean;
  errors: Array<{ plan: string; error: string }>;
  createdAt: number;
}

export interface FeaturesView {
  features: Feature[];
  problem: string | null;
  exists: boolean;
  session: QaSession | null;
  batch: BatchView | null;
}

/** Runs are newest first. */
export interface PlanView {
  plan: Plan;
  runs: RunSummary[];
  lastOutcomes: Record<string, StepHistory>;
  session: QaSession | null;
}

export interface RunReply {
  run: Run;
  summary: RunSummary;
}

export interface NewPlanInput {
  title: string;
  from?: PlanSource;
  note?: string;
  /** An agent explores the app instead of drafting from the source. */
  explore?: boolean;
  /** Where the app runs, for an exploring agent. Without it the agent finds the app itself. */
  baseUrl?: string;
}

export interface BugDraft {
  title: string;
  kind: "functional";
  steps: string[];
  expected: string;
  actual: string;
  path: StepPath | null;
}

const base = (root: string) => `/api/qa/${root}`;

export const qaKey = {
  plans: (root: string) => ["qa", root, "plans"] as const,
  plan: (root: string, slug: string) => ["qa", root, "plan", slug] as const,
  run: (root: string, id: string) => ["qa", root, "run", id] as const,
  features: (root: string) => ["qa", root, "features"] as const,
};

export const usePlans = (root: string) =>
  useQuery({ queryKey: qaKey.plans(root), queryFn: () => get<{ plans: PlanSummary[] }>(`${base(root)}/plans`).then((r) => r.plans), staleTime: 2000 });

/** The drafting agent writes the plan while its session runs: look again every 2s until it stops. */
export const usePlan = (root: string, slug: string | null) =>
  useQuery({
    queryKey: qaKey.plan(root, slug ?? ""),
    enabled: !!slug,
    queryFn: () => get<PlanView>(`${base(root)}/plans/${encodeURIComponent(slug!)}`),
    refetchInterval: (q) => (q.state.data?.session?.running ? 2000 : false),
    staleTime: 1000,
  });

/** `live`: an agent is recording this run's steps now, so it is read again every 2s. */
export const useRun = (root: string, id: string | null, live = false) =>
  useQuery({ queryKey: qaKey.run(root, id ?? ""), enabled: !!id, queryFn: () => get<RunReply>(`${base(root)}/runs/${encodeURIComponent(id!)}`).then((r) => r.run), staleTime: 1000, refetchInterval: live ? 2000 : false });

/** The feature map, its mapping session and the newest end-to-end run: read again every 3s while either works. */
export const useFeatures = (root: string) =>
  useQuery({
    queryKey: qaKey.features(root),
    queryFn: () => get<FeaturesView>(`${base(root)}/features`),
    refetchInterval: (q) => (q.state.data?.session?.running || q.state.data?.batch?.running ? 3000 : false),
    staleTime: 1000,
  });

/** Who runs an agent session: the engine choice, as the lab and design launchers send it. */
export type AgentChoice = { engine?: string | null; model?: string | null; effort?: string | null; agent?: string | null; pairId?: string | null };

export function useQaActions(root: string) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["qa", root] });
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");
  const mut = <V, R>(fn: (v: V) => Promise<R>, ok: (r: R, v: V) => void = refresh) => useMutation({ mutationFn: fn, onSuccess: ok, onError });
  const plan = (slug: string) => `${base(root)}/plans/${encodeURIComponent(slug)}`;
  return {
    create: mut((v: NewPlanInput) => post<{ plan: Plan; session: QaSession | null }>(`${base(root)}/plans`, v)),
    edit: mut((v: { slug: string; edit: PlanEdit }) => patch<{ plan: Plan }>(plan(v.slug), { edit: v.edit })),
    remove: mut((slug: string) => del<{ ok: true }>(plan(slug))),
    decide: mut((v: { slug: string; pid: string | "all"; decision: "accept" | "reject" }) => post<{ plan: Plan }>(`${plan(v.slug)}/proposals/${encodeURIComponent(v.pid)}`, { decision: v.decision })),
    suggest: mut((v: { slug: string; focus: Focus[]; note: string }) => post<{ session: QaSession }>(`${plan(v.slug)}/suggest`, { focus: v.focus, note: v.note })),
    start: mut((slug: string) => post<RunReply>(`${plan(slug)}/runs`, {})),
    /** A run walked by an agent in its own browser: it records each step and logs the bugs it finds. */
    startAgent: mut((v: { slug: string; baseUrl?: string; note?: string } & AgentChoice) => post<RunReply & { session: QaSession | null }>(`${plan(v.slug)}/runs`, { ...v, agent: true })),
    explore: mut((v: { slug: string; baseUrl?: string; note?: string } & AgentChoice) => post<{ session: QaSession }>(`${plan(v.slug)}/explore`, v)),
    mapFeatures: mut((v: { baseUrl?: string; note?: string } & AgentChoice) => post<{ session: QaSession }>(`${base(root)}/features/map`, v)),
    planFeature: mut((v: { id: string } & AgentChoice) => post<{ plan: Plan; session: QaSession }>(`${base(root)}/features/${encodeURIComponent(v.id)}/plan`, v)),
    e2e: mut((v: { features?: string[]; plans?: string[]; baseUrl?: string } & AgentChoice) => post<{ batch: BatchView }>(`${base(root)}/e2e`, v)),
    cancelBatch: mut((id: string) => post<{ batch: BatchView }>(`${base(root)}/batches/${encodeURIComponent(id)}/cancel`, {})),
    mark: mut((v: { runId: string; stepId: string; outcome: OutcomeInput }) => put<RunReply>(`${base(root)}/runs/${encodeURIComponent(v.runId)}/steps/${encodeURIComponent(v.stepId)}`, { outcome: v.outcome }), (r, v) => {
      qc.setQueryData(qaKey.run(root, v.runId), r.run);
      refresh();
    }),
  };
}

export type QaActions = ReturnType<typeof useQaActions>;
