import { describe, expect, test } from "bun:test";
import type { Finding } from "../../web/src/features/lab/data";
import { type BugKind, applyFilter, bugState, byKind, kindCounts, checklistRef, fixableBugs, fixBlock, hasScreenshot, isBug, countByStatus, inFilter, NO_FILTER, splitEvidence, tokensLabel } from "../../web/src/features/lab/logic";

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
  test("bugState reads the status and whether the fix is running", () => {
    expect(bugState({ status: "new" }, false)).toBe("open");
    expect(bugState({ status: "accepted" }, true)).toBe("fixing");
    expect(bugState({ status: "accepted" }, false)).toBe("needs-check");
    expect(bugState({ status: "shipped" }, false)).toBe("fixed");
    expect(bugState({ status: "dismissed" }, false)).toBe("dismissed");
  });
  test("fix all counts open and needs-check bugs only", () => {
    const bug = { url: "http://x", capture: null, shot: "none" as const, kind: "functional" as const };
    const list = [
      f({ id: "o", lens: "bug", bug }),
      f({ id: "n", lens: "bug", bug, status: "accepted" }),
      f({ id: "r", lens: "bug", bug, status: "accepted", fixRunning: true }),
      f({ id: "s", lens: "bug", bug, status: "shipped" }),
      f({ id: "p", lens: "perf" }),
    ];
    expect(fixableBugs(list).map((x) => x.id)).toEqual(["o", "n"]);
    expect(list.filter((x) => !isBug(x))).toHaveLength(1);
  });
});

describe("one fix at a time, and the screenshot thumbnail", () => {
  const list = [f({ id: "a", title: "Alpha" }), f({ id: "b", title: "Beta", fixRunning: true, fixSession: "s_1" })];
  test("a running fix blocks every finding, naming it", () => {
    expect(fixBlock(list, "a")).toContain("Beta");
    expect(fixBlock(list, "a")).toContain("s_1");
    expect(fixBlock(list, "b")).toMatch(/still running/);
    expect(fixBlock([list[0]!], "a")).toBeNull();
  });
  test("a thumbnail needs a capture and a screenshot", () => {
    const b = (shot: "desktop" | "rerender" | "none", capture: string | null) => f({ id: "x", lens: "bug", bug: { url: "http://x", capture, shot, kind: "functional" } });
    expect(hasScreenshot(b("desktop", "ev_1"))).toBe(true);
    expect(hasScreenshot(b("rerender", "ev_1"))).toBe(true);
    expect(hasScreenshot(b("none", "ev_1"))).toBe(false);
    expect(hasScreenshot(b("desktop", null))).toBe(false);
  });
});

describe("bug kinds", () => {
  const b = (id: string, kind: BugKind, status: Finding["status"] = "new") => f({ id, lens: "bug", status, bug: { url: "http://x", capture: null, shot: "none", kind } });
  const list = [b("a", "visual"), b("b", "visual", "shipped"), b("c", "logic"), b("d", "performance")];
  test("counts per kind include every bug, whatever its status, and all", () => {
    expect(kindCounts(list)).toEqual({ all: 4, functional: 0, visual: 2, logic: 1, content: 0, performance: 1 });
    expect(kindCounts([])).toEqual({ all: 0, functional: 0, visual: 0, logic: 0, content: 0, performance: 0 });
  });
  test("a kind narrows the list and all keeps it", () => {
    expect(byKind(list, "visual").map((x) => x.id)).toEqual(["a", "b"]);
    expect(byKind(list, "content")).toEqual([]);
    expect(byKind(list, "all")).toHaveLength(4);
  });
});
