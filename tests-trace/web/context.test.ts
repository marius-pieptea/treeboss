import { describe, expect, test } from "bun:test";
import { breakdownRows, contextLevel, fmtTokens, meterModel, shouldHintHandoff } from "../../web/src/features/agent/context-logic";
import { deriveChat } from "../../web/src/features/agent/chat-logic";
import { appendLine, emptyTranscript } from "../../web/src/lib/transcript";
import type { SessionView } from "../../web/src/lib/types";
import { classifyLine } from "../../src/engines/classify";

const ctx = (tokens: number, max: number | null, over: Partial<NonNullable<SessionView["context"]>> = {}): SessionView["context"] => ({
  tokens,
  max,
  pct: max ? tokens / max : null,
  breakdown: { input: 10, cache_read: tokens - 10, cache_creation: 0, output: 0 },
  approx: false,
  updated_at: null,
  ...over,
});
const view = (context: SessionView["context"], over: Partial<SessionView> = {}) => ({ context, status: "idle" as const, depth: 0, compactions: 0, ...over });

describe("meter", () => {
  test("formats like the daemon's log line", () => {
    expect([fmtTokens(950), fmtTokens(84_200), fmtTokens(1_000_000), fmtTokens(null)]).toEqual(["950", "84k", "1M", "?"]);
  });

  test("amber from 70%, red from 90%, unknown without a window", () => {
    expect([0.1, 0.69, 0.7, 0.89, 0.9, 1].map(contextLevel)).toEqual(["ok", "ok", "warn", "warn", "high", "high"]);
    expect(contextLevel(null)).toBe("unknown");
  });

  test("label, fill and tooltip", () => {
    const m = meterModel(view(ctx(84_000, 200_000), { compactions: 2 }))!;
    expect(m).toMatchObject({ label: "84k / 200k", level: "ok" });
    expect(m.fill).toBeCloseTo(0.42);
    expect(m.title).toContain("42% of 200,000");
    expect(m.title).toContain("compacted 2×");
  });

  test("shows just the count when the window is unknown, and nothing when nothing was reported", () => {
    expect(meterModel(view(ctx(5_000, null)))).toMatchObject({ label: "5k", level: "unknown", fill: 0 });
    expect(meterModel(view(null))).toBeNull();
    expect(meterModel(undefined)).toBeNull();
  });

  test("flags approximate readings in the tooltip", () => {
    expect(meterModel(view(ctx(5_000, 100_000, { approx: true })))!.title).toContain("approximate");
  });

  test("breakdown: largest first, zeros dropped", () => {
    const rows = breakdownRows(view(ctx(50_000, 200_000, { breakdown: { input: 10, cache_read: 40_000, cache_creation: 9_000, output: 0 } })));
    expect(rows.map((r) => r.key)).toEqual(["cache_read", "cache_creation", "input"]);
  });
});

describe("handoff hint", () => {
  test("appears at 80% on an open lead, not before, not on heads or closed sessions", () => {
    expect(shouldHintHandoff(view(ctx(159_000, 200_000)))).toBe(false);
    expect(shouldHintHandoff(view(ctx(160_000, 200_000)))).toBe(true);
    expect(shouldHintHandoff(view(ctx(190_000, 200_000), { status: "closed" }))).toBe(false);
    expect(shouldHintHandoff(view(ctx(190_000, 200_000), { depth: 1 }))).toBe(false);
    expect(shouldHintHandoff(view(ctx(190_000, null)))).toBe(false);
    expect(shouldHintHandoff(null)).toBe(false);
  });
});

describe("compaction in the transcript", () => {
  const feed = (texts: string[]) => texts.reduce((s, t, i) => appendLine(s, { id: i + 1, session: "s_a", turn_id: "t_1", text: t, kind: classifyLine(t).kind, data: classifyLine(t) }), emptyTranscript());

  test("is its own item, in Trace and in Chat", () => {
    const s = feed(["[claude] Context compacted: 168k → 24k"]);
    expect(s.items[0]).toMatchObject({ type: "compact", from: 168_000, to: 24_000 });
    expect(deriveChat(s.items, "s_a")).toEqual([{ kind: "compact", id: s.items[0].id, from: 168_000, to: 24_000 }]);
  });

  test("other info lines are still plain notes", () => {
    expect(feed(["[claude] rate limit: ok"]).items[0].type).toBe("note");
  });
});
