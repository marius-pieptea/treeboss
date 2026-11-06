import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { createLead, getSession, interrupt, interruptAll, recoverOnStartup, send, setTurnRunner, viewSession, wait } from "../src/sessions/manager";
import { JITTER_MAX_MS, awaitPark, dueParks, formatResumeAt, jitterMs, listParks, parkOf, releasePark, schedulePark, stopParkScheduler, tickParks, type ParkRow } from "../src/sessions/parks";
import { makeDir, resetState, settled } from "./helpers";

beforeEach(() => {
  resetState();
  setTurnRunner(null);
});

afterEach(async () => {
  // A parked turn is not stopped by interruptAll (it survives a restart), so the tests cancel their own parks.
  for (const r of listParks()) await interrupt({ operator: true }, r.session_id);
  await interruptAll();
  setTurnRunner(null);
  stopParkScheduler();
});

const lead = (prompt: string) => createLead({ prompt, engine: "fake", cwd: makeDir() });

/** The fake engine's FAIL line carrying a claude-style limit message, reset `secFromNow` seconds ahead. */
const limitFail = (secFromNow: number) => `FAIL Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + secFromNow}`;

async function untilParked(id: string): Promise<ParkRow> {
  for (let i = 0; i < 200 && !parkOf(id); i++) await new Promise((r) => setTimeout(r, 50));
  const p = parkOf(id);
  if (!p) throw new Error(`session ${id} never parked`);
  return p;
}

const row = (session_id: string, resume_at: number, over: Partial<ParkRow> = {}): Omit<ParkRow, "parked_at"> => ({
  session_id,
  turn_id: "t_test",
  resume_at,
  prompt: "SAY back",
  resume: false,
  reason: "usage limit reached",
  ...over,
});

describe("the park scheduler", () => {
  test("jitter is a small non-negative spread after the reset", () => {
    expect(jitterMs(() => 0)).toBe(0);
    expect(jitterMs(() => 0.5)).toBe(JITTER_MAX_MS / 2);
    expect(jitterMs(() => 0.9999)).toBeLessThan(JITTER_MAX_MS);
  });

  test("dueParks keeps the rows whose time has come, and only those", () => {
    const now = 1_000_000;
    const rows = [{ session_id: "a", resume_at: now - 1 }, { session_id: "b", resume_at: now }, { session_id: "c", resume_at: now + 1 }] as ParkRow[];
    expect(dueParks(rows, now).map((r) => r.session_id)).toEqual(["a", "b"]);
  });

  test("a park is stored, read back in wake-up order, and replaced by the next one for the session", async () => {
    const s = await settled(lead("SAY x").id);
    schedulePark(row(s.id, 2_000, { prompt: "first" }));
    schedulePark(row(s.id, 1_000, { prompt: "second", resume: true }));
    expect(listParks()).toHaveLength(1);
    expect(parkOf(s.id)).toMatchObject({ resume_at: 1_000, prompt: "second", resume: true, turn_id: "t_test" });
  });

  test("tickParks wakes only the due park; a not-yet-due one stays parked", async () => {
    const s = await settled(lead("SAY x").id);
    const other = await settled(lead("SAY y").id);
    schedulePark(row(s.id, 5_000));
    schedulePark(row(other.id, 500));
    const woken = awaitPark(other.id);
    expect(tickParks(1_000)).toBe(1);
    expect(await woken).toBe("due");
    expect(parkOf(other.id)).toBeNull();
    expect(parkOf(s.id)).not.toBeNull();
  });

  test("an interrupt cancels the park: the gate resolves cancelled and the row is dropped, so it is never woken", async () => {
    const s = await settled(lead("SAY x").id);
    schedulePark(row(s.id, 1_000));
    const controller = new AbortController();
    const gate = awaitPark(s.id, controller.signal);
    controller.abort();
    expect(await gate).toBe("cancelled");
    expect(parkOf(s.id)).toBeNull();
    expect(tickParks(10_000)).toBe(0);
  });

  test("an already-aborted signal cancels at once", async () => {
    const s = await settled(lead("SAY x").id);
    schedulePark(row(s.id, 1_000));
    const controller = new AbortController();
    controller.abort();
    expect(await awaitPark(s.id, controller.signal)).toBe("cancelled");
    expect(parkOf(s.id)).toBeNull();
  });

  test("releasePark without a waiting turn still drops the row, and says there was no gate", async () => {
    const s = await settled(lead("SAY x").id);
    schedulePark(row(s.id, 1_000));
    expect(releasePark(s.id, "due")).toBe(false);
    expect(parkOf(s.id)).toBeNull();
  });

  test("formatResumeAt gives a clock time today, and a date with it later", () => {
    const now = Date.parse("2026-10-18T10:00:00Z");
    const today = formatResumeAt(now + 3600_000, now);
    const later = formatResumeAt(now + 3 * 24 * 3600_000, now);
    expect(today).toMatch(/\d/);
    expect(later.length).toBeGreaterThan(today.length);
  });
});

describe("a session that hits a usage limit", () => {
  test("parks instead of failing: running, parked until the reset, the turn failed with the reason", async () => {
    const s0 = lead(limitFail(3600));
    const p = await untilParked(s0.id);
    expect(p.resume_at).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) * 1000 + 3600_000 - 2000);
    expect(p.resume_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) * 1000 + 3600_000 + JITTER_MAX_MS);

    const s = getSession(s0.id)!;
    expect(s.status).toBe("running");
    expect(s.last_error).toContain("parked");
    const view = viewSession(s);
    expect(view.status).toBe("running");
    expect(view.parked_until).toBe(new Date(p.resume_at).toISOString());
    const turn = db().prepare("SELECT status, error FROM turns WHERE session_id = ?").get(s.id) as any;
    expect(turn).toMatchObject({ status: "failed" });
    expect(turn.error).toContain("usage limit reached");
  });

  test("a parked session still blocks subagent_wait (it is not reported as finished)", async () => {
    const s0 = lead(limitFail(3600));
    await untilParked(s0.id);
    const res = await wait({ operator: true }, [s0.id], { timeoutSec: 1 });
    expect(res.timedOut).toBe(true);
    expect(getSession(s0.id)!.status).toBe("running");
  });

  test("an interrupt cancels the park: the session goes idle and nothing is sent again", async () => {
    const s0 = lead(limitFail(3600));
    await untilParked(s0.id);
    await interrupt({ operator: true }, s0.id);
    const s = getSession(s0.id)!;
    expect(s.status).toBe("idle");
    expect(s.last_error).toContain("interrupted");
    expect(parkOf(s0.id)).toBeNull();
    const turn = db().prepare("SELECT status FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(s0.id) as any;
    expect(turn.status).toBe("cancelled");
  });

  test("when the reset comes, the same prompt is sent again; if the limit still holds, it parks again", async () => {
    const s0 = lead(limitFail(3600));
    await untilParked(s0.id);
    // The scheduler's clock moves two hours on, but the engine's reset is an hour out in real time, so the resent
    // turn is still limited and parks again rather than failing or spinning.
    expect(tickParks(Date.now() + 2 * 3600_000)).toBe(1);
    expect(parkOf(s0.id)).toBeNull();
    await untilParked(s0.id);
    const turns = db().prepare("SELECT prompt, status FROM turns WHERE session_id = ? ORDER BY seq").all(s0.id) as Array<{ prompt: string; status: string }>;
    expect(turns).toHaveLength(2);
    expect(turns[1].prompt).toBe(turns[0].prompt);
    expect(turns.map((t) => t.status)).toEqual(["failed", "failed"]);
    expect(getSession(s0.id)!.status).toBe("running");
  });

  test("a limit whose reset is already past is not trusted: the session fails as before", async () => {
    const s = await settled(lead(limitFail(-60)).id);
    expect(s.status).toBe("failed");
    expect(parkOf(s.id)).toBeNull();
  });

  test("a limit with no reset time fails the session, as before", async () => {
    const s = await settled(lead("FAIL rate limit hit, try again later").id);
    expect(s.status).toBe("failed");
    expect(parkOf(s.id)).toBeNull();
  });

  test("a follow-up to a parked session is refused with the wake-up time", async () => {
    const s0 = lead(limitFail(3600));
    await untilParked(s0.id);
    expect(() => send({ operator: true }, s0.id, "SAY hi")).toThrow(/parked until/);
  });

  test("after a restart the park is re-armed from the DB and the prompt is sent when it is due", async () => {
    const s = await settled(lead("SAY first").id);
    expect(s.cli_session_id).toMatch(/^fake-/);
    // What a daemon killed while parked leaves behind: the session still running, its park row in the DB.
    db().exec(`UPDATE sessions SET status = 'running' WHERE id = '${s.id}'`);
    schedulePark(row(s.id, Date.now() - 1_000, { prompt: "SAY back again", resume: true }));
    const r = recoverOnStartup();
    expect(r.parked).toBe(1);
    expect(r.interrupted).toBe(0);
    expect(tickParks()).toBe(1);
    const after = await settled(s.id);
    expect(after.status).toBe("idle");
    expect(after.last_output).toBe("back again");
    expect(after.cli_session_id).toBe(s.cli_session_id);
  });

  test("a park whose session was closed meanwhile is dropped at startup, not re-armed", async () => {
    const s = await settled(lead("SAY x").id);
    schedulePark(row(s.id, Date.now() + 3600_000));
    db().exec(`UPDATE sessions SET status = 'closed' WHERE id = '${s.id}'`);
    const r = recoverOnStartup();
    expect(r.parked).toBe(0);
    expect(parkOf(s.id)).toBeNull();
  });
});
