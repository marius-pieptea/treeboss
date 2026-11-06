import { describe, expect, test } from "bun:test";
import { awaitedBy, awaitedLabel, formatWaitElapsed, namesLabel, waitingInfo, waitingText } from "../../web/src/features/agent/waiting-logic";
import { shelfFor } from "../../web/src/features/agent/chat-logic";
import type { SessionView } from "../../web/src/lib/types";

const s = (over: Partial<SessionView>): SessionView =>
  ({ id: "s_1", title: "lead", status: "running", parent: null, depth: 0, role: null, engine: "claude", model: null, effort: null, pair: "p_1", turns: 1, isolation: "none", cwd: "/x", branch: null, changes: null, merged: false, cost_usd: null, tokens: { input: 0, output: 0, cache_read: 0 }, ...over }) as SessionView;

describe("elapsed", () => {
  test("seconds, minutes and hours stay short", () => {
    expect([0, 999, 45_000, 60_000, 130_000, 3_599_000, 3_900_000].map(formatWaitElapsed)).toEqual(["0s", "0s", "45s", "1m 00s", "2m 10s", "59m 59s", "1h 05m"]);
    expect(formatWaitElapsed(-5000)).toBe("0s");
  });
});

describe("the waiting line", () => {
  test("nothing waits when the view has no waiting_on", () => {
    expect(waitingInfo(s({}))).toBeNull();
    expect(waitingInfo(s({ waiting_on: [] }))).toBeNull();
    expect(waitingInfo(null)).toBeNull();
  });

  test("names the head and ticks the time", () => {
    const since = new Date(1_000_000).toISOString();
    const w = waitingInfo(s({ waiting_on: [{ id: "s_2", name: "api-head" }], waiting_since: since }))!;
    expect(w).toMatchObject({ ids: ["s_2"], names: ["api-head"], sinceMs: 1_000_000 });
    expect(waitingText(w, 1_130_000)).toBe("waiting on api-head, 2m 10s");
    expect(waitingText(w, 1_130_000, { compact: true })).toBe("waiting 2m 10s");
  });

  test("a missing or broken timestamp falls back to now instead of NaN", () => {
    const w = waitingInfo(s({ waiting_on: [{ id: "s_2", name: "a" }], waiting_since: "not a date" }))!;
    expect(Number.isFinite(w.sinceMs)).toBe(true);
  });

  test("never lists more than two names", () => {
    expect(namesLabel(["a"])).toBe("a");
    expect(namesLabel(["a", "b"])).toBe("a, b");
    expect(namesLabel(["a", "b", "c", "d"])).toBe("a, b +2");
  });
});

describe("who awaits whom", () => {
  test("maps each awaited head to its waiter, and words the tag by depth", () => {
    const lead = s({ id: "s_1", title: "lead", waiting_on: [{ id: "s_2", name: "api" }] });
    const mid = s({ id: "s_2", title: "api", depth: 1, parent: "s_1", waiting_on: [{ id: "s_3", name: "db" }] });
    const m = awaitedBy([lead, mid, s({ id: "s_3", depth: 2 })]);
    expect([...m.keys()]).toEqual(["s_2", "s_3"]);
    expect(awaitedLabel(m.get("s_2")!)).toBe("lead is waiting");
    expect(awaitedLabel(m.get("s_3")!)).toBe("parent is waiting");
  });
});

describe("the shelf", () => {
  const lead = s({ id: "s_1", waiting_on: [{ id: "s_2", name: "api" }], waiting_since: new Date(5000).toISOString() });
  const heads = [s({ id: "s_2", parent: "s_1", depth: 1, title: "api", role: "coder" }), s({ id: "s_3", parent: "s_1", depth: 1, title: "docs", role: "writer" })];

  test("carries the lead's wait and marks only the awaited head", () => {
    const shelf = shelfFor(lead, heads)!;
    expect(shelf.lead.waiting).toEqual({ names: ["api"], sinceMs: 5000 });
    expect(shelf.heads.map((h) => h.awaited)).toEqual([true, undefined]);
  });

  test("a lead that is not waiting adds nothing", () => {
    const shelf = shelfFor(s({ id: "s_1" }), heads)!;
    expect(shelf.lead).toEqual({ engine: "claude", status: "running" });
    expect(shelf.heads.every((h) => !("awaited" in h))).toBe(true);
  });
});
