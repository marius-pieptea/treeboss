import { describe, expect, test } from "bun:test";
import { checkLabel, draftFromGoal, draftProblems, emptyDraft, goalKey, goalPayload, goalProgress, goalStatusLabel, goalTone } from "../../web/src/features/agent/goal-logic";
import type { GoalView } from "../../web/src/lib/types";

const goal = (over: Partial<GoalView> = {}): GoalView => ({ session_id: "s_1", text: "ship it", check_cmd: "bun test", max_turns: 12, max_minutes: 60, status: "active", turns_used: 3, started_at: "2026-10-08T10:00:00Z", ended_at: null, last_check_exit: 1, last_check_output: "1 fail", last_note: null, ...over });

describe("goal dialog", () => {
  test("the empty draft is the daemon's defaults and is not yet valid", () => {
    expect(emptyDraft()).toEqual({ text: "", check: "", maxTurns: 12, maxMinutes: 60 });
    expect(draftProblems(emptyDraft()).text).toBeTruthy();
  });

  test("limits match the daemon's", () => {
    const ok = { text: "x", check: "", maxTurns: 12, maxMinutes: 60 };
    expect(draftProblems(ok)).toEqual({});
    expect(draftProblems({ ...ok, maxTurns: 0 }).maxTurns).toBeTruthy();
    expect(draftProblems({ ...ok, maxTurns: 101 }).maxTurns).toBeTruthy();
    expect(draftProblems({ ...ok, maxMinutes: 721 }).maxMinutes).toBeTruthy();
    expect(draftProblems({ ...ok, maxTurns: 2.5 }).maxTurns).toBeTruthy();
    expect(draftProblems({ ...ok, maxTurns: NaN }).maxTurns).toBeTruthy();
    expect(draftProblems({ ...ok, text: "x".repeat(8001) }).text).toBeTruthy();
  });

  test("the payload trims, and leaves the check out when blank", () => {
    expect(goalPayload({ text: "  done  ", check: "  ", maxTurns: 5, maxMinutes: 30 })).toEqual({ text: "done", max_turns: 5, max_minutes: 30 });
    expect(goalPayload({ text: "d", check: " bun test ", maxTurns: 5, maxMinutes: 30 })).toEqual({ text: "d", check: "bun test", max_turns: 5, max_minutes: 30 });
  });

  test("editing starts from the goal that is there", () => {
    expect(draftFromGoal(goal({ check_cmd: null }))).toEqual({ text: "ship it", check: "", maxTurns: 12, maxMinutes: 60 });
  });
});

describe("goal bar", () => {
  test("progress is turns over budget, held to 0..1", () => {
    expect(goalProgress({ turns_used: 3, max_turns: 12 })).toBe(0.25);
    expect(goalProgress({ turns_used: 20, max_turns: 12 })).toBe(1);
    expect(goalProgress({ turns_used: 0, max_turns: 0 })).toBe(0);
  });

  test("each outcome has its own tone and words", () => {
    expect(goalTone("active")).toBe("accent");
    expect(goalTone("met")).toBe("green");
    expect(goalTone("stalled")).toBe("amber");
    expect(goalTone("exhausted")).toBe("amber");
    expect(goalTone("stopped")).toBe("neutral");
    expect(goalStatusLabel("exhausted")).toBe("budget spent");
    expect(goalStatusLabel("met")).toBe("goal met");
  });

  test("the last check in a phrase, or nothing before it has run", () => {
    expect(checkLabel(goal({ last_check_exit: 0 }))).toEqual({ text: "check passed", ok: true });
    expect(checkLabel(goal({ last_check_exit: 2 }))).toEqual({ text: "check failed (exit 2)", ok: false });
    expect(checkLabel(goal({ last_check_exit: 124 }))?.text).toBe("check timed out");
    expect(checkLabel(goal({ last_check_exit: null }))).toBeNull();
    expect(checkLabel(goal({ check_cmd: null, last_check_exit: null }))).toBeNull();
  });

  test("a new goal on the same session is not the dismissed one", () => {
    expect(goalKey(goal())).not.toBe(goalKey(goal({ started_at: "2026-10-08T11:00:00Z" })));
  });
});
