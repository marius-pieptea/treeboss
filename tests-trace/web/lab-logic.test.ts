import { describe, expect, test } from "bun:test";
import type { Finding } from "../../web/src/features/lab/data";
import { applyFilter, countByStatus, inFilter, NO_FILTER, splitEvidence, tokensLabel } from "../../web/src/features/lab/logic";

const f = (over: Partial<Finding> & { id: string }): Finding => ({ path: `lab/findings/${over.id}.md`, title: over.id, lens: "perf", scope: null, impact: "medium", effort: "m", status: "new", evidence: [], missing: [], unmeasured: false, roadmap: null, spec: null, summary: "", body: "", updatedAt: 0, problem: null, ...over });

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
});
