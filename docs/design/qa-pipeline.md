# QA pipeline: implementation contract

This is the contract four builders work from in parallel. It synthesizes architect sketches A (reconciler) and B (stage
queues) with the lead's final decisions. When this doc and a builder's judgment disagree, the doc wins, and the builder
reports the disagreement and does not work around it. Where the doc says "exactly", copy it character for character.

## 1. What changes, in one paragraph

The QA tab and the Bugs tab become one QA view, tab kind `"qa"`. It shows a grid of features (from `lab/features.md`).
Each row has a Plan cell, a Test cell, and the feature's bugs inline. A run bar starts a **pipeline**: any non-empty
subset of the stages Map → Plan → Test → Fix, in that order. A pipeline has a scope (all features, some features, or some
bugs), a pace (auto, or stop after each stage), a batching per stage (one session per unit, or one session for all
units) and a driver (a single agent or a Hydra pair).

These go away:
- proposals, bug confirmation and manual step-by-step runs;
- the browser QA dock;
- `qa_batches`, `qa_sessions` and the `fix` kind of `lab_sweeps`.

The server stores one `qa_pipelines` row per pipeline and one `qa_jobs` row per launched session. A pure `reconcile()`
decides every launch and every control move from a snapshot.

## 2. Shared constants (both sides of HTTP use these exact values)

```ts
export const STAGES = ["map", "plan", "test", "fix"] as const;          // order is the run order
export const FEATURE_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;                    // a feature id is also its plan's file name
export const BUG_ID = /^bug-[a-z0-9][a-z0-9-]*$/;
export const PARALLEL = { map: 1, plan: 3, test: 1, fix: 1 } as const;  // server only; never on the wire
export const PAIR_HEAD_CAP = 6;                                           // heads at once = min(6, pair.max_heads ?? 6)
```

### `featureForUrl(features, url)`

It is implemented twice: the server in `src/qa/features.ts`, the web in `web/src/features/qa/logic.ts`. Both
implementations must pass the same test vectors below.

Take `path` = `new URL(url).pathname` with any trailing `/` removed (the root path `/` stays `/`). A feature *matches*
when one of its `where` entries `w` (trailing `/` removed, except `/`) satisfies `path === w` or
`path.startsWith(w === "/" ? "/" : w + "/")`. The score is the length of the longest matching `w`. The result is the id
of the single feature with the highest score. It is `null` when nothing matches, when two features tie on the highest
score, or when the URL does not parse.

| features (id: where) | url | result |
|---|---|---|
| `cart: /cart`, `checkout: /cart/checkout` | `http://localhost:3000/cart/checkout?x=1` | `checkout` |
| `cart: /cart` | `http://localhost:3000/cart/` | `cart` |
| `cart: /cart` | `http://localhost:3000/cartoon` | `null` |
| `home: /`, `cart: /cart` | `http://localhost:3000/about` | `home` |
| `a: /x`, `b: /x` | `http://localhost:3000/x/1` | `null` (tie) |
| any | `not a url` | `null` |

## 3. Wire types (every JSON shape that crosses HTTP)

S2 declares these in `src/qa/types.ts` under a `// ---- wire ----` banner. S3 copies them byte for byte into
`web/src/features/qa/api.ts`, with no brands, because the web uses plain strings. A test in each slice checks the
copy: S3 asserts the web `STAGES` equals the server `STAGES`. An error reply is always `{ error: string }` with status
400, 404 or 409. 401 is the daemon's usual auth reply.

```ts
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
  | { kind: "features"; ids: string[] }   // ≥1, each matches FEATURE_ID and exists in features.md (400 otherwise; ids missing at a later stage are dropped)
  | { kind: "bugs"; ids: string[] };      // ≥1 bug ids; only with stages = { fix } (400 otherwise)

/** Absent key = stage skipped. At least one key (400 otherwise). Order is always STAGES order. */
export interface StageSettings {
  map?: Record<string, never>;
  plan?: { batching: Batching; replan?: boolean };   // replan omitted → scope "all": false; scope "features": true
  test?: { batching: Batching };
  fix?: { batching: Batching };
}

/** POST /api/qa/:root/pipelines body. */
export interface PipelineRequest {
  stages: StageSettings;
  scope: Scope;
  pace: Pace;
  driver: Driver;
  note?: string;              // ≤ 4000 chars after trim
  baseUrl?: string | null;    // http(s) only; trailing "/" removed
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
  | { kind: "held"; after: Stage; next: Stage }          // only under pace "step"
  | { kind: "stopping"; stage: Stage }                   // stop asked; running jobs finish, nothing new starts
  | { kind: "ended"; reason: "done" | "stopped" | "superseded"; at: number };

export interface JobView {
  id: string;                          // qaj_…
  stage: Stage;
  units: string[];                     // ["map"] | feature ids | bug ids
  sessionId: string | null;            // null: the launch failed (see error)
  pair: boolean;                       // the session is a Hydra lead
  state: "running" | "merging" | "settled";   // merging: the lead was nudged to merge its heads
  problem: string | null;              // settled without its work, per the artifact check
  error: string | null;                // the launch threw; never retried
  startedAt: number;
  settledAt: number | null;
}

export type StageState = "done" | "current" | "held" | "next" | "skipped";

export interface PipelineView {
  id: string;                          // qap_…
  config: PipelineConfig;
  control: Control;
  /** One entry per STAGES item. total/done count units of that stage (0/0 when it has not opened yet or is skipped). */
  stages: Array<{ stage: Stage; state: StageState; done: number; total: number; problems: number }>;
  jobs: JobView[];                     // every job of this pipeline, oldest first
  createdAt: number;
}

export type Activity =
  | { kind: "idle" }
  | { kind: "queued" }                                           // in the current stage's units, not yet covered by a job
  | { kind: "working"; sessionId: string; pair: boolean }        // covered by an unsettled job
  | { kind: "problem"; text: string; sessionId: string | null }; // latest settled job covering it has a problem or error

export type PlanCell = { kind: "missing" } | { kind: "ready"; steps: number; updatedAt: number } | { kind: "broken"; problem: string };

export interface RunSummary {
  id: string;                          // qa_…
  feature: string;
  startedAt: number;
  counts: Record<OutcomeState, number>;
  finished: boolean;                   // counts.pending === 0
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
  capture: string | null;              // evidence id; screenshot at GET /api/evidence/:root/:capture/file/screenshot.png when shot !== "none"
  shot: "desktop" | "rerender" | "agent" | "none";
  byAgent: boolean;                    // found_by: agent
  feature: string | null;              // the feature it is shown under: stored, else featureForUrl, else null
  featureSource: "stored" | "url" | null;
  summary: string;
  problem: string | null;              // the finding file is malformed
  fixSession: string | null;
  updatedAt: number;
}

export interface BoardFeature {
  id: string;
  title: string;
  where: string[];
  parent: string | null;               // a feature id, one level only
  depth: 0 | 1;
  summary: string;
  plan: PlanCell;
  test: TestCell;
  bugs: BoardBug[];                    // every bug shown under this feature, open first, then by updatedAt desc
  activity: { plan: Activity; test: Activity; fix: Activity };
}

export interface QaBoard {
  browser: boolean;                    // the agent browser is on (map, plan and test need it)
  map: { exists: boolean; problem: string | null; updatedAt: number | null; activity: Activity };
  /** features.md order, each child right after its parent; a child whose parent is unknown is shown at depth 0. */
  features: BoardFeature[];
  bugsWithoutFeature: BoardBug[];
  plansWithoutFeature: Array<{ slug: string; title: string; steps: number; problem: string | null; path: string }>;
  /** The pipeline that is not ended, else the newest ended one, else null. */
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
  /** last = the step's newest non-pending outcome across this feature's runs (by step id). */
  plan: { title: string; intro: string; path: string; steps: PlanStepView[]; problem: string | null } | null;
  runs: RunSummary[];                  // newest first, at most 20
  lastRun: Run | null;
}

/** GET /api/qa/:root/runs/:id */
export interface RunReply { run: Run; summary: RunSummary }

export interface ErrorBody { error: string }
```

The wire shapes of the Lab routes S1 changes (S4 consumes them):

```ts
// PATCH /api/lab/:root/findings/:id   body (all optional; confirmed is gone and now a 400 "Unknown field confirmed.")
export interface FindingPatchBody { status?: "new" | "accepted" | "dismissed" | "shipped"; impact?: "high" | "medium" | "low"; effort?: "s" | "m" | "l"; feature?: string | null }
//   → 200 { finding: Finding }    400 bad value, feature on a non-bug, feature not matching FEATURE_ID    404 no finding
// POST /api/lab/:root/bugs            body: today's bug report + feature?: string | null (FEATURE_ID or null)
//   → 201 { finding, capture, shotNote }   (LoggedBug, unchanged)
// Finding.bug on the wire (web/src/features/lab/data.ts):
//   { url: string; capture: string | null; shot: "desktop" | "rerender" | "agent" | "none"; kind: BugKind; by?: "agent"; feature: string | null }
```

## 4. Server-only domain types (`src/qa/types.ts`, below the wire banner)

```ts
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

/** What reconcile reads. Built by jobs.ts in one synchronous pass. */
export interface Snapshot {
  features: readonly Feature[];
  mapExists: boolean;
  plans: ReadonlyMap<FeatureId, { steps: number; problem: string | null }>;
  /** Open = status new|accepted. feature = stored ?? featureForUrl ?? null (same rule as the board). */
  openBugs: ReadonlyArray<{ id: BugId; feature: FeatureId | null }>;
  jobs: ReadonlyArray<Job & { active: boolean }>;     // this pipeline's jobs; active = settledAt === null && session !== null
  fixBusyElsewhere: boolean;                           // runningFix(root) names a session that is not a job of this pipeline
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
```

## 5. The pure core (`src/qa/pipeline.ts`): rules builders must implement exactly

### `reconcile(p: Pipeline, s: Snapshot, now: number): Decision`

The first rule that applies wins.

1. `ended` or `held` → `wait`.
2. `stopping(st)`: if any job is active → `wait`. Otherwise → `control ended(stopped, now)`, units null.
3. `running(st)`:
   - `covered` is the set of units of every job of stage `st`, including jobs with an `error`.
   - `left` is `p.units` minus `covered`, in `p.units` order.
   - `active` is the jobs of stage `st` that are active.
   1. When `left` is empty and `active` is empty, the stage is done. Let `next` be the next stage after `st` present in
      `config.stages`:
      - no `next` → `control ended(done, now)`;
      - pace `step` → `control held(st, next)`, units null;
      - otherwise → `control running(next)`, units `unitsFor(next, config, s)`.
   2. `st === "fix"` and `s.fixBusyElsewhere` → `wait`.
   3. `left` is empty → `wait`.
   4. `st === "map"`, or the stage's batching is `together`: when `active` is empty, `launch` one job with all of `left`;
      otherwise `wait`.
   5. `each`: let `room = PARALLEL[st] - active.length`. When `room <= 0`, `wait`. Otherwise `launch` the first `room`
      units of `left`, one unit per launch.

### `unitsFor(stage, config, s): Unit[]` (pure, deterministic order)

Order is the order of `s.features` (features.md order) for feature units, and bug id order for bug units.

- `map` → `["map"]`.
- `plan` → each feature in scope where `replan || !plans.has(f) || plan.problem || plan.steps === 0`.
- `test` → each feature in scope whose plan exists, has no problem and has `steps ≥ 1`.
- `fix` →
  - scope `bugs`: the named ids that are still open;
  - scope `all`: every open bug, including ones with no feature;
  - scope `features`: the open bugs whose feature is in scope.

"In scope" means: scope `all`, every feature; scope `features`, the named ids that still exist; scope `bugs`, none.

`startPipeline` computes the first stage the same way: `control running(first)` with `units = unitsFor(first, …)`. A
first stage with no units is allowed. It advances at the first tick, so "Test" with no plans ends at once as done, and
the board shows Test as 0/0.

### `pipelineView(p, jobs, s): PipelineView` and `activityOf(...)`

Both are also pure, in `pipeline.ts`.

- A stage's `total` depends on where it is:
  - the current stage: `p.units.length`;
  - a stage already passed: the number of distinct units across its jobs (it drained, so every unit was covered);
  - a stage not yet opened, or skipped: 0.
- `done` is the number of covered units whose job is settled.
- `problems` is the number of settled jobs of the stage with a problem or error.

### `parseConfig(body: unknown, ctx: { features: readonly Feature[]; pairExists: (id: string) => boolean }): PipelineConfig`

This is the boundary. It throws `UserError`, which the route turns into 400, with these exact messages:

- `"Pick at least one stage."`
- `"A list of bugs can only be fixed: choose the Fix stage alone."`
- `"No feature \"<id>\"."`
- `"No Hydra pair \"<id>\". See \`trb pair list\`."`
- `"batching must be \"each\" or \"together\"."`
- `"pace must be \"auto\" or \"step\"."`
- `"baseUrl must be an http or https address."`

## 6. Module map

### S1: `src/lab/*`, `src/checklists/findings.ts`, `src/daemon/routes/lab.ts`

```ts
// src/lab/findings.ts
export interface BugInfo { url: string; capture: string | null; shot: ShotKind; kind: BugKind; by?: "agent"; feature: string | null }
//   read: `feature:` front-matter line (FEATURE_ID or absent → null; a bad value → null + a warning in problem). `confirmed:` is ignored.
//   write: emits `feature: <id>` only when non-null; never emits `confirmed:`.
export interface FindingPatch { status?: Status; impact?: Impact; effort?: Effort; feature?: string | null }   // confirmed removed
export function patchFinding(rootDir: string, id: string, patch: FindingPatch): Finding;   // feature on a non-bug → UserError
// removed: unconfirmedBug, the confirmed check
export const FEATURE_ID: RegExp;   // /^[a-z0-9][a-z0-9-]{0,59}$/ (S2 imports it from here so there is one copy on the server)

// src/lab/capture.ts
export interface BugReport { /* unchanged fields */ byAgent?: boolean; feature?: string | null }
export function parseBugReport(body: unknown): BugReport;      // reads body.feature: null/absent → null, else must match FEATURE_ID (400 "feature must be a feature id.")
export async function logBug(rootDir: string, r: BugReport, deps?: CaptureDeps): Promise<LoggedBug>;   // writes bug.feature = r.feature ?? null; no confirmed

// src/lab/sweeps.ts: SweepKind = "run" only; startFixSweep, openFixSweep, the fix branch of pumpSweep and the
//   "a fix that is not the sweep's own" loop are deleted. startSweep/pumpSweep/listSweeps/cancelSweep/startSweepDriver unchanged otherwise.
// src/lab/tables.ts: after the lab_sweeps upgrade: `UPDATE lab_sweeps SET cancelled = 1 WHERE kind = 'fix' AND cancelled = 0` (idempotent).
// src/lab/sessions.ts
export function fixFinding(rootDir: string, id: string, o?: LabOpts, sweepId?: string | null): { finding: Finding; session: SessionRecord };
//   refuses lens "bug": UserError("Bugs are fixed from the QA view.") ; the bug paragraph is deleted.
export function runningFix(rootDir: string): { findingId: string; sessionId: string } | null;   // unchanged; S2 consumes it
// src/checklists/findings.ts: patchLabFinding's patch type drops confirmed, adds feature?: string | null (passed through).
// src/daemon/routes/lab.ts: DELETE `POST bugs/fix-all`; PATCH accepts feature, rejects confirmed; POST bugs passes feature; header doc updated.
```

### S2: `src/qa/*`, `src/daemon/routes/qa.ts`, `src/db.ts`, `src/sessions/manager.ts` (additions), `src/daemon/lifecycle.ts`

```ts
// src/qa/types.ts: §3 wire types + §4 domain types. Nothing else.
// src/qa/pipeline.ts: PURE (no db, fs, manager). reconcile, unitsFor, parseConfig, pipelineView, activityOf, featureForUrl
export function reconcile(p: Pipeline, s: Snapshot, now: number): Decision;
export function unitsFor(stage: Stage, c: PipelineConfig, s: Snapshot): Unit[];
export function parseConfig(body: unknown, ctx: { features: readonly Feature[]; pairExists: (id: string) => boolean }): PipelineConfig;
export function pipelineView(p: Pipeline, jobs: readonly Job[], s: Snapshot): PipelineView;
/** Activity of one feature (or "map") for one stage, from the pipeline that is not ended and its jobs. */
export function activityOf(stage: Stage, unit: Unit, p: Pipeline | null, jobs: readonly Job[], leadIsPair: (session: string) => boolean): Activity;

// src/qa/prompts.ts: PURE. Text only (§8).
export interface PromptInputs {
  launch: Launch; batching: Batching; driver: Driver; pairCap: number | null;   // pairCap set only when the job is a pair lead
  note: string; baseUrl: string | null;
  features: readonly Feature[]; plans: ReadonlyMap<FeatureId, Plan>; runs: ReadonlyMap<FeatureId, Run>;
  bugs: ReadonlyMap<BugId, { id: BugId; path: string; title: string; url: string; kind: string; capture: string | null; body: string }>;
  openBugs: ReadonlyArray<{ id: string; title: string; url: string }>;
}
export function jobPrompt(i: PromptInputs): { visible: string; title: string; instructions: string };

// src/qa/jobs.ts: THE SHELL: persistence, launch, settle, driver, board. Every decision comes from pipeline.ts.
export function startPipeline(root: string, body: unknown): PipelineView;      // 409 if control running|stopping; a held one is ended(superseded) first; 400 browser off when map|plan|test ∈ stages
export function continuePipeline(root: string, id: string): PipelineView;      // held → running(next) with fresh unitsFor; 409 otherwise; then tick
export function stopPipeline(root: string, id: string): PipelineView;          // running → stopping; held → ended(stopped); stopping|ended → unchanged; then tick
export function qaBoard(root: string): QaBoard;
export function featureDetail(root: string, id: string): FeatureDetail;        // QaNotFound when the id is not in features.md
export function runReply(root: string, id: string): RunReply;                   // QaNotFound when not this project's
export function deletePlan(root: string, slug: string): void;                   // removes lab/qa/<slug>.md and its qa_runs; 409 while an active job covers it
export function tickProject(root: string): void;                                 // SYNCHRONOUS: snapshot → reconcile → apply, until "wait" (max 20 rounds)
export function startQaDriver(): void;                                           // Hub turn_end | state(≠running): settle the job of e.rootId if its tree is idle, then tickProject; at start: settle + tick every project with a pipeline not ended
export function stopQaDriver(): void;

// src/qa/registry.ts: imports db only (no manager: cycle-free)
export interface QaContext { job: Job; head: boolean }
export function qaContext(sessionId: string): QaContext | null;                  // job whose session_id = sessions.root_id of sessionId
export function usesQaTools(sessionId: string): boolean;                          // qaContext and job.stage ∈ {map, plan, test}

// src/qa/tools.ts (names kept: core.ts imports executeQaTool)
export async function executeQaTool(name: string, args: Record<string, unknown>, sessionId: string): Promise<{ text: string }>;
//   qa_record { flow?, step, state, note?, actual?, bug? }: runs = qa_runs.session_id = job.session; flow required when >1 run.
//   bug_log { feature?, title, kind?, steps, expected?, actual, screenshot?, new? }: feature = the job's single feature unit,
//     else required and ∈ job.units (plan/test together), map: optional and must exist in features.md. Calls
//     logBug(root, { …, byAgent: true, feature }) and notes "Found by a QA agent in the <stage> job <jobId> (session <id>)."
// src/qa/defs.ts (names kept: QA_TOOL_NAMES, QA_TOOL_SET, qaToolDefs, BUG_KIND_LIST): add flow/feature params, drop "unconfirmed" text.
// src/qa/features.ts
export function parseFeatures(text: string): { features: Feature[]; problem: string | null };   // keys id|where|parent; `plans:` read and ignored; parent must be an id of a depth-0 feature, else problem + parent null
export function readFeatures(root: string): { features: Feature[]; problem: string | null; exists: boolean; updatedAt: number | null };
export function featuresSignature(root: string): string | null;
export function featureForUrl(features: readonly Pick<Feature, "id" | "where">[], url: string): FeatureId | null;   // §2
export const FEATURES_FILE: string;   // "lab/features.md"
// src/qa/plan.ts
export const QA_DIR: string;          // "lab/qa"
export class QaNotFound extends UserError {}
export function readPlan(root: string, id: FeatureId): Plan;                     // normalizes id-less steps once (existing behavior); `source:` line ignored
export function listPlans(root: string): { byFeature: Map<FeatureId, Plan & { updatedAt: number }>; loose: QaBoard["plansWithoutFeature"] };  // loose = files whose slug is not a feature; *.proposals.md never read
export function planSignature(root: string, id: FeatureId): string | null;
export function removePlan(root: string, slug: string): void;
// src/qa/runs.ts
export function startRun(root: string, plan: Plan, sessionId: string | null): Run;   // sessionId patched in onCreated when unknown at creation
export function setRunSession(id: RunId, sessionId: string): void;
export function getRun(id: RunId): Run | null;
export function runsOfSession(sessionId: string): Run[];
export function setOutcome(id: RunId, step: StepId, o: Outcome): Run;
export function parseOutcome(raw: unknown, now?: number): Outcome;
export function summarize(run: Run): RunSummary;
export function listRuns(root: string, feature: FeatureId, limit?: number): RunSummary[];
export function lastOutcomes(root: string, feature: FeatureId): Record<string, OutcomeState>;
export function removeRuns(root: string, slug: string): void;
// src/sessions/manager.ts (additions only)
export function treeIdle(sessionId: string): boolean;          // no live turn and not finalizing, for the session and every descendant (status is not consulted: a crashed head counts idle)
export function unmergedHeads(leadId: string): SessionRecord[]; // worktree children, idle, whose branch tip ≠ (merged_sha ?? base_sha)
// src/daemon/lifecycle.ts: import startQaDriver/stopQaDriver from "../qa/jobs".
// src/daemon/routes/qa.ts: §7.
// deleted: src/qa/batches.ts, src/qa/sessions.ts
```

### S3: `web/src/features/qa/*`

```ts
// api.ts: §3 types (copied) + hooks
export const qaKey: { board: (root: string) => readonly unknown[]; feature: (root: string, id: string) => readonly unknown[]; run: (root: string, id: string) => readonly unknown[] };
export function useQaBoard(root: string | null): UseQueryResult<QaBoard>;     // refetchInterval 3000 while board.pipeline?.control.kind is running|stopping, else 15000 when visible
export function useFeatureDetail(root: string, id: string | null): UseQueryResult<FeatureDetail>;
export function useRun(root: string, id: string | null): UseQueryResult<RunReply>;
export function useQaActions(root: string): { start; cont; stop; deletePlan; setBug };   // setBug = PATCH /api/lab/:root/findings/:id { status?, feature? }; each invalidates qaKey.board and ["lab", root]
// logic.ts: PURE
export function featureForUrl(features: readonly { id: string; where: string[] }[], url: string): string | null;   // §2 (S4 imports this)
export function pipelineRequest(form: RunForm, scope: Scope, driver: Driver): PipelineRequest;
export function rowRequest(action: "plan" | "test" | "fix" | "stages", featureId: string, form: RunForm, driver: Driver): PipelineRequest;
export function bugFixRequest(bugId: string, driver: Driver): PipelineRequest;      // { stages: { fix: { batching: "each" } }, scope: { kind: "bugs", ids: [bugId] }, pace: "auto", driver }
export function stageLine(s: PipelineView["stages"][number]): string;              // "Plan 3/8 · 1 problem"
export function countsLine(counts: Record<OutcomeState, number>): string;            // moved from old logic.ts: "5/12 · 1 fail"
export interface RunForm { stages: Stage[]; batching: Record<"plan" | "test" | "fix", Batching>; replan: boolean | null; pace: Pace; baseUrl: string; note: string }
// run-choice.ts: the persisted driver choice, localStorage "trb.qa.driver" (falls back to getWho() for an agent)
export function useQaDriver(): [Driver, (d: Driver) => void];
// open.ts
export interface QaIntent { feature?: string; bug?: string }
export function openQa(intent?: QaIntent): void;     // stash intent, useUi.getState().openTab({ kind: "qa", title: "QA" }), bus.emit("qa-open")
export function takeQaIntent(): QaIntent | null;
// QaTab.tsx
export function QaTab(): JSX.Element;               // no props; EditorArea lazy-imports it by this name
// components (not imported outside qa/): QaBoardView, RunBar, DriverPicker, PipelineStrip, FeatureGrid, FeatureRow, FeatureDetailPane, BugCard, OrphanPlans, UnsortedBugs
```

### S4: `web/src/features/lab/*` (bug parts), `web/src/shell/*`, `web/src/lib/store.ts`, `web/src/lib/tab-migration.ts`, `web/src/features/browser/*`

```ts
// lib/tab-migration.ts: a saved { kind: "bugs" } becomes { id: "qa", kind: "qa", title: "QA" }, deduped against an existing qa tab;
//   activeTab and history rename "bugs" → "qa" (history deduped). The existing lab → findings rule stays.
export function migrateSavedTabs<T extends SavedTab>(tabs: T[]): T[];
export function migrateSavedWs<W extends { tabs?: SavedTab[]; activeTab?: unknown; history?: unknown }>(ws: W): W;
// lib/store.ts: the "bugs" tab variant and its cases removed.
// features/lab/views.ts: LabViewKind = "findings" | "checklists"; BugsIntent, stashBugs, takePendingBugs removed.
// features/lab/open.ts: openBugs and openQa removed (openQa now lives in features/qa/open.ts).
// features/lab/logic.ts: unconfirmed, fixableBugs, bugState, BugState, kindCounts, byKind, KindFilter removed.
// features/lab/data.ts: Finding.bug as in §3 Lab wire; SweepView.kind = "run"; actions confirm and fixAllBugs removed.
// features/lab/shared.tsx, FindingsTab.tsx: the fix-sweep branches removed.
// features/lab/BugsTab.tsx: deleted.
// shell/ActivityBar.tsx: Bugs item removed; QA item shows countBadge(labCounts?.bugs ?? 0); opens openQa().
// shell/commands.tsx: "Open Bugs" removed; "Open QA" keywords: "qa test plan flows bugs fix features map".
// shell/EditorArea.tsx: "bugs" cases removed; "qa" renders QaTab from "@/features/qa/QaTab".
// features/browser/BrowserTab.tsx: QaPanel import, the dock, qaOpen, Alt+Q and its IconButton removed.
// features/browser/prefs.ts: qaOpen removed (a stored qaOpen is ignored).
// features/browser/logic.ts: qaDock, QA_COMPACT_BELOW, stepsSince, resolvePath removed (only if no other user remains).
// features/browser/LogBugDialog.tsx: a Feature <Select> (options from useQaBoard(root).data.features, "No feature" first),
//   preselected with featureForUrl(features, url); sends feature in POST /api/lab/:root/bugs; toast action "Open in QA" → openQa({ bug: id }).
```

## 7. Routes

`:root` is a root reference (`w_…` or `s_…`). An unknown root gets 404 from `resolveRoot`.

| Method | Path | Body | 2xx | Errors |
|---|---|---|---|---|
| GET | `/api/qa/:root` | none | 200 `QaBoard` | 404 root |
| GET | `/api/qa/:root/features/:id` | none | 200 `FeatureDetail` | 404 `No feature "<id>".` |
| GET | `/api/qa/:root/runs/:id` | none | 200 `RunReply` | 400 bad run id; 404 not this project's |
| POST | `/api/qa/:root/pipelines` | `PipelineRequest` | 201 `{ pipeline: PipelineView }` | 400 `parseConfig` messages, plus `The agent browser is off … (trb config set agent_browser on)` when map, plan or test is chosen; 409 `A QA pipeline is already running in this project. Stop it or wait for it.` |
| POST | `/api/qa/:root/pipelines/:id/continue` | none | 200 `{ pipeline }` | 404 `No pipeline "<id>".`; 409 `The pipeline is not waiting to continue.` |
| POST | `/api/qa/:root/pipelines/:id/stop` | none | 200 `{ pipeline }` (idempotent) | 404 |
| DELETE | `/api/qa/:root/plans/:slug` | none | 200 `{ ok: true }` | 400 bad slug; 404 `No plan "<slug>".`; 409 `A job is working on "<slug>". Wait for it.` |
| PATCH | `/api/lab/:root/findings/:id` | `FindingPatchBody` | 200 `{ finding }` | 400; 404 |
| POST | `/api/lab/:root/bugs` | bug report + `feature?` | 201 `LoggedBug` | 400 |
| GET | `/api/evidence/:root/:id/file/screenshot.png` | none | unchanged (bug thumbnails) | unchanged |
| GET | `/api/lab/:root/summary` | none | unchanged (`bugs` = open bugs; activity-bar QA badge) | unchanged |

Deleted:
- every other `/api/qa/*` route;
- `POST /api/lab/:root/bugs/fix-all`;
- `confirmed` in the Lab PATCH body.

## 8. Launch, prompts and checks

### Launch (in `jobs.ts`, per `Launch`, inside `tickProject`)

1. `pair = config.driver.kind === "pair" && stage !== "test"`. Test under a pair: `createLead` with the pair's
   `lead_engine`, `lead_model`, `lead_effort` and **no `pairId`**.
2. Map, plan and test: the browser must be on, else the job is recorded with `error`. Test: `startRun` for each
   feature unit before `createLead`, and the run ids go into the prompt. If the launch throws, those runs are removed.
3. `createLead({ prompt: withInstructions(visible, label, instructions), title, cwd: root, isolate: false, mode: "build", pairId?, engine/model/effort/agent?, onCreated })`.
   `onCreated(id)` inserts the `qa_jobs` row with `sigs` and calls `setRunSession` for the test runs. The row exists
   before the first turn, so the turn gets the QA tools.
4. Fix: after `createLead`, `patchFinding(root, bug, { status: "accepted" })` and set `fix_session = session.id` for
   each bug unit, through `noteFinding`/`patchFinding` as `fixFinding` does today. This is what makes `runningFix` see
   the job.
5. A throw anywhere in steps 2–4 inserts the job with `session_id NULL` and `error = message`. The job is never retried.
6. The label is `QA · map|plan|test|fix`. The title is `QA · <stage> · <first unit title>[ +n]`, at most 100 characters.

### Settle (in `jobs.ts`, called by the driver)

A job settles when `job.session` is set, `settledAt` is null and `treeIdle(job.session)` holds:
- If its lead has `unmergedHeads(lead).length > 0` and `nudgedTurns === null`, store
  `nudgedTurns = lead.turns`, `send({ operator: true }, lead, NUDGE)` and return.
- If `nudgedTurns !== null` and `lead.turns <= nudgedTurns` and the lead's status is not `failed`/`closed`, return:
  the nudge turn has not ended yet.
- Otherwise `problem = check(job)`, `settled_at = now`.

`NUDGE`, exactly:
`"Your heads <ids> finished with commits that are not merged. Merge each one with subagent_merge, one at a time, check the result, finish the job you were given, then end your turn."`

### Common blocks, written once in `prompts.ts` and reused

- **APP**: today's `appBlock(baseUrl)` text.
- **BROWSER**: today's `BROWSER` constant.
- **BUGS**: today's `BUGS` constant, with "The bug starts unconfirmed" removed, plus: `Pass feature: <id> to bug_log when you are asked to (several features in one job).`
- **OPEN_BUGS**: today's `openBugsBlock`.
- **NOTE**: when non-empty, `\nThe operator's note:\n<note>\n`.
- **PLAN_FORMAT**, exactly:

```
---
title: <feature title>
---
<one or two sentences: what this flow covers>
## Steps
1. [s-xxxx] <one action>
   path: /page
   expect: <one concrete, checkable result>
Rules: keep the [s-…] id of every step you keep, unchanged. Write new steps WITHOUT an id: ids are added for you.
`path:` starts with / and is left out when no page applies. `expect:` is concrete (a text, a number, a state), never
"works". No other text after ## Steps.
```

### Skeletons

`{cap}` = `min(6, pair.max_heads ?? 6)`.

**map, agent (each = together: map has one unit)**
```
Map the user-facing features of this product into `lab/features.md`, so a test flow can be written and run per feature.
APP
BROWSER
A feature is one thing a user does, named the way they would say it ("Checkout", "Invite a teammate"). Write the
high-level journeys first; under each, the specific things a user does inside it, marked with `parent: <journey id>`
(one level only). Aim for 5 to 40 features in all.
Write ONLY `lab/features.md`, in exactly this format:
# Features
## Checkout
id: checkout
where: /cart, /checkout
A buyer pays for the cart with a saved or a new card.
## Apply a discount code
id: apply-discount
parent: checkout
where: /cart
A buyer enters a code and sees the total drop.
Rules: `id:` lowercase letters, digits and dashes, unique. Keep every existing feature's id exactly. Drop any `plans:`
line. Check each feature in the browser. BUGS (no feature needed for map) Change no other file.
OPEN_BUGS
NOTE
```
**map, pair**: the agent text, then:
```
You lead a Hydra pair. Split the product into its top-level areas (navigation sections; at most {cap}). Open one head per
area with subagent_create, isolate: false. Brief each head: "Map the area <name> (<paths>) in the browser: every journey
and every specific thing a user does in it, in the features.md section format above, with parent: lines. Do NOT write
any file. Log broken things with bug_log. Return the sections as text in your final message." Wait for all heads with
subagent_wait. Then YOU write lab/features.md alone: merge the sections, dedupe ids, keep existing ids. Close the heads.
```
**plan, agent each** (one feature X)
```
Write the test flow for the feature "<title>" (id <X>) to `lab/qa/<X>.md`.
<summary>. It lives on: <where>.
APP
BROWSER
First walk the feature in the browser as a new user: the main path, then wrong, empty and very long input, double
clicks, back and reload mid-flow, a narrow window, and what a user sees when something fails. BUGS
Then write the flow: the steps worth running again, in the order a user walks them, including the ones that found a bug.
<if the plan exists> The current plan is below; revise it: keep good steps with their ids, fix wrong ones, add missing ones.
<current plan file text>
PLAN_FORMAT
Write ONLY `lab/qa/<X>.md`. Change no other file and do not commit.
OPEN_BUGS
NOTE
```
**plan, agent together** (features X1..Xn): `Write a test flow for each of these features, one file each, in this order:`
followed by one block per feature (title, id, summary, where, current plan text if any). The rest is the each text
with `lab/qa/<id>.md` per feature, and `Pass feature: <id> to bug_log.`

**plan, pair** (each or together): the agent text for the job's features, then:
```
You lead a Hydra pair. Open one head per feature with subagent_create, isolate: false (at most {cap} open; open the next
when one finishes). Brief each head with its feature's block above and: "Write ONLY lab/qa/<id>.md. Pass feature: <id>
to bug_log. Do not commit." Heads share the project folder and each writes its own file, so there is nothing to merge.
Wait for every head, read each file, and redo any head that failed or wrote no steps. Close the heads.
```
**test, agent each** (one feature X, run R)
```
Run the test flow "<title>" (feature <X>, run <R>) in the browser, as a person would by hand.
APP
BROWSER
Do the steps in order. Record each one with qa_record before going to the next:
- <step id>: <action>
  page: <path>
  expect: <expected>
How to record: pass (say what you saw in note); fail (bug_log first, or take the id of an open bug that is the same
problem, then qa_record with state fail, actual and bug); blocked (note says what blocks it); skip (note says why).
Do not record a step you did not try. Do not change any file.
BUGS
OPEN_BUGS
End with one paragraph: passed, failed, blocked, and the bug ids.
NOTE
```
**test, agent together**: `Run these flows one after another, in this order.` Then one step list per flow, headed
`Flow <X> (run <R>)`, with `Pass flow: <X> to qa_record and feature: <X> to bug_log.` The rest is the same.

**test, pair**: the same as the agent text (a plain session on the lead's engine, no heads).

**fix, agent each** (one bug B)
```
Fix this bug.
<findingBrief(B): id, path, title, kind, url, evidence capture id, body with steps to reproduce / expected / actual>
APP
Reproduce it first in the browser at <url>, following the steps (read the capture <capture> for the page state, console
and requests). If you cannot reproduce it, set `status: dismissed` in <path> and add one line under the body saying why,
then stop. Otherwise fix the cause, not the symptom; keep the change to what the bug needs; for a visual bug follow
DESIGN.md and design/tokens.css. Verify in the browser that it is fixed, then set `status: shipped` in <path> and say
what you changed. Do not commit.
```
**fix, agent together**: `Fix these bugs one at a time, in this order. Finish one (shipped or dismissed) before you
start the next.` Then one brief per bug, then the each rules.

**fix, pair**: the agent text for the job's bugs, then:
```
You lead a Hydra pair. Open one head per bug with subagent_create (its own worktree; at most {cap} open; open the next
when one finishes). Brief each head with its bug and: "Fix the cause in your worktree, add a test when the project has
tests for that code, commit. Do NOT edit lab/findings/." As each head finishes, subagent_merge it — one at a time. If a
merge conflicts, send that head "rebase on the project and retry" and merge it after the others. After each merge,
reproduce the bug's steps in the browser against the running app: fixed → set `status: shipped` in its finding file;
not fixed → follow up with the head or fix it yourself; not a bug → `status: dismissed` with one line why. Do not end
your turn while a head is open or unmerged. Do not commit.
```

### Artifact check per stage (`check(job)` → `problem: string | null`)

These run against the project folder. A job with several units joins the problems per unit with `"; "`, each one
prefixed `<unit>: `.

| Stage | Problem when… | Text |
|---|---|---|
| map | `lab/features.md` missing | `The agent did not write lab/features.md.` |
| | signature equals `sigs.map` (and it was not null) | `The agent did not change lab/features.md.` |
| | 0 features | `lab/features.md lists no features: each starts with "## ".` |
| | parse problem | the parse problem |
| plan | file missing | `<X>: no plan written.` |
| | plan has a problem | `<X>: <problem>` |
| | 0 steps | `<X>: the plan has no steps.` |
| | signature equals `sigs[X]` | `<X>: the plan was not changed.` |
| test | a run of the job has pending steps | `<X>: <n> of <m> steps not recorded.` |
| fix | a bug's status is not `shipped`/`dismissed` | `<B>: still open.` |
| | pair: `unmergedHeads(lead)` non-empty | `heads not merged: <ids>.` |

## 9. DDL (`src/db.ts`, idempotent, in this order)

```sql
CREATE TABLE IF NOT EXISTS qa_pipelines (
  id TEXT PRIMARY KEY,                 -- qap_…
  root_dir TEXT NOT NULL,              -- realOf(root)
  config TEXT NOT NULL,                -- PipelineConfig JSON
  control TEXT NOT NULL,               -- Control JSON
  units TEXT,                          -- JSON Unit[] of control's stage, NULL while held/ended
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_pipelines_root ON qa_pipelines(root_dir, created_at);
CREATE TABLE IF NOT EXISTS qa_jobs (
  id TEXT PRIMARY KEY,                 -- qaj_…
  pipeline_id TEXT NOT NULL,
  root_dir TEXT NOT NULL,
  stage TEXT NOT NULL,                 -- map|plan|test|fix
  units TEXT NOT NULL,                 -- JSON NonEmpty<Unit>
  session_id TEXT UNIQUE,              -- NULL when the launch failed
  error TEXT,                          -- launch failure; never retried
  sigs TEXT NOT NULL DEFAULT '{}',
  nudged_turns INTEGER,
  problem TEXT,
  started_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_qa_jobs_pipeline ON qa_jobs(pipeline_id);
-- qa_runs: keep; add the walking session.
ALTER TABLE qa_runs ADD COLUMN session_id TEXT;          -- via addColumn(conn, "qa_runs", "session_id", "TEXT")
-- only while qa_sessions exists (check sqlite_master first):
UPDATE qa_runs SET session_id = (SELECT session_id FROM qa_sessions WHERE qa_sessions.run_id = qa_runs.id) WHERE session_id IS NULL;
DROP TABLE IF EXISTS qa_sessions;
DROP TABLE IF EXISTS qa_batches;
```

`qa_runs.plan` keeps its name and now holds a feature id or plan slug. They share one regex, so the column does not
change. The fix-kind `lab_sweeps` cancellation is in S1's `src/lab/tables.ts`, because that file owns `lab_sweeps`.

## 10. File ownership: four slices

Every touched or deleted file is in exactly one slice. A builder edits only its own files. When a builder needs a
change in another slice's file, it stops and reports it.

### S1 "lab bugs"

- **Touches:**
  - `src/lab/findings.ts`, `src/lab/capture.ts`, `src/lab/sweeps.ts`, `src/lab/tables.ts`, `src/lab/sessions.ts`
  - `src/checklists/findings.ts`
  - `src/daemon/routes/lab.ts`
- **Tests:**
  - `tests/lab-bugs.test.ts`: `feature:` round-trips; `confirmed:` is ignored and dropped on write; `fixFinding`
    refuses a bug; the fix-sweep test is removed.
  - `tests/lab-capture.test.ts`: `feature` is parsed and validated; an agent bug has no `confirmed`.
  - `tests/lab.test.ts`, `tests/checklists.test.ts`, `tests/checklists-gaps.test.ts`, `tests/signals.test.ts`: still
    pass.
  - New `tests/lab-bug-routes.test.ts`: PATCH `feature` (null, valid, bad, on a non-bug), PATCH `confirmed` → 400,
    `POST bugs/fix-all` → 404, `POST bugs` with `feature`.
- **Run:** `bun test tests/lab-bugs.test.ts tests/lab-capture.test.ts tests/lab.test.ts tests/checklists.test.ts tests/checklists-gaps.test.ts tests/signals.test.ts tests/lab-bug-routes.test.ts`
- **Exports for others:**
  - `BugInfo.feature: string | null`
  - `FindingPatch.feature`
  - `FEATURE_ID` (from `src/lab/findings.ts`)
  - `BugReport.feature?: string | null`
  - `logBug(rootDir, r, deps?)`, unchanged signature
  - `runningFix(rootDir)`
  - `patchFinding`, `noteFinding`, `listFindings`, `readFinding`, `createBugFinding`
- **Consumes:** nothing new.

### S2 "qa server"

- **Touches:**
  - `src/qa/types.ts`, `pipeline.ts` (new), `jobs.ts` (new), `prompts.ts` (new), `registry.ts`, `tools.ts`,
    `defs.ts`, `plan.ts`, `features.ts`, `runs.ts`
  - Deletes `src/qa/batches.ts` and `src/qa/sessions.ts`.
  - `src/daemon/routes/qa.ts`, `src/db.ts`, `src/sessions/manager.ts` (`treeIdle`, `unmergedHeads` only),
    `src/daemon/lifecycle.ts`
- **Tests:**
  - New `tests/qa-pipeline.test.ts`: a table-driven test of `reconcile` over every `Control` × batching × PARALLEL ×
    `fixBusyElsewhere` × failed launches; `unitsFor` with replan defaults; `parseConfig` messages; `featureForUrl` with
    the §2 vectors.
  - New `tests/qa-jobs.test.ts`, with a fake turn runner:
    - start, then 409 on a second start; a held pipeline is superseded;
    - continue and stop;
    - a restart resumes without relaunching covered units;
    - two racing ticks launch once;
    - the nudge is sent once and settle waits for the nudge turn;
    - a crashed head does not stall settling;
    - each artifact check;
    - test under a pair launches without `pairId`;
    - fix sets `fix_session` and respects a Lab fix.
  - New `tests/qa-prompts.test.ts`: each stage × {agent each, agent together, pair} contains its key lines, and
    `{cap}` is filled.
  - Rewritten `tests/qa-routes.test.ts`: every route in §7, with its codes.
  - Changed:
    - `tests/qa-plan.test.ts`: proposals, edit, create and decide are dropped; a `source:` line is ignored; ids are
      kept.
    - `tests/qa-runs.test.ts`: `session_id`, `runsOfSession`, and `qa_record` `flow` routing.
    - `tests/qa-agent.test.ts`: `parent:`; `plans:` is ignored; linkPlan, coverage and confirm are dropped.
    - `tests/qa-bug-log.browser.test.ts`: the feature comes from the job; a head of a QA lead can call `bug_log`.
  - Deleted: `tests/qa-agent-routes.test.ts`.
- **Run:** `bun test tests/qa-pipeline.test.ts tests/qa-jobs.test.ts tests/qa-prompts.test.ts tests/qa-routes.test.ts tests/qa-plan.test.ts tests/qa-runs.test.ts tests/qa-agent.test.ts tests/qa-bug-log.browser.test.ts`
- **Consumes from S1:**
  - `BugInfo.feature`, `FEATURE_ID`, `BugReport.feature`
  - `logBug(rootDir, r: BugReport, deps?)`
  - `runningFix`, `patchFinding`, `noteFinding`, `listFindings`, `readFinding`
- **Keeps stable for unchanged importers:** `QA_TOOL_SET`, `qaToolDefs` (`defs.ts`), `executeQaTool` (`tools.ts`),
  `usesQaTools` (`registry.ts`).

### S3 "qa web board"

- **Touches:**
  - Everything under `web/src/features/qa/`.
    - New: `api.ts` (rewritten), `logic.ts` (rewritten), `open.ts`, `run-choice.ts`, `QaTab.tsx`, `QaBoardView.tsx`,
      `RunBar.tsx`, `DriverPicker.tsx`, `PipelineStrip.tsx`, `FeatureGrid.tsx`, `FeatureRow.tsx`,
      `FeatureDetailPane.tsx`, `BugCard.tsx`, `OrphanPlans.tsx`, `UnsortedBugs.tsx`.
    - Deleted: `QaPanel.tsx`, `StepEditor.tsx`, `StepRow.tsx`, `RunHeader.tsx`, `NewPlanDialog.tsx`,
      `SuggestDialog.tsx`, `ProposalRow.tsx`, `QaView.tsx`, `FeaturesView.tsx`, `Banner.tsx`, `intent.ts`.
  - The browser QA dock, so S3 builds on its own: in `web/src/features/browser/BrowserTab.tsx` only the `QaPanel`
    mount, `qaOpen` and Alt+Q; in `browser/prefs.ts` the `qaOpen` pref; in `browser/logic.ts` `qaDock`, `stepsSince`,
    `resolvePath` and anything else only the dock used.
  - `DriverPicker` reuses `RunTabs`, `PairList` and `PairChipInner` from `web/src/features/agent/RunWith.tsx` and
    `WhoPicker` from `web/src/components/agent-who.tsx`. It does not edit either file.
- **UI:**
  - Read DESIGN.md first and use `design/tokens.css`.
  - Rows are 28px. Hover is `--color-hover`, and the selected row is `--color-primary-soft`.
  - Status dots are 7px: running is `--color-primary` with the pulse; ok is `--color-success`; partial or
    needs-check is `--color-warning`; fail or problem is `--color-danger`. A word always goes with the dot.
  - `--color-accent` is only for pair chips and pair jobs.
  - Mono for ids, paths and counts.
  - One primary button: Run when idle, Continue when held, none while running.
  - Pace and batching are segmented controls. Use `Empty` when there is no map.
  - No new tokens.
- **Tests:**
  - New `tests/web/qa-board.test.ts`:
    - `featureForUrl` with the §2 vectors;
    - the `pipelineRequest`, `rowRequest` and `bugFixRequest` bodies (a pair sends `{kind:"pair",pairId}` and no
      engine; replan is omitted for scope "all");
    - `stageLine`, `countsLine`;
    - `openQa` intent stash and take-once;
    - the web `STAGES` equals the server `STAGES`.
  - Changed: `tests/web/qa-logic.test.ts` keeps only the `countsLine` cases (or is deleted and they move to
    qa-board).
  - Deleted: `tests/web/qa-agent-logic.test.ts`, `tests/web/qa-dock.test.ts`.
- **Run:** `bun test tests/web/qa-board.test.ts tests/web/qa-logic.test.ts tests/web/bug-steps.test.ts tests/web/browser-location.test.ts tests/web/terminal.test.ts`
- **Consumes:** the §3 HTTP contract and §7 routes (S2), and the Lab PATCH (S1).
- **Exports for S4, exactly:**
  - `QaTab` (`web/src/features/qa/QaTab.tsx`)
  - `openQa`, `QaIntent` (`web/src/features/qa/open.ts`)
  - `useQaBoard` (`web/src/features/qa/api.ts`)
  - `featureForUrl` (`web/src/features/qa/logic.ts`)

### S4 "web shell + removals"

- **Touches:**
  - `web/src/features/lab/BugsTab.tsx` (deleted), `views.ts`, `open.ts`, `logic.ts`, `data.ts`, `shared.tsx`,
    `FindingsTab.tsx`
  - `web/src/shell/ActivityBar.tsx`, `commands.tsx`, `EditorArea.tsx`
  - `web/src/lib/store.ts`, `web/src/lib/tab-migration.ts`
  - `web/src/features/browser/LogBugDialog.tsx` only (the dock removal in `BrowserTab.tsx`, `prefs.ts`, `logic.ts` is
    S3's), plus any other `BrowserTab.tsx` line that opens the Bugs view, which S4 sends to the lead to apply
- **Tests:**
  - `tests/web/tab-migration.test.ts`: the bugs → qa case.
  - `tests/web/lab-views.test.ts`: the bugs intent cases are dropped.
  - `tests/web/lab-logic.test.ts`: the bug helper cases are dropped.
  - `tests/web/bug-steps.test.ts`, `tests/web/browser-location.test.ts`, `tests/web/terminal.test.ts`: still pass
    after the `browser/logic.ts` removals.
- **Run:** `bun test tests/web/tab-migration.test.ts tests/web/lab-views.test.ts tests/web/lab-logic.test.ts`
- **Consumes:**
  - From S3: `QaTab`, `openQa`, `QaIntent`, `useQaBoard`, `featureForUrl`.
  - From S1: the Lab wire shapes in §3 (`Finding.bug.feature`, PATCH and POST bugs `feature`).

## 11. Order and merge

1. **S1 merges before S2.** S2 imports `FEATURE_ID`, `BugReport.feature` and `BugInfo.feature`. Until S1 lands, S2
   builds against the §6 S1 signatures.
2. **S3 merges before S4.** S4 imports S3's exports. S3 owns the browser QA dock removal, so each slice builds on its own;
   S4 starts from the branch after S3 has landed.
3. S1/S2 and S3/S4 do not depend on each other at build time, only on this doc. Run all four slices' test commands
   after the last merge, plus `bun run typecheck` (server and web).
4. A builder that finds this contract wrong (a missing field, an impossible rule) stops and reports it. It does not
   add a field on one side only.
