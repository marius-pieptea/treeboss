/**
 * Parked sessions: a turn that hit a usage or rate limit with a known reset time waits here until the window opens,
 * then the daemon sends the same prompt again.
 *
 * The state is the `session_parks` row (it survives a restart; sessions/manager.ts re-arms it on startup). While a
 * session is parked its sessions row stays `running` and its turn stays in flight, so subagent_wait keeps blocking
 * and interrupt cancels it, exactly as for a turn that is still working. The gate below is what the parked turn
 * waits on: it resolves "due" when the scheduler wakes it, or "cancelled" when the operator interrupts it.
 */
import { db } from "../db";

/** Spread of the wake-up after the reset, so many parked heads do not all come back in the same second. */
export const JITTER_MAX_MS = 30_000;
const TICK_MS = 15_000;

export interface ParkRow {
  session_id: string;
  turn_id: string;
  /** Epoch ms the turn is sent again (the reset time plus jitter). */
  resume_at: number;
  /** The prompt the interrupted turn was started with: sent again as it is. */
  prompt: string;
  /** Whether the re-sent turn resumes the engine's own session (false: a fresh conversation with the replayed thread). */
  resume: boolean;
  /** Why it parked, for the operator (the engine's own limit message, shortened). */
  reason: string;
  parked_at: string;
}

export type ParkOutcome = "due" | "cancelled";

interface RawRow extends Omit<ParkRow, "resume"> {
  resume: number;
}

const fromRaw = (r: RawRow): ParkRow => ({ ...r, resume: r.resume === 1 });

/** The gates of the turns parked in this process, by session. */
const gates = new Map<string, (outcome: ParkOutcome) => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

export function jitterMs(rand: () => number = Math.random): number {
  return Math.round(rand() * JITTER_MAX_MS);
}

export function parkOf(sessionId: string): ParkRow | null {
  const r = db().prepare("SELECT * FROM session_parks WHERE session_id = ?").get(sessionId) as RawRow | undefined;
  return r ? fromRaw(r) : null;
}

export function listParks(): ParkRow[] {
  return (db().prepare("SELECT * FROM session_parks ORDER BY resume_at").all() as RawRow[]).map(fromRaw);
}

/** The parks whose wake-up time has come. Pure: the caller decides what "now" is. */
export function dueParks(rows: ParkRow[], now: number): ParkRow[] {
  return rows.filter((r) => r.resume_at <= now);
}

/** Record a park (replacing any earlier one for the session) and make sure the scheduler is running. */
export function schedulePark(row: Omit<ParkRow, "parked_at">): void {
  db()
    .prepare(
      `INSERT INTO session_parks (session_id, turn_id, resume_at, prompt, resume, reason, parked_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET turn_id = excluded.turn_id, resume_at = excluded.resume_at, prompt = excluded.prompt,
         resume = excluded.resume, reason = excluded.reason, parked_at = excluded.parked_at`,
    )
    .run(row.session_id, row.turn_id, row.resume_at, row.prompt, row.resume ? 1 : 0, row.reason);
  startParkScheduler();
}

/**
 * Wait for a parked session to be woken or cancelled. An abort (interrupt, close) cancels it at once and drops the
 * park, so the cancelled turn is not woken later.
 */
export function awaitPark(sessionId: string, signal?: AbortSignal): Promise<ParkOutcome> {
  return new Promise<ParkOutcome>((resolve) => {
    const done = (outcome: ParkOutcome) => {
      if (gates.get(sessionId) !== done) return;
      gates.delete(sessionId);
      signal?.removeEventListener("abort", onAbort);
      if (outcome === "cancelled") db().prepare("DELETE FROM session_parks WHERE session_id = ?").run(sessionId);
      resolve(outcome);
    };
    const onAbort = () => done("cancelled");
    gates.set(sessionId, done);
    if (signal?.aborted) return done("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wake a parked session ("due": its row is removed and the gate opens) or drop it ("cancelled"). Returns whether a park existed. */
export function releasePark(sessionId: string, outcome: ParkOutcome): boolean {
  const gate = gates.get(sessionId);
  db().prepare("DELETE FROM session_parks WHERE session_id = ?").run(sessionId);
  if (!gate) return false;
  gate(outcome);
  return true;
}

/** One pass of the scheduler: wake every park whose time has come. Returns how many it woke. */
export function tickParks(now = Date.now()): number {
  let woke = 0;
  for (const row of dueParks(listParks(), now)) if (releasePark(row.session_id, "due")) woke++;
  return woke;
}

export function startParkScheduler(): void {
  if (ticker) return;
  ticker = setInterval(() => {
    try {
      tickParks();
    } catch (err: any) {
      console.warn(`[trb] park scheduler failed: ${err?.message ?? err}`);
    }
  }, TICK_MS);
  (ticker as any).unref?.();
}

export function stopParkScheduler(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

/** "14:05" when the reset is today, else "Oct 20 14:05". */
export function formatResumeAt(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
