import { describe, expect, test } from "bun:test";
import { LEGACY_WHO_KEY, WHO_KEY, getWho, readWho, setWho, subscribeWho, writeWho } from "../../web/src/components/agent-who";
import { findingActionRequest, type Finding } from "../../web/src/features/lab/data";
import { applyFilter, checklistRef, fixBlock, isBug, countByStatus, inFilter, NO_FILTER, splitEvidence, tokensLabel } from "../../web/src/features/lab/logic";

const f = (over: Partial<Finding> & { id: string }): Finding => ({ path: `lab/findings/${over.id}.md`, title: over.id, lens: "perf", scope: null, impact: "medium", effort: "m", status: "new", evidence: [], missing: [], unmeasured: false, roadmap: null, spec: null, checklist: null, bug: null, session: null, fixSession: null, fixRunning: false, drifted: [], summary: "", body: "", updatedAt: 0, problem: null, ...over });

describe("lab filters", () => {
  const list = [f({ id: "a" }), f({ id: "b", status: "accepted", lens: "ui" }), f({ id: "c", status: "dismissed" }), f({ id: "d", status: "shipped", lens: "ui" })];
  test("open means new or accepted", () => {
    expect(applyFilter(list, NO_FILTER).map((x) => x.id)).toEqual(["a", "b"]);
    expect(inFilter("shipped", "open")).toBe(false);
    expect(applyFilter(list, { status: "all", lens: "all" })).toHaveLength(4);
  });
  test("a lens narrows the list", () => {
    expect(applyFilter(list, { status: "all", lens: "ui" }).map((x) => x.id)).toEqual(["b", "d"]);
  });
  test("counts per tab", () => {
    expect(countByStatus(list)).toEqual({ open: 2, dismissed: 1, shipped: 1, all: 4 });
  });
});

describe("lab labels", () => {
  test("token counts read at a glance", () => {
    expect(tokensLabel(850)).toBe("850 tokens");
    expect(tokensLabel(1500)).toBe("1.5k tokens");
    expect(tokensLabel(42_000)).toBe("42k tokens");
    expect(tokensLabel(2_400_000)).toBe("2.4M tokens");
  });
  test("evidence splits into a path and a line", () => {
    expect(splitEvidence("web/src/a.tsx:84")).toEqual({ path: "web/src/a.tsx", line: 84 });
    expect(splitEvidence("web/src/a.tsx:84:3")).toEqual({ path: "web/src/a.tsx", line: 84 });
    expect(splitEvidence("src/a.ts#L12")).toEqual({ path: "src/a.ts", line: 12 });
    expect(splitEvidence("src/a.ts")).toEqual({ path: "src/a.ts", line: null });
    expect(splitEvidence("bundle is 2.1 MB")).toBeNull();
    expect(splitEvidence("screenshot")).toBeNull();
  });
  test("a checklist finding names its checklist and item", () => {
    expect(checklistRef("marketing-site/seo.title")).toEqual({ checklist: "marketing-site", item: "seo.title" });
    expect(checklistRef("my/list/item-1")).toEqual({ checklist: "my/list", item: "item-1" });
    expect(checklistRef(null)).toEqual({});
    expect(checklistRef("no-slash")).toEqual({});
    expect(checklistRef("trailing/")).toEqual({});
  });
});

describe("bugs", () => {
  test("the findings list leaves bugs out", () => {
    const bug = { url: "http://x", capture: null, shot: "none" as const, kind: "functional" as const, feature: null };
    const list = [f({ id: "b", lens: "bug", bug }), f({ id: "p", lens: "perf" })];
    expect(list.filter((x) => !isBug(x)).map((x) => x.id)).toEqual(["p"]);
  });
});

describe("one fix at a time", () => {
  const list = [f({ id: "a", title: "Alpha" }), f({ id: "b", title: "Beta", fixRunning: true, fixSession: "s_1" })];
  test("a running fix blocks every finding, naming it", () => {
    expect(fixBlock(list, "a")).toContain("Beta");
    expect(fixBlock(list, "a")).toContain("s_1");
    expect(fixBlock(list, "b")).toMatch(/still running/);
    expect(fixBlock([list[0]!], "a")).toBeNull();
  });
});

describe("the engine and model every Lab session starts with", () => {
  const mem = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: (k: string) => m.get(k) };
  };

  test("a choice is read from the shared key", () => {
    const s = mem({ [WHO_KEY]: JSON.stringify({ engine: "codex", model: "gpt-5" }) });
    expect(readWho(s)).toEqual({ engine: "codex", model: "gpt-5" });
  });

  test("the first read falls back to the old Lab key, then the shared key wins", () => {
    const s = mem({ [LEGACY_WHO_KEY]: JSON.stringify({ engine: "claude", model: "opus" }) });
    expect(readWho(s)).toEqual({ engine: "claude", model: "opus" });
    writeWho({ engine: "codex" }, s);
    expect(s.raw(WHO_KEY)).toBe(JSON.stringify({ engine: "codex" }));
    expect(readWho(s)).toEqual({ engine: "codex", model: undefined });
  });

  test("an explicit default is kept, not replaced by the old key", () => {
    const s = mem({ [LEGACY_WHO_KEY]: JSON.stringify({ engine: "claude" }), [WHO_KEY]: "{}" });
    expect(readWho(s)).toEqual({ engine: undefined, model: undefined });
  });

  test("junk, a missing store or a throwing store means the engine default", () => {
    expect(readWho(mem({ [WHO_KEY]: "not json" }))).toEqual({ engine: undefined, model: undefined });
    expect(readWho(mem({ [WHO_KEY]: JSON.stringify({ engine: 7 }) }))).toEqual({ engine: undefined, model: undefined });
    expect(readWho(null)).toEqual({ engine: undefined, model: undefined });
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readWho(bad)).toEqual({ engine: undefined, model: undefined });
    expect(() => writeWho({ engine: "claude" }, bad)).not.toThrow();
  });

  test("one write reaches every mounted picker and button", () => {
    const label = () => `${getWho().engine ?? ""}/${getWho().model ?? ""}`;
    const first: string[] = [];
    const second: string[] = [];
    const offFirst = subscribeWho(() => first.push(label()));
    const offSecond = subscribeWho(() => second.push(label()));
    setWho({ engine: "claude", model: "opus" });
    expect(first).toEqual(["claude/opus"]);
    expect(second).toEqual(["claude/opus"]);
    expect(getWho()).toEqual({ engine: "claude", model: "opus" });
    offFirst();
    setWho({ engine: "codex" });
    expect(first).toHaveLength(1);
    expect(second).toEqual(["claude/opus", "codex/"]);
    expect(getWho()).toEqual({ engine: "codex", model: undefined });
    offSecond();
  });

  test("spec, fix and design put the choice in the request body, not only run and sweep", () => {
    const who = { engine: "claude", model: "opus" };
    expect(findingActionRequest("w_1", "fix", { id: "f 1", ...who })).toEqual({ path: "/api/lab/w_1/findings/f%201/fix", body: who });
    expect(findingActionRequest("w_1", "spec", { id: "f1", ...who }).body).toEqual(who);
    expect(findingActionRequest("w_1", "design", { id: "f1", ...who }).body).toEqual(who);
  });
});
