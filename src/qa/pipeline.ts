/**
 * The QA pipeline's pure core: every scheduling rule lives here and nothing here touches the database, the disk or the
 * session manager. A decision is derived from the snapshot alone, so running it twice converges to the same end state.
 */
import { UserError } from "../util";
import {
  STAGES,
  type Activity,
  type Area,
  type Batching,
  type Control,
  type Decision,
  type Driver,
  type Feature,
  type FeatureId,
  type Job,
  type Launch,
  type MapUnit,
  type NonEmpty,
  type Pace,
  type Pipeline,
  type PipelineConfig,
  type PipelineView,
  type Scope,
  type Snapshot,
  type Stage,
  type StageState,
  type Unit,
} from "./types";

export { STAGES };

export const BUG_ID = /^bug-[a-z0-9][a-z0-9-]*$/;
/** How many jobs of a stage run at once. Server only. Test is set per pipeline (`stages.test.parallel`). */
export const PARALLEL = { map: 3, plan: 3, fix: 1 } as const;
/** The daemon allows four agent browsers in all (src/browser/manager.ts MAX_CONTEXTS), so test runs get at most three. */
export const MAX_TEST_PARALLEL = 3;
export const PAIR_HEAD_CAP = 6;
export const MAX_ATTEMPTS = 2;
/** Most units in one `together` job: the prompt inlines every unit, so a bigger batch overflows the model's context. */
export const TOGETHER_MAX = 10;
const MAX_NOTE = 4000;

const WAIT: Decision = { kind: "wait" };

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);

/** The one feature whose `where` best matches the page, or null: no match, a tie on the best score, or a url that does not parse. */
export function featureForUrl(features: readonly Pick<Feature, "id" | "where">[], url: string): FeatureId | null {
  let path: string;
  try {
    path = trimSlash(new URL(url).pathname);
  } catch {
    return null;
  }
  let best = 0;
  let winners: FeatureId[] = [];
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

/** The feature a bug is shown under: the one stored in its file when it still exists, else the one its page matches. */
export function bugFeature(stored: string | null | undefined, url: string, features: readonly Pick<Feature, "id" | "where">[]): { feature: FeatureId | null; source: "stored" | "url" | null } {
  const hit = stored ? features.find((f) => f.id === stored) : null;
  if (hit) return { feature: hit.id, source: "stored" };
  const byUrl = featureForUrl(features, url);
  return byUrl ? { feature: byUrl, source: "url" } : { feature: null, source: null };
}

const present = (c: PipelineConfig): Stage[] => STAGES.filter((s) => c.stages[s] !== undefined);

function nextStage(after: Stage, c: PipelineConfig): Stage | null {
  return present(c).find((s) => STAGES.indexOf(s) > STAGES.indexOf(after)) ?? null;
}

function inScope(c: PipelineConfig, s: Snapshot): Feature[] {
  if (c.scope.kind === "all") return [...s.features];
  if (c.scope.kind === "features") {
    const ids = new Set(c.scope.ids);
    return s.features.filter((f) => ids.has(f.id));
  }
  if (c.scope.kind === "areas") {
    const ids = new Set<string>(c.scope.ids);
    return s.features.filter((f) => f.area !== null && ids.has(f.area));
  }
  return [];
}

function mapUnits(c: PipelineConfig, s: Snapshot): MapUnit[] {
  if (s.layout === "flat") return ["map"];
  const wanted = (a: Snapshot["areas"][number]): boolean => {
    if (c.scope.kind === "areas") return c.scope.ids.includes(a.id);
    if (c.scope.kind === "features") {
      const ids = new Set<string>(c.scope.ids);
      return s.features.some((f) => f.area === a.id && ids.has(f.id));
    }
    return true;
  };
  return s.areas.filter(wanted).map((a): MapUnit => `area:${a.id}`);
}

/** The units a stage works on, in the order they run. Frozen into the pipeline when the stage opens. */
export function unitsFor(stage: Stage, c: PipelineConfig, s: Snapshot): Unit[] {
  switch (stage) {
    case "map":
      return c.stages.map?.survey ? ["areas"] : mapUnits(c, s);
    case "plan": {
      const replan = c.stages.plan?.replan ?? false;
      return inScope(c, s)
        .filter((f) => {
          const plan = s.plans.get(f.id);
          return replan || !plan || plan.problem !== null || plan.steps === 0;
        })
        .map((f) => f.id);
    }
    case "test":
      return inScope(c, s)
        .filter((f) => {
          const plan = s.plans.get(f.id);
          return !!plan && plan.problem === null && plan.steps >= 1;
        })
        .map((f) => f.id);
    case "fix": {
      const open = [...s.openBugs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (c.scope.kind === "bugs") {
        const named = new Set<string>(c.scope.ids);
        return open.filter((b) => named.has(b.id)).map((b) => b.id);
      }
      if (c.scope.kind === "all") return open.map((b) => b.id);
      const feats = new Set<string>(inScope(c, s).map((f) => f.id));
      return open.filter((b) => b.feature !== null && feats.has(b.feature)).map((b) => b.id);
    }
  }
}

const launchOf = (stage: Stage, units: Unit[]): Launch => ({ stage, units }) as unknown as Launch;

/** The first rule that applies wins (docs/design/qa-pipeline.md §5). */
export function reconcile(p: Pipeline, s: Snapshot, now: number): Decision {
  const c = p.control;
  switch (c.kind) {
    case "ended":
    case "held":
      return WAIT;
    case "stopping":
      return s.jobs.some((j) => j.active) ? WAIT : { kind: "control", control: { kind: "ended", reason: "stopped", at: now }, units: null };
    case "running":
      return running(p, c.stage, s, now);
  }
}

/** A job's error counts against every unit it listed; its problem against the units in `failed`, or all when that is null. */
export interface UnitState { attempts: number; ok: boolean; active: boolean }

const isActive = (j: Job): boolean => j.settledAt === null && j.session !== null;

/** The job settled and this unit was not among the ones that failed. */
const passedIn = (j: Job, u: Unit): boolean => j.settledAt !== null && j.error === null && (j.problem === null || (j.failed !== null && !j.failed.includes(u)));

export function unitStates(jobs: readonly Job[]): Map<Unit, UnitState> {
  const states = new Map<Unit, UnitState>();
  for (const j of jobs) {
    for (const u of j.units) {
      const st = states.get(u) ?? { attempts: 0, ok: false, active: false };
      states.set(u, { attempts: st.attempts + 1, ok: st.ok || passedIn(j, u), active: st.active || isActive(j) });
    }
  }
  return states;
}

const retryable = (st: UnitState | undefined): boolean => !st || (!st.active && !st.ok && st.attempts < MAX_ATTEMPTS);

// A stored pipeline can lack `parallel`: it ran one test at a time.
const roomOf = (st: Stage, c: PipelineConfig): number => (st === "test" ? (c.stages.test?.parallel ?? 1) : PARALLEL[st]);

function running(p: Pipeline, st: Stage, s: Snapshot, now: number): Decision {
  const jobs = s.jobs.filter((j) => j.stage === st);
  const states = unitStates(jobs);
  const left = (p.units ?? []).filter((u) => retryable(states.get(u)));
  const active = jobs.filter((j) => j.active);

  if (!left.length && !active.length) {
    // The survey made the areas: re-freeze the stage onto them.
    if (st === "map" && p.units?.length === 1 && p.units[0] === "areas" && states.get("areas")?.ok && s.layout === "areas") {
      return { kind: "control", control: { kind: "running", stage: "map" }, units: mapUnits(p.config, s) };
    }
    const next = nextStage(st, p.config);
    if (!next) return { kind: "control", control: { kind: "ended", reason: "done", at: now }, units: null };
    if (p.config.pace === "step") return { kind: "control", control: { kind: "held", after: st, next }, units: null };
    return { kind: "control", control: { kind: "running", stage: next }, units: unitsFor(next, p.config, s) };
  }
  if (st === "fix" && s.fixBusyElsewhere) return WAIT;
  if (!left.length) return WAIT;

  const together = st !== "map" && p.config.stages[st]?.batching === "together";
  if (together) return active.length ? WAIT : { kind: "launch", launches: [launchOf(st, left.slice(0, TOGETHER_MAX))] };

  const room = roomOf(st, p.config) - active.length;
  if (room <= 0) return WAIT;
  const launches = left.slice(0, room).map((u) => launchOf(st, [u]));
  return { kind: "launch", launches: launches as unknown as NonEmpty<Launch> };
}

const settled = (j: Job): boolean => j.settledAt !== null;

export function pipelineView(p: Pipeline, jobs: readonly Job[], _s?: Snapshot): PipelineView {
  const c = p.control;
  const current = c.kind === "running" || c.kind === "stopping" ? c.stage : null;
  const stages = STAGES.map((stage) => {
    const frozen = stage === current && p.units ? new Set<Unit>(p.units) : null;
    // After a survey re-freezes the stage, the survey unit is no longer one of its units.
    const states = new Map([...unitStates(jobs.filter((j) => j.stage === stage))].filter(([u]) => !frozen || frozen.has(u)));
    const retrying = (st: UnitState): boolean => p.control.kind === "running" && p.control.stage === stage && retryable(st);
    const finished = [...states.values()].filter((st) => st.ok || (!st.active && !retrying(st)));
    const done = finished.length;
    const problems = finished.filter((st) => !st.ok).length;
    const total = stage === current ? (p.units?.length ?? 0) : states.size;
    return { stage, state: stateOf(p, stage, total, done), done, total, problems };
  });
  return { id: p.id, config: p.config, control: p.control, stages, jobs: jobs.map((j) => jobViewOf(j)), createdAt: p.createdAt };
}

function stateOf(p: Pipeline, stage: Stage, total: number, done: number): StageState {
  if (p.config.stages[stage] === undefined) return "skipped";
  const at = STAGES.indexOf(stage);
  const c: Control = p.control;
  switch (c.kind) {
    case "running":
    case "stopping":
      return at < STAGES.indexOf(c.stage) ? "done" : at === STAGES.indexOf(c.stage) ? "current" : "next";
    case "held":
      return at <= STAGES.indexOf(c.after) ? "done" : at === STAGES.indexOf(c.next) ? "held" : "next";
    case "ended":
      return c.reason === "done" || (total > 0 && done === total) ? "done" : "next";
  }
}

/** A job as the wire shows it. `pair` is told by the caller: only the session manager knows. */
export function jobViewOf(j: Job, pair = false): PipelineView["jobs"][number] {
  return {
    id: j.id,
    stage: j.stage,
    units: [...j.units],
    sessionId: j.session,
    pair,
    state: j.settledAt !== null ? "settled" : j.nudgedTurns !== null ? "merging" : "running",
    problem: j.problem,
    error: j.error,
    startedAt: j.startedAt,
    settledAt: j.settledAt,
  };
}

export function activityOf(stage: Stage, unit: Unit, p: Pipeline | null, jobs: readonly Job[], leadIsPair: (session: string) => boolean): Activity {
  const covering = jobs.filter((j) => j.stage === stage && (j.units as readonly Unit[]).includes(unit));
  const live = covering.find(isActive);
  if (live) return { kind: "working", sessionId: live.session!, pair: leadIsPair(live.session!) };
  // A unit that failed once will be launched again while the stage runs: it is waiting, not a problem yet.
  const frozen = p?.control.kind === "running" && p.control.stage === stage && (p.units ?? []).includes(unit);
  if (frozen && retryable(unitStates(covering).get(unit))) return { kind: "queued" };
  const last = covering[covering.length - 1];
  if (last && settled(last) && !passedIn(last, unit)) return { kind: "problem", text: last.error ?? last.problem ?? "", sessionId: last.session };
  return { kind: "idle" };
}

/** One activity for several: a working unit shows over a queued one, a queued one over a problem. */
export function mergeActivity(parts: readonly Activity[]): Activity {
  for (const kind of ["working", "queued", "problem"] as const) {
    const hit = parts.find((a) => a.kind === kind);
    if (hit) return hit;
  }
  return { kind: "idle" };
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function batchingOf(v: unknown): Batching {
  const b = obj(v).batching;
  if (b !== "each" && b !== "together") throw new UserError('batching must be "each" or "together".');
  return b;
}

const SINGULAR = { features: "feature", areas: "area", bugs: "bug" } as const;

function idsOf(v: unknown, what: keyof typeof SINGULAR): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new UserError(`${what} must be a list of ids.`);
  const ids = [...new Set((v as string[]).map((x) => x.trim()))].filter(Boolean);
  if (!ids.length) throw new UserError(`Pick at least one ${SINGULAR[what]}.`);
  return ids;
}

function scopeOf(v: unknown, ctx: { features: readonly Feature[]; areas: readonly Area[] }, stages: PipelineConfig["stages"]): Scope {
  const o = obj(v);
  const kind = o.kind ?? "all";
  if (kind === "all") return { kind: "all" };
  if (kind === "features") {
    const ids = idsOf(o.ids, "features");
    const known = new Set(ctx.features.map((f) => f.id as string));
    for (const id of ids) if (!known.has(id)) throw new UserError(`No feature "${id}".`);
    return { kind: "features", ids };
  }
  if (kind === "areas") {
    const ids = idsOf(o.ids, "areas");
    const known = new Set(ctx.areas.map((a) => a.id as string));
    for (const id of ids) if (!known.has(id)) throw new UserError(`No area "${id}".`);
    return { kind: "areas", ids };
  }
  if (kind === "bugs") {
    if (Object.keys(stages).length !== 1 || !stages.fix) throw new UserError("A list of bugs can only be fixed: choose the Fix stage alone.");
    const ids = idsOf(o.ids, "bugs");
    const bad = ids.find((id) => !BUG_ID.test(id));
    if (bad !== undefined) throw new UserError(`"${bad}" is not a bug id.`);
    return { kind: "bugs", ids };
  }
  throw new UserError('scope must be "all", "features", "areas" or "bugs".');
}

function driverOf(v: unknown, ctx: { pairExists: (id: string) => boolean }): Driver {
  const o = obj(v);
  if (o.kind === "pair") {
    const id = text(o.pairId);
    if (!id || !ctx.pairExists(id)) throw new UserError(`No Hydra pair "${id ?? ""}". See \`trb pair list\`.`);
    return { kind: "pair", pairId: id };
  }
  if (o.kind !== undefined && o.kind !== "agent") throw new UserError('driver must be an agent or a pair: kind "agent" or "pair".');
  return { kind: "agent", engine: text(o.engine), model: text(o.model), effort: text(o.effort), agent: text(o.agent) };
}

function parallelOf(v: unknown): number {
  const n = obj(v).parallel;
  if (n === undefined) return 1;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_TEST_PARALLEL) throw new UserError(`parallel must be a whole number from 1 to ${MAX_TEST_PARALLEL}.`);
  return n;
}

function baseUrlOf(v: unknown): string | null {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return null;
  let u: URL;
  try {
    if (typeof v !== "string") throw new Error("not text");
    u = new URL(v.trim());
  } catch {
    throw new UserError("baseUrl must be an http or https address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UserError("baseUrl must be an http or https address.");
  return u.toString().replace(/\/+$/, "");
}

/** A request body as a stored config: validated, defaults resolved. Throws UserError with the message the route answers 400 with. */
export function parseConfig(body: unknown, ctx: { features: readonly Feature[]; areas: readonly Area[]; pairExists: (id: string) => boolean }): PipelineConfig {
  const b = obj(body);
  const raw = obj(b.stages);
  const unknown = Object.keys(raw).find((k) => !(STAGES as readonly string[]).includes(k));
  if (unknown !== undefined) throw new UserError(`Unknown stage "${unknown}": use ${STAGES.join(", ")}.`);
  if (!Object.keys(raw).length) throw new UserError("Pick at least one stage.");

  const scopeKind = obj(b.scope).kind ?? "all";
  const stages: PipelineConfig["stages"] = {};
  if (raw.map !== undefined) {
    const survey = obj(raw.map).survey;
    if (survey !== undefined && typeof survey !== "boolean") throw new UserError("survey must be true or false.");
    stages.map = { survey: survey ?? false };
  }
  if (raw.plan !== undefined) {
    const replan = obj(raw.plan).replan;
    if (replan !== undefined && typeof replan !== "boolean") throw new UserError("replan must be true or false.");
    stages.plan = { batching: batchingOf(raw.plan), replan: replan ?? scopeKind === "features" };
  }
  if (raw.test !== undefined) stages.test = { batching: batchingOf(raw.test), parallel: parallelOf(raw.test) };
  if (raw.fix !== undefined) stages.fix = { batching: batchingOf(raw.fix) };

  const scope = scopeOf(b.scope, ctx, stages);
  if (b.pace !== "auto" && b.pace !== "step") throw new UserError('pace must be "auto" or "step".');
  const pace: Pace = b.pace;
  const note = b.note === undefined || b.note === null ? "" : typeof b.note === "string" ? b.note.trim() : null;
  if (note === null) throw new UserError("note must be text.");
  if (note.length > MAX_NOTE) throw new UserError(`note is at most ${MAX_NOTE} characters.`);
  return { stages, scope, pace, driver: driverOf(b.driver, ctx), note, baseUrl: baseUrlOf(b.baseUrl) };
}
