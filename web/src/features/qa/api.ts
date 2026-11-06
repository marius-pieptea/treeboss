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

export interface QaSession {
  sessionId: string;
  kind: "draft" | "suggest";
  running: boolean;
  /** The turn ended without usable proposals. */
  problem: string | null;
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

export const useRun = (root: string, id: string | null) =>
  useQuery({ queryKey: qaKey.run(root, id ?? ""), enabled: !!id, queryFn: () => get<RunReply>(`${base(root)}/runs/${encodeURIComponent(id!)}`).then((r) => r.run), staleTime: 1000 });

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
    mark: mut((v: { runId: string; stepId: string; outcome: OutcomeInput }) => put<RunReply>(`${base(root)}/runs/${encodeURIComponent(v.runId)}/steps/${encodeURIComponent(v.stepId)}`, { outcome: v.outcome }), (r, v) => {
      qc.setQueryData(qaKey.run(root, v.runId), r.run);
      refresh();
    }),
  };
}

export type QaActions = ReturnType<typeof useQaActions>;
