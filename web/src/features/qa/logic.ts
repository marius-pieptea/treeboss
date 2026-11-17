import { STAGES } from "./api";
import type { Activity, BoardArea, BoardBug, BoardFeature, Batching, BugState, Driver, JobView, Outcome, OutcomeState, Pace, PipelineRequest, PipelineView, QaBoard, Scope, Stage, StageSettings } from "./api";

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);

/** Mirrors `featureForUrl` in src/qa/pipeline.ts, including its quirk: a `where` entry counts only when it starts with "/" as written (no trimming). */
export function featureForUrl(features: readonly { id: string; where: string[] }[], url: string): string | null {
  let path: string;
  try {
    path = trimSlash(new URL(url).pathname);
  } catch {
    return null;
  }
  let best = 0;
  let winners: string[] = [];
  for (const f of features) {
    let score = 0;
    for (const raw of f.where) {
      if (!raw.startsWith("/")) continue;
      const w = trimSlash(raw);
      if ((path === w || path.startsWith(w === "/" ? "/" : `${w}/`)) && w.length > score) score = w.length;
    }
    if (!score) continue;
    if (score > best) {
      best = score;
      winners = [f.id];
    } else if (score === best) winners.push(f.id);
  }
  return winners.length === 1 ? winners[0]! : null;
}

export const STAGE_LABEL: Record<Stage, string> = { map: "Map", plan: "Plan", test: "Test", fix: "Fix" };

export interface RunForm {
  stages: Stage[];
  batching: Record<"plan" | "test" | "fix", Batching>;
  /** Null: leave it to the server (scope "all" keeps plans, picked features redo them). */
  replan: boolean | null;
  /** Map stage: decide the areas first, then map each one. Off by default. */
  survey: boolean;
  /** Test stage, batching "each" only: how many jobs run at once. */
  parallel: Parallel;
  pace: Pace;
  baseUrl: string;
  note: string;
}

export type Parallel = 1 | 2 | 3;

export const PARALLEL: readonly Parallel[] = [1, 2, 3];

export const NOTE_MAX = 4000;

export const defaultStages = (mapExists: boolean): Stage[] => (mapExists ? ["plan", "test", "fix"] : [...STAGES]);

export const defaultForm = (mapExists: boolean): RunForm => ({ stages: defaultStages(mapExists), batching: { plan: "each", test: "each", fix: "each" }, replan: null, survey: false, parallel: 1, pace: "auto", baseUrl: "", note: "" });

/** `stages` with `stage` switched on or off, always in run order. */
export const toggleStage = (stages: readonly Stage[], stage: Stage): Stage[] => STAGES.filter((s) => (s === stage ? !stages.includes(s) : stages.includes(s)));

/** The wire driver, with nothing a pair does not have and nothing an agent left empty. */
export function driverBody(d: Driver): Driver {
  if (d.kind === "pair") return { kind: "pair", pairId: d.pairId };
  const out: Extract<Driver, { kind: "agent" }> = { kind: "agent" };
  for (const k of ["engine", "model", "effort", "agent"] as const) if (d[k]) out[k] = d[k];
  return out;
}

function settings(stages: readonly Stage[], batching: (s: "plan" | "test" | "fix") => Batching, form: Pick<RunForm, "replan" | "survey" | "parallel">): StageSettings {
  const out: StageSettings = {};
  for (const s of STAGES) {
    if (!stages.includes(s)) continue;
    if (s === "map") out.map = form.survey ? { survey: true } : {};
    else if (s === "plan") out.plan = { batching: batching("plan"), ...(form.replan !== null ? { replan: form.replan } : {}) };
    // The server reads a missing parallel as 1, and rejects one beside "together".
    else if (s === "test") out.test = { batching: batching("test"), ...(batching("test") === "each" && form.parallel > 1 ? { parallel: form.parallel } : {}) };
    else out[s] = { batching: batching(s) };
  }
  return out;
}

function extras(form: RunForm): Pick<PipelineRequest, "note" | "baseUrl"> {
  const note = form.note.trim().slice(0, NOTE_MAX);
  const baseUrl = form.baseUrl.trim();
  return { ...(note ? { note } : {}), ...(baseUrl ? { baseUrl } : {}) };
}

export function pipelineRequest(form: RunForm, scope: Scope, driver: Driver): PipelineRequest {
  return { stages: settings(form.stages, (s) => form.batching[s], form), scope, pace: form.pace, driver: driverBody(driver), ...extras(form) };
}

export function rowRequest(action: "plan" | "test" | "fix" | "stages", featureId: string, form: RunForm, driver: Driver): PipelineRequest {
  const scope: Scope = { kind: "features", ids: [featureId] };
  if (action === "stages") return pipelineRequest(form, scope, driver);
  if (action === "plan") return { stages: { plan: { batching: "each", replan: true } }, scope, pace: "auto", driver: driverBody(driver), ...extras(form) };
  const stages: StageSettings = action === "test" ? { test: { batching: "each" } } : { fix: { batching: form.batching.fix } };
  return { stages, scope, pace: "auto", driver: driverBody(driver), ...extras(form) };
}

export function areaRemapRequest(areaId: string, form: RunForm, driver: Driver): PipelineRequest {
  return { stages: { map: {} }, scope: { kind: "areas", ids: [areaId] }, pace: "auto", driver: driverBody(driver), ...extras(form) };
}

export const bugsFixRequest = (ids: readonly string[], driver: Driver): PipelineRequest => ({ stages: { fix: { batching: "each" } }, scope: { kind: "bugs", ids: [...ids] }, pace: "auto", driver: driverBody(driver) });

export const bugFixRequest = (bugId: string, driver: Driver): PipelineRequest => bugsFixRequest([bugId], driver);

/** The picked features in the order the map lists them; with none picked, the area filtered to, if any; else all of the features. */
export const scopeOf = (picked: readonly string[], features: readonly { id: string }[], area?: string | null): Scope => {
  const ids = features.map((f) => f.id).filter((id) => picked.includes(id));
  if (ids.length) return { kind: "features", ids };
  return area ? { kind: "areas", ids: [area] } : { kind: "all" };
};

export function scopeLabel(scope: Scope, total: number, areas: readonly Pick<BoardArea, "id" | "title" | "features">[] = []): string {
  if (total === 0) return "No features yet";
  if (scope.kind === "all") return `All ${total} ${total === 1 ? "feature" : "features"}`;
  if (scope.kind === "areas") {
    const a = areas.find((x) => x.id === scope.ids[0]);
    return a ? `Area ${a.title} · ${a.features} ${a.features === 1 ? "feature" : "features"}` : `${scope.ids.length} ${scope.ids.length === 1 ? "area" : "areas"}`;
  }
  return `${scope.ids.length} of ${total} picked`;
}

export function runBlock(i: { stages: readonly Stage[]; browser: boolean; featureCount: number; driverMissing: boolean }): string | null {
  if (i.stages.length === 0) return "Pick at least one stage.";
  if (!i.browser && i.stages.some((s) => s !== "fix")) return "The agent browser is off. Run `trb config set agent_browser on`.";
  if (i.driverMissing) return "That Hydra pair no longer exists. Pick another.";
  if (i.featureCount === 0 && !i.stages.includes("map") && i.stages.some((s) => s === "plan" || s === "test")) return "There is no feature map yet. Switch Map on.";
  return null;
}

export function stageLine(s: PipelineView["stages"][number]): string {
  const name = STAGE_LABEL[s.stage];
  if (s.state === "skipped") return `${name} skipped`;
  return [`${name} ${s.done}/${s.total}`, ...(s.problems > 0 ? [`${s.problems} ${s.problems === 1 ? "problem" : "problems"}`] : [])].join(" · ");
}

const BAD: OutcomeState[] = ["fail", "blocked"];

/** "5/12 · 1 fail": only the states that need a look are named. */
export function countsLine(counts: Record<OutcomeState, number>): string {
  const total = counts.pending + counts.pass + counts.fail + counts.skip + counts.blocked;
  return [`${total - counts.pending}/${total}`, ...BAD.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`)].join(" · ");
}

export type RunPhase = "idle" | "running" | "stopping" | "held" | "ended";

export const phaseOf = (p: PipelineView | null): RunPhase => (p ? p.control.kind : "idle");

export const isBusy = (phase: RunPhase): boolean => phase === "running" || phase === "stopping" || phase === "held";

/** What the one primary button is: Run when idle, Continue when held, none while running. */
export const primaryOf = (phase: RunPhase): "run" | "continue" | null => (phase === "held" ? "continue" : phase === "running" || phase === "stopping" ? null : "run");

export function statusLine(p: PipelineView): string {
  const c = p.control;
  switch (c.kind) {
    case "running":
      return `Running · ${stageLine(p.stages.find((s) => s.stage === c.stage)!)}`;
    case "stopping":
      return "Stopping · running sessions finish";
    case "held": {
      const problems = p.stages.find((s) => s.stage === c.after)?.problems ?? 0;
      const ended = problems > 0 ? `: ${problems} ${problems === 1 ? "problem" : "problems"}` : " done";
      return `${STAGE_LABEL[c.after]}${ended} · ${STAGE_LABEL[c.next]} next`;
    }
    case "ended": {
      const problems = p.stages.reduce((n, s) => n + s.problems, 0);
      const word = c.reason === "done" ? "Done" : c.reason === "stopped" ? "Stopped" : "Replaced";
      return problems > 0 ? `${word} · ${problems} ${problems === 1 ? "problem" : "problems"}` : word;
    }
  }
}

export type Tone = "run" | "ok" | "warn" | "bad" | "idle";

export interface Cell {
  tone: Tone;
  word: string;
  count?: string;
  pair?: boolean;
  title?: string;
}

function activityCell(a: Activity, verb: string): Cell | null {
  switch (a.kind) {
    case "working":
      return { tone: "run", word: verb, pair: a.pair };
    case "queued":
      return { tone: "idle", word: "queued" };
    case "problem":
      return { tone: "bad", word: "problem", title: a.text };
    case "idle":
      return null;
  }
}

export function planCell(f: Pick<BoardFeature, "plan" | "activity">): Cell {
  const a = activityCell(f.activity.plan, "planning");
  if (a) return a;
  switch (f.plan.kind) {
    case "ready":
      return { tone: "ok", word: "ready", count: `${f.plan.steps} ${f.plan.steps === 1 ? "step" : "steps"}` };
    case "broken":
      return { tone: "bad", word: "broken", title: f.plan.problem };
    case "missing":
      return { tone: "idle", word: "no plan" };
  }
}

export function testCell(f: Pick<BoardFeature, "test" | "activity">): Cell {
  const a = activityCell(f.activity.test, "testing");
  if (a) return a;
  if (f.test.kind === "never") return { tone: "idle", word: "not run" };
  const c = f.test.run.counts;
  const total = c.pending + c.pass + c.fail + c.skip + c.blocked;
  const count = `${total - c.pending}/${total}`;
  if (c.fail > 0) return { tone: "bad", word: "fail", count };
  if (c.blocked > 0) return { tone: "warn", word: "blocked", count };
  if (c.pending > 0) return { tone: "warn", word: "partial", count };
  return { tone: "ok", word: "pass", count };
}

export const isOpenBug = (b: Pick<BoardBug, "state">): boolean => b.state !== "fixed" && b.state !== "dismissed";

export function bugsCell(f: Pick<BoardFeature, "bugs" | "activity">): Cell {
  const open = f.bugs.filter(isOpenBug);
  const a = activityCell(f.activity.fix, "fixing");
  if (a) return { ...a, ...(open.length ? { count: String(open.length) } : {}) };
  if (open.length === 0) return f.bugs.length ? { tone: "ok", word: "fixed", count: String(f.bugs.length) } : { tone: "idle", word: "none" };
  if (open.some((b) => b.state === "open")) return { tone: "bad", word: "open", count: String(open.length) };
  if (open.some((b) => b.state === "fixing")) return { tone: "run", word: "fixing", count: String(open.length) };
  return { tone: "warn", word: "check", count: String(open.length) };
}

export function mapCell(map: QaBoard["map"], features: number): Cell {
  const a = activityCell(map.activity, "mapping");
  if (a && a.tone !== "idle") return a;
  if (map.problem) return { tone: "bad", word: "problem", title: map.problem };
  if (!map.exists) return { tone: "idle", word: "not mapped" };
  return { tone: "ok", word: "mapped", count: `${features} ${features === 1 ? "feature" : "features"}` };
}

export function areaCell(a: Pick<BoardArea, "features" | "updatedAt" | "activity">): Cell {
  const count = `${a.features} ${a.features === 1 ? "feature" : "features"}`;
  const act = activityCell(a.activity, "mapping");
  if (act) return { ...act, count };
  return a.updatedAt === null ? { tone: "idle", word: "not mapped", count } : { tone: "ok", word: "mapped", count };
}

export const BUG_TONE: Record<BugState, Tone> = { open: "bad", fixing: "run", "needs-check": "warn", fixed: "ok", dismissed: "idle" };
export const BUG_WORD: Record<BugState, string> = { open: "open", fixing: "fixing", "needs-check": "needs check", fixed: "fixed", dismissed: "dismissed" };

/** What a bug's card offers: Fix while it is open or waiting for a check, Reopen once it is closed. */
export function bugOffers(state: BugState): { fix: boolean; close: boolean; reopen: boolean } {
  return { fix: state === "open" || state === "needs-check", close: state === "open" || state === "needs-check", reopen: state === "fixed" || state === "dismissed" };
}

const STEP_TONE: Record<OutcomeState, Tone> = { pass: "ok", fail: "bad", blocked: "warn", skip: "idle", pending: "idle" };

export const stepCell = (last: OutcomeState | null): Cell => (last && last !== "pending" ? { tone: STEP_TONE[last], word: last } : { tone: "idle", word: "not run" });

/** The jobs worth a line in the strip: the ones going and the ones that came back without their work. */
export const notableJobs = (jobs: readonly JobView[]): JobView[] => jobs.filter((j) => j.state !== "settled" || j.problem !== null || j.error !== null);

/** "plan · checkout", "fix · 3 bugs", "map". */
export function jobUnits(j: Pick<JobView, "stage" | "units">): string {
  if (j.stage === "map") return "map";
  if (j.units.length === 1) return `${j.stage} · ${j.units[0]}`;
  return `${j.stage} · ${j.units.length} ${j.stage === "fix" ? "bugs" : "features"}`;
}

/** "just now", "5m ago", "2h ago", "3d ago". */
export function since(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export type FeatureFilter = "needs-plan" | "never-tested" | "failing" | "open-bugs" | "working";

export const FEATURE_FILTERS: ReadonlyArray<{ id: FeatureFilter; label: string; hint: string }> = [
  { id: "needs-plan", label: "Needs a plan", hint: "No plan yet, or the plan file is broken" },
  { id: "never-tested", label: "Never tested", hint: "No test run recorded" },
  { id: "failing", label: "Failing", hint: "The last run has failed steps" },
  { id: "open-bugs", label: "Open bugs", hint: "Has a bug that is not fixed or dismissed" },
  { id: "working", label: "Working", hint: "A plan, test or fix job is queued or running on it" },
];

const busyActivity = (a: Activity): boolean => a.kind === "queued" || a.kind === "working";

export function matchesFilter(f: BoardFeature, filter: FeatureFilter): boolean {
  switch (filter) {
    case "needs-plan":
      return f.plan.kind !== "ready";
    case "never-tested":
      return f.test.kind === "never";
    case "failing":
      return f.test.kind === "ran" && f.test.run.counts.fail > 0;
    case "open-bugs":
      return f.bugs.some(isOpenBug);
    case "working":
      return busyActivity(f.activity.plan) || busyActivity(f.activity.test) || busyActivity(f.activity.fix);
  }
}

export interface FeatureQuery {
  text: string;
  filters: readonly FeatureFilter[];
  /** An area id: only that area's features. Unset or null: all areas (and always so in the flat layout). */
  area?: string | null;
}

export const NO_QUERY: FeatureQuery = { text: "", filters: [] };

export const isFiltering = (q: FeatureQuery): boolean => q.text.trim() !== "" || q.filters.length > 0 || !!q.area;

/** The query with an area that is no longer on the map dropped, so a remap that renamed it cannot leave the list empty with no chip to clear. */
export const liveQuery = (q: FeatureQuery, areas: readonly { id: string }[]): FeatureQuery => (q.area && !areas.some((a) => a.id === q.area) ? { ...q, area: null } : q);

export function matchesQuery(f: BoardFeature, q: FeatureQuery): boolean {
  if (q.area && f.area !== q.area) return false;
  if (!q.filters.every((k) => matchesFilter(f, k))) return false;
  const words = q.text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [f.title, f.id, ...f.where, f.summary].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface FeatureRowModel {
  feature: BoardFeature;
  /** Shown only because a child matches: it gives the child its journey, it is not part of "shown". */
  context: boolean;
  /** How many depth-1 features sit under it (0 for a child or a lone feature). */
  children: number;
  collapsed: boolean;
}

/** While a query is active nothing is collapsed, so a hit is never hidden. */
export function featureRows(features: readonly BoardFeature[], q: FeatureQuery, collapsed: ReadonlySet<string>): { rows: FeatureRowModel[]; matched: string[] } {
  const active = isFiltering(q);
  const ids = new Set(features.map((f) => f.id));
  const isChild = (f: BoardFeature) => f.depth === 1 && f.parent !== null && ids.has(f.parent);
  const hit = new Set(features.filter((f) => matchesQuery(f, q)).map((f) => f.id));
  const kids = new Map<string, number>();
  const hitParents = new Set<string>();
  for (const f of features) {
    if (!isChild(f)) continue;
    kids.set(f.parent!, (kids.get(f.parent!) ?? 0) + 1);
    if (hit.has(f.id)) hitParents.add(f.parent!);
  }
  const rows: FeatureRowModel[] = [];
  for (const f of features) {
    if (isChild(f)) {
      if (hit.has(f.id) && (active || !collapsed.has(f.parent!))) rows.push({ feature: f, context: false, children: 0, collapsed: false });
    } else if (hit.has(f.id) || hitParents.has(f.id)) {
      rows.push({ feature: f, context: !hit.has(f.id), children: kids.get(f.id) ?? 0, collapsed: !active && collapsed.has(f.id) });
    }
  }
  return { rows, matched: features.filter((f) => hit.has(f.id)).map((f) => f.id) };
}

export const shownLine = (shown: number, total: number, active: boolean): string => `${active ? `${shown} of ${total}` : total} ${total === 1 ? "feature" : "features"}`;

export const pickShown = (matched: readonly string[]): string[] => [...matched];

/** The header box: pick the shown features, or, when they are all picked already, drop just those. */
export const toggleShown = (picked: readonly string[], matched: readonly string[]): string[] => (matched.length > 0 && matched.every((id) => picked.includes(id)) ? picked.filter((id) => !matched.includes(id)) : pickShown(matched));

/** Fix offers itself on open and needs-check bugs, so only those can be ticked. */
export const selectableBugs = (bugs: readonly BoardBug[]): BoardBug[] => bugs.filter((b) => bugOffers(b.state).fix);

export const prunePickedBugs = (picked: readonly string[], bugs: readonly BoardBug[]): string[] => selectableBugs(bugs).map((b) => b.id).filter((id) => picked.includes(id));

export const prunePicked = (picked: readonly string[], features: readonly { id: string }[]): string[] => picked.filter((id) => features.some((f) => f.id === id));

/** The bug a notification points at, wherever the board shows it: its feature, or null for the unsorted list. */
export function findBug(board: Pick<QaBoard, "features" | "bugsWithoutFeature">, id: string): { feature: string | null } | null {
  for (const f of board.features) if (f.bugs.some((b) => b.id === id)) return { feature: f.id };
  return board.bugsWithoutFeature.some((b) => b.id === id) ? { feature: null } : null;
}

/** What a step's outcome says in words: what actually happened for a failure, the note otherwise. */
export const outcomeText = (o: Outcome): string => (o.state === "fail" ? o.actual : o.state === "pending" ? "" : o.note);
