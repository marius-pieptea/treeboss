import { describe, expect, test } from "bun:test";
import type { Activity, BoardBug, BoardFeature, JobView, PipelineView } from "../../web/src/features/qa/api";
import { bugOffers, bugsCell, countsLine, defaultForm, findBug, isBusy, jobUnits, mapCell, notableJobs, outcomeText, phaseOf, planCell, primaryOf, prunePicked, runBlock, scopeLabel, since, statusLine, stepCell, testCell } from "../../web/src/features/qa/logic";

const idle: Activity = { kind: "idle" };
const feature = (over: Partial<BoardFeature> = {}): BoardFeature => ({ id: "cart", title: "Cart", where: ["/cart"], parent: null, depth: 0, summary: "", plan: { kind: "missing" }, test: { kind: "never" }, bugs: [], activity: { plan: idle, test: idle, fix: idle }, ...over });
const bug = (state: BoardBug["state"], id = "bug-a"): BoardBug => ({ id, title: id, kind: "functional", impact: "medium", status: "new", state, url: "http://x/", capture: null, shot: "none", byAgent: false, feature: null, featureSource: null, summary: "", problem: null, fixSession: null, updatedAt: 0 });
const counts = (c: Partial<Record<"pending" | "pass" | "fail" | "skip" | "blocked", number>>) => ({ pending: 0, pass: 0, fail: 0, skip: 0, blocked: 0, ...c });

describe("countsLine", () => {
  test("done over total, naming only fail and blocked", () => {
    expect(countsLine(counts({ pending: 7, pass: 4, fail: 1 }))).toBe("5/12 · 1 fail");
    expect(countsLine(counts({ pass: 3 }))).toBe("3/3");
    expect(countsLine(counts({}))).toBe("0/0");
  });
});

describe("the plan cell", () => {
  test("a plan is ready with its steps, missing, or broken with its problem", () => {
    expect(planCell(feature({ plan: { kind: "ready", steps: 6, updatedAt: 1 } }))).toEqual({ tone: "ok", word: "ready", count: "6 steps" });
    expect(planCell(feature({ plan: { kind: "ready", steps: 1, updatedAt: 1 } })).count).toBe("1 step");
    expect(planCell(feature())).toEqual({ tone: "idle", word: "no plan" });
    expect(planCell(feature({ plan: { kind: "broken", problem: "no steps" } }))).toEqual({ tone: "bad", word: "broken", title: "no steps" });
  });
  test("a job working on it says so over what the file says, and a pair job is marked", () => {
    const f = feature({ plan: { kind: "ready", steps: 6, updatedAt: 1 }, activity: { plan: { kind: "working", sessionId: "s", pair: true }, test: idle, fix: idle } });
    expect(planCell(f)).toEqual({ tone: "run", word: "planning", pair: true });
  });
  test("queued and problem come from the pipeline", () => {
    expect(planCell(feature({ activity: { plan: { kind: "queued" }, test: idle, fix: idle } })).word).toBe("queued");
    expect(planCell(feature({ activity: { plan: { kind: "problem", text: "no plan written.", sessionId: null }, test: idle, fix: idle } }))).toEqual({ tone: "bad", word: "problem", title: "no plan written." });
  });
});

describe("the test cell", () => {
  const ran = (c: ReturnType<typeof counts>) => feature({ test: { kind: "ran", run: { id: "qa_1", feature: "cart", startedAt: 1, counts: c, finished: c.pending === 0, sessionId: null } } });
  test("never run", () => expect(testCell(feature())).toEqual({ tone: "idle", word: "not run" }));
  test("a failure is danger, whatever else passed", () => expect(testCell(ran(counts({ pass: 4, fail: 1 })))).toEqual({ tone: "bad", word: "fail", count: "5/5" }));
  test("blocked and unfinished runs are warnings", () => {
    expect(testCell(ran(counts({ pass: 4, blocked: 1 }))).tone).toBe("warn");
    expect(testCell(ran(counts({ pass: 4, pending: 3 })))).toEqual({ tone: "warn", word: "partial", count: "4/7" });
  });
  test("every step through and passing is ok", () => expect(testCell(ran(counts({ pass: 5, skip: 1 })))).toEqual({ tone: "ok", word: "pass", count: "6/6" }));
});

describe("the bugs cell", () => {
  const withBugs = (...states: BoardBug["state"][]) => feature({ bugs: states.map((s, i) => bug(s, `bug-${i}`)) });
  test("none, all closed, open, fixing, waiting for a check", () => {
    expect(bugsCell(withBugs())).toEqual({ tone: "idle", word: "none" });
    expect(bugsCell(withBugs("fixed", "dismissed"))).toEqual({ tone: "ok", word: "fixed", count: "2" });
    expect(bugsCell(withBugs("open", "fixed"))).toEqual({ tone: "bad", word: "open", count: "1" });
    expect(bugsCell(withBugs("fixing"))).toEqual({ tone: "run", word: "fixing", count: "1" });
    expect(bugsCell(withBugs("needs-check", "needs-check"))).toEqual({ tone: "warn", word: "check", count: "2" });
  });
  test("a fix job working on the feature says so", () => {
    const f = feature({ bugs: [bug("open")], activity: { plan: idle, test: idle, fix: { kind: "working", sessionId: "s", pair: false } } });
    expect(bugsCell(f)).toEqual({ tone: "run", word: "fixing", pair: false, count: "1" });
  });
});

describe("the map cell", () => {
  const map = (over: Partial<Parameters<typeof mapCell>[0]> = {}) => ({ exists: true, problem: null, updatedAt: 1, activity: idle, ...over });
  test("mapped with a count, not mapped, a problem, or being mapped now", () => {
    expect(mapCell(map(), 12)).toEqual({ tone: "ok", word: "mapped", count: "12 features" });
    expect(mapCell(map({ exists: false }), 0)).toEqual({ tone: "idle", word: "not mapped" });
    expect(mapCell(map({ problem: "bad file" }), 0).tone).toBe("bad");
    expect(mapCell(map({ activity: { kind: "working", sessionId: "s", pair: false } }), 0).word).toBe("mapping");
  });
});

describe("what a bug's card offers", () => {
  test("fix and close while it is open or waiting, reopen once closed, nothing while a fix runs", () => {
    expect(bugOffers("open")).toEqual({ fix: true, close: true, reopen: false });
    expect(bugOffers("needs-check")).toEqual({ fix: true, close: true, reopen: false });
    expect(bugOffers("fixing")).toEqual({ fix: false, close: false, reopen: false });
    expect(bugOffers("fixed")).toEqual({ fix: false, close: false, reopen: true });
    expect(bugOffers("dismissed")).toEqual({ fix: false, close: false, reopen: true });
  });
});

describe("the run bar", () => {
  const view = (control: PipelineView["control"], stages: PipelineView["stages"] = []): PipelineView => ({ id: "qap_1", config: {} as PipelineView["config"], control, stages, jobs: [], createdAt: 1 });
  const stage = (s: PipelineView["stages"][number]["stage"], over: Partial<PipelineView["stages"][number]> = {}): PipelineView["stages"][number] => ({ stage: s, state: "current", done: 0, total: 0, problems: 0, ...over });
  test("one primary button: Run when idle or ended, Continue when held, none while running", () => {
    expect(primaryOf(phaseOf(null))).toBe("run");
    expect(primaryOf(phaseOf(view({ kind: "ended", reason: "done", at: 1 })))).toBe("run");
    expect(primaryOf(phaseOf(view({ kind: "held", after: "plan", next: "test" })))).toBe("continue");
    expect(primaryOf(phaseOf(view({ kind: "running", stage: "plan" })))).toBeNull();
    expect(primaryOf(phaseOf(view({ kind: "stopping", stage: "plan" })))).toBeNull();
  });
  test("a new pipeline waits for one in flight", () => {
    expect((["idle", "ended"] as const).map(isBusy)).toEqual([false, false]);
    expect((["running", "stopping", "held"] as const).map(isBusy)).toEqual([true, true, true]);
  });
  test("the status line says where the pipeline is", () => {
    expect(statusLine(view({ kind: "running", stage: "plan" }, [stage("plan", { done: 3, total: 8, problems: 1 })]))).toBe("Running · Plan 3/8 · 1 problem");
    expect(statusLine(view({ kind: "held", after: "plan", next: "test" }))).toBe("Plan done · Test next");
    expect(statusLine(view({ kind: "held", after: "map", next: "plan" }, [stage("map", { state: "done", problems: 1 })]))).toBe("Map: 1 problem · Plan next");
    expect(statusLine(view({ kind: "held", after: "test", next: "fix" }, [stage("test", { state: "done", problems: 2 })]))).toBe("Test: 2 problems · Fix next");
    expect(statusLine(view({ kind: "stopping", stage: "test" }))).toBe("Stopping · running sessions finish");
    expect(statusLine(view({ kind: "ended", reason: "done", at: 1 }, [stage("plan", { problems: 1 }), stage("test", { problems: 1 })]))).toBe("Done · 2 problems");
    expect(statusLine(view({ kind: "ended", reason: "stopped", at: 1 }))).toBe("Stopped");
    expect(statusLine(view({ kind: "ended", reason: "superseded", at: 1 }))).toBe("Replaced");
  });
  test("why Run is blocked", () => {
    const ok = { stages: ["plan", "test"] as const, browser: true, featureCount: 3, driverMissing: false };
    expect(runBlock(ok)).toBeNull();
    expect(runBlock({ ...ok, stages: [] })).toBe("Pick at least one stage.");
    expect(runBlock({ ...ok, browser: false })).toContain("agent browser is off");
    expect(runBlock({ ...ok, browser: false, stages: ["fix"] })).toBeNull();
    expect(runBlock({ ...ok, driverMissing: true })).toContain("no longer exists");
    expect(runBlock({ ...ok, featureCount: 0 })).toContain("Switch Map on");
    expect(runBlock({ ...ok, featureCount: 0, stages: ["map", "plan"] })).toBeNull();
  });
  test("a first run starts with Map, a later one without", () => {
    expect(defaultForm(false).stages).toEqual(["map", "plan", "test", "fix"]);
    expect(defaultForm(true).stages).toEqual(["plan", "test", "fix"]);
  });
  test("the scope says how many features a run covers", () => {
    expect(scopeLabel({ kind: "all" }, 12)).toBe("All 12 features");
    expect(scopeLabel({ kind: "all" }, 1)).toBe("All 1 feature");
    expect(scopeLabel({ kind: "all" }, 0)).toBe("No features yet");
    expect(scopeLabel({ kind: "features", ids: ["a", "b"] }, 12)).toBe("2 of 12 picked");
  });
});

describe("jobs in the strip", () => {
  const job = (over: Partial<JobView>): JobView => ({ id: "qaj_1", stage: "plan", units: ["cart"], sessionId: "s", pair: false, state: "settled", problem: null, error: null, startedAt: 1, settledAt: 2, ...over });
  test("only running jobs and ones that came back without their work are listed", () => {
    const list = [job({ id: "a" }), job({ id: "b", state: "running", settledAt: null }), job({ id: "c", problem: "cart: no plan written." }), job({ id: "d", sessionId: null, error: "browser is off" })];
    expect(notableJobs(list).map((j) => j.id)).toEqual(["b", "c", "d"]);
  });
  test("a job names its stage and units", () => {
    expect(jobUnits(job({}))).toBe("plan · cart");
    expect(jobUnits(job({ stage: "map", units: ["map"] }))).toBe("map");
    expect(jobUnits(job({ stage: "test", units: ["a", "b", "c"] }))).toBe("test · 3 features");
    expect(jobUnits(job({ stage: "fix", units: ["bug-1", "bug-2"] }))).toBe("fix · 2 bugs");
  });
});

describe("small helpers", () => {
  test("how long ago", () => {
    expect(since(1000, 1000 + 30_000)).toBe("just now");
    expect(since(0, 5 * 60_000)).toBe("5m ago");
    expect(since(0, 2 * 3_600_000)).toBe("2h ago");
    expect(since(0, 3 * 86_400_000)).toBe("3d ago");
  });
  test("a step's last outcome", () => {
    expect(stepCell("fail")).toEqual({ tone: "bad", word: "fail" });
    expect(stepCell("blocked").tone).toBe("warn");
    expect(stepCell(null)).toEqual({ tone: "idle", word: "not run" });
    expect(stepCell("pending").word).toBe("not run");
  });
  test("an outcome says what happened for a failure and the note otherwise", () => {
    expect(outcomeText({ state: "fail", at: 1, actual: "blank page", bug: null })).toBe("blank page");
    expect(outcomeText({ state: "pass", at: 1, note: "saw the receipt" })).toBe("saw the receipt");
    expect(outcomeText({ state: "blocked", at: 1, note: "no login" })).toBe("no login");
    expect(outcomeText({ state: "pending" })).toBe("");
  });
  test("picked features that left the map are dropped", () => expect(prunePicked(["a", "x"], [{ id: "a" }, { id: "b" }])).toEqual(["a"]));
  test("a bug is found under its feature or in the unsorted list", () => {
    const board = { features: [feature({ bugs: [bug("open", "bug-in")] })], bugsWithoutFeature: [bug("open", "bug-out")] };
    expect(findBug(board, "bug-in")).toEqual({ feature: "cart" });
    expect(findBug(board, "bug-out")).toEqual({ feature: null });
    expect(findBug(board, "bug-zz")).toBeNull();
  });
});
