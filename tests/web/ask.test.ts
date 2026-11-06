import { describe, expect, test } from "bun:test";
import { askTurnsById, costLine, followUpsFor, lastTextByTurn, usageTotals } from "../../web/src/features/agent/ask-logic";
import { deriveChat } from "../../web/src/features/agent/chat-logic";
import type { TurnRow } from "../../web/src/lib/types";

const turn = (over: Partial<TurnRow> & { id: string; seq: number }): TurnRow => ({ status: "completed", started_at: "", finished_at: "", cost_usd: 0.0021, prompt: "q", output: "a", mode: "ask", usage_json: null, ...over });

describe("usage and cost lines", () => {
  test("usage sums input, both cache kinds and output; junk and empty give null", () => {
    expect(usageTotals(JSON.stringify({ input_tokens: 10, cache_read_input_tokens: 7000, cache_creation_input_tokens: 200, output_tokens: 310 }))).toEqual({ input: 7210, output: 310 });
    expect(usageTotals(JSON.stringify({ input_tokens: 5, cached_input_tokens: 95, output_tokens: 1 }))).toEqual({ input: 100, output: 1 });
    expect(usageTotals(JSON.stringify({ inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, totalCostUsd: 0.001 }))).toEqual({ input: 110, output: 20 }); // what the daemon stores
    expect(usageTotals("not json")).toBeNull();
    expect(usageTotals(JSON.stringify({}))).toBeNull();
    expect(usageTotals(null)).toBeNull();
  });
  test("the cost line shows what the turn reported and nothing it did not", () => {
    const usage = JSON.stringify({ input_tokens: 10, cache_read_input_tokens: 7190, output_tokens: 310 });
    expect(costLine({ cost_usd: 0.0021, usage_json: usage })).toBe("$0.0021 · 7.2k in · 310 out");
    expect(costLine({ cost_usd: 0.12, usage_json: null })).toBe("$0.12");
    expect(costLine({ cost_usd: null, usage_json: usage })).toBe("7.2k in · 310 out");
    expect(costLine({ cost_usd: null, usage_json: null })).toBe("");
  });
});

describe("which answer gets what", () => {
  const turns = [turn({ id: "t1", seq: 1 }), turn({ id: "t2", seq: 2, mode: "build" }), turn({ id: "t3", seq: 3 }), turn({ id: "t4", seq: 4, status: "running" })];
  test("only finished ask turns have a footer", () => {
    expect([...askTurnsById(turns).keys()]).toEqual(["t1", "t3"]);
    expect(askTurnsById(undefined).size).toBe(0);
  });
  test("the follow-ups go only on the newest finished ask answer, and only when idle", () => {
    const asks = askTurnsById(turns);
    expect(followUpsFor("t3", asks, true)).toBe(true);
    expect(followUpsFor("t1", asks, true)).toBe(false);
    expect(followUpsFor("t3", asks, false)).toBe(false);
  });
  test("the footer sits under the last text of a turn", () => {
    const items = [
      { kind: "text", id: "a", turnId: "t1" },
      { kind: "tools", id: "b" },
      { kind: "text", id: "c", turnId: "t1" },
      { kind: "text", id: "d", turnId: "t3" },
      { kind: "text", id: "e", turnId: null },
    ];
    expect([...lastTextByTurn(items).entries()]).toEqual([["t1", "c"], ["t3", "d"]]);
  });
  test("chat text items carry the turn they came from", () => {
    const chat = deriveChat([{ type: "text", id: "x1", session: "s1", turnId: "t9", text: "hello" }] as any, "s1");
    expect(chat[0]).toMatchObject({ kind: "text", text: "hello", turnId: "t9" });
  });
});
