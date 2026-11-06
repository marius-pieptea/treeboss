/** What "the lead is blocked in subagent_wait" looks like in the UI. Pure, so it can be tested without a DOM. */
import type { SessionView } from "@/lib/types";

export interface WaitingInfo {
  ids: string[];
  names: string[];
  /** Epoch ms the wait began. */
  sinceMs: number;
}

/** "45s", "2m 10s", "1h 05m": a ticking timer that stays short. */
export function formatWaitElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The session's open wait, or null when it is not blocked on anything. */
export function waitingInfo(s: Pick<SessionView, "waiting_on" | "waiting_since"> | null | undefined): WaitingInfo | null {
  if (!s?.waiting_on?.length) return null;
  const sinceMs = s.waiting_since ? Date.parse(s.waiting_since) : NaN;
  return { ids: s.waiting_on.map((w) => w.id), names: s.waiting_on.map((w) => w.name), sinceMs: Number.isNaN(sinceMs) ? Date.now() : sinceMs };
}

/** "api-head", "api-head, db-head", "api-head +2": never more than two names, however many heads are awaited. */
export function namesLabel(names: string[]): string {
  if (names.length <= 2) return names.join(", ");
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

/** "waiting on api-head, 2m 10s". `compact` drops the names for tight rows: "waiting 2m 10s". */
export function waitingText(w: WaitingInfo, now: number, opts: { compact?: boolean } = {}): string {
  const elapsed = formatWaitElapsed(now - w.sinceMs);
  return opts.compact ? `waiting ${elapsed}` : `waiting on ${namesLabel(w.names)}, ${elapsed}`;
}

/** Who is waiting on each head: head id -> the session blocked on it. Several waiters: the first wins. */
export function awaitedBy(sessions: Array<Pick<SessionView, "id" | "title" | "depth" | "waiting_on">>): Map<string, { waiter: string; title: string; depth: number }> {
  const out = new Map<string, { waiter: string; title: string; depth: number }>();
  for (const s of sessions) for (const w of s.waiting_on ?? []) if (!out.has(w.id)) out.set(w.id, { waiter: s.id, title: s.title, depth: s.depth });
  return out;
}

/** The tag on a head the lead (or its parent) is blocked on. */
export function awaitedLabel(by: { depth: number }): string {
  return by.depth === 0 ? "lead is waiting" : "parent is waiting";
}
