import { describe, expect, test } from "bun:test";
import type { Outcome, Plan, PlanSummary, Run, RunStep, RunSummary } from "../../web/src/features/qa/api";
import { bugDraftOf, bugOf, countsLine, currentStep, keyFor, lastRunLine, markersOf, nextStep, outcomeDetail, pathOf, planChanged, prevStep, progress, rowsOf, runLine, runNumber, runsNewestFirst, sortPlans, sourceOf, summaryProgress, switchesStep } from "../../web/src/features/qa/logic";

const step = (id: string, outcome: Outcome = { state: "pending" }, extra: Partial<RunStep> = {}): RunStep => ({ id, action: `do ${id}`, expected: `see ${id}`, path: null, outcome, ...extra });
const run = (steps: RunStep[], extra: Partial<Run> = {}): Run => ({ id: "r1", plan: "p", root: "x", startedAt: 1, steps, ...extra });
const pass: Outcome = { state: "pass", at: 5, note: "" };
const fail: Outcome = { state: "fail", at: 6, actual: "blank page", bug: null };

describe("progress", () => {
  test("counts each state and treats every non-pending step as done", () => {
    const r = run([step("a", pass), step("b", fail), step("c", { state: "skip", at: 1, note: "" }), step("d", { state: "blocked", at: 1, note: "no login" }), step("e")]);
    expect(progress(r)).toEqual({ counts: { pending: 1, pass: 1, fail: 1, skip: 1, blocked: 1 }, done: 4, total: 5 });
  });
  test("an empty run is 0 of 0", () => {
    expect(progress(run([]))).toEqual({ counts: { pending: 0, pass: 0, fail: 0, skip: 0, blocked: 0 }, done: 0, total: 0 });
  });
});

describe("walking the steps", () => {
  const r = run([step("a", pass), step("b"), step("c", fail), step("d")]);
  test("the current step is the first pending one, not the first after the last mark", () => {
    expect(currentStep(r)?.id).toBe("b");
  });
  test("no current step when nothing is pending", () => {
    expect(currentStep(run([step("a", pass)]))).toBeNull();
  });
  test("next and previous stop at the ends", () => {
    expect(nextStep(r, "a")?.id).toBe("b");
    expect(nextStep(r, "d")).toBeNull();
    expect(prevStep(r, "b")?.id).toBe("a");
    expect(prevStep(r, "a")).toBeNull();
  });
  test("an unknown id has no neighbours", () => {
    expect(nextStep(r, "zz")).toBeNull();
    expect(prevStep(r, "zz")).toBeNull();
  });
});

describe("bugDraftOf", () => {
  const r = run([step("a", pass, { action: "Open the page" }), step("b", fail, { action: "Click Save", expected: "A toast", path: "/save" }), step("c", { state: "pending" }, { action: "Never reached" })]);
  test("reproduces every action up to and including the failed one, then the recorded lines", () => {
    const d = bugDraftOf(r, "b", ["clicked #save", "POST /api 500"]);
    expect(d).toEqual({
      title: "Click Save",
      kind: "functional",
      steps: ["Open the page", "Click Save", "clicked #save (recorded)", "POST /api 500 (recorded)"],
      expected: "A toast",
      actual: "blank page",
      path: "/save",
    });
  });
  test("a step that has not failed yet drafts an empty actual", () => {
    expect(bugDraftOf(r, "a", [])?.actual).toBe("");
  });
  test("an unknown step gives no draft", () => {
    expect(bugDraftOf(r, "zz", [])).toBeNull();
  });
});

describe("keyFor", () => {
  const k = (key: string, extra: object = {}) => keyFor({ key, ...extra });
  test("maps the outcome keys in either case", () => {
    expect(k("p")).toBe("pass");
    expect(k("P")).toBe("pass");
    expect(k("f")).toBe("fail");
    expect(k("s")).toBe("skip");
    expect(k("b")).toBe("blocked");
  });
  test("maps arrows and Enter", () => {
    expect(k("ArrowUp")).toBe("prev");
    expect(k("ArrowDown")).toBe("next");
    expect(k("Enter")).toBe("go");
  });
  test("ignores other keys and chords", () => {
    expect(k("x")).toBeNull();
    expect(k("p", { ctrlKey: true })).toBeNull();
    expect(k("f", { metaKey: true })).toBeNull();
    expect(k("s", { altKey: true })).toBeNull();
  });
  test("ignores everything while typing in a field", () => {
    expect(k("p", { editable: true })).toBeNull();
    expect(k("Enter", { editable: true })).toBeNull();
  });
});

describe("markersOf", () => {
  const h = (runId: string, outcome: Outcome) => ({ run: runId, at: 1, outcome: outcome as Exclude<Outcome, { state: "pending" }> });
  test("is the newest outcome of each step, as a state", () => {
    expect(markersOf({ a: h("r1", fail), b: h("r1", pass) }, "r2")).toEqual({ a: "fail", b: "pass" });
  });
  test("leaves out what the run on screen marked itself", () => {
    expect(markersOf({ a: h("r2", fail), b: h("r1", pass) }, "r2")).toEqual({ b: "pass" });
  });
  test("no history, no markers", () => {
    expect(markersOf({}, "r2")).toEqual({});
  });
});

describe("summaryProgress", () => {
  test("totals the counts and counts everything not pending as done", () => {
    expect(summaryProgress({ pending: 2, pass: 3, fail: 1, skip: 0, blocked: 1 })).toEqual({ counts: { pending: 2, pass: 3, fail: 1, skip: 0, blocked: 1 }, done: 5, total: 7 });
  });
});

describe("planChanged", () => {
  const plan = (steps: Array<{ id: string; action: string; expected: string; path: string | null }>): Plan => ({ slug: "p", title: "P", source: { kind: "manual" }, intro: "", steps, proposals: [], problem: null, proposalsProblem: null });
  const r = run([step("a"), step("b")]);
  test("same ids and text is unchanged, whatever the outcomes", () => {
    expect(planChanged(run([step("a", pass), step("b", fail)]), plan(r.steps.map(({ outcome, ...s }) => s)))).toBe(false);
  });
  test("an added, removed, reordered or edited step is a change", () => {
    const s = r.steps.map(({ outcome, ...p }) => p);
    expect(planChanged(r, plan([...s, { id: "c", action: "x", expected: "", path: null }]))).toBe(true);
    expect(planChanged(r, plan([s[0]!]))).toBe(true);
    expect(planChanged(r, plan([s[1]!, s[0]!]))).toBe(true);
    expect(planChanged(r, plan([s[0]!, { ...s[1]!, expected: "other" }]))).toBe(true);
  });
});

describe("rowsOf", () => {
  const steps = [
    { id: "a", action: "A", expected: "", path: null },
    { id: "b", action: "B", expected: "", path: null },
  ];
  const prop = (id: string, after: string) => ({ id, after, why: "w", orphan: false, step: { action: id, expected: "", path: null } });
  test("puts each proposal after the step it names, and 'start' first", () => {
    const rows = rowsOf(steps, [prop("p1", "a"), prop("p0", "start")]);
    expect(rows.map((r) => (r.kind === "step" ? r.step.id : r.proposal.id))).toEqual(["p0", "a", "p1", "b"]);
  });
  test("a proposal that names a step no longer there goes last", () => {
    const rows = rowsOf(steps, [prop("p9", "gone")]);
    expect(rows.at(-1)).toMatchObject({ kind: "proposal" });
  });
  test("steps carry their 1-based number", () => {
    const rows = rowsOf(steps, [prop("p1", "a")]);
    expect(rows.filter((r) => r.kind === "step").map((r) => (r as { number: number }).number)).toEqual([1, 2]);
  });
});

describe("runLine", () => {
  test("names the run, progress, and only the problems", () => {
    expect(runLine(3, progress(run([step("a", pass), step("b", fail), step("c")])))).toBe("Run 3 · 2/3 · 1 fail");
    expect(runLine(1, progress(run([step("a", pass)])))).toBe("Run 1 · 1/1");
    expect(runLine(2, progress(run([step("a", fail), step("b", fail), step("c", { state: "blocked", at: 1, note: "x" })])))).toBe("Run 2 · 3/3 · 2 fail · 1 blocked");
  });
});

describe("pathOf", () => {
  test("keeps the path and drops origin, query and hash", () => {
    expect(pathOf("http://localhost:5173/cart/items?x=1#top")).toBe("/cart/items");
    expect(pathOf("http://localhost:5173")).toBe("/");
  });
  test("a non-URL has no path", () => {
    expect(pathOf("about:blank")).toBeNull();
    expect(pathOf("not a url")).toBeNull();
  });
});

describe("sourceOf", () => {
  test("builds the plan source each choice names, and null when its input is missing", () => {
    expect(sourceOf({ kind: "page", page: "/cart", dir: "", base: "" })).toEqual({ kind: "page", path: "/cart" });
    expect(sourceOf({ kind: "page", page: null, dir: "", base: "" })).toBeNull();
    expect(sourceOf({ kind: "spec", page: null, dir: "specs/001", base: "" })).toEqual({ kind: "spec", dir: "specs/001" });
    expect(sourceOf({ kind: "spec", page: null, dir: "", base: "" })).toBeNull();
    expect(sourceOf({ kind: "diff", page: null, dir: "", base: "main" })).toEqual({ kind: "diff", base: "main", head: "HEAD" });
    expect(sourceOf({ kind: "text", page: null, dir: "", base: "" })).toEqual({ kind: "text" });
    expect(sourceOf({ kind: "manual", page: null, dir: "", base: "" })).toBeNull();
  });
});

describe("switchesStep", () => {
  test("choosing the step already open changes nothing, so its recording window and typed text stay", () => {
    expect(switchesStep("s-1", "s-1")).toBe(false);
    expect(switchesStep("s-1", "s-2")).toBe(true);
    expect(switchesStep(null, "s-1")).toBe(true);
    expect(switchesStep("s-1", null)).toBe(true);
  });
});

const summary = (id: string, startedAt: number, counts: Partial<RunSummary["counts"]> = {}): RunSummary => ({ id, plan: "p", startedAt, finished: false, states: {}, counts: { pending: 0, pass: 0, fail: 0, skip: 0, blocked: 0, ...counts } });
const planSummary = (slug: string, updatedAt: number, lastRun: RunSummary | null = null): PlanSummary => ({ slug, title: slug, steps: 3, proposals: 0, problem: null, updatedAt, lastRun });

describe("sortPlans", () => {
  test("a plan run after another was edited rises above it: the newest activity wins", () => {
    const sorted = sortPlans([planSummary("edited", 50), planSummary("ran", 10, summary("r", 90)), planSummary("old", 5)]);
    expect(sorted.map((p) => p.slug)).toEqual(["ran", "edited", "old"]);
  });
  test("ties fall back to the title and the input is not mutated", () => {
    const input = [planSummary("b", 1), planSummary("a", 1)];
    expect(sortPlans(input).map((p) => p.slug)).toEqual(["a", "b"]);
    expect(input.map((p) => p.slug)).toEqual(["b", "a"]);
  });
});

describe("countsLine", () => {
  test("is the run line without its number", () => {
    const p = progress(run([step("a", pass), step("b", fail), step("c")]));
    expect(countsLine(p)).toBe("2/3 · 1 fail");
    expect(runLine(4, p)).toBe(`Run 4 · ${countsLine(p)}`);
  });
});

describe("lastRunLine", () => {
  test("names done over total and only the states that need a look", () => {
    expect(lastRunLine(summary("r", 1, { pass: 5, fail: 1, pending: 6 }))).toBe("6/12 · 1 fail");
    expect(lastRunLine(summary("r", 1, { pass: 3 }))).toBe("3/3");
  });
  test("a plan that never ran says so", () => {
    expect(lastRunLine(null)).toBe("Not run yet");
  });
});

describe("runs of a plan", () => {
  const runs = [summary("a", 10), summary("c", 30), summary("b", 20)];
  test("newest first, without touching the input", () => {
    expect(runsNewestFirst(runs).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(runs.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });
  test("a run's number is its place from the oldest", () => {
    const sorted = runsNewestFirst(runs);
    expect(sorted.map((r) => runNumber(sorted, r.id))).toEqual([3, 2, 1]);
    expect(runNumber(sorted, "gone")).toBe(0);
  });
});

describe("what a step outcome says", () => {
  test("a failure speaks through what actually happened, the others through their note, pending says nothing", () => {
    expect(outcomeDetail(fail)).toBe("blank page");
    expect(outcomeDetail({ state: "blocked", at: 1, note: "no login" })).toBe("no login");
    expect(outcomeDetail({ state: "pending" })).toBe("");
  });
  test("only a failed step can carry a bug", () => {
    expect(bugOf({ state: "fail", at: 1, actual: "x", bug: "f-9" })).toBe("f-9");
    expect(bugOf(fail)).toBeNull();
    expect(bugOf(pass)).toBeNull();
  });
});
