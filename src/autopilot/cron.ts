/**
 * A five-field cron expression (minute hour day-of-month month day-of-week), in the daemon's local time.
 *
 * Each field takes `*`, a number, a range `a-b`, a list of those separated by commas, and a step `/n` after
 * a `*` or a range (`*\/15`, `1-5/2`). Day-of-week is 0-6 with Sunday as 0 or 7. Names (`mon`, `jan`) are not
 * accepted: an expression that means something else in another tool should fail here, not run at the wrong time.
 *
 * Day-of-month and day-of-week follow the usual rule: when both are restricted, a day matches if either does.
 * That is the rule every cron implementation shares, so `0 9 1 * 1` runs on the 1st and on each Monday.
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Whether the day-of-month field was `*` (unrestricted). */
  domStar: boolean;
  dowStar: boolean;
}

const RANGES: Array<[string, number, number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day-of-month", 1, 31],
  ["month", 1, 12],
  ["day-of-week", 0, 7],
];

function field(raw: string, lo: number, hi: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`The ${name} field "${raw}" is not valid.`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(step) || step < 1) throw new Error(`The step in the ${name} field "${raw}" must be a whole number of at least 1.`);
    let from: number;
    let to: number;
    if (m[1] === "*") {
      from = lo;
      to = hi;
    } else if (m[1].includes("-")) {
      [from, to] = m[1].split("-").map(Number);
    } else {
      from = Number(m[1]);
      // A bare number with a step ("5/15") runs from that number to the end of the range.
      to = m[2] === undefined ? from : hi;
    }
    if (from < lo || to > hi || from > to) throw new Error(`The ${name} field "${raw}" must be between ${lo} and ${hi}.`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** Parse a five-field expression. Throws an Error that says which field is wrong. */
export function parseCron(expr: string): CronSpec {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === "") throw new Error(`A cron expression has five fields (minute hour day month weekday), got ${parts.length}.`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, RANGES[i][1], RANGES[i][2], RANGES[i][0]));
  const dowSet = new Set([...dow].map((d) => (d === 7 ? 0 : d)));
  return { minute, hour, dom, month, dow: dowSet, domStar: parts[2].startsWith("*"), dowStar: parts[4].startsWith("*") };
}

export function cronMatches(c: CronSpec, d: Date): boolean {
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk;
}

/** The first minute strictly after `after` that the expression matches. Throws when none falls within the next five years. */
export function nextRun(expr: string, after: Date): Date {
  const c = parseCron(expr);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = 5 * 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`"${expr}" never runs.`);
}
