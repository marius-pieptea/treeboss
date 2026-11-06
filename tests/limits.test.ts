import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { exposesLimits, getLimits, mergeWindows, parseCodexRateLimits, parseRateLimitInfo, recordLimits } from "../src/engines/limits";
import { parseCursorUsage, parseGrokBilling, readCodexWindows } from "../src/engines/plan-read";

const event = { status: "allowed", resetsAt: 1791462000, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.03, resetsAt: 1791462000 } } };

describe("claude rate_limit_event", () => {
  test("a unified window becomes percent used and a reset time", () => {
    expect(parseRateLimitInfo(event, 10)).toEqual([{ id: "five_hour", title: "5-hour limit", percent: 3, resets_at: 1791462000, status: "allowed", at: 10 }]);
  });
  test("an event naming only its type keeps the window without a number", () => {
    const w = parseRateLimitInfo({ status: "rejected", rateLimitType: "seven_day", resetsAt: 5 }, 1);
    expect(w).toEqual([{ id: "seven_day", title: "Weekly · all models", percent: null, resets_at: 5, status: "rejected", at: 1 }]);
  });
  test("garbage yields nothing", () => {
    expect(parseRateLimitInfo(null)).toEqual([]);
    expect(parseRateLimitInfo({ unifiedWindows: { five_hour: { utilization: "x" } } }, 1)[0].percent).toBeNull();
  });
});

describe("stored snapshot", () => {
  test("a later event replaces its own window and keeps the others; other engines report nothing", () => {
    recordLimits("claude", event);
    recordLimits("claude", { status: "allowed", unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 9 } } });
    recordLimits("claude", { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 7 } } });
    const l = getLimits("claude", 1);
    expect(l.exposed).toBe(true);
    expect(l.windows.map((w) => [w.id, w.percent]).sort()).toEqual([["five_hour", 10], ["seven_day", 50]]);
    // Past a window's reset it is no longer a reading: the stored value is only a cache until the next event.
    expect(getLimits("claude", 8).windows.map((w) => w.id)).toEqual(["seven_day"]);
    expect(getLimits("claude", 100).windows).toEqual([]);
    expect(getLimits("claude", 1791462001).windows).toEqual([]);
    recordLimits("opencode", event);
    expect(getLimits("opencode")).toMatchObject({ exposed: false, windows: [], updated_at: null });
  });
});

describe("codex rate limits", () => {
  const go = {
    limit_id: "codex",
    primary: { used_percent: 6.5, window_minutes: 43_200, resets_at: 1_795_897_504 },
    secondary: null,
    plan_type: "go",
    spend_control_reached: null,
  };

  test("the go plan's monthly window becomes one reading", () => {
    expect(parseCodexRateLimits(go, 10)).toEqual([
      { id: "monthly", title: "Monthly limit", percent: 6.5, resets_at: 1_795_897_504, status: "allowed", at: 10 },
    ]);
  });

  test("primary and secondary are the 5-hour and weekly windows", () => {
    const both = {
      primary: { used_percent: 12.34, window_minutes: 300, resets_at: 100 },
      secondary: { used_percent: 50, window_minutes: 10_080, resets_at: 200 },
    };
    expect(parseCodexRateLimits(both, 1).map((w) => [w.id, w.title, w.percent])).toEqual([
      ["five_hour", "5-hour limit", 12.3],
      ["weekly", "Weekly limit", 50],
    ]);
  });

  test("a null or missing window yields nothing; a window without fields is kept unnamed", () => {
    expect(parseCodexRateLimits(null, 1)).toEqual([]);
    expect(parseCodexRateLimits({ primary: null, secondary: null }, 1)).toEqual([]);
    expect(parseCodexRateLimits({ primary: {} }, 1)).toMatchObject([{ id: "limit", title: "Limit", percent: null, resets_at: null, status: "allowed" }]);
  });

  test("percent clamps at 100 and a spend control or a full window reads limit reached", () => {
    expect(parseCodexRateLimits({ primary: { used_percent: 150, window_minutes: 300, resets_at: 5 } }, 1)[0]).toMatchObject({ percent: 100, status: "limit reached" });
    expect(parseCodexRateLimits({ primary: { used_percent: 20, window_minutes: 300, resets_at: 5 }, spend_control_reached: true }, 1)[0].status).toBe("limit reached");
  });

  test("older readings count down from the reported time and name odd lengths", () => {
    expect(parseCodexRateLimits({ primary: { used_percent: 1, window_minutes: 60, resets_in_seconds: 120 } }, 100)[0]).toMatchObject({
      id: "hours_1",
      title: "1-hour limit",
      resets_at: 220,
    });
  });

  test("codex is exposed and its readings merge by window id", () => {
    expect(exposesLimits("codex")).toBe(true);
    mergeWindows("codex", parseCodexRateLimits(go, 10));
    mergeWindows("codex", parseCodexRateLimits({ primary: { used_percent: 7, window_minutes: 300, resets_at: 200 }, secondary: null }, 10));
    const l = getLimits("codex", 10);
    expect(l.exposed).toBe(true);
    expect(l.windows.map((w) => [w.id, w.percent]).sort()).toEqual([["five_hour", 7], ["monthly", 6.5]]);
  });
});

describe("codex rollout reading", () => {
  const timestamp = "2026-11-05T16:40:09.695Z";
  const reportedAt = Math.floor(Date.parse(timestamp) / 1000);
  const limits = { primary: { used_percent: 6, window_minutes: 43_200, resets_at: 1_795_897_504 }, secondary: null, spend_control_reached: null };
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const tokenCount = () => ({ timestamp, type: "event_msg", payload: { type: "token_count", info: {}, rate_limits: limits } });
  const sessions = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trb-codex-"));
    const day = path.join(root, "2026", "11", "05");
    fs.mkdirSync(day, { recursive: true });
    return { root, day };
  };

  test("the rollout's own timestamp is the reported time", async () => {
    const { root, day } = sessions();
    fs.writeFileSync(path.join(day, "rollout.jsonl"), line(tokenCount()));
    expect(await readCodexWindows(9_999_999_999, root)).toEqual([
      { id: "monthly", title: "Monthly limit", percent: 6, resets_at: 1_795_897_504, status: "allowed", at: reportedAt },
    ]);
  });

  test("a later token_count without rate limits leaves the earlier reading in place", async () => {
    const { root, day } = sessions();
    const later = { timestamp, type: "event_msg", payload: { type: "token_count", info: {} } };
    fs.writeFileSync(path.join(day, "rollout.jsonl"), line(tokenCount()) + line(later));
    expect((await readCodexWindows(9_999_999_999, root))[0]).toMatchObject({ id: "monthly", at: reportedAt });
  });

  test("finds a reading beyond the first tail read", async () => {
    const { root, day } = sessions();
    const filler = line({ timestamp, type: "response_item", payload: { type: "message", content: "x".repeat(200) } });
    fs.writeFileSync(path.join(day, "rollout.jsonl"), line(tokenCount()) + filler.repeat(2_000));
    expect((await readCodexWindows(9_999_999_999, root))[0]).toMatchObject({ id: "monthly", percent: 6, at: reportedAt });
  });

  test("without a timestamp, the file's mtime is the reported time", async () => {
    const { root, day } = sessions();
    const file = path.join(day, "rollout.jsonl");
    fs.writeFileSync(file, line({ type: "event_msg", payload: { type: "token_count", info: {}, rate_limits: limits } }));
    fs.utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    expect((await readCodexWindows(9_999_999_999, root))[0].at).toBe(1_700_000_000);
  });

  test("the newest day wins, and a tree outside YYYY/MM/DD still resolves", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trb-codex-"));
    const older = path.join(root, "2026", "11", "04");
    const newer = path.join(root, "2026", "11", "05");
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    fs.writeFileSync(path.join(older, "rollout.jsonl"), line({ ...tokenCount(), timestamp: "2026-11-04T00:00:00.000Z" }));
    fs.writeFileSync(path.join(newer, "rollout.jsonl"), line(tokenCount()));
    expect((await readCodexWindows(9_999_999_999, root))[0].at).toBe(reportedAt);

    const odd = fs.mkdtempSync(path.join(os.tmpdir(), "trb-codex-"));
    fs.mkdirSync(path.join(odd, "elsewhere"));
    fs.writeFileSync(path.join(odd, "elsewhere", "rollout.jsonl"), line(tokenCount()));
    expect((await readCodexWindows(9_999_999_999, odd))[0]).toMatchObject({ id: "monthly", at: reportedAt });
  });

  test("a missing sessions tree yields nothing", async () => {
    expect(await readCodexWindows(1, path.join(os.tmpdir(), `trb-codex-missing-${Date.now()}`))).toEqual([]);
  });
});

describe("grok and cursor readings", () => {
  const now = 1_000;
  test("grok billing is one window, and a missing percent on a real period is 0", () => {
    const period = { type: "weekly", start: "2026-10-19T00:00:00.000Z", end: "2026-10-26T00:00:00.000Z" };
    const used = parseGrokBilling({ config: { creditUsagePercent: 42, currentPeriod: period } }, now);
    expect(used).toMatchObject([{ id: "weekly", title: "Weekly", percent: 42, resets_at: Date.parse(period.end) / 1000 }]);
    expect(parseGrokBilling({ config: { currentPeriod: period } }, now)[0].percent).toBe(0);
    expect(parseGrokBilling({ config: { creditUsagePercent: "nope", currentPeriod: period } }, now)).toEqual([]);
    expect(parseGrokBilling({ config: {} }, now)).toEqual([]);
  });
  test("cursor splits its models, and a merged plan is the total for the cycle", () => {
    const start = Date.parse("2026-10-20T00:00:00.000Z");
    const end = Date.parse("2026-11-19T00:00:00.000Z");
    const usage = { billingCycleStart: String(start), billingCycleEnd: String(end), planUsage: { autoPercentUsed: 10, apiPercentUsed: 80, totalPercentUsed: 25 } };
    expect(parseCursorUsage(usage, { isMerged: false }, now).map((w) => [w.id, w.percent, w.title])).toEqual([
      ["cursor_models", 10, "Cursor models"],
      ["other_models", 80, "Other models"],
    ]);
    expect(parseCursorUsage(usage, { isMerged: true }, now)).toMatchObject([{ id: "monthly", title: "Monthly", percent: 25, resets_at: end / 1000 }]);
    expect(parseCursorUsage({ planUsage: {} }, null, now)).toEqual([]);
  });
});
