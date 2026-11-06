/**
 * Plan usage windows. Claude's come from its stream (`rate_limit_event`). Grok, Cursor and Codex are
 * read in `plan-read.ts` (Codex from its rollout JSONL), then stored here. The snapshot survives a restart.
 */
import { db } from "../db";

export interface LimitWindow {
  id: string;
  title: string;
  /** 0..100 used, or null when the event named the window without a number. */
  percent: number | null;
  /** Epoch seconds the window resets, or null. */
  resets_at: number | null;
  /** The engine's own status ("allowed", or a warning/rejection). */
  status: string | null;
  /** Epoch seconds this window was last reported. */
  at: number;
}

export interface EngineLimits {
  engine: string;
  /** The engine can report limits (so "nothing yet" is meaningful); false: it never does. */
  exposed: boolean;
  windows: LimitWindow[];
  updated_at: number | null;
}

/** Engines that report plan usage: Claude on its stream, Grok, Cursor and Codex via plan-read.ts. */
const REPORTS = new Set(["claude", "codex", "cursor", "grok"]);
export const exposesLimits = (engine: string): boolean => REPORTS.has(engine);

const TITLES: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly · all models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
};

const titleOf = (key: string): string => TITLES[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The windows in one claude `rate_limit_info`: every `unifiedWindows` entry, else the one window it names. */
export function parseRateLimitInfo(info: any, now = Math.floor(Date.now() / 1000)): LimitWindow[] {
  if (!info || typeof info !== "object") return [];
  const status = typeof info.status === "string" ? info.status : null;
  const out: LimitWindow[] = [];
  const unified = info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows : {};
  for (const [key, w] of Object.entries<any>(unified)) {
    const used = num(w?.utilization);
    out.push({ id: key, title: titleOf(key), percent: used === null ? null : Math.round(Math.min(1, Math.max(0, used)) * 1000) / 10, resets_at: num(w?.resetsAt), status, at: now });
  }
  if (!out.length && typeof info.rateLimitType === "string") {
    out.push({ id: info.rateLimitType, title: titleOf(info.rateLimitType), percent: null, resets_at: num(info.resetsAt), status, at: now });
  }
  return out;
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A codex window length as a stable id and the plan wording the card shows. */
function codexWindowName(mins: number | null): { id: string; title: string } {
  if (mins === null || mins <= 0) return { id: "limit", title: "Limit" };
  const m = Math.round(mins);
  if (m === 300) return { id: "five_hour", title: "5-hour limit" };
  if (m === 10_080) return { id: "weekly", title: "Weekly limit" };
  if (m === 43_200) return { id: "monthly", title: "Monthly limit" };
  if (m % 1_440 === 0) return { id: `days_${m / 1_440}`, title: `${m / 1_440}-day limit` };
  if (m < 60) return { id: `minutes_${m}`, title: `${m}-minute limit` };
  const hours = Math.round((m / 60) * 10) / 10;
  return { id: `hours_${String(hours).replace(".", "_")}`, title: `${hours}-hour limit` };
}

/**
 * The windows in one codex `rate_limits` object (from a rollout `token_count` event):
 * `primary` and `secondary`, each with `used_percent`, `window_minutes` and `resets_at`.
 * `at` is when the rollout reported the reading, in epoch seconds; a countdown starts from it.
 */
export function parseCodexRateLimits(rateLimits: unknown, at = Math.floor(Date.now() / 1000)): LimitWindow[] {
  const limits = record(rateLimits);
  if (!limits) return [];
  const out: LimitWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = record(limits[key]);
    if (!w) continue;
    const used = num(w.used_percent);
    const resetsIn = num(w.resets_in_seconds);
    const named = codexWindowName(num(w.window_minutes));
    out.push({
      id: named.id,
      title: named.title,
      percent: used === null ? null : Math.round(Math.min(100, Math.max(0, used)) * 10) / 10,
      resets_at: num(w.resets_at) ?? (resetsIn === null ? null : at + resetsIn),
      status: limits.spend_control_reached || (used !== null && used >= 100) ? "limit reached" : "allowed",
      at,
    });
  }
  return out;
}

/** A window that never said when it resets is not trusted for longer than this (seconds). */
const UNDATED_TTL = 60 * 60;

/** A reading is good until its window resets, or, with no reset time, for an hour. After that it is as good as unknown. */
const live = (w: LimitWindow, now: number): boolean => (w.resets_at !== null ? w.resets_at > now : now - w.at < UNDATED_TTL);

function stored(engine: string): LimitWindow[] {
  const row = db().prepare("SELECT windows FROM engine_limits WHERE engine = ?").get(engine) as { windows: string } | undefined;
  try {
    return row ? (JSON.parse(row.windows) as LimitWindow[]) : [];
  } catch {
    return [];
  }
}

export function getLimits(engine: string, now = Math.floor(Date.now() / 1000)): EngineLimits {
  const windows = stored(engine).filter((w) => live(w, now));
  const updated = windows.reduce((m, w) => Math.max(m, w.at), 0);
  return { engine, exposed: exposesLimits(engine), windows, updated_at: updated || null };
}

function writeWindows(engine: string, windows: LimitWindow[]): void {
  db()
    .prepare("INSERT INTO engine_limits (engine, windows, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(engine) DO UPDATE SET windows = excluded.windows, updated_at = CURRENT_TIMESTAMP")
    .run(engine, JSON.stringify(windows));
}

/** Replace an engine's snapshot with a reading from plan-read.ts. An empty reading keeps the previous one. */
export function storeWindows(engine: string, windows: LimitWindow[]): void {
  if (!windows.length) return;
  writeWindows(engine, windows);
}

/** Fold readings into the stored snapshot: a window that is named replaces the old reading, the others stay. */
export function mergeWindows(engine: string, windows: LimitWindow[]): void {
  if (!windows.length) return;
  const byId = new Map(stored(engine).map((w) => [w.id, w]));
  for (const w of windows) byId.set(w.id, w);
  writeWindows(engine, [...byId.values()]);
}

/** Fold one event into the stored snapshot: a window it names replaces the old reading, the others stay. */
export function recordLimits(engine: string, info: unknown): void {
  if (!exposesLimits(engine)) return;
  mergeWindows(engine, parseRateLimitInfo(info));
}
