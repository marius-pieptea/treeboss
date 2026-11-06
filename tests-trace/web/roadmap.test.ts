import { describe, expect, test } from "bun:test";
import type { RoadmapItem, RoadmapLane } from "../../web/src/features/roadmap/data";
import { allTags, applyMove, dropIndex, filterLanes, isFiltering, isNoopMove, neighborLane, NO_FILTER, parseTags, parseTarget, progressPct, timelineLayout } from "../../web/src/features/roadmap/logic";

function item(over: Partial<RoadmapItem> & { key: string; title: string }): RoadmapItem {
  return { id: over.key, done: false, description: "", tags: [], spec: null, docs: null, target: null, lane: "Now", index: 0, line: 1, status: "not_started", progress: null, links: { spec: null, docs: null }, sessions: [], ...over };
}
function lane(name: string, items: RoadmapItem[]): RoadmapLane {
  return { name, items: items.map((i, index) => ({ ...i, lane: name, index })), progress: { items: items.length, shipped: 0, inProgress: 0, tasksDone: 0, tasksTotal: 0 } };
}
const UTC = (y: number, m: number, d = 1) => Date.UTC(y, m - 1, d);

describe("parseTarget", () => {
  test("quarters, months, days and years in the usual spellings", () => {
    expect(parseTarget("2026-Q4")).toMatchObject({ kind: "quarter", start: UTC(2026, 10), end: UTC(2027, 1), label: "2026 Q4" });
    expect(parseTarget("Q1 2027")).toMatchObject({ kind: "quarter", start: UTC(2027, 1), label: "2027 Q1" });
    expect(parseTarget("2026 q2")).toMatchObject({ kind: "quarter", label: "2026 Q2" });
    expect(parseTarget("2026-11")).toMatchObject({ kind: "month", start: UTC(2026, 11), end: UTC(2026, 12), label: "Nov 2026" });
    expect(parseTarget("Nov 2026")).toMatchObject({ kind: "month", label: "Nov 2026" });
    expect(parseTarget("september 2026")).toMatchObject({ kind: "month", label: "Sep 2026" });
    expect(parseTarget("2026-11-15")).toMatchObject({ kind: "day", start: UTC(2026, 11, 15), label: "15 Nov 2026" });
    expect(parseTarget("15 Nov 2026")).toMatchObject({ kind: "day", start: UTC(2026, 11, 15) });
    expect(parseTarget("2027")).toMatchObject({ kind: "year", start: UTC(2027, 1), end: UTC(2028, 1) });
  });
  test("a range spans both ends", () => {
    expect(parseTarget("2026-Q4..2027-Q1")).toMatchObject({ kind: "range", start: UTC(2026, 10), end: UTC(2027, 4) });
    expect(parseTarget("2026-09 to 2026-11")).toMatchObject({ kind: "range", start: UTC(2026, 9), end: UTC(2026, 12) });
    expect(parseTarget("2026-Q4..2026-Q1")).toBeNull(); // backwards
  });
  test("anything else is unreadable, not a guess", () => {
    for (const bad of ["sometime soon", "", "2026-13", "2026-02-31", "Q5 2026", "tomorrow", "2026-Q9"]) expect(parseTarget(bad)).toBeNull();
    expect(parseTarget(null)).toBeNull();
  });
});

describe("filter", () => {
  const lanes = [
    lane("Now", [item({ key: "r1", title: "Ship chat", tags: ["core"], status: "in_progress" }), item({ key: "r2", title: "Fix login", tags: ["bug"], status: "shipped", done: true })]),
    lane("Next", [item({ key: "r3", title: "Billing", description: "Stripe subscriptions", tags: ["money", "core"], target: "2026-11" })]),
  ];
  test("by text (title, description, tags, target), tag, status and lane", () => {
    const titles = (f: Partial<typeof NO_FILTER>) => filterLanes(lanes, { ...NO_FILTER, ...f }).flatMap((l) => l.items.map((i) => i.title));
    expect(titles({})).toEqual(["Ship chat", "Fix login", "Billing"]);
    expect(titles({ q: "stripe" })).toEqual(["Billing"]);
    expect(titles({ q: "2026-11" })).toEqual(["Billing"]);
    expect(titles({ q: "BUG" })).toEqual(["Fix login"]);
    expect(titles({ tag: "core" })).toEqual(["Ship chat", "Billing"]);
    expect(titles({ status: "shipped" })).toEqual(["Fix login"]);
    expect(titles({ lane: "Next" })).toEqual(["Billing"]);
    expect(titles({ tag: "core", status: "in_progress", q: "chat" })).toEqual(["Ship chat"]);
    expect(filterLanes(lanes, { ...NO_FILTER, q: "zzz" }).map((l) => l.name)).toEqual(["Now", "Next"]); // empty lanes stay
    expect(filterLanes(lanes, { ...NO_FILTER, lane: "Next" }).map((l) => l.name)).toEqual(["Next"]);
  });
  test("tags are collected sorted and unique; isFiltering sees any criterion", () => {
    expect(allTags(lanes)).toEqual(["bug", "core", "money"]);
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering({ ...NO_FILTER, q: "  " })).toBe(false);
    expect(isFiltering({ ...NO_FILTER, tag: "x" })).toBe(true);
  });
  test("tag input is normalised", () => {
    expect(parseTags("a, b  #c,, a (x)")).toEqual(["a", "b", "c", "x"]);
    expect(parseTags("")).toEqual([]);
  });
  test("progress percent", () => {
    expect(progressPct(null)).toBe(0);
    expect(progressPct({ done: 0, total: 0 })).toBe(0);
    expect(progressPct({ done: 1, total: 3 })).toBe(33);
    expect(progressPct({ done: 3, total: 3 })).toBe(100);
  });
});

describe("timeline", () => {
  const NOW = UTC(2026, 10, 8);
  test("the axis starts on a quarter edge and covers every target", () => {
    const t = timelineLayout([lane("Now", [item({ key: "a", title: "A", target: "2026-Q4" }), item({ key: "b", title: "B", target: "2027-02" })])], NOW);
    expect(t.months[0]).toMatchObject({ label: "Oct", year: 2026 });
    expect(t.months.length % 3).toBe(0);
    expect(t.months.length).toBeGreaterThanOrEqual(6);
    expect(t.months.at(-1)!.year * 12 + t.months.at(-1)!.month).toBeGreaterThanOrEqual(2027 * 12 + 1);
    expect(t.quarters.map((q) => q.label).slice(0, 2)).toEqual(["2026 Q4", "2027 Q1"]);
    const widths = t.months.reduce((a, m) => a + m.width, 0);
    expect(Math.round(widths)).toBe(100);
  });
  test("bars sit on their span; overlapping ones take separate rows; non-overlapping share one", () => {
    const t = timelineLayout([lane("Now", [item({ key: "a", title: "A", target: "2026-Q4" }), item({ key: "b", title: "B", target: "2026-11" }), item({ key: "c", title: "C", target: "2027-Q1" })])], NOW);
    const [a, b, c] = ["a", "b", "c"].map((k) => t.bands[0]!.bars.find((x) => x.item.key === k)!);
    expect(a.left).toBeCloseTo(0, 5);
    expect(b.left).toBeGreaterThan(a.left);
    expect(b.left + b.width).toBeLessThanOrEqual(a.left + a.width + 0.001);
    expect(a.row).not.toBe(b.row); // B is inside A's span
    expect(c.row).toBe(a.row); // C starts after A ends
    expect(t.bands[0]!.rows).toBe(2);
  });
  test("items without a target, or one that cannot be read, are unscheduled and reported", () => {
    const t = timelineLayout([lane("Later", [item({ key: "a", title: "A" }), item({ key: "b", title: "B", target: "sometime soon" }), item({ key: "c", title: "C", target: "2026-12" })])], NOW);
    expect(t.bands[0]!.unscheduled.map((i) => i.key)).toEqual(["a", "b"]);
    expect(t.bands[0]!.bars.map((b) => b.item.key)).toEqual(["c"]);
    expect(t.unreadable).toEqual(["sometime soon"]);
  });
  test("today is on the axis when it falls inside it, and a single day still has width", () => {
    const t = timelineLayout([lane("Now", [item({ key: "a", title: "A", target: "2026-12-24" })])], NOW);
    expect(t.today).not.toBeNull();
    expect(t.today!).toBeGreaterThan(0);
    expect(t.bands[0]!.bars[0]!.width).toBeGreaterThan(1);
    const past = timelineLayout([lane("Now", [item({ key: "a", title: "A", target: "2026-12" })])], UTC(2031, 1, 1));
    expect(past.today).toBeNull();
  });
  test("a very long range does not blow up the axis", () => {
    const t = timelineLayout([lane("Now", [item({ key: "a", title: "A", target: "2026..2040" })])], NOW);
    expect(t.months.length).toBeLessThanOrEqual(36);
    expect(t.bands[0]!.bars[0]!.left + t.bands[0]!.bars[0]!.width).toBeLessThanOrEqual(100.001);
  });
  test("an empty roadmap still draws an axis", () => {
    const t = timelineLayout([], NOW);
    expect(t.months.length).toBeGreaterThanOrEqual(6);
    expect(t.bands).toEqual([]);
  });
});

describe("drag and drop", () => {
  test("the drop slot counts the other cards above the pointer", () => {
    expect(dropIndex([], 100)).toBe(0);
    expect(dropIndex([50, 150, 250], 10)).toBe(0);
    expect(dropIndex([50, 150, 250], 100)).toBe(1);
    expect(dropIndex([50, 150, 250], 200)).toBe(2);
    expect(dropIndex([50, 150, 250], 999)).toBe(3);
  });
  test("a drop where the card already is changes nothing", () => {
    expect(isNoopMove({ lane: "Now", index: 1 }, "Now", 1)).toBe(true);
    expect(isNoopMove({ lane: "Now", index: 1 }, "Now", 0)).toBe(false);
    expect(isNoopMove({ lane: "Now", index: 1 }, "Next", 1)).toBe(false);
  });
  const lanes = [lane("Now", [item({ key: "a", title: "A" }), item({ key: "b", title: "B" }), item({ key: "c", title: "C" })]), lane("Next", [item({ key: "d", title: "D" })])];
  test("an optimistic move matches what the server will do", () => {
    const keys = (ls: RoadmapLane[]) => ls.map((l) => l.items.map((i) => i.key).join(""));
    expect(keys(applyMove(lanes, "a", "Now", 1))).toEqual(["bac", "d"]); // indexes count the other cards
    expect(keys(applyMove(lanes, "a", "Now", 2))).toEqual(["bca", "d"]);
    expect(keys(applyMove(lanes, "c", "Now", 0))).toEqual(["cab", "d"]);
    expect(keys(applyMove(lanes, "b", "Next", null))).toEqual(["ac", "db"]);
    expect(keys(applyMove(lanes, "b", "Next", 0))).toEqual(["ac", "bd"]);
    expect(keys(applyMove(lanes, "zzz", "Next", 0))).toEqual(["abc", "d"]);
    const moved = applyMove(lanes, "b", "Next", 0);
    expect(moved[1]!.items.map((i) => [i.key, i.lane, i.index])).toEqual([["b", "Next", 0], ["d", "Next", 1]]);
    expect(moved[0]!.items.map((i) => i.index)).toEqual([0, 1]);
    expect(lanes[0]!.items).toHaveLength(3); // the input is not mutated
  });
  test("neighbouring lanes", () => {
    expect(neighborLane(lanes, "Now", 1)).toBe("Next");
    expect(neighborLane(lanes, "Now", -1)).toBeNull();
    expect(neighborLane(lanes, "Next", 1)).toBeNull();
    expect(neighborLane(lanes, "Nope", 1)).toBeNull();
  });
});
