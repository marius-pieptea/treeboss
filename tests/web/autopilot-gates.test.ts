import { describe, expect, test } from "bun:test";
import { gatedRuns } from "../../web/src/features/autopilot/logic";
import type { RunStatus } from "../../web/src/features/autopilot/data";

const run = (id: string, status: RunStatus, gate: unknown = null) => ({ id, status, gate });

describe("gatedRuns", () => {
  test("keeps every run that awaits approval with a gate, in order", () => {
    const list = [run("a", "awaiting_approval", { text: "x" }), run("b", "running"), run("c", "awaiting_approval", { text: "y" })];
    expect(gatedRuns(list).map((r) => r.id)).toEqual(["a", "c"]);
  });
  test("drops an awaiting run that has no gate and a gate on a run that moved on", () => {
    expect(gatedRuns([run("a", "awaiting_approval"), run("b", "done", { text: "old" })])).toEqual([]);
  });
});
