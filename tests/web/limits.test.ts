import { describe, expect, test } from "bun:test";
import { ago, exposesLimits, orderedWindows, ringWindows, span, usageEmptyCopy, usageTone, windowView } from "../../web/src/lib/limits-logic";

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
  test("claude, grok, cursor, codex, devin and agy report; other engines do not", () => {
    expect(exposesLimits("agy")).toBe(true);
    expect(exposesLimits("claude")).toBe(true);
    expect(exposesLimits("grok")).toBe(true);
    expect(exposesLimits("cursor")).toBe(true);
    expect(exposesLimits("codex")).toBe(true);
    expect(exposesLimits("devin")).toBe(true);
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
    const daily = { id: "daily", title: "Daily quota", percent: 6, resets_at: 2000, status: "allowed", at: 1000 };
    const devinWeekly = { id: "weekly", title: "Weekly quota", percent: 3, resets_at: 3000, status: "allowed", at: 1000 };
    const unknown = { id: "aaaa", title: "Unnamed", percent: 1, resets_at: 4000, status: "allowed", at: 1000 };
    expect(orderedWindows([devinWeekly, unknown, daily]).map((x) => x.id)).toEqual(["daily", "weekly", "aaaa"]);
  });

  test("multi-group windows order shortest-first and rings keep the tightest window per duration", () => {
    const g5 = { id: "gemini_5h", title: "5-hour · Gemini", percent: 7, resets_at: 2000, status: "allowed", at: 1000 };
    const t5 = { id: "third_party_5h", title: "5-hour · Claude/GPT", percent: 80, resets_at: 2000, status: "allowed", at: 1000 };
    const gw = { id: "gemini_weekly", title: "Weekly · Gemini", percent: 3, resets_at: 5000, status: "allowed", at: 1000 };
    const tw = { id: "third_party_weekly", title: "Weekly · Claude/GPT", percent: 0, resets_at: 5000, status: "allowed", at: 1000 };
    expect(orderedWindows([tw, gw, t5, g5]).map((x) => x.id)).toEqual(["gemini_5h", "third_party_5h", "gemini_weekly", "third_party_weekly"]);
    expect(ringWindows([tw, gw, t5, g5], 1000)).toEqual([
      { id: "gemini_weekly", left: 97, tone: "neutral" },
      { id: "third_party_5h", left: 20, tone: "warning" },
    ]);
    // Same-duration pairs (e.g. Cursor) still draw both rings.
    const c1 = { id: "cursor_models", title: "Cursor models", percent: 10, resets_at: 5000, status: "allowed", at: 1000 };
    const c2 = { id: "other_models", title: "Other models", percent: 20, resets_at: 5000, status: "allowed", at: 1000 };
    expect(ringWindows([c1, c2], 1000).map((r) => r.id)).toEqual(["other_models", "cursor_models"]);
  });
});
