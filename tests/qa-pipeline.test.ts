import { describe, expect, test } from "bun:test";
import { activityOf, bugFeature, featureForUrl, mergeActivity, MAX_TEST_PARALLEL, PARALLEL, parseConfig, pipelineView, reconcile, unitsFor } from "../src/qa/pipeline";
import type { Area, AreaId, Batching, BugId, Control, Decision, Feature, FeatureId, Job, JobId, MapFeature, Pipeline, PipelineConfig, PipelineId, Snapshot, Stage, Unit } from "../src/qa/types";

const fid = (s: string) => s as FeatureId;
const bid = (s: string) => s as BugId;
const feature = (id: string, where: string[] = [], parent: string | null = null, area: string | null = null): MapFeature => ({ id: fid(id), title: id, where, parent: parent as FeatureId | null, summary: "", area: area as AreaId | null });
const F = ["a", "b", "c", "d", "e"].map((x) => feature(x));
const area = (id: string): Area => ({ id: id as AreaId, title: id, where: [`/${id}`], summary: "" });

const config = (o: Partial<PipelineConfig> & { stages: PipelineConfig["stages"] }): PipelineConfig => ({ scope: { kind: "all" }, pace: "auto", driver: { kind: "agent" }, note: "", baseUrl: null, ...o });
const pipeline = (c: PipelineConfig, control: Control, units: Unit[] | null): Pipeline => ({ id: "qap_1" as PipelineId, root: "/r", config: c, control, units, createdAt: 1 });

let n = 0;
const job = (stage: Stage, units: string[], o: { active?: boolean; error?: string | null; problem?: string | null; failed?: string[] } = {}): Job & { active: boolean } => {
  const active = o.active ?? false;
  return {
    id: `qaj_${++n}` as JobId, pipeline: "qap_1" as PipelineId, root: "/r", stage, units: units as unknown as Job["units"],
    session: o.error ? null : `s_${n}`, error: o.error ?? null, sigs: {}, nudgedTurns: null, problem: o.problem ?? null, failed: (o.failed ?? null) as Job["failed"], startedAt: n,
    settledAt: active ? null : 5, active: active && !o.error,
  };
};

const snap = (o: Partial<Snapshot> = {}): Snapshot => ({ features: F, areas: [], layout: "flat", mapExists: true, plans: new Map(), openBugs: [], jobs: [], fixBusyElsewhere: false, ...o });
const planned = (...ids: string[]) => new Map(ids.map((i) => [fid(i), { steps: 2, problem: null }]));

const launches = (d: Decision) => (d.kind === "launch" ? d.launches.map((l) => ({ stage: l.stage, units: [...l.units] })) : null);

describe("reconcile: control", () => {
  const c = config({ stages: { plan: { batching: "each", replan: false } } });
  const cases: Array<[string, Control, Job[], Decision]> = [
    ["ended waits", { kind: "ended", reason: "done", at: 1 }, [], { kind: "wait" }],
    ["held waits", { kind: "held", after: "plan", next: "test" }, [], { kind: "wait" }],
    ["stopping with an active job waits", { kind: "stopping", stage: "plan" }, [job("plan", ["a"], { active: true })], { kind: "wait" }],
    ["stopping with nothing active ends as stopped", { kind: "stopping", stage: "plan" }, [job("plan", ["a"])], { kind: "control", control: { kind: "ended", reason: "stopped", at: 99 }, units: null }],
    ["stopping with only a failed launch ends as stopped", { kind: "stopping", stage: "plan" }, [job("plan", ["a"], { error: "boom" })], { kind: "control", control: { kind: "ended", reason: "stopped", at: 99 }, units: null }],
  ];
  for (const [name, control, jobs, want] of cases) {
    test(name, () => {
      expect<unknown>(reconcile(pipeline(c, control, ["a", "b"] as Unit[]), snap({ jobs: jobs as unknown as Snapshot["jobs"] }), 99)).toEqual(want);
    });
  }

  test("a stopping pipeline never launches, even with units left", () => {
    const d = reconcile(pipeline(c, { kind: "stopping", stage: "plan" }, ["a", "b"] as Unit[]), snap({ jobs: [job("plan", ["x"], { active: true })] }), 9);
    expect(d).toEqual({ kind: "wait" });
  });
});

describe("reconcile: launching", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

  type Row = { name: string; stage: Stage; batching: Batching; units: string[]; jobs: Array<ReturnType<typeof job>>; fixBusy?: boolean; parallel?: number; want: Array<{ stage: Stage; units: string[] }> | "wait" };
  const rows: Row[] = [
    { name: "map launches its one unit", stage: "map", batching: "each", units: ["map"], jobs: [], want: [{ stage: "map", units: ["map"] }] },
    { name: "map waits while its job is active", stage: "map", batching: "each", units: ["map"], jobs: [job("map", ["map"], { active: true })], want: "wait" },
    { name: "plan each opens three at once", stage: "plan", batching: "each", units: ["a", "b", "c", "d", "e"], jobs: [], want: [{ stage: "plan", units: ["a"] }, { stage: "plan", units: ["b"] }, { stage: "plan", units: ["c"] }] },
    { name: "plan each fills only the room left", stage: "plan", batching: "each", units: ["a", "b", "c", "d", "e"], jobs: [job("plan", ["a"], { active: true }), job("plan", ["b"], { active: true })], want: [{ stage: "plan", units: ["c"] }] },
    { name: "plan each is full at three active", stage: "plan", batching: "each", units: ["a", "b", "c", "d", "e"], jobs: ["a", "b", "c"].map((u) => job("plan", [u], { active: true })), want: "wait" },
    { name: "plan each skips settled units", stage: "plan", batching: "each", units: ["a", "b", "c", "d", "e"], jobs: [job("plan", ["a"]), job("plan", ["b"])], want: [{ stage: "plan", units: ["c"] }, { stage: "plan", units: ["d"] }, { stage: "plan", units: ["e"] }] },
    { name: "plan each retries a failed launch once", stage: "plan", batching: "each", units: ["a", "b"], jobs: [job("plan", ["a"], { error: "boom" })], want: [{ stage: "plan", units: ["a"] }, { stage: "plan", units: ["b"] }] },
    { name: "plan each relaunches a unit whose job settled with a problem", stage: "plan", batching: "each", units: ["a", "b"], jobs: [job("plan", ["a"], { problem: "no steps" }), job("plan", ["b"])], want: [{ stage: "plan", units: ["a"] }] },
    { name: "plan each leaves a unit alone after its retry also failed", stage: "plan", batching: "each", units: ["a", "b"], jobs: [job("plan", ["a"], { problem: "no steps" }), job("plan", ["a"], { error: "boom" })], want: [{ stage: "plan", units: ["b"] }] },
    { name: "plan each does not relaunch a unit while its retry runs", stage: "plan", batching: "each", units: ["a", "b"], jobs: [job("plan", ["a"], { problem: "no steps" }), job("plan", ["a"], { active: true }), job("plan", ["b"])], want: "wait" },
    { name: "plan each does not relaunch a unit that failed and then passed", stage: "plan", batching: "each", units: ["a", "b"], jobs: [job("plan", ["a"], { problem: "no steps" }), job("plan", ["a"]), job("plan", ["b"], { active: true })], want: "wait" },
    { name: "plan together retries only the units of a failed job", stage: "plan", batching: "together", units: ["a", "b", "c"], jobs: [job("plan", ["a", "b"], { problem: "b: no plan written." }), job("plan", ["c"])], want: [{ stage: "plan", units: ["a", "b"] }] },
    { name: "plan together retries only the units that failed", stage: "plan", batching: "together", units: ["a", "b", "c", "d"], jobs: [job("plan", ["a", "b", "c", "d"], { problem: "d: the plan was not changed.", failed: ["d"] })], want: [{ stage: "plan", units: ["d"] }] },
    { name: "plan together retries every unit of a job that failed as a whole", stage: "plan", batching: "together", units: ["a", "b", "c", "d"], jobs: [job("plan", ["a", "b", "c", "d"], { problem: "The session is gone." })], want: [{ stage: "plan", units: ["a", "b", "c", "d"] }] },
    { name: "test together retries only the failed run, not the passing features", stage: "test", batching: "together", units: ["a", "b", "c"], jobs: [job("test", ["a", "b", "c"], { problem: "b: 1 of 2 steps not recorded.", failed: ["b"] })], want: [{ stage: "test", units: ["b"] }] },
    { name: "plan together leaves a failed unit alone after its retry failed too", stage: "plan", batching: "together", units: ["a", "b", "c", "d", "e"], jobs: [job("plan", ["a", "b", "c", "d"], { problem: "d: no plan written.", failed: ["d"] }), job("plan", ["d"], { problem: "d: no plan written.", failed: ["d"] })], want: [{ stage: "plan", units: ["e"] }] },
    { name: "map is retried once", stage: "map", batching: "each", units: ["map"], jobs: [job("map", ["map"], { problem: "The agent did not write features.md." })], want: [{ stage: "map", units: ["map"] }] },
    { name: "fix each retries a bug that is still open", stage: "fix", batching: "each", units: ["bug-1", "bug-2"], jobs: [job("fix", ["bug-1"], { problem: "bug-1: still open." })], want: [{ stage: "fix", units: ["bug-1"] }] },
    { name: "plan together launches everything left in one job", stage: "plan", batching: "together", units: ["a", "b", "c", "d"], jobs: [], want: [{ stage: "plan", units: ["a", "b", "c", "d"] }] },
    { name: "plan together launches at most ten units", stage: "plan", batching: "together", units: many(23), jobs: [], want: [{ stage: "plan", units: many(10) }] },

    { name: "plan together takes the next ten once the first chunk settled", stage: "plan", batching: "together", units: many(23), jobs: [job("plan", many(10))], want: [{ stage: "plan", units: many(23).slice(10, 20) }] },

    { name: "plan together waits for a chunk even with units left", stage: "plan", batching: "together", units: many(23), jobs: [job("plan", many(10), { active: true })], want: "wait" },

    { name: "fix together is chunked too", stage: "fix", batching: "together", units: many(12).map((u) => `bug-${u}`), jobs: [], want: [{ stage: "fix", units: many(10).map((u) => `bug-${u}`) }] },

    { name: "plan together waits while its job is active", stage: "plan", batching: "together", units: ["a", "b"], jobs: [job("plan", ["a", "b"], { active: true })], want: "wait" },
    { name: "plan together leaves covered units out", stage: "plan", batching: "together", units: ["a", "b", "c"], jobs: [job("plan", ["a"])], want: [{ stage: "plan", units: ["b", "c"] }] },
    { name: "test each runs one at a time", stage: "test", batching: "each", units: ["a", "b"], jobs: [], want: [{ stage: "test", units: ["a"] }] },
    { name: "test each waits for the running test", stage: "test", batching: "each", units: ["a", "b"], jobs: [job("test", ["a"], { active: true })], want: "wait" },
    { name: "test each moves on after a settled one", stage: "test", batching: "each", units: ["a", "b"], jobs: [job("test", ["a"])], want: [{ stage: "test", units: ["b"] }] },
    { name: "test each parallel 3 launches three at once", stage: "test", batching: "each", parallel: 3, units: ["a", "b", "c", "d"], jobs: [], want: [{ stage: "test", units: ["a"] }, { stage: "test", units: ["b"] }, { stage: "test", units: ["c"] }] },
    { name: "test each parallel 3 fills only the room left", stage: "test", batching: "each", parallel: 3, units: ["a", "b", "c", "d"], jobs: [job("test", ["a"], { active: true }), job("test", ["b"], { active: true })], want: [{ stage: "test", units: ["c"] }] },
    { name: "test each parallel 3 is full at three active", stage: "test", batching: "each", parallel: 3, units: ["a", "b", "c", "d"], jobs: ["a", "b", "c"].map((u) => job("test", [u], { active: true })), want: "wait" },
    { name: "test each parallel 2 retries a failed unit within its room", stage: "test", batching: "each", parallel: 2, units: ["a", "b", "c"], jobs: [job("test", ["a"], { problem: "a: 1 of 3 steps not recorded." })], want: [{ stage: "test", units: ["a"] }, { stage: "test", units: ["b"] }] },
    { name: "test together ignores parallel", stage: "test", batching: "together", parallel: 3, units: ["a", "b"], jobs: [], want: [{ stage: "test", units: ["a", "b"] }] },
    { name: "test together ignores parallel while its job is active", stage: "test", batching: "together", parallel: 3, units: ["a", "b", "c"], jobs: [job("test", ["a"], { active: true })], want: "wait" },
    { name: "test together is one job", stage: "test", batching: "together", units: ["a", "b"], jobs: [], want: [{ stage: "test", units: ["a", "b"] }] },
    { name: "fix each launches one bug", stage: "fix", batching: "each", units: ["bug-1", "bug-2"], jobs: [], want: [{ stage: "fix", units: ["bug-1"] }] },
    { name: "fix waits while a Lab fix runs", stage: "fix", batching: "each", units: ["bug-1"], jobs: [], fixBusy: true, want: "wait" },
    { name: "fix together waits while a Lab fix runs", stage: "fix", batching: "together", units: ["bug-1", "bug-2"], jobs: [], fixBusy: true, want: "wait" },
    { name: "fix together launches every bug in one job", stage: "fix", batching: "together", units: ["bug-1", "bug-2"], jobs: [], want: [{ stage: "fix", units: ["bug-1", "bug-2"] }] },
    { name: "jobs of another stage do not cover or occupy this one", stage: "test", batching: "each", units: ["a"], jobs: [job("plan", ["a"], { active: true })], want: [{ stage: "test", units: ["a"] }] },
  ];
  for (const r of rows) {
    test(r.name, () => {
      const c = config({ stages: { [r.stage]: r.stage === "map" ? { survey: false } : { batching: r.batching, ...(r.stage === "plan" ? { replan: false } : {}), ...(r.stage === "test" ? { parallel: r.parallel ?? 1 } : {}) } } as PipelineConfig["stages"] });
      const d = reconcile(pipeline(c, { kind: "running", stage: r.stage }, r.units as Unit[]), snap({ jobs: r.jobs, fixBusyElsewhere: r.fixBusy ?? false }), 7);
      expect<unknown>(r.want === "wait" ? d : launches(d)).toEqual(r.want === "wait" ? { kind: "wait" } : r.want);
    });
  }

  test("together with 23 units runs as chunks of 10, 10 and 3, one at a time", () => {

    const units = many(23);

    const c = config({ stages: { plan: { batching: "together", replan: false } } });

    const p = pipeline(c, { kind: "running", stage: "plan" }, units as Unit[]);

    const jobs: Array<ReturnType<typeof job>> = [];

    const sizes: number[] = [];

    for (let round = 0; round < 10; round++) {

      const d = reconcile(p, snap({ jobs }), round);

      if (d.kind !== "launch") break;

      expect(d.launches.length).toBe(1);

      sizes.push(d.launches[0].units.length);

      jobs.push(job("plan", [...d.launches[0].units], { active: true }));

      expect(reconcile(p, snap({ jobs }), round)).toEqual({ kind: "wait" });

      jobs[jobs.length - 1] = job("plan", [...d.launches[0].units]);

    }

    expect(sizes).toEqual([10, 10, 3]);

    expect(reconcile(p, snap({ jobs }), 99).kind).toBe("control");

  });



  test("a map stage launches up to three area jobs at once and tops up as they settle", () => {
    const c = config({ stages: { map: { survey: false } } });
    const units = ["area:a", "area:b", "area:c", "area:d", "area:e"] as Unit[];
    const p = pipeline(c, { kind: "running", stage: "map" }, units);
    expect(launches(reconcile(p, snap({ layout: "areas" }), 1))).toEqual(["a", "b", "c"].map((u) => ({ stage: "map", units: [`area:${u}`] })));
    const two = ["area:a", "area:b"].map((u) => job("map", [u], { active: true }));
    expect(launches(reconcile(p, snap({ jobs: two }), 1))).toEqual([{ stage: "map", units: ["area:c"] }]);
    expect(reconcile(p, snap({ jobs: [...two, job("map", ["area:c"], { active: true })] }), 1)).toEqual({ kind: "wait" });
  });

  test("a fix lock held elsewhere does not stop a finished stage from advancing", () => {
    const c = config({ stages: { fix: { batching: "each" } } });
    const d = reconcile(pipeline(c, { kind: "running", stage: "fix" }, ["bug-1"] as Unit[]), snap({ jobs: [job("fix", ["bug-1"])], fixBusyElsewhere: true }), 3);
    expect(d).toEqual({ kind: "control", control: { kind: "ended", reason: "done", at: 3 }, units: null });
  });
});

describe("reconcile: sweeping the whole grid", () => {
  test("no launch ever breaks the stage's parallelism, a lock, or covers a unit twice", () => {
    let checked = 0;
    for (const stage of ["map", "plan", "test", "fix"] as Stage[]) {
      for (const batching of ["each", "together"] as Batching[]) {
        for (let total = 0; total <= 6; total++) {
          for (let covered = 0; covered <= total; covered++) {
            for (let active = 0; active <= covered; active++) {
              for (const failed of [false, true]) {
                for (const busy of [false, true]) {
                  const units = stage === "map" ? ["map"] : Array.from({ length: total }, (_, i) => (stage === "fix" ? `bug-${i}` : `f${i}`));
                  const cov = units.slice(0, covered);
                  const jobs = cov.map((u, i) => job(stage, [u], i < active ? { active: true } : failed && i === covered - 1 ? { error: "x" } : {}));
                  const c = config({ stages: { [stage]: stage === "map" ? { survey: false } : { batching, ...(stage === "plan" ? { replan: false } : {}) } } as PipelineConfig["stages"] });
                  const d = reconcile(pipeline(c, { kind: "running", stage }, units as Unit[]), snap({ jobs, fixBusyElsewhere: busy }), 1);
                  checked++;
                  if (d.kind !== "launch") continue;
                  const taken = d.launches.flatMap((l) => [...l.units]);
                  expect(new Set(taken).size).toBe(taken.length);
                  const retried = failed && covered > active ? cov[covered - 1] : undefined;
                  for (const u of taken) if (u !== retried) expect(cov).not.toContain(u);
                  for (const u of taken) expect(units).toContain(u);
                  const activeNow = jobs.filter((j) => j.active).length;
                  if (stage === "fix") expect(busy).toBe(false);
                  if (stage !== "map" && batching === "together") {
                    expect(d.launches.length).toBe(1);
                    expect(activeNow).toBe(0);
                  } else expect(activeNow + d.launches.length).toBeLessThanOrEqual(stage === "test" ? 1 : PARALLEL[stage]);
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  test("applying a launch decision makes the next reconcile wait (idempotent)", () => {
    const c = config({ stages: { plan: { batching: "each", replan: false } } });
    const p = pipeline(c, { kind: "running", stage: "plan" }, ["a", "b", "c", "d"] as Unit[]);
    let jobs: Snapshot["jobs"] = [];
    const first = reconcile(p, snap({ jobs }), 1);
    expect(first.kind).toBe("launch");
    if (first.kind !== "launch") return;
    jobs = first.launches.map((l) => job("plan", [...l.units], { active: true }));
    expect(reconcile(p, snap({ jobs }), 2)).toEqual({ kind: "wait" });
    expect(reconcile(p, snap({ jobs }), 3)).toEqual({ kind: "wait" });
  });
});

describe("reconcile: advancing", () => {
  const all = (pace: "auto" | "step") => config({ pace, stages: { plan: { batching: "each", replan: false }, test: { batching: "each", parallel: 1 }, fix: { batching: "each" } } });

  test("a drained stage opens the next with fresh units (auto)", () => {
    const p = pipeline(all("auto"), { kind: "running", stage: "plan" }, ["a", "b"] as Unit[]);
    const s = snap({ plans: planned("a", "b", "c"), jobs: [job("plan", ["a"]), job("plan", ["b"])] });
    expect<unknown>(reconcile(p, s, 4)).toEqual({ kind: "control", control: { kind: "running", stage: "test" }, units: ["a", "b", "c"] });
  });

  test("a drained stage holds under pace step", () => {
    const p = pipeline(all("step"), { kind: "running", stage: "plan" }, ["a"] as Unit[]);
    expect(reconcile(p, snap({ jobs: [job("plan", ["a"])] }), 4)).toEqual({ kind: "control", control: { kind: "held", after: "plan", next: "test" }, units: null });
  });

  test("a stage is not drained while a job is active", () => {
    const p = pipeline(all("auto"), { kind: "running", stage: "plan" }, ["a"] as Unit[]);
    expect(reconcile(p, snap({ jobs: [job("plan", ["a"], { active: true })] }), 4)).toEqual({ kind: "wait" });
  });

  test("a stage with no units advances at the first tick", () => {
    const p = pipeline(all("auto"), { kind: "running", stage: "test" }, []);
    expect(reconcile(p, snap(), 4)).toEqual({ kind: "control", control: { kind: "running", stage: "fix" }, units: [] });
  });

  test("the last stage ends the pipeline as done, even under pace step", () => {
    const p = pipeline(all("step"), { kind: "running", stage: "fix" }, ["bug-1"] as Unit[]);
    expect(reconcile(p, snap({ jobs: [job("fix", ["bug-1"])] }), 4)).toEqual({ kind: "control", control: { kind: "ended", reason: "done", at: 4 }, units: null });
  });

  test("stages that are not chosen are skipped", () => {
    const c = config({ stages: { map: { survey: false }, fix: { batching: "each" } } });
    const p = pipeline(c, { kind: "running", stage: "map" }, ["map"] as Unit[]);
    const d = reconcile(p, snap({ jobs: [job("map", ["map"])], openBugs: [{ id: bid("bug-9"), feature: null }] }), 4);
    expect<unknown>(d).toEqual({ kind: "control", control: { kind: "running", stage: "fix" }, units: ["bug-9"] });
  });

  test("a unit that failed once keeps the stage open for its retry", () => {
    const p = pipeline(all("auto"), { kind: "running", stage: "plan" }, ["a"] as Unit[]);
    expect(reconcile(p, snap({ jobs: [job("plan", ["a"], { error: "no browser" })] }), 4).kind).toBe("launch");
  });

  test("a unit that failed twice no longer holds the stage, so it drains", () => {
    const p = pipeline(all("auto"), { kind: "running", stage: "plan" }, ["a"] as Unit[]);
    const d = reconcile(p, snap({ jobs: [job("plan", ["a"], { error: "no browser" }), job("plan", ["a"], { problem: "no steps" })] }), 4);
    expect(d.kind).toBe("control");
  });
});

describe("reconcile: the survey re-freezes the map stage", () => {
  const c = config({ stages: { map: { survey: true }, fix: { batching: "each" } } });
  const areas = ["shop", "team"].map(area);
  const mapped = { layout: "areas", areas } as const;
  const survey = (p: Pipeline, jobs: Snapshot["jobs"], o: Partial<Snapshot> = {}) => reconcile(p, snap({ ...mapped, jobs, ...o }), 5);
  const frozen = (units: string[]) => pipeline(c, { kind: "running", stage: "map" }, units as Unit[]);

  test("a clean survey that made the areas layout opens the stage again on the area units", () => {
    expect<unknown>(survey(frozen(["areas"]), [job("map", ["areas"])])).toEqual({ kind: "control", control: { kind: "running", stage: "map" }, units: ["area:shop", "area:team"] });
  });
  test("it fires once: the same stage with the area units goes on to launch them and then to the next stage", () => {
    const p = frozen(["area:shop", "area:team"]);
    const done = [job("map", ["areas"])];
    expect(launches(survey(p, done))).toEqual([{ stage: "map", units: ["area:shop"] }, { stage: "map", units: ["area:team"] }]);
    const all = [...done, job("map", ["area:shop"]), job("map", ["area:team"])];
    expect<unknown>(survey(p, all, {})).toEqual({ kind: "control", control: { kind: "running", stage: "fix" }, units: [] });
  });
  test("a survey still running, or retryable after one failure, does not re-freeze", () => {
    expect(survey(frozen(["areas"]), [job("map", ["areas"], { active: true })])).toEqual({ kind: "wait" });
    expect(launches(survey(frozen(["areas"]), [job("map", ["areas"], { problem: "no areas" })]))).toEqual([{ stage: "map", units: ["areas"] }]);
  });
  test("a survey that failed twice ends the stage as usual", () => {
    const d = survey(frozen(["areas"]), [job("map", ["areas"], { problem: "x" }), job("map", ["areas"], { problem: "x" })]);
    expect<unknown>(d).toEqual({ kind: "control", control: { kind: "running", stage: "fix" }, units: [] });
  });
  test("a clean survey that left the map flat does not re-freeze", () => {
    expect(reconcile(frozen(["areas"]), snap({ jobs: [job("map", ["areas"])] }), 5).kind).toBe("control");
    expect(reconcile(frozen(["areas"]), snap({ jobs: [job("map", ["areas"])] }), 5)).toMatchObject({ control: { stage: "fix" } });
  });
  test("a scope narrows the area units it re-freezes onto", () => {
    const narrow = pipeline({ ...c, scope: { kind: "areas", ids: ["team"] } }, { kind: "running", stage: "map" }, ["areas"] as Unit[]);
    expect(survey(narrow, [job("map", ["areas"])])).toMatchObject({ units: ["area:team"] });
  });
  test("the stage's counters follow the area units, not the survey", () => {
    const p = frozen(["area:shop", "area:team"]);
    const v = pipelineView(p, [job("map", ["areas"]), job("map", ["area:shop"]), job("map", ["area:team"], { active: true })]);
    expect(v.stages.find((s) => s.stage === "map")).toMatchObject({ state: "current", done: 1, total: 2, problems: 0 });
  });
});

describe("unitsFor", () => {
  const bugs = [{ id: bid("bug-b"), feature: fid("b") }, { id: bid("bug-a"), feature: fid("a") }, { id: bid("bug-z"), feature: null }];
  const stages = { plan: { batching: "each" as const, replan: false }, test: { batching: "each" as const, parallel: 1 }, fix: { batching: "each" as const } };
  const plans = new Map<FeatureId, { steps: number; problem: string | null }>([[fid("a"), { steps: 3, problem: null }], [fid("b"), { steps: 0, problem: null }], [fid("c"), { steps: 2, problem: "bad file" }]]);
  const s = snap({ plans, openBugs: bugs });

  test("map is its one unit", () => expect(unitsFor("map", config({ stages: { map: { survey: false } } }), s)).toEqual(["map"]));

  describe("map units", () => {
    const areas = ["shop", "team", "admin"].map(area);
    const placed = [feature("cart", ["/shop"], null, "shop"), feature("promo", ["/shop/promo"], "cart", "shop"), feature("invite", ["/team"], null, "team"), feature("users", ["/admin"], null, "admin")];
    const mapped = snap({ layout: "areas", areas, features: placed });
    const stagesOf = (survey: boolean) => ({ map: { survey } });

    test("a flat map, or no map at all, is the one flat unit", () => {
      expect<unknown>(unitsFor("map", config({ stages: stagesOf(false) }), snap({ mapExists: false, features: [] }))).toEqual(["map"]);
    });
    test("a survey is the areas unit, whatever the layout is", () => {
      expect<unknown>(unitsFor("map", config({ stages: stagesOf(true) }), snap())).toEqual(["areas"]);
      expect<unknown>(unitsFor("map", config({ stages: stagesOf(true) }), mapped)).toEqual(["areas"]);
    });
    test("an areas layout with scope all has one unit per area, in map order", () => {
      expect<unknown>(unitsFor("map", config({ stages: stagesOf(false) }), mapped)).toEqual(["area:shop", "area:team", "area:admin"]);
    });
    test("scope areas keeps the named areas, in map order, and drops one that is gone", () => {
      expect<unknown>(unitsFor("map", config({ stages: stagesOf(false), scope: { kind: "areas", ids: ["admin", "shop", "gone"] } }), mapped)).toEqual(["area:shop", "area:admin"]);
    });
    test("scope features keeps the areas that hold those features, a child included", () => {
      expect<unknown>(unitsFor("map", config({ stages: stagesOf(false), scope: { kind: "features", ids: ["promo", "users"] } }), mapped)).toEqual(["area:shop", "area:admin"]);
    });
  });

  test("plan without replan takes features with no usable plan, in features.md order", () => {
    expect<unknown>(unitsFor("plan", config({ stages }), s)).toEqual(["b", "c", "d", "e"]);
  });
  test("plan with replan takes every feature in scope", () => {
    expect<unknown>(unitsFor("plan", config({ stages: { plan: { batching: "each", replan: true } } }), s)).toEqual(["a", "b", "c", "d", "e"]);
  });
  test("test takes only features whose plan is usable", () => expect<unknown>(unitsFor("test", config({ stages }), s)).toEqual(["a"]));
  test("a features scope narrows plan and test and drops ids that no longer exist", () => {
    const c = config({ stages, scope: { kind: "features", ids: ["c", "a", "gone"] } });
    expect<unknown>(unitsFor("plan", c, s)).toEqual(["c"]);
    expect<unknown>(unitsFor("test", c, s)).toEqual(["a"]);
  });
  describe("scope areas", () => {
    const placed = [feature("a", ["/shop"], null, "shop"), feature("b", ["/shop/x"], "a", "shop"), feature("c", ["/team"], null, "team"), feature("d", [], null, "admin")];
    const as = snap({ layout: "areas", areas: ["shop", "team", "admin"].map(area), features: placed, plans: new Map<FeatureId, { steps: number; problem: string | null }>([[fid("a"), { steps: 2, problem: null }], [fid("b"), { steps: 2, problem: null }], [fid("c"), { steps: 2, problem: null }]]), openBugs: [{ id: bid("bug-1"), feature: fid("b") }, { id: bid("bug-2"), feature: fid("c") }, { id: bid("bug-3"), feature: null }] });
    const scoped = (ids: string[]) => config({ stages: { plan: { batching: "each", replan: true }, test: { batching: "each", parallel: 1 }, fix: { batching: "each" } }, scope: { kind: "areas", ids } });

    test("plan takes the features of those areas, a child included, and none from other areas", () => {
      expect<unknown>(unitsFor("plan", scoped(["shop"]), as)).toEqual(["a", "b"]);
      expect<unknown>(unitsFor("plan", scoped(["team", "admin"]), as)).toEqual(["c", "d"]);
    });
    test("test takes only those features that have a usable plan", () => {
      expect<unknown>(unitsFor("test", scoped(["team", "admin"]), as)).toEqual(["c"]);
    });
    test("fix takes the open bugs whose feature is in those areas, never a bug with no feature", () => {
      expect<unknown>(unitsFor("fix", scoped(["shop"]), as)).toEqual(["bug-1"]);
      expect<unknown>(unitsFor("fix", scoped(["shop", "team"]), as)).toEqual(["bug-1", "bug-2"]);
    });
  });

  test("fix with scope all takes every open bug, one with no feature too, in id order", () => {
    expect<unknown>(unitsFor("fix", config({ stages }), s)).toEqual(["bug-a", "bug-b", "bug-z"]);
  });
  test("fix with a features scope takes the bugs of those features", () => {
    expect<unknown>(unitsFor("fix", config({ stages, scope: { kind: "features", ids: ["b"] } }), s)).toEqual(["bug-b"]);
  });
  test("fix with a bugs scope takes the named bugs that are still open", () => {
    expect<unknown>(unitsFor("fix", config({ stages: { fix: { batching: "each" } }, scope: { kind: "bugs", ids: ["bug-z", "bug-gone"] } }), s)).toEqual(["bug-z"]);
  });
});

describe("parseConfig", () => {
  const ctx = { features: F, areas: ["shop", "team"].map(area), pairExists: (id: string) => id === "pair_1" };
  const base = { stages: { plan: { batching: "each" } }, scope: { kind: "all" }, pace: "auto", driver: { kind: "agent" } };
  const bad = (body: unknown, msg: string) => expect(() => parseConfig(body, ctx)).toThrow(msg);

  test("a minimal body gets its defaults", () => {
    expect(parseConfig(base, ctx)).toEqual({ stages: { plan: { batching: "each", replan: false } }, scope: { kind: "all" }, pace: "auto", driver: { kind: "agent", engine: null, model: null, effort: null, agent: null }, note: "", baseUrl: null });
  });
  test("replan defaults to true for a features scope and false for all, and an explicit value wins", () => {
    expect(parseConfig({ ...base, scope: { kind: "features", ids: ["a"] } }, ctx).stages.plan?.replan).toBe(true);
    expect(parseConfig({ ...base, scope: { kind: "features", ids: ["a"] }, stages: { plan: { batching: "each", replan: false } } }, ctx).stages.plan?.replan).toBe(false);
    expect(parseConfig({ ...base, stages: { plan: { batching: "each", replan: true } } }, ctx).stages.plan?.replan).toBe(true);
  });
  test("note and baseUrl are cleaned", () => {
    const c = parseConfig({ ...base, note: "  look at checkout  ", baseUrl: "http://localhost:3000/" }, ctx);
    expect([c.note, c.baseUrl]).toEqual(["look at checkout", "http://localhost:3000"]);
  });
  test("a pair driver keeps only its id", () => {
    expect(parseConfig({ ...base, driver: { kind: "pair", pairId: "pair_1", engine: "codex" } }, ctx).driver).toEqual({ kind: "pair", pairId: "pair_1" });
  });
  test("the five stage orders collapse to STAGES order", () => {
    const c = parseConfig({ ...base, stages: { fix: { batching: "each" }, map: {}, test: { batching: "together" } } }, ctx);
    expect(Object.keys(c.stages)).toEqual(["map", "test", "fix"]);
  });

  test("messages", () => {
    bad({ ...base, stages: {} }, "Pick at least one stage.");
    bad({ ...base, stages: undefined }, "Pick at least one stage.");
    bad({ ...base, stages: { plan: { batching: "each" } }, scope: { kind: "bugs", ids: ["bug-a"] } }, "A list of bugs can only be fixed: choose the Fix stage alone.");
    bad({ ...base, stages: { map: {}, fix: { batching: "each" } }, scope: { kind: "bugs", ids: ["bug-a"] } }, "A list of bugs can only be fixed: choose the Fix stage alone.");
    bad({ ...base, scope: { kind: "features", ids: ["nope"] } }, 'No feature "nope".');
    bad({ ...base, driver: { kind: "pair", pairId: "pair_x" } }, 'No Hydra pair "pair_x". See `trb pair list`.');
    bad({ ...base, stages: { plan: { batching: "sometimes" } } }, 'batching must be "each" or "together".');
    bad({ ...base, stages: { test: {} } }, 'batching must be "each" or "together".');
    bad({ ...base, pace: "fast" }, 'pace must be "auto" or "step".');
    bad({ ...base, baseUrl: "ftp://x.test" }, "baseUrl must be an http or https address.");
    bad({ ...base, baseUrl: "not a url" }, "baseUrl must be an http or https address.");
  });
  test("test parallel defaults to 1 and is kept when valid", () => {
    expect(parseConfig({ ...base, stages: { test: { batching: "each" } } }, ctx).stages.test).toEqual({ batching: "each", parallel: 1 });
    for (const n of [1, 2, MAX_TEST_PARALLEL]) expect(parseConfig({ ...base, stages: { test: { batching: "each", parallel: n } } }, ctx).stages.test).toEqual({ batching: "each", parallel: n });
    expect(parseConfig({ ...base, stages: { test: { batching: "together", parallel: 3 } } }, ctx).stages.test?.batching).toBe("together");
  });
  test("test parallel outside 1..3 or not a whole number is refused", () => {
    for (const parallel of [0, 4, 1.5, -1, NaN, "2", null, true]) bad({ ...base, stages: { test: { batching: "each", parallel } } }, "parallel must be a whole number from 1 to 3.");
  });
  test("an areas scope is kept, de-duplicated, and every id must be an area of the map", () => {
    expect(parseConfig({ ...base, scope: { kind: "areas", ids: ["team", "shop", "team"] } }, ctx).scope).toEqual({ kind: "areas", ids: ["team", "shop"] });
    bad({ ...base, scope: { kind: "areas", ids: ["shop", "nope"] } }, 'No area "nope".');
    bad({ ...base, scope: { kind: "areas", ids: [] } }, "Pick at least one area.");
    bad({ ...base, scope: { kind: "areas", ids: "shop" } }, "areas must be a list of ids.");
    expect(() => parseConfig({ ...base, scope: { kind: "areas", ids: ["shop"] } }, { ...ctx, areas: [] })).toThrow('No area "shop".');
  });
  test("an old stored map stage with no survey loads as no survey; a survey flag must be a boolean", () => {
    expect(parseConfig({ ...base, stages: { map: {} } }, ctx).stages.map).toEqual({ survey: false });
    expect(parseConfig({ ...base, stages: { map: { survey: true } } }, ctx).stages.map).toEqual({ survey: true });
    bad({ ...base, stages: { map: { survey: "yes" } } }, "survey must be true or false.");
  });
  test("a bugs scope with the Fix stage alone is accepted", () => {
    expect(parseConfig({ ...base, stages: { fix: { batching: "each" } }, scope: { kind: "bugs", ids: ["bug-a", "bug-a"] } }, ctx).scope).toEqual({ kind: "bugs", ids: ["bug-a"] });
  });
  test("an empty id list and a note that is too long are refused", () => {
    bad({ ...base, scope: { kind: "features", ids: [] } }, "Pick at least one feature.");
    bad({ ...base, note: "x".repeat(4001) }, "4000");
  });
});

describe("featureForUrl", () => {
  const f = (...xs: Array<[string, string[]]>) => xs.map(([id, where]) => feature(id, where));
  const vectors: Array<[string, Feature[], string, string | null]> = [
    ["the longest match wins", f(["cart", ["/cart"]], ["checkout", ["/cart/checkout"]]), "http://localhost:3000/cart/checkout?x=1", "checkout"],
    ["a trailing slash is ignored", f(["cart", ["/cart"]]), "http://localhost:3000/cart/", "cart"],
    ["a prefix must end at a path boundary", f(["cart", ["/cart"]]), "http://localhost:3000/cartoon", null],
    ["/ matches anything that nothing longer claims", f(["home", ["/"]], ["cart", ["/cart"]]), "http://localhost:3000/about", "home"],
    ["a tie is null", f(["a", ["/x"]], ["b", ["/x"]]), "http://localhost:3000/x/1", null],
    ["a url that does not parse is null", f(["a", ["/x"]]), "not a url", null],
  ];
  for (const [name, features, url, want] of vectors) test(name, () => expect<unknown>(featureForUrl(features, url)).toBe(want));

  test("a bug is shown under its stored feature when that still exists, else by url", () => {
    const fs = f(["cart", ["/cart"]]);
    expect<unknown>(bugFeature("cart", "http://x/other", fs)).toEqual({ feature: "cart", source: "stored" });
    expect<unknown>(bugFeature("gone", "http://x/cart", fs)).toEqual({ feature: "cart", source: "url" });
    expect(bugFeature(null, "http://x/none", fs)).toEqual({ feature: null, source: null });
  });
});

describe("pipelineView and activityOf", () => {
  const c = config({ stages: { plan: { batching: "each", replan: false }, test: { batching: "each", parallel: 1 } } });
  const jobs = [job("plan", ["a"]), job("plan", ["b"], { problem: "no steps" }), job("plan", ["c"], { active: true })];

  test("the current stage counts its frozen units, a passed one the units its jobs covered", () => {
    const p = pipeline(c, { kind: "running", stage: "plan" }, ["a", "b", "c", "d"] as Unit[]);
    const v = pipelineView(p, jobs);
    expect(v.stages.find((s) => s.stage === "plan")).toEqual({ stage: "plan", state: "current", done: 1, total: 4, problems: 0 });
    expect(v.stages.find((s) => s.stage === "test")).toEqual({ stage: "test", state: "next", done: 0, total: 0, problems: 0 });
    expect(v.stages.find((s) => s.stage === "map")?.state).toBe("skipped");
    const held = pipelineView(pipeline(c, { kind: "held", after: "plan", next: "test" }, null), jobs.slice(0, 2));
    expect(held.stages.map((s) => [s.stage, s.state, s.total])).toEqual([["map", "skipped", 0], ["plan", "done", 2], ["test", "held", 0], ["fix", "skipped", 0]]);
  });

  const counters = (control: Control, units: string[] | null, js: Job[]) => {
    const v = pipelineView(pipeline(c, control, units as Unit[] | null), js);
    const { done, total, problems } = v.stages.find((s) => s.stage === "plan")!;
    return { done, total, problems };
  };
  const running = { kind: "running", stage: "plan" } as const;
  const counterRows: Array<[string, Control, Job[], { done: number; total: number; problems: number }]> = [
    ["a unit that failed then passed is done, not a problem", running, [job("plan", ["a"], { problem: "no steps" }), job("plan", ["a"])], { done: 1, total: 1, problems: 0 }],
    ["a unit that failed twice is one problem", running, [job("plan", ["a"], { problem: "no steps" }), job("plan", ["a"], { error: "boom" })], { done: 1, total: 1, problems: 1 }],
    ["a unit waiting for its retry is neither done nor a problem", running, [job("plan", ["a"], { error: "boom" })], { done: 0, total: 1, problems: 0 }],
    ["a unit whose retry runs is not done", running, [job("plan", ["a"], { error: "boom" }), job("plan", ["a"], { active: true })], { done: 0, total: 1, problems: 0 }],
    ["a stopping pipeline will not retry, so the failure is a problem", { kind: "stopping", stage: "plan" }, [job("plan", ["a"], { error: "boom" })], { done: 1, total: 1, problems: 1 }],
    ["one failed job over several units is a problem for each", { kind: "held", after: "plan", next: "test" }, [job("plan", ["a", "b"], { problem: "x" }), job("plan", ["a", "b"], { problem: "x" })], { done: 2, total: 2, problems: 2 }],
  ];
  const together = job("plan", ["a", "b", "c", "d"], { problem: "d: the plan was not changed.", failed: ["d"] });
  counterRows.push(
    ["a unit that passed beside a failed one is done, and the failed one waits for its retry", running, [together], { done: 3, total: 4, problems: 0 }],
    ["after its retry also failed, only the failed unit is a problem", running, [together, job("plan", ["d"], { problem: "d: the plan was not changed.", failed: ["d"] })], { done: 4, total: 4, problems: 1 }],
  );
  for (const [name, control, js, want] of counterRows) test(`counters: ${name}`, () => expect(counters(control, control.kind === "held" ? null : name.includes("beside") || name.includes("only the failed") ? ["a", "b", "c", "d"] : ["a"], js)).toEqual(want));

  test("activity: working over queued, queued while the stage runs, problem after a failed job", () => {
    const p = pipeline(c, { kind: "running", stage: "plan" }, ["a", "b", "c", "d"] as Unit[]);
    const pair = (s: string) => s === jobs[2]!.session;
    expect(activityOf("plan", "c" as Unit, p, jobs, pair)).toEqual({ kind: "working", sessionId: jobs[2]!.session!, pair: true });
    expect(activityOf("plan", "d" as Unit, p, jobs, pair)).toEqual({ kind: "queued" });
    expect(activityOf("plan", "b" as Unit, p, jobs, pair)).toEqual({ kind: "queued" });
    expect(activityOf("plan", "a" as Unit, p, jobs, pair)).toEqual({ kind: "idle" });
    expect(activityOf("test", "d" as Unit, p, jobs, pair)).toEqual({ kind: "idle" });
    expect(activityOf("plan", "d" as Unit, null, [], pair)).toEqual({ kind: "idle" });
  });
  test("activity: a unit that failed once is queued for its retry while the stage runs, a problem once it will not be retried", () => {
    const running = pipeline(c, { kind: "running", stage: "plan" }, ["a", "b"] as Unit[]);
    const once = [job("plan", ["a"], { problem: "no steps" })];
    const twice = [...once, job("plan", ["a"], { error: "boom" })];
    expect(activityOf("plan", "a" as Unit, running, once, () => false)).toEqual({ kind: "queued" });
    expect(activityOf("plan", "a" as Unit, running, [...once, job("plan", ["a"])], () => false)).toEqual({ kind: "idle" });
    expect(activityOf("plan", "a" as Unit, running, twice, () => false)).toEqual({ kind: "problem", text: "boom", sessionId: null });
    for (const control of [{ kind: "stopping", stage: "plan" }, { kind: "ended", reason: "done", at: 1 }, { kind: "held", after: "plan", next: "test" }] as const) {
      expect(activityOf("plan", "a" as Unit, pipeline(c, control, ["a"] as Unit[]), once, () => false)).toMatchObject({ kind: "problem", text: "no steps" });
    }
  });
  test("activity: a unit that passed inside a job with a problem for another unit shows no problem", () => {
    const units = ["a", "b", "c", "d"] as Unit[];
    const mixed = [job("plan", ["a", "b", "c", "d"], { problem: "d: the plan was not changed.", failed: ["d"] })];
    const retried = [...mixed, job("plan", ["d"], { problem: "d: the plan was not changed.", failed: ["d"] })];
    const ended = pipeline(c, { kind: "ended", reason: "done", at: 1 }, null);
    expect(activityOf("plan", "a" as Unit, pipeline(c, { kind: "running", stage: "plan" }, units), mixed, () => false)).toEqual({ kind: "idle" });
    expect(activityOf("plan", "d" as Unit, pipeline(c, { kind: "running", stage: "plan" }, units), mixed, () => false)).toEqual({ kind: "queued" });
    expect(activityOf("plan", "a" as Unit, ended, retried, () => false)).toEqual({ kind: "idle" });
    expect(activityOf("plan", "d" as Unit, ended, retried, () => false)).toMatchObject({ kind: "problem", text: "d: the plan was not changed." });
    expect(activityOf("plan", "a" as Unit, ended, [job("plan", ["a", "b"], { problem: "The session is gone." })], () => false)).toMatchObject({ kind: "problem", text: "The session is gone." });
  });
  test("a failed launch shows its error", () => {
    const failed = job("plan", ["a"], { error: "The agent browser is off" });
    expect(activityOf("plan", "a" as Unit, pipeline(c, { kind: "ended", reason: "done", at: 1 }, null), [failed], () => false)).toEqual({ kind: "problem", text: "The agent browser is off", sessionId: null });
  });
  test("mergeActivity prefers working, then queued, then a problem", () => {
    const w = { kind: "working", sessionId: "s", pair: false } as const;
    const pr = { kind: "problem", text: "x", sessionId: null } as const;
    expect(mergeActivity([pr, { kind: "queued" }, w])).toEqual(w);
    expect(mergeActivity([pr, { kind: "queued" }])).toEqual({ kind: "queued" });
    expect(mergeActivity([{ kind: "idle" }, pr])).toEqual(pr);
    expect(mergeActivity([])).toEqual({ kind: "idle" });
  });
});
