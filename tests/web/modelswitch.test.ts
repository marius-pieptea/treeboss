import { describe, expect, test } from "bun:test";
import { CONFIRM_TOKENS, compactTokens, modelChipState, modelChipTitle, needsConfirm, uncachedNote } from "../../web/src/features/agent/model-switch-logic";

const s = (over: Record<string, unknown> = {}) => ({ status: "idle", model_lock: null, turns: 3, context: { tokens: 12_000 }, ...over }) as any;

describe("the model chip of an existing session", () => {
  test("idle and free: switchable", () => expect(modelChipState(s())).toEqual({ kind: "switchable" }));
  test("a running turn: busy, not locked", () => expect(modelChipState(s({ status: "running" }))).toEqual({ kind: "busy" }));
  test("a lock wins over running, and carries its reason", () => {
    expect(modelChipState(s({ status: "running", model_lock: "Set by the pair" }))).toEqual({ kind: "busy" });
    expect(modelChipState(s({ model_lock: "Set by the pair" }))).toEqual({ kind: "pair" });
    expect(modelChipState(s({ model_lock: "This engine keeps its model for the whole session" }))).toEqual({ kind: "locked", reason: "This engine keeps its model for the whole session" });
  });
  test("tooltips say why, and always point to a new session for the engine", () => {
    expect(modelChipTitle({ kind: "pair" }, false)).toContain("detach");
    expect(modelChipTitle({ kind: "locked", reason: "This engine keeps its model for the whole session" }, false)).toContain("new session");
    expect(modelChipTitle({ kind: "busy" }, false)).toContain("between turns");
    expect(modelChipTitle({ kind: "switchable" }, true)).toContain("applies to the next turn");
    expect(modelChipTitle({ kind: "switchable" }, false)).toContain("new session to change the engine");
  });
});

describe("the uncached-cache warning", () => {
  test("only a big conversation asks first", () => {
    expect(needsConfirm(s({ context: { tokens: CONFIRM_TOKENS } }), true)).toBe(false);
    expect(needsConfirm(s({ context: { tokens: CONFIRM_TOKENS + 1 } }), true)).toBe(true);
    expect(needsConfirm(s({ context: { tokens: 90_000 } }), false)).toBe(false);
    expect(needsConfirm(s({ turns: 0, context: { tokens: 90_000 } }), true)).toBe(false);
    expect(needsConfirm(s({ context: null }), true)).toBe(false);
  });
  test("the note names the size when known, and is absent before the first turn", () => {
    expect(uncachedNote(s({ context: { tokens: 84_200 } }))).toBe("Next turn re-reads the conversation without cache (~84k tokens): costs more once.");
    expect(uncachedNote(s({ context: null }))).toBe("Next turn re-reads the conversation without cache: costs more once.");
    expect(uncachedNote(s({ context: { tokens: 115 } }))).toBe("Next turn re-reads the conversation without cache: costs more once.");
    expect(uncachedNote(s({ turns: 0 }))).toBeNull();
  });
  test("compact token labels", () => {
    expect(compactTokens(950)).toBe("950");
    expect(compactTokens(84_200)).toBe("84k");
  });
});
