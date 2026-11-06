/**
 * When a usage or rate limit ends, as an engine reports it. Two sources, tried in order:
 *  - the engine's own rate-limit event (claude's `rate_limit_info` with status "rejected" and `resetsAt`, epoch seconds);
 *  - the failure text: an epoch after a pipe ("Claude AI usage limit reached|1760000000"), an ISO timestamp, or a
 *    clock time ("resets 3pm", "resets at 15:30 (Europe/Bucharest)", "resets Oct 20, 3pm").
 *
 * Returns epoch ms, or null when the text is not a limit or no reset time can be read. Null means the caller keeps
 * the plain failed behaviour: a session is only parked when the time it should wake is known.
 */

/** A reset further out than this is not trusted (the longest window is a week). */
export const MAX_PARK_MS = 8 * 24 * 3600 * 1000;

/** Failures that mean "the model never ran, and it will run again once the window resets". */
const LIMIT_RE = /limit (reached|hit|exceeded)|hit your (usage |rate |plan )?limit|rate[- ]?limited|too many requests|\b429\b/i;
/** Money limits do not reset on a timer the way usage windows do: never parked. */
const SPEND_RE = /spend limit|usage-credits|monthly (spend|usage) limit|insufficient (credit|quota|balance)|quota exceeded|out of credits|billing (hard )?limit/i;

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Epoch seconds or milliseconds, whichever the number is. */
const epochMs = (n: number): number => (n < 1e11 ? n * 1000 : n);

function inWindow(ms: number | null, now: number): number | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return ms > now && ms - now <= MAX_PARK_MS ? ms : null;
}

/** The offset (ms) of a zone from UTC at an instant, read from Intl. Throws on an unknown zone. */
function zoneOffsetMs(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** A wall-clock time in a zone (or the daemon's own zone) as an instant. */
function wallToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string | null): number {
  if (!tz) return new Date(y, mo, d, h, mi).getTime();
  // Two passes: the first offset is read at the naive instant, the second at the corrected one (they differ across a DST change).
  const guess = Date.UTC(y, mo, d, h, mi);
  return guess - zoneOffsetMs(guess - zoneOffsetMs(guess, tz), tz);
}

/** The calendar date "now" falls on in a zone (or locally). */
function todayIn(now: number, tz: string | null): { y: number; mo: number; d: number } {
  if (!tz) {
    const t = new Date(now);
    return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate() };
  }
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const get = (type: string) => Number(p.find((x) => x.type === type)?.value ?? 0);
  return { y: get("year"), mo: get("month") - 1, d: get("day") };
}

/** A clock time (optionally with a date and zone) from the text after "resets". Null when it reads as nothing sensible. */
function clockReset(m: RegExpExecArray, now: number): number | null {
  const groups = m.groups ?? {};
  let h = Number(groups.h);
  const mi = groups.min ? Number(groups.min) : 0;
  const ap = groups.ap?.toLowerCase().replace(/\./g, "");
  // A bare number ("resets 2 hours") is not a clock time: it needs am/pm, minutes or a zone.
  if (!ap && !groups.min && !groups.tz && !groups.tzw) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  }
  if (h > 23 || mi > 59) return null;
  const tz = (groups.tz ?? groups.tzw ?? null) || null;
  if (tz) {
    try {
      zoneOffsetMs(now, tz);
    } catch {
      return null;
    }
  }

  let y: number;
  let mo: number;
  let d: number;
  let explicitDate = false;
  if (groups.date) {
    const dm = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/.exec(groups.date);
    const month = dm ? MONTHS[dm[1].slice(0, 3).toLowerCase()] : undefined;
    if (!dm || month === undefined) return null;
    const today = todayIn(now, tz);
    y = dm[3] ? Number(dm[3]) : today.y;
    mo = month;
    d = Number(dm[2]);
    explicitDate = true;
  } else {
    const today = todayIn(now, tz);
    ({ y, mo, d } = today);
  }

  let at = wallToEpoch(y, mo, d, h, mi, tz);
  if (at <= now) {
    if (!explicitDate) {
      // "resets 3pm" said after 3pm means tomorrow's 3pm.
      const next = new Date(Date.UTC(y, mo, d + 1));
      at = wallToEpoch(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), h, mi, tz);
    } else if (!/\d{4}/.test(groups.date ?? "")) {
      // A month and day with no year that already passed means next year.
      at = wallToEpoch(y + 1, mo, d, h, mi, tz);
    }
  }
  return at;
}

const CLOCK_RE = /resets?(?:\s+at)?\s+(?:(?<date>[A-Za-z]{3,9}\.?\s+\d{1,2}(?:,?\s+\d{4})?)\s*,?\s+)?(?<h>\d{1,2})(?::(?<min>\d{2}))?\s*(?<ap>[ap]\.?m\.?)?(?:\s*\((?<tz>[A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC|GMT)\)|\s+(?<tzw>UTC|GMT)\b)?/i;

/** The reset time a limit failure's text names, as epoch ms, or null. */
export function limitResetAt(text: string, now = Date.now()): number | null {
  if (!text || SPEND_RE.test(text) || !LIMIT_RE.test(text)) return null;

  const iso = /resets?(?:\s+at)?\s*:?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso) {
    const ms = Date.parse(iso[1]);
    if (Number.isFinite(ms)) return inWindow(ms, now);
  }

  const epoch = /\|\s*(\d{10}|\d{13})\b/.exec(text) ?? /resets?(?:\s+at)?\s*:?\s*(\d{10}|\d{13})\b/i.exec(text);
  if (epoch) return inWindow(epochMs(Number(epoch[1])), now);

  const clock = CLOCK_RE.exec(text);
  if (clock) {
    try {
      return inWindow(clockReset(clock, now), now);
    } catch {
      return null; // an unknown zone name
    }
  }
  return null;
}

/** The reset time of an engine's rate-limit event (claude: `rate_limit_info`), or null unless it rejected the request. */
export function resetFromRateLimitEvent(info: unknown, now = Date.now()): number | null {
  if (!info || typeof info !== "object") return null;
  const i = info as { status?: unknown; resetsAt?: unknown };
  if (i.status !== "rejected" || typeof i.resetsAt !== "number") return null;
  return inWindow(epochMs(i.resetsAt), now);
}
