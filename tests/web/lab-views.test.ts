import { describe, expect, test } from "bun:test";
import { takePendingBugs, takePendingChecklists, takePendingFindings, viewTab, stashBugs, stashChecklists, stashFindings } from "../../web/src/features/lab/views";

describe("which tab each Lab view opens", () => {
  test("each view has its own tab kind and title", () => {
    expect(viewTab("findings")).toEqual({ kind: "findings", title: "Findings" });
    expect(viewTab("bugs")).toEqual({ kind: "bugs", title: "Bugs" });
    expect(viewTab("checklists")).toEqual({ kind: "checklists", title: "Checklists" });
    expect(viewTab("qa")).toEqual({ kind: "qa", title: "QA" });
  });
});

describe("an intent waiting for a view that is not mounted yet", () => {
  test("a findings intent is taken once, by the findings view only", () => {
    stashFindings({ lens: "security", sweep: true });
    expect(takePendingChecklists()).toBeNull();
    expect(takePendingFindings()).toEqual({ lens: "security", sweep: true });
    expect(takePendingFindings()).toBeNull();
  });

  test("a checklists intent is taken once, by the checklists view only", () => {
    stashChecklists({ checklist: "launch", item: "https" });
    expect(takePendingFindings()).toBeNull();
    expect(takePendingChecklists()).toEqual({ checklist: "launch", item: "https" });
    expect(takePendingChecklists()).toBeNull();
  });

  test("a later intent replaces an earlier one that was never taken", () => {
    stashFindings({ lens: "ui" });
    stashFindings({ finding: "f1" });
    expect(takePendingFindings()).toEqual({ finding: "f1" });
  });
});

describe("a bug to show in Bugs", () => {
  test("the bugs intent is taken once, by the bugs view only", () => {
    stashBugs({ finding: "b1" });
    expect(takePendingFindings()).toBeNull();
    expect(takePendingBugs()).toEqual({ finding: "b1" });
    expect(takePendingBugs()).toBeNull();
  });
});
