/** Pure helpers for the Roadmap view: filtering, target parsing, timeline layout, drop positions. No React here. */
import type { ItemStatus, RoadmapItem, RoadmapLane } from "./data";

/* ------------------------------------------------------------------ filter */

export interface Filter {
  q: string;
  tag: string;
  status: "" | ItemStatus;
  lane: string;
}

export const NO_FILTER: Filter = { q: "", tag: "", status: "", lane: "" };
export const isFiltering = (f: Filter): boolean => !!(f.q.trim() || f.tag || f.status || f.lane);

export function matches(it: RoadmapItem, f: Filter): boolean {
  if (f.tag && !it.tags.includes(f.tag)) return false;
  if (f.status && it.status !== f.status) return false;
  const q = f.q.trim().toLowerCase();
  if (!q) return true;
  return [it.title, it.description, it.tags.join(" "), it.target ?? "", it.spec ?? "", it.docs ?? "", it.id ?? ""].some((s) => s.toLowerCase().includes(q));
}

/** The lanes with only the items that pass. A lane filter hides the other lanes; an empty lane stays visible otherwise. */
export function filterLanes(lanes: RoadmapLane[], f: Filter): RoadmapLane[] {
  return lanes.filter((l) => !f.lane || l.name === f.lane).map((l) => ({ ...l, items: l.items.filter((it) => matches(it, f)) }));
}

export const allTags = (lanes: RoadmapLane[]): string[] => [...new Set(lanes.flatMap((l) => l.items.flatMap((i) => i.tags)))].sort((a, b) => a.localeCompare(b));

export const allItems = (lanes: RoadmapLane[]): RoadmapItem[] => lanes.flatMap((l) => l.items);

/* ---------------------------------------------------------------- progress */

export function progressPct(p: { done: number; total: number } | null): number {
  if (!p || p.total <= 0) return 0;
  return Math.round((p.done / p.total) * 100);
}

export const STATUS_LABEL: Record<ItemStatus, string> = { shipped: "Shipped", in_progress: "In progress", not_started: "Not started" };

export const liveSessions = (it: RoadmapItem): number => it.sessions.filter((s) => s.status === "running").length;

/* ----------------------------------------------------------------- targets */

export interface Span {
  /** UTC ms, inclusive start and exclusive end. */
  start: number;
  end: number;
  kind: "year" | "quarter" | "month" | "day" | "range";
  label: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const utc = (y: number, m: number, d = 1) => Date.UTC(y, m, d);

function monthIndex(word: string): number {
  const i = MONTHS.indexOf(word.slice(0, 3).toLowerCase());
  return i;
}

/** Parse one point: 2026-Q4, Q4 2026, 2026 Q4, 2026-11, Nov 2026, 2026-11-15, 15 Nov 2026, 2026. */
function parseOne(raw: string): Span | null {
  const s = raw.trim();
  let m: RegExpMatchArray | null;
  const q = s.match(/^(\d{4})[\s-]*Q([1-4])$/i) ?? s.match(/^Q([1-4])[\s-]*(\d{4})$/i);
  if (q) {
    const first = q[0]!.trim().toUpperCase().startsWith("Q");
    const y = Number(first ? q[2] : q[1]);
    const qi = Number(first ? q[1] : q[2]) - 1;
    return { start: utc(y, qi * 3), end: utc(y, qi * 3 + 3), kind: "quarter", label: `${y} Q${qi + 1}` };
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
    const t = utc(y, mo, d);
    if (new Date(t).getUTCMonth() !== mo) return null;
    return { start: t, end: t + 86_400_000, kind: "day", label: `${d} ${MONTH_LABEL[mo]} ${y}` };
  }
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/)) && monthIndex(m[2]!) >= 0) {
    const mo = monthIndex(m[2]!);
    const t = utc(Number(m[3]), mo, Number(m[1]));
    if (new Date(t).getUTCMonth() !== mo) return null;
    return { start: t, end: t + 86_400_000, kind: "day", label: `${Number(m[1])} ${MONTH_LABEL[mo]} ${m[3]}` };
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) {
    const mo = Number(m[2]) - 1;
    if (mo < 0 || mo > 11) return null;
    const y = Number(m[1]);
    return { start: utc(y, mo), end: utc(y, mo + 1), kind: "month", label: `${MONTH_LABEL[mo]} ${y}` };
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/)) && monthIndex(m[1]!) >= 0) {
    const mo = monthIndex(m[1]!);
    const y = Number(m[2]);
    return { start: utc(y, mo), end: utc(y, mo + 1), kind: "month", label: `${MONTH_LABEL[mo]} ${y}` };
  }
  if ((m = s.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    return { start: utc(y, 0), end: utc(y + 1, 0), kind: "year", label: String(y) };
  }
  return null;
}

/** A target as written in the file → the time it covers. "A..B" (or "A to B", "A – B") is a range. Anything else is null. */
export function parseTarget(target: string | null | undefined): Span | null {
  if (!target) return null;
  const parts = target.split(/\s*(?:\.\.|–|—|\bto\b)\s*/i);
  if (parts.length === 2) {
    const a = parseOne(parts[0]!);
    const b = parseOne(parts[1]!);
    if (a && b && b.end > a.start) return { start: a.start, end: b.end, kind: "range", label: `${a.label} to ${b.label}` };
    return null;
  }
  return parseOne(target);
}

/* ---------------------------------------------------------------- timeline */

export interface TimelineBar {
  item: RoadmapItem;
  span: Span;
  /** Percent of the axis. */
  left: number;
  width: number;
  row: number;
}

export interface TimelineBand {
  lane: string;
  bars: TimelineBar[];
  rows: number;
  /** In the lane but with no (parseable) target. */
  unscheduled: RoadmapItem[];
}

export interface Timeline {
  /** Each month column of the axis. */
  months: Array<{ label: string; year: number; month: number; left: number; width: number }>;
  quarters: Array<{ label: string; left: number; width: number }>;
  bands: TimelineBand[];
  /** Where "today" falls, in percent of the axis, or null when it is outside it. */
  today: number | null;
  /** Targets we could not read, by raw text, for a hint. */
  unreadable: string[];
}

const MIN_MONTHS = 6;
const MAX_MONTHS = 36;

export function timelineLayout(lanes: RoadmapLane[], now: number = Date.now()): Timeline {
  const d = new Date(now);
  const thisMonth = utc(d.getUTCFullYear(), d.getUTCMonth());
  const parsed = new Map<string, Span>();
  const unreadable = new Set<string>();
  for (const l of lanes)
    for (const it of l.items) {
      if (!it.target) continue;
      const s = parseTarget(it.target);
      if (s) parsed.set(it.key, s);
      else unreadable.add(it.target);
    }
  let lo = thisMonth;
  let hi = utc(d.getUTCFullYear(), d.getUTCMonth() + MIN_MONTHS);
  for (const s of parsed.values()) {
    lo = Math.min(lo, utc(new Date(s.start).getUTCFullYear(), new Date(s.start).getUTCMonth()));
    const e = new Date(s.end - 1);
    hi = Math.max(hi, utc(e.getUTCFullYear(), e.getUTCMonth() + 1));
  }
  // Start on a quarter edge so the header reads cleanly, and keep the axis a sane width.
  const lo0 = new Date(lo);
  lo = utc(lo0.getUTCFullYear(), Math.floor(lo0.getUTCMonth() / 3) * 3);
  const monthsBetween = (a: number, b: number) => {
    const A = new Date(a);
    const B = new Date(b);
    return (B.getUTCFullYear() - A.getUTCFullYear()) * 12 + (B.getUTCMonth() - A.getUTCMonth());
  };
  let n = Math.max(MIN_MONTHS, monthsBetween(lo, hi));
  n = Math.ceil(n / 3) * 3;
  n = Math.min(n, MAX_MONTHS);
  const first = new Date(lo);
  const hiEdge = utc(first.getUTCFullYear(), first.getUTCMonth() + n);
  const span = hiEdge - lo;
  const pct = (t: number) => ((Math.min(Math.max(t, lo), hiEdge) - lo) / span) * 100;

  const months = Array.from({ length: n }, (_, i) => {
    const t = utc(first.getUTCFullYear(), first.getUTCMonth() + i);
    const t2 = utc(first.getUTCFullYear(), first.getUTCMonth() + i + 1);
    const dd = new Date(t);
    return { label: MONTH_LABEL[dd.getUTCMonth()]!, year: dd.getUTCFullYear(), month: dd.getUTCMonth(), left: pct(t), width: pct(t2) - pct(t) };
  });
  const quarters: Timeline["quarters"] = [];
  for (let i = 0; i < n; i += 3) {
    const dd = new Date(utc(first.getUTCFullYear(), first.getUTCMonth() + i));
    quarters.push({ label: `${dd.getUTCFullYear()} Q${Math.floor(dd.getUTCMonth() / 3) + 1}`, left: months[i]!.left, width: months.slice(i, i + 3).reduce((a, m) => a + m.width, 0) });
  }

  const bands: TimelineBand[] = lanes.map((lane) => {
    const bars: TimelineBar[] = [];
    const unscheduled: RoadmapItem[] = [];
    const sorted = lane.items.map((item) => ({ item, span: parsed.get(item.key) ?? null }));
    for (const x of sorted) if (!x.span) unscheduled.push(x.item);
    const placed = sorted.filter((x): x is { item: RoadmapItem; span: Span } => !!x.span).sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
    const rowEnds: number[] = [];
    for (const { item, span: sp } of placed) {
      const left = pct(sp.start);
      // A single day still needs room to read: give it a minimum width.
      const width = Math.max(pct(sp.end) - left, (100 / n) * 0.55);
      let row = rowEnds.findIndex((end) => end <= left + 0.01);
      if (row < 0) row = rowEnds.length;
      rowEnds[row] = left + width;
      bars.push({ item, span: sp, left, width: Math.min(width, 100 - left), row });
    }
    return { lane: lane.name, bars, rows: Math.max(1, rowEnds.length), unscheduled };
  });

  const today = now >= lo && now < hiEdge ? pct(now) : null;
  return { months, quarters, bands, today, unreadable: [...unreadable] };
}

/* ------------------------------------------------------------- drag & drop */

/** Where a dragged card lands in a lane: how many of the other cards' midlines are above the pointer. */
export function dropIndex(mids: number[], pointerY: number): number {
  let n = 0;
  for (const m of mids) if (m < pointerY) n++;
  return n;
}

/** A move that changes nothing: same lane, and `slot` (the other cards above the pointer) is where the card already is. */
export function isNoopMove(item: { lane: string; index: number }, toLane: string, slot: number): boolean {
  return item.lane === toLane && slot === item.index;
}

export function neighborLane(lanes: RoadmapLane[], from: string, dir: -1 | 1): string | null {
  const i = lanes.findIndex((l) => l.name === from);
  const j = i + dir;
  return i >= 0 && j >= 0 && j < lanes.length ? lanes[j]!.name : null;
}

/** Normalised tag input: "a, b  c" → ["a","b","c"] without duplicates. */
export function parseTags(input: string): string[] {
  return [...new Set(input.split(/[,\s]+/).map((t) => t.replace(/^#/, "").replace(/[()]/g, "").trim()).filter(Boolean))];
}

/** The lanes after a move, for an instant (optimistic) update before the server answers. `toIndex` is as sent to the server. */
export function applyMove(lanes: RoadmapLane[], key: string, toLane: string, toIndex: number | null): RoadmapLane[] {
  let moved: RoadmapItem | null = null;
  const without = lanes.map((l) => ({
    ...l,
    items: l.items.filter((it) => {
      if (it.key === key || it.id === key) {
        moved = it;
        return false;
      }
      return true;
    }),
  }));
  if (!moved) return lanes;
  return without.map((l) => {
    if (l.name !== toLane) return { ...l, items: l.items.map((it, index) => ({ ...it, index })) };
    const at = toIndex === null ? l.items.length : Math.max(0, Math.min(toIndex, l.items.length));
    const items = [...l.items.slice(0, at), { ...(moved as RoadmapItem), lane: toLane }, ...l.items.slice(at)];
    return { ...l, items: items.map((it, index) => ({ ...it, index })) };
  });
}
