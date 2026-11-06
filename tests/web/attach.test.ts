import { describe, expect, test } from "bun:test";
import { GROUPS, guessKind, isFreshness, KIND_LABEL, labelFor, summarize } from "../../web/src/features/attach/logic";

describe("the attach picker's logic", () => {
  test("a path's kind follows where it lives, as the daemon decides it", () => {
    expect(guessKind("specs/001-csv")).toBe("spec");
    expect(guessKind(".specify/memory/constitution.md")).toBe("spec");
    expect(guessKind("plans/2026-10-08-x.md")).toBe("plan");
    expect(guessKind("thinking/x.md", "thinking")).toBe("plan");
    expect(guessKind("plans/x.md", "thinking")).toBe("doc");
    expect(guessKind("docs/architecture.md")).toBe("doc");
    expect(guessKind("README.md")).toBe("doc");
  });

  test("labels prefer the title the daemon sent, then a readable form of the path", () => {
    const titles = new Map([["plans/a.md", "CSV export plan"]]);
    expect(labelFor("plans/a.md", "plan", titles)).toBe("CSV export plan");
    expect(labelFor("specs/001-orders-export", "spec", new Map())).toBe("001 orders-export");
    expect(labelFor(".specify/memory/constitution.md", "spec", new Map())).toBe("Constitution");
    expect(labelFor("docs/decisions/0001-use-sqlite.md", "doc", new Map())).toBe("0001-use-sqlite");
  });

  test("the summary counts each kind, defaulting a pending item's kind from its path", () => {
    expect(summarize([])).toEqual({ total: 0, byKind: { spec: 0, plan: 0, doc: 0 } });
    expect(summarize([{ path: "specs/001-x", mode: "ref" }, { path: "plans/a.md", mode: "inline", kind: "plan" }, { path: "docs/a.md", mode: "ref" }, { path: "docs/b.md", mode: "ref" }])).toEqual({ total: 4, byKind: { spec: 1, plan: 1, doc: 2 } });
  });

  test("the groups come in the order the prompt block uses", () => {
    expect(GROUPS.map((g) => g.kind)).toEqual(["spec", "plan", "doc"]);
    expect(GROUPS.map((g) => KIND_LABEL[g.kind])).toEqual(["Specs", "Plans", "Docs"]);
    expect(isFreshness("stale")).toBe(true);
    expect(isFreshness("approved")).toBe(false);
  });
});
