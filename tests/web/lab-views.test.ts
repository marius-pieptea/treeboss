import { describe, expect, test } from "bun:test";
import { takePendingChecklists, takePendingFindings, viewTab, stashChecklists, stashFindings } from "../../web/src/features/lab/views";

describe("which tab each Lab view opens", () => {
  test("each view has its own tab kind and title", () => {
    expect(viewTab("findings")).toEqual({ kind: "findings", title: "Findings" });
    expect(viewTab("checklists")).toEqual({ kind: "checklists", title: "Checklists" });
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
