import { describe, expect, test } from "bun:test";
import { goalSlot, isModeShortcut, modeView, nextMode, planReady, showMeterLabel, slotKind, type SlotInputs } from "../../web/src/features/agent/slot-logic";
import type { PlanRecord } from "../../web/src/lib/types";

const none: SlotInputs = { question: false, plan: false, goal: null, shelf: false };
const plan = (over: Partial<PlanRecord> = {}): PlanRecord => ({ id: "p_1", title: "Add a cache", version: 1, status: "draft", depth: "quick", path: "plans/x.md", edited: false, ...over }) as PlanRecord;

describe("status slot: one item, by urgency", () => {
  // question > plan > goal (working) > shelf > goal (finished)
  const cases: Array<[string, Partial<SlotInputs>, ReturnType<typeof slotKind>]> = [
    ["nothing", {}, "none"],
    ["only the heads", { shelf: true }, "shelf"],
    ["a working goal beats the heads", { goal: "active", shelf: true }, "goal"],
    ["a finished goal yields to the heads", { goal: "finished", shelf: true }, "shelf"],
    ["a finished goal alone still shows", { goal: "finished" }, "goal"],
    ["a plan beats a goal and the heads", { plan: true, goal: "active", shelf: true }, "plan"],
    ["a question beats everything", { question: true, plan: true, goal: "active", shelf: true }, "question"],
    ["a question alone", { question: true }, "question"],
    ["a question over a plan", { question: true, plan: true }, "question"],
  ];
  for (const [name, over, want] of cases) test(name, () => expect(slotKind({ ...none, ...over })).toBe(want));

  test("a dismissed finished goal is gone; a working one cannot be dismissed", () => {
    expect(goalSlot("active", false)).toBe("active");
    expect(goalSlot("active", true)).toBe("active");
    for (const s of ["met", "stopped", "stalled", "exhausted"] as const) {
      expect(goalSlot(s, false)).toBe("finished");
      expect(goalSlot(s, true)).toBeNull();
    }
    expect(goalSlot(undefined, false)).toBeNull();
  });
});

describe("plan ready means a written draft plan", () => {
  test("no plan record: not ready, whatever the session did (the old banner said ready here)", () => {
    expect(planReady(undefined, "idle")).toBeNull();
    expect(planReady({ plan: null }, "idle")).toBeNull();
  });
  test("a draft is ready once the turn is over", () => {
    expect(planReady({ plan: plan() }, "idle")?.id).toBe("p_1");
    expect(planReady({ plan: plan() }, "failed")?.id).toBe("p_1");
  });
  test("not while the agent is still wrapping up, and not for a closed session", () => {
    expect(planReady({ plan: plan() }, "running")).toBeNull();
    expect(planReady({ plan: plan() }, "closed")).toBeNull();
  });
  test("decided plans are not ready", () => {
    for (const status of ["approved", "rejected", "superseded"] as const) expect(planReady({ plan: plan({ status }) }, "idle")).toBeNull();
  });
});

describe("Build | Plan", () => {
  test("the placeholder follows the mode and whether a session exists", () => {
    expect(modeView("plan", "quick").placeholder(false)).toBe("Describe what to plan…");
    expect(modeView("plan", "quick").placeholder(true)).toMatch(/plan/i);
    expect(modeView("build", "quick").placeholder(false)).toMatch(/what you want done/);
    expect(modeView("build", "spec").placeholder(true)).toMatch(/Follow up/);
  });
  test("the depth is in the tooltip, so the control's width never depends on it", () => {
    expect(modeView("plan", "spec").planTitle).toMatch(/Spec it/);
    expect(modeView("plan", "quick").planTitle).toMatch(/Quick plan/);
    expect(modeView("build", "spec").planTitle).toMatch(/Plan first/);
  });
  test("Alt+P cycles Build → Plan → Ask → Build", () => {
    expect(nextMode("build")).toBe("plan");
    expect(nextMode("plan")).toBe("ask");
    expect(nextMode("ask")).toBe("build");
    const seen = new Set(["build", "plan", "ask"].map((m) => nextMode(m as any)));
    expect(seen.size).toBe(3); // a permutation: every mode is reachable, none is skipped
  });
  test("ask asks about the project, and says what it is in its tooltip", () => {
    expect(modeView("ask", "quick").placeholder(false)).toBe("Ask about this project…");
    expect(modeView("ask", "quick").placeholder(true)).toBe("Ask a follow-up…");
    expect(modeView("ask", "quick").askTitle).toMatch(/read-only/);
    expect(modeView("ask", "spec").placeholder(false)).toBe("Ask about this project…"); // depth never leaks into ask
    expect(modeView("build", "quick").askTitle).toMatch(/quick question/i);
  });
  test("Alt+P flips the mode; Shift+Tab and plain P do not", () => {
    const e = { altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, code: "KeyP" };
    expect(isModeShortcut(e)).toBe(true);
    expect(isModeShortcut({ ...e, altKey: false })).toBe(false);
    expect(isModeShortcut({ ...e, shiftKey: true })).toBe(false);
    expect(isModeShortcut({ ...e, metaKey: true })).toBe(false);
    expect(isModeShortcut({ ...e, code: "Tab" })).toBe(false);
  });
});

describe("context ring label", () => {
  test("a number from half full, only the ring below", () => {
    expect(showMeterLabel(0.49)).toBe(false);
    expect(showMeterLabel(0.5)).toBe(true);
    expect(showMeterLabel(0.95)).toBe(true);
  });
});
