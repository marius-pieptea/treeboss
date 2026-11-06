import { describe, expect, test } from "bun:test";
import { ago, exposesLimits, ringWindows, span, usageEmptyCopy, usageTone, windowView } from "../../web/src/lib/limits-logic";

const w = { id: "five_hour", title: "5-hour limit", percent: 3, resets_at: 1000 + 7800, status: "allowed", at: 1000 };

describe("usage card logic", () => {
  test("spans and ages", () => {
    expect(span(45 * 60)).toBe("45m");
    expect(span(7800)).toBe("2h 10m");
    expect(span(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(ago(1000, 1030)).toBe("just now");
    expect(ago(1000, 1000 + 300)).toBe("5m ago");
  });
  test("a window shows used, left and reset", () => {
    expect(windowView(w, 1000)).toMatchObject({ summary: "3% used · 97% left", reset: "resets in 2h 10m", used: 3, warn: false });
  });
  test("a nearly spent or refused window warns; a reset one drops its number", () => {
    expect(windowView({ ...w, percent: 90 }, 1000).warn).toBe(true);
    expect(windowView({ ...w, percent: null, status: "rejected" }, 1000)).toMatchObject({ summary: "status: rejected", warn: true });
    expect(windowView(w, 9000)).toMatchObject({ summary: "reset since", used: null });
  });
  test("claude, grok, cursor and codex report; other engines do not", () => {
    expect(exposesLimits("claude")).toBe(true);
    expect(exposesLimits("grok")).toBe(true);
    expect(exposesLimits("cursor")).toBe(true);
    expect(exposesLimits("codex")).toBe(true);
    expect(exposesLimits("opencode")).toBe(false);
    expect(usageEmptyCopy(true)).toBe("Nothing reported yet. It updates after the next turn.");
    expect(usageEmptyCopy(false)).toBe("This engine does not report plan usage.");
  });
  test("tones follow what is left, and a refusal is critical", () => {
    expect(usageTone(3, "allowed")).toBe("neutral");
    expect(usageTone(75, "allowed")).toBe("warning");
    expect(usageTone(95, "allowed")).toBe("critical");
    expect(usageTone(3, "rejected")).toBe("critical");
    expect(usageTone(null, null)).toBe("neutral");
  });
  test("rings keep the longest window outside and measure what is left", () => {
    const weekly = { id: "seven_day", title: "Weekly · all models", percent: 40, resets_at: 1000 + 86400, status: "allowed", at: 1000 };
    const rings = ringWindows([weekly, w], 1000);
    expect(rings.map((r) => r.id)).toEqual(["seven_day", "five_hour"]);
    expect(rings[1]).toMatchObject({ left: 97, tone: "neutral" });
    expect(ringWindows([w], 9000)).toEqual([{ id: "five_hour", left: null, tone: "neutral" }]);
  });
});
