import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { STAGES, bugPatchBody, refetchMs, type Driver, type PipelineView, type QaBoard } from "../../web/src/features/qa/api";
import { bugFixRequest, countsLine, defaultForm, featureForUrl, pipelineRequest, rowRequest, scopeOf, stageLine, toggleStage, type RunForm } from "../../web/src/features/qa/logic";
import { openQa, takeQaIntent } from "../../web/src/features/qa/open";
import { agentFromWho, parseDriver } from "../../web/src/features/qa/run-choice";
import { useUi } from "../../web/src/lib/store";

const f = (id: string, ...where: string[]) => ({ id, where });
const URL0 = "http://localhost:3000";

describe("featureForUrl: the vectors every implementation must pass", () => {
  test("the longest matching path wins, and a query does not count", () => {
    expect(featureForUrl([f("cart", "/cart"), f("checkout", "/cart/checkout")], `${URL0}/cart/checkout?x=1`)).toBe("checkout");
  });
  test("a trailing slash on the URL is ignored", () => {
    expect(featureForUrl([f("cart", "/cart")], `${URL0}/cart/`)).toBe("cart");
  });
  test("a path that only shares a prefix of letters does not match", () => {
    expect(featureForUrl([f("cart", "/cart")], `${URL0}/cartoon`)).toBeNull();
  });
  test("the root path catches what nothing else claims", () => {
    expect(featureForUrl([f("home", "/"), f("cart", "/cart")], `${URL0}/about`)).toBe("home");
    expect(featureForUrl([f("home", "/"), f("cart", "/cart")], `${URL0}/cart/1`)).toBe("cart");
  });
  test("two features that tie on the best score give null", () => {
    expect(featureForUrl([f("a", "/x"), f("b", "/x")], `${URL0}/x/1`)).toBeNull();
  });
  test("a URL that does not parse gives null", () => {
    expect(featureForUrl([f("a", "/x"), f("home", "/")], "not a url")).toBeNull();
  });
  test("a feature with two paths counts once, by its longest match", () => {
    expect(featureForUrl([f("a", "/x", "/x/y"), f("b", "/x")], `${URL0}/x/y/z`)).toBe("a");
  });
  test("trailing slashes on a where entry are ignored", () => {
    expect(featureForUrl([f("cart", "/cart/")], `${URL0}/cart/items`)).toBe("cart");
  });
});

const form = (over: Partial<RunForm> = {}): RunForm => ({ ...defaultForm(true), ...over });
const agent: Driver = { kind: "agent", engine: "claude", model: "opus", effort: null };
const pair: Driver = { kind: "pair", pairId: "pr_1" };

describe("pipelineRequest", () => {
  test("the stages chosen, in run order, with their batching; replan is left out for scope all", () => {
    const r = pipelineRequest(form({ stages: ["plan", "test", "fix"], batching: { plan: "together", test: "each", fix: "together" } }), { kind: "all" }, agent);
    expect(r).toEqual({ stages: { plan: { batching: "together" }, test: { batching: "each" }, fix: { batching: "together" } }, scope: { kind: "all" }, pace: "auto", driver: { kind: "agent", engine: "claude", model: "opus" } });
    expect("replan" in r.stages.plan!).toBe(false);
  });
  test("map carries no settings and a skipped stage has no key", () => {
    const r = pipelineRequest(form({ stages: ["map", "test"] }), { kind: "all" }, agent);
    expect(r.stages).toEqual({ map: {}, test: { batching: "each" } });
  });
  test("an explicit replan is sent", () => {
    expect(pipelineRequest(form({ stages: ["plan"], replan: true }), { kind: "all" }, agent).stages.plan).toEqual({ batching: "each", replan: true });
  });
  test("a pair sends its id and no engine, even when the stored driver carries one", () => {
    const r = pipelineRequest(form(), { kind: "all" }, { ...pair, engine: "claude" } as unknown as Driver);
    expect(r.driver).toEqual({ kind: "pair", pairId: "pr_1" });
  });
  test("pace, a trimmed note and a base address ride along; empty ones are left out", () => {
    const r = pipelineRequest(form({ pace: "step", note: "  focus on checkout  ", baseUrl: " http://localhost:5173/ " }), { kind: "features", ids: ["a", "b"] }, agent);
    expect(r.pace).toBe("step");
    expect(r.note).toBe("focus on checkout");
    expect(r.baseUrl).toBe("http://localhost:5173/");
    expect(r.scope).toEqual({ kind: "features", ids: ["a", "b"] });
    const bare = pipelineRequest(form({ note: "   ", baseUrl: "" }), { kind: "all" }, agent);
    expect("note" in bare).toBe(false);
    expect("baseUrl" in bare).toBe(false);
  });
  test("a note is cut at 4000 characters", () => {
    expect(pipelineRequest(form({ note: "x".repeat(5000) }), { kind: "all" }, agent).note).toHaveLength(4000);
  });
});

describe("rowRequest", () => {
  test("plan: one feature, planned again, one at a time", () => {
    expect(rowRequest("plan", "cart", form(), agent)).toEqual({ stages: { plan: { batching: "each", replan: true } }, scope: { kind: "features", ids: ["cart"] }, pace: "auto", driver: { kind: "agent", engine: "claude", model: "opus" } });
  });
  test("test: just the test stage for that feature", () => {
    expect(rowRequest("test", "cart", form(), pair)).toEqual({ stages: { test: { batching: "each" } }, scope: { kind: "features", ids: ["cart"] }, pace: "auto", driver: { kind: "pair", pairId: "pr_1" } });
  });
  test("fix: the feature's open bugs, batched as the form says", () => {
    const r = rowRequest("fix", "cart", form({ batching: { plan: "each", test: "each", fix: "together" } }), agent);
    expect(r.stages).toEqual({ fix: { batching: "together" } });
    expect(r.scope).toEqual({ kind: "features", ids: ["cart"] });
  });
  test("stages: the form's stages, its pace and its batching, for that one feature", () => {
    const r = rowRequest("stages", "cart", form({ stages: ["plan", "test"], pace: "step" }), agent);
    expect(r.stages).toEqual({ plan: { batching: "each" }, test: { batching: "each" } });
    expect(r.pace).toBe("step");
    expect(r.scope).toEqual({ kind: "features", ids: ["cart"] });
  });
  test("the run bar's note and base address apply to a row too", () => {
    const r = rowRequest("test", "cart", form({ note: "mobile", baseUrl: "http://localhost:3000" }), agent);
    expect(r.note).toBe("mobile");
    expect(r.baseUrl).toBe("http://localhost:3000");
  });
});

describe("bugFixRequest", () => {
  test("one bug, fixed on its own, no pause", () => {
    expect(bugFixRequest("bug-1", agent)).toEqual({ stages: { fix: { batching: "each" } }, scope: { kind: "bugs", ids: ["bug-1"] }, pace: "auto", driver: { kind: "agent", engine: "claude", model: "opus" } });
  });
});

describe("the run scope", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  test("nothing picked is all", () => expect(scopeOf([], list)).toEqual({ kind: "all" }));
  test("picked ids come back in map order, and unknown ones are dropped", () => expect(scopeOf(["c", "zz", "a"], list)).toEqual({ kind: "features", ids: ["a", "c"] }));
  test("toggling a stage keeps run order", () => {
    expect(toggleStage(["plan", "fix"], "test")).toEqual(["plan", "test", "fix"]);
    expect(toggleStage(["plan", "test"], "plan")).toEqual(["test"]);
    expect(toggleStage(["map"], "map")).toEqual([]);
  });
});

describe("stageLine and countsLine", () => {
  const s = (over: Partial<PipelineView["stages"][number]>): PipelineView["stages"][number] => ({ stage: "plan", state: "current", done: 3, total: 8, problems: 0, ...over });
  test("a stage is its name and progress, and problems only when there are some", () => {
    expect(stageLine(s({ problems: 1 }))).toBe("Plan 3/8 · 1 problem");
    expect(stageLine(s({ problems: 2 }))).toBe("Plan 3/8 · 2 problems");
    expect(stageLine(s({}))).toBe("Plan 3/8");
    expect(stageLine(s({ stage: "test", state: "next", done: 0, total: 0 }))).toBe("Test 0/0");
    expect(stageLine(s({ stage: "map", state: "skipped", done: 0, total: 0 }))).toBe("Map skipped");
  });
  test("a run's counts name only the states that need a look", () => {
    expect(countsLine({ pending: 7, pass: 4, fail: 1, skip: 0, blocked: 0 })).toBe("5/12 · 1 fail");
    expect(countsLine({ pending: 0, pass: 3, fail: 0, skip: 1, blocked: 0 })).toBe("4/4");
    expect(countsLine({ pending: 0, pass: 2, fail: 2, skip: 0, blocked: 1 })).toBe("5/5 · 2 fail · 1 blocked");
  });
});

describe("opening the QA view", () => {
  const withSpy = (run: () => void) => {
    const openTab = useUi.getState().openTab;
    const seen: unknown[] = [];
    useUi.setState({ openTab: ((t) => (seen.push(t), "qa")) as typeof openTab });
    try {
      run();
    } finally {
      useUi.setState({ openTab });
    }
    return seen;
  };
  test("it opens the one qa tab and leaves the intent to be taken once", () => {
    const seen = withSpy(() => openQa({ bug: "bug-1" }));
    expect(seen).toEqual([{ kind: "qa", title: "QA" }]);
    expect(takeQaIntent()).toEqual({ bug: "bug-1" });
    expect(takeQaIntent()).toBeNull();
  });
  test("a later intent replaces one that was never taken, and a plain open clears it", () => {
    withSpy(() => {
      openQa({ feature: "cart" });
      openQa({ bug: "bug-2" });
    });
    expect(takeQaIntent()).toEqual({ bug: "bug-2" });
    withSpy(() => {
      openQa({ feature: "cart" });
      openQa();
    });
    expect(takeQaIntent()).toBeNull();
  });
});

describe("the wire copy", () => {
  test("the stages are the contract's, in run order", () => {
    expect([...STAGES]).toEqual(["map", "plan", "test", "fix"]);
  });
  const server = ["types", "pipeline"].map((n) => `${import.meta.dir}/../../src/qa/${n}.ts`).filter((p) => existsSync(p) && /export const STAGES\b/.test(readFileSync(p, "utf8")));
  // The server's STAGES arrives with slice S2: until its file exports one there is nothing to compare, and the literal above holds the contract.
  test.skipIf(server.length === 0)("the web STAGES equals the server STAGES", async () => {
    const mod = await import(server[0]!);
    expect([...STAGES]).toEqual([...mod.STAGES]);
  });
});

describe("what the board polls on", () => {
  const board = (control: PipelineView["control"] | null) => ({ pipeline: control ? ({ control } as PipelineView) : null }) as Pick<QaBoard, "pipeline">;
  test("fast while a pipeline works or is stopping, slow otherwise", () => {
    expect(refetchMs(board({ kind: "running", stage: "plan" }))).toBe(3000);
    expect(refetchMs(board({ kind: "stopping", stage: "plan" }))).toBe(3000);
    expect(refetchMs(board({ kind: "held", after: "plan", next: "test" }))).toBe(15_000);
    expect(refetchMs(board({ kind: "ended", reason: "done", at: 1 }))).toBe(15_000);
    expect(refetchMs(board(null))).toBe(15_000);
    expect(refetchMs(undefined)).toBe(15_000);
  });
});

describe("the bug PATCH body", () => {
  test("only what was given; a feature of null clears it", () => {
    expect(bugPatchBody({ status: "dismissed" })).toEqual({ status: "dismissed" });
    expect(bugPatchBody({ feature: "cart" })).toEqual({ feature: "cart" });
    expect(bugPatchBody({ feature: null })).toEqual({ feature: null });
    expect(bugPatchBody({ status: "new", feature: null })).toEqual({ status: "new", feature: null });
  });
});

describe("the remembered driver", () => {
  test("an agent keeps its fields, a pair keeps only its id, junk is nothing", () => {
    expect(parseDriver(JSON.stringify({ kind: "agent", engine: "codex", model: "", effort: "high" }))).toEqual({ kind: "agent", engine: "codex", effort: "high" });
    expect(parseDriver(JSON.stringify({ kind: "pair", pairId: "pr_1", engine: "x" }))).toEqual({ kind: "pair", pairId: "pr_1" });
    expect(parseDriver(JSON.stringify({ kind: "pair" }))).toBeNull();
    expect(parseDriver("nope")).toBeNull();
    expect(parseDriver(null)).toBeNull();
  });
  test("without a choice the shared engine and model stand in", () => {
    expect(agentFromWho({ engine: "claude", model: "opus" })).toEqual({ kind: "agent", engine: "claude", model: "opus" });
    expect(agentFromWho({})).toEqual({ kind: "agent" });
  });
});
