import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, patch, post } from "@/lib/api";

export const STAGES = ["map", "plan", "test", "fix"] as const;
export const FEATURE_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const BUG_ID = /^bug-[a-z0-9][a-z0-9-]*$/;

// ---- wire: a byte-for-byte copy of docs/design/qa-pipeline.md section 3, without the brands ----

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
  | { kind: "features"; ids: string[] } // ≥1, each matches FEATURE_ID and exists in features.md (400 otherwise; ids missing at a later stage are dropped)
  | { kind: "bugs"; ids: string[] }; // ≥1 bug ids; only with stages = { fix } (400 otherwise)

/** Absent key = stage skipped. At least one key (400 otherwise). Order is always STAGES order. */
export interface StageSettings {
  map?: Record<string, never>;
  plan?: { batching: Batching; replan?: boolean }; // replan omitted → scope "all": false; scope "features": true
  test?: { batching: Batching };
  fix?: { batching: Batching };
}

/** POST /api/qa/:root/pipelines body. */
export interface PipelineRequest {
  stages: StageSettings;
  scope: Scope;
  pace: Pace;
  driver: Driver;
  note?: string; // ≤ 4000 chars after trim
  baseUrl?: string | null; // http(s) only; trailing "/" removed
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

/** The only stored progress of a pipeline. */
export type Control =
  | { kind: "running"; stage: Stage }
  | { kind: "held"; after: Stage; next: Stage } // only under pace "step"
  | { kind: "stopping"; stage: Stage } // stop asked; running jobs finish, nothing new starts
  | { kind: "ended"; reason: "done" | "stopped" | "superseded"; at: number };

export interface JobView {
  id: string; // qaj_…
  stage: Stage;
  units: string[]; // ["map"] | feature ids | bug ids
  sessionId: string | null; // null: the launch failed (see error)
  pair: boolean; // the session is a Hydra lead
  state: "running" | "merging" | "settled"; // merging: the lead was nudged to merge its heads
  problem: string | null; // settled without its work, per the artifact check
  error: string | null; // the launch threw; never retried
  startedAt: number;
  settledAt: number | null;
}

export type StageState = "done" | "current" | "held" | "next" | "skipped";

export interface PipelineView {
  id: string; // qap_…
  config: PipelineConfig;
  control: Control;
  /** One entry per STAGES item. total/done count units of that stage (0/0 when it has not opened yet or is skipped). */
  stages: Array<{ stage: Stage; state: StageState; done: number; total: number; problems: number }>;
  jobs: JobView[]; // every job of this pipeline, oldest first
  createdAt: number;
}

export type Activity =
  | { kind: "idle" }
  | { kind: "queued" } // in the current stage's units, not yet covered by a job
  | { kind: "working"; sessionId: string; pair: boolean } // covered by an unsettled job
  | { kind: "problem"; text: string; sessionId: string | null }; // latest settled job covering it has a problem or error

export type PlanCell = { kind: "missing" } | { kind: "ready"; steps: number; updatedAt: number } | { kind: "broken"; problem: string };

export interface RunSummary {
  id: string; // qa_…
  feature: string;
  startedAt: number;
  counts: Record<OutcomeState, number>;
  finished: boolean; // counts.pending === 0
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
  /** Derived on the server only: shipped→fixed, dismissed→dismissed, accepted→(fix session running ? fixing : needs-check), new→open. */
  state: BugState;
  url: string;
  capture: string | null; // evidence id; screenshot at GET /api/evidence/:root/:capture/file/screenshot.png when shot !== "none"
  shot: "desktop" | "rerender" | "agent" | "none";
  byAgent: boolean; // found_by: agent
  feature: string | null; // the feature it is shown under: stored, else featureForUrl, else null
  featureSource: "stored" | "url" | null;
  summary: string;
  problem: string | null; // the finding file is malformed
  fixSession: string | null;
  updatedAt: number;
}

export interface BoardFeature {
  id: string;
  title: string;
  where: string[];
  parent: string | null; // a feature id, one level only
  depth: 0 | 1;
  summary: string;
  plan: PlanCell;
  test: TestCell;
  bugs: BoardBug[]; // every bug shown under this feature, open first, then by updatedAt desc
  activity: { plan: Activity; test: Activity; fix: Activity };
}

export interface QaBoard {
  browser: boolean; // the agent browser is on (map, plan and test need it)
  map: { exists: boolean; problem: string | null; updatedAt: number | null; activity: Activity };
  /** features.md order, each child right after its parent; a child whose parent is unknown is shown at depth 0. */
  features: BoardFeature[];
  bugsWithoutFeature: BoardBug[];
  plansWithoutFeature: Array<{ slug: string; title: string; steps: number; problem: string | null; path: string }>;
  /** The pipeline that is not ended, else the newest ended one, else null. */
  pipeline: PipelineView | null;
}

export interface PlanStepView {
  id: string;
  action: string;
  expected: string;
  path: string | null;
  last: OutcomeState | null;
}

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
  /** last = the step's newest non-pending outcome across this feature's runs (by step id). */
  plan: { title: string; intro: string; path: string; steps: PlanStepView[]; problem: string | null } | null;
  runs: RunSummary[]; // newest first, at most 20
  lastRun: Run | null;
}

/** GET /api/qa/:root/runs/:id */
export interface RunReply {
  run: Run;
  summary: RunSummary;
}

export interface ErrorBody {
  error: string;
}

// PATCH /api/lab/:root/findings/:id   body (all optional; confirmed is gone and now a 400 "Unknown field confirmed.")
export interface FindingPatchBody {
  status?: "new" | "accepted" | "dismissed" | "shipped";
  impact?: "high" | "medium" | "low";
  effort?: "s" | "m" | "l";
  feature?: string | null;
}

// ---- end of the wire copy ----

const base = (root: string) => `/api/qa/${root}`;

/** How often the board is read again: fast while a pipeline works, slow otherwise (react-query pauses it in a hidden tab). */
export const refetchMs = (board: Pick<QaBoard, "pipeline"> | undefined): number => {
  const k = board?.pipeline?.control.kind;
  return k === "running" || k === "stopping" ? 3000 : 15_000;
};

/** The Lab PATCH body for a bug: only the fields that were given. A feature of null clears it. */
export function bugPatchBody(p: { status?: FindingPatchBody["status"]; feature?: string | null }): FindingPatchBody {
  const body: FindingPatchBody = {};
  if (p.status !== undefined) body.status = p.status;
  if (p.feature !== undefined) body.feature = p.feature;
  return body;
}

export const qaKey = {
  board: (root: string) => ["qa", root, "board"] as const,
  feature: (root: string, id: string) => ["qa", root, "feature", id] as const,
  run: (root: string, id: string) => ["qa", root, "run", id] as const,
};

export function useQaBoard(root: string | null) {
  return useQuery({
    queryKey: qaKey.board(root ?? ""),
    enabled: !!root,
    queryFn: () => get<QaBoard>(base(root!)),
    refetchInterval: (q) => refetchMs(q.state.data),
    staleTime: 1000,
  });
}

export function useFeatureDetail(root: string, id: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qaKey.feature(root, id ?? ""),
    enabled: !!id,
    queryFn: () => get<FeatureDetail>(`${base(root)}/features/${encodeURIComponent(id!)}`),
    refetchInterval: () => refetchMs(qc.getQueryData<QaBoard>(qaKey.board(root))),
    staleTime: 1000,
  });
}

export function useRun(root: string, id: string | null) {
  return useQuery({
    queryKey: qaKey.run(root, id ?? ""),
    enabled: !!id,
    queryFn: () => get<RunReply>(`${base(root)}/runs/${encodeURIComponent(id!)}`),
    staleTime: 5000,
  });
}

export function useQaActions(root: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["qa", root] });
    void qc.invalidateQueries({ queryKey: ["lab", root] });
  };
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");
  const adopt = (r: { pipeline: PipelineView }) => {
    qc.setQueryData<QaBoard>(qaKey.board(root), (b) => (b ? { ...b, pipeline: r.pipeline } : b));
    refresh();
  };
  const pipeline = (id: string) => `${base(root)}/pipelines/${encodeURIComponent(id)}`;
  return {
    start: useMutation({ mutationFn: (req: PipelineRequest) => post<{ pipeline: PipelineView }>(`${base(root)}/pipelines`, req), onSuccess: adopt, onError }),
    cont: useMutation({ mutationFn: (id: string) => post<{ pipeline: PipelineView }>(`${pipeline(id)}/continue`), onSuccess: adopt, onError }),
    stop: useMutation({ mutationFn: (id: string) => post<{ pipeline: PipelineView }>(`${pipeline(id)}/stop`), onSuccess: adopt, onError }),
    deletePlan: useMutation({ mutationFn: (slug: string) => del<{ ok: true }>(`${base(root)}/plans/${encodeURIComponent(slug)}`), onSuccess: refresh, onError }),
    setBug: useMutation({
      mutationFn: (v: { id: string; status?: FindingPatchBody["status"]; feature?: string | null }) => patch<{ finding: unknown }>(`/api/lab/${root}/findings/${encodeURIComponent(v.id)}`, bugPatchBody(v)),
      onSuccess: refresh,
      onError,
    }),
  };
}

export type QaActions = ReturnType<typeof useQaActions>;
