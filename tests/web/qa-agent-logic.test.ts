import { describe, expect, test } from "bun:test";
import type { Finding } from "../../web/src/features/lab/data";
import { fixableBugs, unconfirmed } from "../../web/src/features/lab/logic";
import { agentRequest, batchLine, e2ePlansOf, newPlanBody, sessionLabel, sortFeatures } from "../../web/src/features/qa/logic";

const bug = (id: string, extra: Partial<NonNullable<Finding["bug"]>> = {}): Finding => ({ id, path: `lab/findings/${id}.md`, title: id, lens: "bug", scope: null, impact: "medium", effort: "s", status: "new", evidence: [], missing: [], unmeasured: false, roadmap: null, spec: null, checklist: null, bug: { url: "http://x", capture: null, shot: "agent", kind: "functional", ...extra }, session: null, fixSession: null, fixRunning: false, drifted: [], summary: "", body: "", updatedAt: 0, problem: null });

describe("agent-found bugs in the Bugs view", () => {
  test("an agent's bug is unconfirmed until confirmed, and fix-all skips it", () => {
    const list = [bug("person"), bug("agent-new", { by: "agent", confirmed: false }), bug("agent-ok", { by: "agent", confirmed: true })];
    expect(list.map(unconfirmed)).toEqual([false, true, false]);
    expect(fixableBugs(list).map((f) => f.id)).toEqual(["person", "agent-ok"]);
  });
});

describe("QA agent helpers", () => {
  test("session labels name each kind, only while running", () => {
    expect(sessionLabel({ kind: "run", running: true })).toBe("Agent running…");
    expect(sessionLabel({ kind: "explore", running: true })).toBe("Exploring…");
    expect(sessionLabel({ kind: "map", running: false })).toBeNull();
    expect(sessionLabel(null)).toBeNull();
  });

  test("features sort worst first, keeping the map's order among equals", () => {
    const fs = [{ id: "a", coverage: "passing" as const }, { id: "b", coverage: "no-plan" as const }, { id: "c", coverage: "failing" as const }, { id: "d", coverage: "no-plan" as const }];
    expect(sortFeatures(fs).map((f) => f.id)).toEqual(["c", "b", "d", "a"]);
  });

  test("an end-to-end run covers each existing plan with steps once", () => {
    const p = (slug: string, exists = true, steps = 2) => ({ slug, exists, steps });
    expect(e2ePlansOf([{ planInfo: [p("a"), p("gone", false), p("empty", true, 0)] }, { planInfo: [p("a"), p("b")] }])).toEqual(["a", "b"]);
  });

  test("the batch line says where a run is, or how it ended", () => {
    const b = { plans: ["a", "b", "c"], next: 2, current: "b", running: true, cancelled: false, errors: [] as Array<{ plan: string; error: string }> };
    expect(batchLine(b)).toBe("2 of 3 plans · now: b");
    expect(batchLine({ ...b, running: false, current: null, next: 3, errors: [{ plan: "c", error: "no steps" }] })).toBe("Ran 2 of 3 plans · 1 could not start");
    expect(batchLine({ ...b, running: false, current: null, cancelled: true })).toBe("Cancelled after 2 of 3 plans");
  });
});

describe("QA agent requests carry the chosen engine and model", () => {
  const WHO = { engine: "claude", model: "claude-opus-5" };

  test("every agent start sends the engine and model in its body", () => {
    const starts = [
      agentRequest("w_1", { kind: "map", note: "focus", baseUrl: "http://localhost:3000", ...WHO }),
      agentRequest("w_1", { kind: "e2e", plans: ["checkout"], ...WHO }),
      agentRequest("w_1", { kind: "feature-plan", id: "invite", ...WHO }),
      agentRequest("w_1", { kind: "run", slug: "checkout", ...WHO }),
      agentRequest("w_1", { kind: "explore", slug: "checkout", ...WHO }),
      agentRequest("w_1", { kind: "suggest", slug: "checkout", focus: ["errors" as const], note: "", ...WHO }),
    ];
    for (const r of starts) expect(r.body).toMatchObject(WHO);
    expect(starts.map((r) => r.path)).toEqual([
      "/api/qa/w_1/features/map",
      "/api/qa/w_1/e2e",
      "/api/qa/w_1/features/invite/plan",
      "/api/qa/w_1/plans/checkout/runs",
      "/api/qa/w_1/plans/checkout/explore",
      "/api/qa/w_1/plans/checkout/suggest",
    ]);
    expect(starts[3]!.body.agent).toBe(true);
    expect(starts[4]!.body.note).toBeUndefined();
  });

  test("a new plan sends the engine and model only when an agent starts on it", () => {
    expect(newPlanBody({ title: "Cart", ...WHO })).toEqual({ title: "Cart" });
    expect(newPlanBody({ title: "Cart", from: { kind: "manual" }, ...WHO })).toEqual({ title: "Cart", from: { kind: "manual" } });
    expect(newPlanBody({ title: "Cart", from: { kind: "spec", dir: "specs/001" }, note: "pay", ...WHO })).toEqual({ title: "Cart", from: { kind: "spec", dir: "specs/001" }, note: "pay", ...WHO });
    expect(newPlanBody({ title: "Cart", explore: true, note: "try coupons", ...WHO })).toEqual({ title: "Cart", explore: true, note: "try coupons", ...WHO });
  });
});
