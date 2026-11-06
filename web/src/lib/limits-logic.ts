export interface LimitWindow {
  id: string;
  title: string;
  percent: number | null;
  resets_at: number | null;
  status: string | null;
  at: number;
}

export interface EngineLimits {
  engine: string;
  exposed: boolean;
  windows: LimitWindow[];
  updated_at: number | null;
}

export interface WindowView {
  id: string;
  title: string;
  /** "3% used · 97% left", "reset since", or "usage not reported". */
  summary: string;
  /** 0..100 for the bar; null draws none. */
  used: number | null;
  /** "resets in 2h 10m", or "". */
  reset: string;
  /** Needs a word and a color: the engine said anything but "allowed", or 85% and up. */
  warn: boolean;
}

/** "2h 10m", "45m", "3d 4h": the two largest units of a span. */
export function span(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** How long ago something was reported: "just now", "5m ago". */
export function ago(at: number, now: number): string {
  const s = now - at;
  return s < 60 ? "just now" : `${span(s)} ago`;
}

/** How much of a window is left, 0..100. The rings and bars draw this, not the used amount. */
export function remainingOf(percent: number): number {
  return Math.max(0, Math.round(100 - percent));
}

export type UsageTone = "neutral" | "warning" | "critical";

/**
 * The rail widget's bands: under 30% left warns, under 10% left is critical. A status other than
 * "allowed" is critical even when plenty remains, and the card says the status in words.
 */
export function usageTone(percent: number | null, status: string | null): UsageTone {
  if (status !== null && status !== "allowed") return "critical";
  if (percent === null) return "neutral";
  const left = remainingOf(percent);
  if (left < 10) return "critical";
  if (left < 30) return "warning";
  return "neutral";
}

/** Minutes a known window lasts. Unknown ids sort last, so a new window does not hide the 5-hour one. */
const WINDOW_MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10_080,
  seven_day_opus: 10_080,
  seven_day_sonnet: 10_080,
};

/** Shortest window first. That is the one that stops work first, and the one the card lists first. */
export function orderedWindows(windows: LimitWindow[]): LimitWindow[] {
  return [...windows].sort(
    (a, b) => (WINDOW_MINUTES[a.id] ?? Number.POSITIVE_INFINITY) - (WINDOW_MINUTES[b.id] ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id),
  );
}

export interface UsageRing {
  id: string;
  /** 0..100 left. Null draws the track only (no number, or the window already reset). */
  left: number | null;
  tone: UsageTone;
}

/** At most two rings. The longest window is first, so it is drawn on the outside. */
export function ringWindows(windows: LimitWindow[], now: number): UsageRing[] {
  return orderedWindows(windows)
    .map((w): UsageRing => {
      const view = windowView(w, now);
      return { id: w.id, left: view.used === null ? null : remainingOf(view.used), tone: usageTone(view.used === null ? null : w.percent, w.status) };
    })
    .reverse()
    .slice(0, 2);
}

/** A window as the card shows it. A window whose reset time has passed is no longer the number it was. */
export function windowView(w: LimitWindow, now: number): WindowView {
  const over = w.resets_at !== null && w.resets_at <= now;
  const base = { id: w.id, title: w.title };
  if (over) return { ...base, summary: "reset since", used: null, reset: "", warn: false };
  const reset = w.resets_at !== null ? `resets in ${span(w.resets_at - now)}` : "";
  const limited = w.status !== null && w.status !== "allowed";
  if (w.percent === null) return { ...base, summary: limited ? `status: ${w.status}` : "usage not reported", used: null, reset, warn: limited };
  const used = Math.round(w.percent);
  return { ...base, summary: `${used}% used · ${100 - used}% left`, used: w.percent, reset, warn: limited || w.percent >= 85 };
}

/** Engines that report plan usage; mirrors `exposesLimits` in src/engines/limits.ts. */
const REPORTS = new Set(["claude", "codex", "cursor", "grok"]);
export const exposesLimits = (engine: string): boolean => REPORTS.has(engine);

/** What the card says when there is no window. Only an engine that can report may promise a later turn. */
export function usageEmptyCopy(exposed: boolean): string {
  return exposed ? "Nothing reported yet. It updates after the next turn." : "This engine does not report plan usage.";
}
