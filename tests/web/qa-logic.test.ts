import { describe, expect, test } from "bun:test";
import { matchOptions } from "../../web/src/components/ui/combobox";
import type { Activity, BoardBug, BoardFeature, JobView, PipelineView } from "../../web/src/features/qa/api";
import { bugOffers, bugFixRequest, bugsFixRequest, prunePickedBugs, selectableBugs, featureForUrl, featureRows, areaCell, areaRemapRequest, isFiltering, liveQuery, pickShown, pipelineRequest, toggleShown, matchesFilter, matchesQuery, shownLine, bugsCell, countsLine, defaultForm, findBug, isBusy, jobUnits, mapCell, notableJobs, outcomeText, phaseOf, planCell, primaryOf, prunePicked, runBlock, scopeOf, scopeLabel, since, statusLine, stepCell, testCell } from "../../web/src/features/qa/logic";

const idle: Activity = { kind: "idle" };
const feature = (over: Partial<BoardFeature> = {}): BoardFeature => ({ id: "cart", title: "Cart", where: ["/cart"], parent: null, depth: 0, area: null, summary: "", plan: { kind: "missing" }, test: { kind: "never" }, bugs: [], activity: { plan: idle, test: idle, fix: idle }, ...over });
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
  const map = (over: Partial<Parameters<typeof mapCell>[0]> = {}): Parameters<typeof mapCell>[0] => ({ exists: true, layout: "flat", problem: null, updatedAt: 1, activity: idle, areas: [], ...over });
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

describe("featureForUrl follows the server rule, not a friendlier one", () => {
  const f = (id: string, ...where: string[]) => ({ id, where });
  // Before: the web copy trimmed `where`, so a padded entry matched here but never on the server (the pre-fill and the stored bug disagreed).
  test("an entry with a leading or trailing space is not a path", () => {
    expect(featureForUrl([f("cart", " /cart")], "http://x/cart")).toBeNull();
    expect(featureForUrl([f("cart", "/cart ")], "http://x/cart")).toBeNull();
  });
  test("an entry without a leading slash never matches", () => {
    expect(featureForUrl([f("cart", "cart")], "http://x/cart")).toBeNull();
    expect(featureForUrl([f("cart", "cart"), f("home", "/")], "http://x/cart")).toBe("home");
  });
  test("a bad entry does not stop a good one in the same feature", () => {
    expect(featureForUrl([f("cart", "cart", "/cart")], "http://x/cart/1")).toBe("cart");
  });
  test("a tie across two features is null even when one also lists a bad entry", () => {
    expect(featureForUrl([f("a", "/x"), f("b", "/x", "x/y")], "http://x/x/1")).toBeNull();
  });
});

const ran = (c: Partial<Record<"pending" | "pass" | "fail" | "skip" | "blocked", number>>) => ({ kind: "ran" as const, run: { id: "qa_1", feature: "cart", startedAt: 1, counts: counts(c), finished: true, sessionId: null } });
const working: Activity = { kind: "working", sessionId: "s", pair: false };

describe("finding a feature", () => {
  const none = { text: "", filters: [] } as const;
  test("the text matches title, id, where and summary, case-insensitively", () => {
    const f = feature({ id: "checkout-flow", title: "Pay for the Order", where: ["/cart/checkout"], summary: "Card and wallet payment" });
    for (const t of ["PAY FOR", "checkout-flow", "/cart/check", "wallet"]) expect(matchesQuery(f, { ...none, text: t })).toBe(true);
    expect(matchesQuery(f, { ...none, text: "refund" })).toBe(false);
  });
  test("every word must be found, in any field, in any order", () => {
    const f = feature({ title: "Cart", where: ["/cart"], summary: "Line items and totals" });
    expect(matchesQuery(f, { ...none, text: "totals  cart" })).toBe(true);
    expect(matchesQuery(f, { ...none, text: "cart refund" })).toBe(false);
  });
  test("blank text matches everything", () => expect(matchesQuery(feature(), { ...none, text: "   " })).toBe(true));

  test("needs a plan: missing or broken, not ready", () => {
    expect(matchesFilter(feature(), "needs-plan")).toBe(true);
    expect(matchesFilter(feature({ plan: { kind: "broken", problem: "x" } }), "needs-plan")).toBe(true);
    expect(matchesFilter(feature({ plan: { kind: "ready", steps: 2, updatedAt: 1 } }), "needs-plan")).toBe(false);
  });
  test("never tested versus failing", () => {
    expect(matchesFilter(feature(), "never-tested")).toBe(true);
    expect(matchesFilter(feature({ test: ran({ pass: 3 }) }), "never-tested")).toBe(false);
    expect(matchesFilter(feature({ test: ran({ pass: 3, fail: 1 }) }), "failing")).toBe(true);
    expect(matchesFilter(feature({ test: ran({ pass: 3, blocked: 1 }) }), "failing")).toBe(false);
    expect(matchesFilter(feature(), "failing")).toBe(false);
  });
  test("open bugs ignores fixed and dismissed ones", () => {
    expect(matchesFilter(feature({ bugs: [bug("fixed"), bug("dismissed", "bug-b")] }), "open-bugs")).toBe(false);
    expect(matchesFilter(feature({ bugs: [bug("fixed"), bug("needs-check", "bug-b")] }), "open-bugs")).toBe(true);
  });
  test("working is any stage queued or working, not a problem or idle", () => {
    expect(matchesFilter(feature(), "working")).toBe(false);
    expect(matchesFilter(feature({ activity: { plan: idle, test: { kind: "queued" }, fix: idle } }), "working")).toBe(true);
    expect(matchesFilter(feature({ activity: { plan: idle, test: idle, fix: working } }), "working")).toBe(true);
    expect(matchesFilter(feature({ activity: { plan: { kind: "problem", text: "x", sessionId: null }, test: idle, fix: idle } }), "working")).toBe(false);
  });
  test("chips narrow: a feature must satisfy all of them, with the text", () => {
    const f = feature({ title: "Cart", test: ran({ fail: 1 }) });
    expect(matchesQuery(f, { text: "", filters: ["failing", "needs-plan"] })).toBe(true);
    expect(matchesQuery(f, { text: "", filters: ["failing", "never-tested"] })).toBe(false);
    expect(matchesQuery(f, { text: "cart", filters: ["failing"] })).toBe(true);
    expect(matchesQuery(f, { text: "nope", filters: ["failing"] })).toBe(false);
  });
  test("the count says shown of total only while a query is active", () => {
    expect(shownLine(12, 480, true)).toBe("12 of 480 features");
    expect(shownLine(480, 480, false)).toBe("480 features");
    expect(shownLine(1, 1, false)).toBe("1 feature");
  });
});

describe("grouping by journey", () => {
  const f = (id: string, over: Partial<BoardFeature> = {}) => feature({ id, title: id, where: [], ...over });
  const child = (id: string, parent: string, over: Partial<BoardFeature> = {}) => f(id, { parent, depth: 1, ...over });
  const map = [f("shop"), child("cart", "shop"), child("pay", "shop", { test: ran({ fail: 1 }) }), f("admin"), child("users", "admin"), f("about")];
  const ids = (q: { text: string; filters: Parameters<typeof featureRows>[1]["filters"] }, collapsed: string[] = []) => featureRows(map, q, new Set(collapsed)).rows.map((r) => r.feature.id);
  const none = { text: "", filters: [] } as const;

  test("with no query every feature shows, children right under their parent", () => {
    expect(ids(none)).toEqual(["shop", "cart", "pay", "admin", "users", "about"]);
    expect(featureRows(map, none, new Set()).matched).toHaveLength(6);
  });
  test("a parent knows how many children it has", () => {
    const rows = featureRows(map, none, new Set()).rows;
    expect(rows.map((r) => r.children)).toEqual([2, 0, 0, 1, 0, 0]);
  });
  test("a collapsed parent hides its children and nothing else", () => {
    const { rows } = featureRows(map, none, new Set(["shop"]));
    expect(rows.map((r) => r.feature.id)).toEqual(["shop", "admin", "users", "about"]);
    expect(rows[0]!.collapsed).toBe(true);
  });
  test("a child that matches keeps its parent visible as context, and only the matching child shows", () => {
    const { rows, matched } = featureRows(map, { text: "pay", filters: [] }, new Set());
    expect(rows.map((r) => [r.feature.id, r.context])).toEqual([["shop", true], ["pay", false]]);
    expect(matched).toEqual(["pay"]);
  });
  test("a matching parent shows without the children that do not match", () => {
    expect(ids({ text: "admin", filters: [] })).toEqual(["admin"]);
  });
  test("while a query is active a collapsed parent still shows the child that matched", () => {
    const { rows } = featureRows(map, { text: "", filters: ["failing"] }, new Set(["shop"]));
    expect(rows.map((r) => r.feature.id)).toEqual(["shop", "pay"]);
    expect(rows[0]!.collapsed).toBe(false);
  });
  test("a child whose parent is not in the list is a top-level row", () => {
    const lone = [child("orphan", "gone")];
    expect(featureRows(lone, none, new Set()).rows.map((r) => r.feature.id)).toEqual(["orphan"]);
  });
  test("nothing matches: no rows", () => expect(featureRows(map, { text: "zzz", filters: [] }, new Set())).toEqual({ rows: [], matched: [] }));
});

describe("selecting what is shown", () => {
  test("Select shown picks exactly the matching features, dropping earlier picks", () => {
    expect(pickShown(["b", "c"])).toEqual(["b", "c"]);
  });
  test("the scope then runs on them, in map order", () => {
    const features = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(scopeOf(pickShown(["c", "a"]), features)).toEqual({ kind: "features", ids: ["a", "c"] });
  });
  test("nothing shown leaves the scope on all", () => expect(scopeOf(pickShown([]), [{ id: "a" }])).toEqual({ kind: "all" }));
  test("the header box picks the shown features, or drops just those when they are all picked", () => {
    expect(toggleShown(["x"], ["a", "b"])).toEqual(["a", "b"]);
    expect(toggleShown(["a"], ["a", "b"])).toEqual(["a", "b"]);
    expect(toggleShown(["x", "a", "b"], ["a", "b"])).toEqual(["x"]);
    expect(toggleShown(["x"], [])).toEqual([]);
  });
});

describe("fixing several bugs", () => {
  const driver = { kind: "agent" as const, engine: "claude" as const, model: "opus" };
  test("only open and needs-check bugs can be ticked", () => {
    const bugs = [bug("open", "bug-1"), bug("fixing", "bug-2"), bug("needs-check", "bug-3"), bug("fixed", "bug-4"), bug("dismissed", "bug-5")];
    expect(selectableBugs(bugs).map((b) => b.id)).toEqual(["bug-1", "bug-3"]);
  });
  test("ticks on a bug that closed since are dropped, and the rest keep the list's order", () => {
    const bugs = [bug("open", "bug-1"), bug("open", "bug-2"), bug("fixed", "bug-3")];
    expect(prunePickedBugs(["bug-3", "bug-2", "bug-1", "bug-9"], bugs)).toEqual(["bug-1", "bug-2"]);
  });
  test("one Fix sends every ticked id in a bugs scope, fix stage only", () => {
    const r = bugsFixRequest(["bug-1", "bug-2"], driver);
    expect(r.scope).toEqual({ kind: "bugs", ids: ["bug-1", "bug-2"] });
    expect(Object.keys(r.stages)).toEqual(["fix"]);
  });
  test("the one-bug Fix is the same request with one id", () => expect(bugFixRequest("bug-1", driver)).toEqual(bugsFixRequest(["bug-1"], driver)));
});

describe("the feature picker's search", () => {
  const options = [{ value: "", label: "No feature" }, { value: "checkout", label: "Pay for the order", hint: "checkout" }, { value: "cart", label: "Cart", hint: "cart" }];
  test("it filters by label or id as you type, case-insensitively", () => {
    expect(matchOptions(options, "PAY").map((o) => o.value)).toEqual(["checkout"]);
    expect(matchOptions(options, "ca").map((o) => o.value)).toEqual(["cart"]);
    expect(matchOptions(options, "out order").map((o) => o.value)).toEqual(["checkout"]);
  });
  test("empty text keeps every option, the no-feature choice first", () => expect(matchOptions(options, " ").map((o) => o.value)).toEqual(["", "checkout", "cart"]));
  test("no match gives an empty list", () => expect(matchOptions(options, "zzz")).toEqual([]));
});

describe("splitting the map into areas and running tests at once", () => {
  const agent = { kind: "agent" as const };
  const run = (over: Partial<ReturnType<typeof defaultForm>>) => pipelineRequest({ ...defaultForm(false), ...over }, { kind: "all" }, agent).stages;
  test("survey is sent only when it is on; the map stage is otherwise as before", () => {
    expect(run({ stages: ["map"], survey: true }).map).toEqual({ survey: true });
    expect(run({ stages: ["map"] }).map).toEqual({});
  });
  test("survey does nothing while the map stage is off", () => {
    expect(run({ stages: ["plan"], survey: true })).toEqual({ plan: { batching: "each" } });
  });
  test("parallel rides along with each, and the default of 1 is left out", () => {
    expect(run({ stages: ["test"], parallel: 3 }).test).toEqual({ batching: "each", parallel: 3 });
    expect(run({ stages: ["test"], parallel: 1 }).test).toEqual({ batching: "each" });
  });
  test("parallel is never sent with together", () => {
    const r = run({ stages: ["test"], parallel: 2, batching: { plan: "each", test: "together", fix: "each" } });
    expect(r.test).toEqual({ batching: "together" });
  });
  test("plan and fix never carry parallel", () => {
    expect(run({ stages: ["plan", "fix"], parallel: 3 })).toEqual({ plan: { batching: "each" }, fix: { batching: "each" } });
  });
});

describe("area rows", () => {
  const area = (over: Partial<Parameters<typeof areaCell>[0]> = {}) => ({ features: 12, updatedAt: 1, activity: idle, ...over });
  test("a mapped area says so with its feature count; one never mapped says that", () => {
    expect(areaCell(area())).toEqual({ tone: "ok", word: "mapped", count: "12 features" });
    expect(areaCell(area({ updatedAt: null, features: 1 }))).toEqual({ tone: "idle", word: "not mapped", count: "1 feature" });
  });
  test("what is happening to the area wins over its mapped state, and the count stays", () => {
    expect(areaCell(area({ activity: { kind: "working", sessionId: "s", pair: true } }))).toEqual({ tone: "run", word: "mapping", pair: true, count: "12 features" });
    expect(areaCell(area({ activity: { kind: "queued" } })).word).toBe("queued");
    expect(areaCell(area({ activity: { kind: "problem", text: "no file", sessionId: null } })).tone).toBe("bad");
  });
  test("Remap is a map-only run scoped to that area, with the driver and the run bar's note", () => {
    const form = { ...defaultForm(true), survey: true, note: " mobile ", stages: ["plan" as const] };
    expect(areaRemapRequest("billing", form, { kind: "pair", pairId: "pr_1" })).toEqual({ stages: { map: {} }, scope: { kind: "areas", ids: ["billing"] }, pace: "auto", driver: { kind: "pair", pairId: "pr_1" }, note: "mobile" });
  });
});

describe("the area filter", () => {
  const inArea = (area: string | null) => feature({ area });
  test("one area keeps only its features; no area or null keeps all", () => {
    expect(matchesQuery(inArea("billing"), { text: "", filters: [], area: "billing" })).toBe(true);
    expect(matchesQuery(inArea("settings"), { text: "", filters: [], area: "billing" })).toBe(false);
    expect(matchesQuery(inArea(null), { text: "", filters: [], area: "billing" })).toBe(false);
    expect(matchesQuery(inArea("settings"), { text: "", filters: [], area: null })).toBe(true);
    expect(matchesQuery(inArea("settings"), { text: "", filters: [] })).toBe(true);
  });
  test("it combines with the text and the chips", () => {
    const f = feature({ title: "Invoices", area: "billing", test: ran({ fail: 1 }) });
    expect(matchesQuery(f, { text: "invoice", filters: ["failing"], area: "billing" })).toBe(true);
    expect(matchesQuery(f, { text: "invoice", filters: ["failing"], area: "settings" })).toBe(false);
    expect(matchesQuery(f, { text: "refund", filters: [], area: "billing" })).toBe(false);
    expect(matchesQuery(f, { text: "invoice", filters: ["never-tested"], area: "billing" })).toBe(false);
  });
  test("picking an area counts as filtering, so Select shown and the count appear", () => {
    expect(isFiltering({ text: "", filters: [], area: "billing" })).toBe(true);
    expect(isFiltering({ text: "", filters: [], area: null })).toBe(false);
  });
  test("Select shown then picks exactly that area's features, in map order", () => {
    const map = [feature({ id: "a", area: "billing" }), feature({ id: "b", area: "settings" }), feature({ id: "c", area: "billing" })];
    const { matched } = featureRows(map, { text: "", filters: [], area: "billing" }, new Set());
    expect(matched).toEqual(["a", "c"]);
    expect(scopeOf(pickShown(matched), map)).toEqual({ kind: "features", ids: ["a", "c"] });
  });
  test("an area that left the map is dropped from the query", () => {
    const q = { text: "x", filters: [], area: "gone" } as const;
    expect(liveQuery(q, [{ id: "billing" }])).toEqual({ text: "x", filters: [], area: null });
    expect(liveQuery({ ...q, area: "billing" }, [{ id: "billing" }]).area).toBe("billing");
    expect(liveQuery({ text: "", filters: [] }, [])).toEqual({ text: "", filters: [] });
  });
});

describe("scope by area", () => {
  const list = [{ id: "a" }, { id: "b" }];
  const areas = [{ id: "billing", title: "Billing", features: 24 }, { id: "solo", title: "Solo", features: 1 }];
  test("an area filter with nothing picked scopes the run to that area", () => {
    expect(scopeOf([], list, "billing")).toEqual({ kind: "areas", ids: ["billing"] });
  });
  test("picked features take precedence over the area", () => {
    expect(scopeOf(["b"], list, "billing")).toEqual({ kind: "features", ids: ["b"] });
  });
  test("no area, or none given, is all as before", () => {
    expect(scopeOf([], list, null)).toEqual({ kind: "all" });
    expect(scopeOf([], list)).toEqual({ kind: "all" });
  });
  test("the run bar names the area and its size", () => {
    expect(scopeLabel({ kind: "areas", ids: ["billing"] }, 480, areas)).toBe("Area Billing · 24 features");
    expect(scopeLabel({ kind: "areas", ids: ["solo"] }, 480, areas)).toBe("Area Solo · 1 feature");
    expect(scopeLabel({ kind: "areas", ids: ["gone"] }, 480, areas)).toBe("1 area");
  });
  test("the full run carries the area scope, with the stages chosen", () => {
    const r = pipelineRequest({ ...defaultForm(true), stages: ["plan", "test"] }, scopeOf([], list, "billing"), { kind: "agent" });
    expect(r.scope).toEqual({ kind: "areas", ids: ["billing"] });
    expect(r.stages).toEqual({ plan: { batching: "each" }, test: { batching: "each" } });
  });
});
