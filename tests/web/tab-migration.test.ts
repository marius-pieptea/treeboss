import { describe, expect, test } from "bun:test";
import { migrateSavedTabs, migrateSavedWs } from "../../web/src/lib/tab-migration";

describe("saved tabs from before the checklists moved to Lab", () => {
  test("a factory tab on the removed checklists page lands on Portfolio", () => {
    const saved = [{ id: "factory", kind: "factory", page: "checklists", title: "Factory" }];
    expect(migrateSavedTabs(saved)).toEqual([{ id: "factory", kind: "factory", page: "portfolio", title: "Factory" }]);
  });

  test("other factory pages and their tabs pass through unchanged", () => {
    const saved = [
      { id: "factory", kind: "factory", page: "ship", title: "Factory" },
      { id: "file:w_1:a.ts", kind: "file", path: "a.ts" },
    ];
    expect(migrateSavedTabs(saved)).toEqual(saved);
  });

  test("a settings page named checklists is not a factory page and is kept", () => {
    const saved = [{ id: "settings", kind: "settings", page: "checklists", title: "Settings" }];
    expect(migrateSavedTabs(saved)).toEqual(saved);
  });

  test("the input is not mutated", () => {
    const saved = [{ id: "factory", kind: "factory", page: "checklists" }];
    migrateSavedTabs(saved);
    expect(saved[0]!.page).toBe("checklists");
  });
});

describe("saved Lab tab from before Findings and Checklists became views", () => {
  test("a lab tab becomes the Findings tab", () => {
    const saved = [{ id: "lab", kind: "lab", title: "Lab" }];
    expect(migrateSavedTabs(saved)).toEqual([{ id: "findings", kind: "findings", title: "Findings" }]);
  });

  test("the workspace's active tab and history follow the renamed id", () => {
    const ws = { tabs: [{ id: "lab", kind: "lab", title: "Lab" }, { id: "roadmap", kind: "roadmap", title: "Roadmap" }], activeTab: "lab", history: ["roadmap", "lab"], expanded: [] };
    expect(migrateSavedWs(ws)).toEqual({ tabs: [{ id: "findings", kind: "findings", title: "Findings" }, { id: "roadmap", kind: "roadmap", title: "Roadmap" }], activeTab: "findings", history: ["roadmap", "findings"], expanded: [] });
  });

  test("a workspace with no lab tab is unchanged", () => {
    const ws = { tabs: [{ id: "roadmap", kind: "roadmap", title: "Roadmap" }], activeTab: "roadmap", history: ["roadmap"] };
    expect(migrateSavedWs(ws)).toEqual(ws);
  });

  test("a state that already has a Findings tab keeps one", () => {
    const ws = { tabs: [{ id: "findings", kind: "findings", title: "Findings" }, { id: "lab", kind: "lab", title: "Lab" }], activeTab: "lab", history: ["lab", "findings"] };
    const out = migrateSavedWs(ws);
    expect(out.tabs.map((t) => t.id)).toEqual(["findings"]);
    expect(out.history).toEqual(["findings"]);
    expect(out.activeTab).toBe("findings");
  });
});

describe("saved Bugs tab from before Bugs became part of QA", () => {
  const qa = { id: "qa", kind: "qa", title: "QA" };

  test("a bugs tab becomes the QA tab", () => {
    expect(migrateSavedTabs([{ id: "bugs", kind: "bugs", title: "Bugs" }])).toEqual([qa]);
  });

  test("the workspace's active tab and history follow the renamed id", () => {
    const ws = { tabs: [{ id: "roadmap", kind: "roadmap", title: "Roadmap" }, { id: "bugs", kind: "bugs", title: "Bugs" }], activeTab: "bugs", history: ["bugs", "roadmap"] };
    expect(migrateSavedWs(ws)).toEqual({ tabs: [{ id: "roadmap", kind: "roadmap", title: "Roadmap" }, qa], activeTab: "qa", history: ["qa", "roadmap"] });
  });

  test("a state with both a QA and a Bugs tab keeps one QA tab, whichever came first", () => {
    for (const tabs of [[qa, { id: "bugs", kind: "bugs", title: "Bugs" }], [{ id: "bugs", kind: "bugs", title: "Bugs" }, qa]]) {
      const out = migrateSavedWs({ tabs, activeTab: "bugs", history: ["bugs", "qa", "roadmap"] });
      expect(out.tabs).toEqual([qa]);
      expect(out.activeTab).toBe("qa");
      expect(out.history).toEqual(["qa", "roadmap"]);
    }
  });

  test("a state that already has a QA tab and no Bugs tab is unchanged", () => {
    const ws = { tabs: [qa], activeTab: "qa", history: ["qa"] };
    expect(migrateSavedWs(ws)).toEqual(ws);
  });
});
