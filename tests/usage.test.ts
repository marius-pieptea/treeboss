import { afterEach, describe, expect, test } from "bun:test";
import { classifyLine } from "../src/engines/classify";
import { canCompact, compactLine, contextWindow, formatTokens, parseCompactLine, type UsageEvent } from "../src/engines/context";
import { createStreamAccumulator } from "../src/engines/stream";
import { createLead, getSession, readLog, send, viewSession } from "../src/sessions/manager";
import { contextOf } from "../src/sessions/usage";
import { db } from "../src/db";
import { setSetting, resetSetting } from "../src/settings";
import { makeDir, resetState, settled } from "./helpers";

const run = (events: unknown[], label = "claude") => {
  const lines: string[] = [];
  const usage: UsageEvent[] = [];
  const acc = createStreamAccumulator((l) => lines.push(l), undefined, label, { onUsage: (e) => usage.push(e) });
  acc.push(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  acc.end();
  return { acc, lines, usage };
};
const msg = (id: string, u: Record<string, number>, extra: Record<string, unknown> = {}) => ({ type: "assistant", message: { id, model: "m", content: [], usage: u }, ...extra });

describe("context size from a claude stream", () => {
  test("is the LAST message's input + cache + output, not a sum over messages", () => {
    const { acc, usage } = run([
      msg("a", { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 }),
      msg("b", { input_tokens: 6, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300, output_tokens: 80 }),
    ]);
    expect(acc.context()).toMatchObject({ tokens: 6 + 1200 + 300 + 80, input: 6, cacheRead: 1200, cacheCreation: 300, output: 80 });
    expect(usage.filter((e) => e.kind === "context")).toHaveLength(2);
  });

  test("ignores a subagent's sidechain messages", () => {
    const { acc } = run([msg("a", { input_tokens: 100, output_tokens: 10 }), msg("side", { input_tokens: 90_000, output_tokens: 10 }, { parent_tool_use_id: "tu1" })]);
    expect(acc.context()!.tokens).toBe(110);
  });

  test("reports nothing when the engine reports nothing", () => {
    const { acc, usage } = run([{ type: "assistant", message: { id: "a", content: [{ type: "text", text: "hi" }] } }]);
    expect(acc.context()).toBeNull();
    expect(usage).toEqual([]);
  });

  test("takes the real window from the result's modelUsage", () => {
    const { acc, usage } = run([
      msg("a", { input_tokens: 10, output_tokens: 5 }),
      { type: "result", is_error: false, result: "ok", usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { "claude-opus": { contextWindow: 1_000_000 } } },
    ]);
    expect(acc.context()!.window).toBe(1_000_000);
    expect(usage.at(-1)).toMatchObject({ kind: "context", sample: { window: 1_000_000 } });
  });
});

describe("compaction", () => {
  const boundary = { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 168_000 } };

  test("becomes a typed line with before and after, and a compact event", () => {
    const { lines, usage } = run([msg("a", { input_tokens: 100_000, output_tokens: 10 }), boundary, msg("b", { input_tokens: 5, cache_read_input_tokens: 23_995, output_tokens: 0 })]);
    expect(lines).toContain("[claude] Context compacted: 168k → 24k");
    expect(usage.find((e) => e.kind === "compact")).toEqual({ kind: "compact", from: 168_000, to: 24_000, trigger: "auto" });
  });

  test("the line classifies as info with the numbers attached", () => {
    expect(classifyLine("[claude] Context compacted: 168k → 24k")).toMatchObject({ kind: "info", compact: { from: 168_000, to: 24_000 } });
    expect(classifyLine("[claude] done after 1 turn(s)").compact).toBeUndefined();
  });

  test("a compaction with no reading after it still lands, with an unknown after", () => {
    const { lines, usage } = run([boundary]);
    expect(lines).toContain("[claude] Context compacted: 168k → ?");
    expect(usage.find((e) => e.kind === "compact")).toMatchObject({ from: 168_000, to: null });
  });

  test("falls back to the last reading when the boundary names no size", () => {
    const { lines } = run([msg("a", { input_tokens: 90_000, output_tokens: 0 }), { type: "system", subtype: "compact_boundary" }, msg("b", { input_tokens: 4_000, output_tokens: 0 })]);
    expect(lines).toContain("[claude] Context compacted: 90k → 4k");
  });

  test("round-trips through the line format", () => {
    expect(parseCompactLine(compactLine("claude", 1_200_000, 800))).toEqual({ from: 1_200_000, to: 800 });
    expect(parseCompactLine("[claude] done")).toBeNull();
  });
});

describe("codex", () => {
  test("token_count readings carry the window and supersede per-turn totals", () => {
    const { acc } = run(
      [
        { type: "thread.started", thread_id: "t1" },
        { msg: { type: "token_count", info: { last_token_usage: { input_tokens: 50_000, cached_input_tokens: 40_000, output_tokens: 500 }, model_context_window: 272_000 } } },
        { type: "turn.completed", usage: { input_tokens: 300_000, cached_input_tokens: 250_000, output_tokens: 2_000 } },
      ],
      "codex",
    );
    expect(acc.context()).toMatchObject({ tokens: 10_000 + 40_000 + 500, window: 272_000 });
    expect(acc.context()!.approx).toBeFalsy();
  });

  test("without token_count, the turn total is used and marked approximate", () => {
    const { acc } = run([{ type: "thread.started", thread_id: "t1" }, { type: "turn.completed", usage: { input_tokens: 30_000, cached_input_tokens: 20_000, output_tokens: 400 } }], "codex");
    expect(acc.context()).toMatchObject({ tokens: 10_000 + 20_000 + 400, approx: true });
  });

  test("a context_compacted notice pairs with the next reading", () => {
    const { lines } = run(
      [
        { type: "turn.completed", usage: { input_tokens: 200_000, output_tokens: 100 } },
        { msg: { type: "context_compacted" } },
        { msg: { type: "token_count", info: { last_token_usage: { input_tokens: 20_000, output_tokens: 0 } } } },
      ],
      "codex",
    );
    expect(lines.some((l) => /Context compacted: 200k → 20k/.test(l))).toBe(true);
  });
});

describe("window table", () => {
  test("claude 5-5 is 1M, older claude 200k, [1m] explicit, codex 400k", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "sonnet"]) expect(contextWindow("claude", id)).toBe(1_000_000);
    expect(contextWindow("claude", "claude-sonnet-4-5")).toBe(200_000);
    expect(contextWindow("claude", "opus[1m]")).toBe(1_000_000);
    expect(contextWindow("claude", "sonnet[500k]")).toBe(500_000);
    expect(contextWindow("codex", "gpt-5.5")).toBe(400_000);
  });
  test("grok windows follow xAI's table: 4.3 and 4.20 1M, 4.5 to 4.7 500k, the rest 256k", () => {
    expect(contextWindow("grok", "grok-4.3")).toBe(1_000_000);
    expect(contextWindow("grok", "grok-4.20-0309-reasoning")).toBe(1_000_000);
    for (const id of ["grok-4.5", "grok-4.6", "grok-4.7"]) expect(contextWindow("grok", id)).toBe(500_000);
    expect(contextWindow("grok", "grok-build-0.1")).toBe(256_000);
    expect(contextWindow("grok", null)).toBe(256_000);
  });
  test("an override beats everything; an unknown engine and model is unknown", () => {
    expect(contextWindow("claude", "opus[1m]", 123_000)).toBe(123_000);
    expect(contextWindow("mystery", "who-knows")).toBeNull();
  });
  test("formatting", () => {
    expect([formatTokens(950), formatTokens(84_200), formatTokens(1_000_000), formatTokens(1_250_000), formatTokens(null)]).toEqual(["950", "84k", "1M", "1.3M", "?"]);
    expect(canCompact("claude")).toBe(true);
    expect(canCompact("codex")).toBe(false);
  });
});

describe("on a real session (scripted engine)", () => {
  afterEach(() => resetSetting("context_window"));

  test("the view carries tokens, the window and a percentage, updated as the turn runs", async () => {
    resetState();
    const s = createLead({ prompt: "SAY done\nUSAGE 84000", engine: "fake", cwd: makeDir() });
    const done = await settled(s.id);
    const v = viewSession(done);
    expect(v.context).toMatchObject({ tokens: 84_000, max: 200_000 });
    expect(v.context!.pct).toBeCloseTo(0.42, 2);
    expect(v.context!.breakdown.cache_read).toBe(83_990);
    expect(v.compactions).toBe(0);
    expect(v.can_compact).toBe(true);
  });

  test("an engine-reported window wins over the table, and the override wins over both", async () => {
    resetState();
    const a = await settled(createLead({ prompt: "SAY ok\nWINDOW 1000000\nUSAGE 50000", engine: "fake", cwd: makeDir() }).id);
    expect(viewSession(a).context!.max).toBe(1_000_000);
    setSetting("context_window", "64000");
    expect(viewSession(getSession(a.id)!).context!.max).toBe(64_000);
  });

  test("an automatic compaction is counted, shown in the log, and shrinks the meter", async () => {
    resetState();
    const s = createLead({ prompt: "SAY ok\nUSAGE 168000\nCOMPACT 168000 24000", engine: "fake", cwd: makeDir() });
    const done = await settled(s.id);
    expect(done.compactions).toBe(1);
    expect(viewSession(done).context!.tokens).toBe(24_000);
    const line = readLog(s.id).find((l) => l.data?.compact);
    expect(line?.text).toBe("[claude] Context compacted: 168k → 24k");
    expect(line?.kind).toBe("info");
  });

  test("a session that never reported has no meter, but still says whether it can compact", async () => {
    resetState();
    const s = createLead({ prompt: "SAY hi", engine: "fake", cwd: makeDir() });
    await settled(s.id);
    // The scripted engine's plain SAY carries usage; clear it to model an engine that reports nothing.
    db().prepare("UPDATE sessions SET context_tokens = NULL WHERE id = ?").run(s.id);
    expect(contextOf(getSession(s.id)!)).toMatchObject({ context: null, compactions: 0, can_compact: true });
  });

  test("manual /compact is sent bare, counts, and drops the meter", async () => {
    resetState();
    const s = createLead({ prompt: "SAY ok\nUSAGE 150000", engine: "fake", cwd: makeDir() });
    await settled(s.id);
    send({ operator: true }, s.id, "/compact");
    const after = await settled(s.id);
    expect(after.compactions).toBe(1);
    expect(viewSession(after).context!.tokens).toBe(12_000);
    expect(readLog(s.id).some((l) => l.text === "[claude] Context compacted: 150k → 12k")).toBe(true);
  });
});
