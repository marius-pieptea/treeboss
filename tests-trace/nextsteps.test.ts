import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START nextsteps\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END nextsteps\n"); });
import { describe, expect, test } from "bun:test";
import { extractNextSteps, wantsNextSteps } from "../src/sessions/nextsteps";

describe("extractNextSteps", () => {
  test("takes the lines out of the reply and keeps the rest", () => {
    const r = extractNextSteps("Done: added the route.\n\nNEXT: Add tests | Add tests for the new route\nNEXT: Update docs | Document the route in README");
    expect(r.text).toBe("Done: added the route.");
    expect(r.steps).toEqual([
      { label: "Add tests", prompt: "Add tests for the new route" },
      { label: "Update docs", prompt: "Document the route in README" },
    ]);
  });
  test("caps at three, drops repeats and malformed lines", () => {
    const r = extractNextSteps("ok\nNEXT: A | one\nNEXT: a | again\nNEXT: no bar here\nNEXT: B | two\nNEXT: C | three\nNEXT: D | four");
    expect(r.steps.map((s) => s.label)).toEqual(["A", "B", "C"]);
    expect(r.text).toBe("ok");
  });
  test("an opportunity is tagged, and only one is kept", () => {
    const r = extractNextSteps("ok\nNEXT: Add tests | Add tests\nNEXT[opp]: Batch queries | `listSessions` queries per row; batch it\nNEXT[opp]: Dedupe | two helpers do the same");
    expect(r.steps).toEqual([
      { label: "Add tests", prompt: "Add tests" },
      { label: "Batch queries", prompt: "`listSessions` queries per row; batch it", opp: true },
    ]);
    expect(r.text).toBe("ok");
  });
  test("text without the marker is untouched", () => {
    expect(extractNextSteps("plain\nreply").text).toBe("plain\nreply");
    expect(extractNextSteps(null)).toEqual({ text: "", steps: [] });
  });
});

describe("wantsNextSteps", () => {
  const base = { depth: 0, mode: "build", slash: false, prompt: "fix it", enabled: true };
  test("lead build turns only", () => {
    expect(wantsNextSteps(base)).toBe(true);
    expect(wantsNextSteps({ ...base, mode: "plan" })).toBe(false);
    expect(wantsNextSteps({ ...base, mode: "ask" })).toBe(false);
    expect(wantsNextSteps({ ...base, depth: 1 })).toBe(false);
    expect(wantsNextSteps({ ...base, slash: true })).toBe(false);
    expect(wantsNextSteps({ ...base, enabled: false })).toBe(false);
    expect(wantsNextSteps({ ...base, prompt: "end with DOCS_TOUCHED: x" })).toBe(false);
  });
});
