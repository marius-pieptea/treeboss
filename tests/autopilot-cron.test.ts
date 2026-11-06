import { describe, expect, test } from "bun:test";
import { cronMatches, nextRun, parseCron } from "../src/autopilot/cron";

/** A local-time date, so the tests do not depend on the machine's zone. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe("cron: parsing", () => {
  test("accepts stars, lists, ranges and steps", () => {
    const c = parseCron("*/15 9-17 1,15 * 1-5/2");
    expect([...c.minute]).toEqual([0, 15, 30, 45]);
    expect([...c.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...c.dow].sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  test("Sunday is 0 or 7", () => {
    expect(parseCron("0 0 * * 7").dow.has(0)).toBe(true);
    expect(parseCron("0 0 * * 0").dow.has(0)).toBe(true);
  });

  test("a bare number with a step runs to the end of the range", () => {
    expect([...parseCron("5/20 * * * *").minute]).toEqual([5, 25, 45]);
  });

  test("rejects the wrong number of fields", () => {
    expect(() => parseCron("* * * *")).toThrow(/five fields/);
    expect(() => parseCron("0 0 * * * *")).toThrow(/five fields/);
    expect(() => parseCron("")).toThrow(/five fields/);
  });

  test("rejects out-of-range values and names it cannot read", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/minute/);
    expect(() => parseCron("* 24 * * *")).toThrow(/hour/);
    expect(() => parseCron("* * 0 * *")).toThrow(/day-of-month/);
    expect(() => parseCron("* * * 13 *")).toThrow(/month/);
    expect(() => parseCron("* * * * mon")).toThrow(/day-of-week/);
    expect(() => parseCron("5-2 * * * *")).toThrow(/minute/);
  });

  test("rejects a zero or fractional step", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
    expect(() => parseCron("*/1.5 * * * *")).toThrow(/not valid|step/);
  });
});

describe("cron: matching", () => {
  test("day-of-month and day-of-week both restricted: either one matches", () => {
    // 2026-10-28 is a Wednesday; the 1st is a Thursday.
    const c = parseCron("0 9 1 * 1");
    expect(cronMatches(c, at(2026, 11, 1, 9))).toBe(true); // the 1st
    expect(cronMatches(c, at(2026, 11, 2, 9))).toBe(true); // a Monday
    expect(cronMatches(c, at(2026, 11, 3, 9))).toBe(false); // a Tuesday that is not the 1st
  });

  test("only one of them restricted: that one decides", () => {
    const weekdays = parseCron("0 9 * * 1");
    expect(cronMatches(weekdays, at(2026, 11, 2, 9))).toBe(true);
    expect(cronMatches(weekdays, at(2026, 11, 1, 9))).toBe(false);
    const dayOfMonth = parseCron("0 9 15 * *");
    expect(cronMatches(dayOfMonth, at(2026, 11, 15, 9))).toBe(true);
    expect(cronMatches(dayOfMonth, at(2026, 11, 16, 9))).toBe(false);
  });

  test("the minute and hour must both match", () => {
    const c = parseCron("30 14 * * *");
    expect(cronMatches(c, at(2026, 10, 28, 14, 30))).toBe(true);
    expect(cronMatches(c, at(2026, 10, 28, 14, 31))).toBe(false);
    expect(cronMatches(c, at(2026, 10, 28, 15, 30))).toBe(false);
  });
});

describe("cron: next run", () => {
  test("every 15 minutes, from mid-slot", () => {
    expect(nextRun("*/15 * * * *", at(2026, 10, 28, 10, 7)).getTime()).toBe(at(2026, 10, 28, 10, 15).getTime());
  });

  test("is strictly after the given time", () => {
    expect(nextRun("*/15 * * * *", at(2026, 10, 28, 10, 15)).getTime()).toBe(at(2026, 10, 28, 10, 30).getTime());
  });

  test("weekday mornings roll over the weekend", () => {
    // Friday 2026-10-30 after 9:00 -> Monday 2026-11-02 09:00
    expect(nextRun("0 9 * * 1", at(2026, 10, 30, 9, 0)).getTime()).toBe(at(2026, 11, 2, 9, 0).getTime());
  });

  test("crosses a year boundary", () => {
    expect(nextRun("0 0 1 1 *", at(2026, 12, 31, 23, 59)).getTime()).toBe(at(2027, 1, 1, 0, 0).getTime());
  });

  test("a date that never comes is reported, not looped forever", () => {
    expect(() => nextRun("0 0 31 2 *", at(2026, 1, 1))).toThrow(/never runs/);
  });
});
