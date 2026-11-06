/**
 * A session blocked in `subagent_wait`.
 *
 * Two jobs:
 *
 *  1. One model-visible call for the whole wait. A wait is split into daemon blocks of at most
 *     `wait_max_sec` (the HTTP server drops a silent connection after 255s). When a block times out with heads
 *     still running and budget left, the daemon answers `pending: <wait id>` and the MCP shim asks again with
 *     `_resume` (the same loop `plan_ask` uses). The agent sees ONE tool call that returns when its heads
 *     finish, instead of a "still running, call again" result, and a model turn, every 45 seconds. The budget
 *     for one call is `wait_total_sec`, or the agent's own `timeout_sec` when it gave one (clamped to that).
 *
 *  2. What the UI shows: while a wait is open (including the instants between blocks) the caller's view carries
 *     `waiting_on` / `waiting_since`, pushed over the live stream as a `wait` event.
 *
 * The record lives in memory, and each open wait is also persisted (session_waits) so a daemon restart can flag the
 * waits it cut short. The heads' results stay in the database, so a new subagent_wait still returns them. The
 * waiter's turn ending or being interrupted ends the wait at once (an abort leaves no timer behind).
 */
import { randomBytes } from "crypto";
import { db } from "../db";
import { getSetting } from "../settings";
import { Hub } from "./hub";
import { getSession, listForCaller, turnSignal, wait, SessionError, type Caller, type SessionRecord } from "./manager";

type Mode = "all" | "any";

interface WaitCall {
  id: string;
  caller: string;
  ids: string[];
  mode: Mode;
  since: number;
  deadline: number;
  /** Detaches this call's abort listener. */
  detach: () => void;
}

const calls = new Map<string, WaitCall>();

function announce(sessionId: string): void {
  const s = getSession(sessionId);
  if (s) Hub.publish({ type: "wait", sessionId, rootId: s.root_id });
}

function persist(call: WaitCall): void {
  db()
    .prepare("INSERT INTO session_waits (id, caller_id, ids_json, mode, since) VALUES (?, ?, ?, ?, ?)")
    .run(call.id, call.caller, JSON.stringify(call.ids), call.mode, new Date(call.since).toISOString());
}

function drop(call: WaitCall): void {
  if (!calls.delete(call.id)) return;
  db().prepare("DELETE FROM session_waits WHERE id = ?").run(call.id);
  call.detach();
  announce(call.caller);
}

/** End every wait a session has open (its turn ended, was interrupted, or the session closed). */
export function clearWaits(sessionId: string): void {
  for (const call of [...calls.values()]) if (call.caller === sessionId) drop(call);
}

/** Who this session is waiting on right now, or null. Several concurrent waits merge: earliest start, every id. */
export function waitingOf(sessionId: string): { waiting_on: Array<{ id: string; name: string }>; waiting_since: string } | null {
  let since = Infinity;
  const ids = new Set<string>();
  for (const call of calls.values()) {
    if (call.caller !== sessionId) continue;
    since = Math.min(since, call.since);
    for (const id of call.ids) ids.add(id);
  }
  if (ids.size === 0) return null;
  const waiting_on: Array<{ id: string; name: string }> = [];
  for (const id of ids) {
    const t = getSession(id);
    // A head that already finished is not what the lead is waiting for any more (mode "any", or "all" in progress).
    if (t && t.status === "running") waiting_on.push({ id, name: t.title || t.role || id });
  }
  if (waiting_on.length === 0) return null;
  return { waiting_on, waiting_since: new Date(since).toISOString() };
}

/** A wait that was open when the daemon died, as the waiter's view shows it. */
export interface InterruptedWait {
  id: string;
  ids: Array<{ id: string; name: string; status: string }>;
  mode: Mode;
  since: string;
  interrupted_at: string;
}

interface WaitRow {
  id: string;
  caller_id: string;
  ids_json: string;
  mode: Mode;
  since: string;
  interrupted_at: string | null;
}

function viewOf(r: WaitRow): InterruptedWait {
  const ids = (JSON.parse(r.ids_json) as string[]).map((id) => {
    const t = getSession(id);
    return { id, name: t ? t.title || t.role || id : id, status: t?.status ?? "missing" };
  });
  return { id: r.id, ids, mode: r.mode, since: r.since, interrupted_at: r.interrupted_at ?? "" };
}

/**
 * Called once at daemon start: every persisted wait still open was cut short by the restart. Marks them interrupted
 * and returns them (with the waiting session's id), so recovery can say so on that session.
 */
export function interruptWaitsOnStartup(): Array<{ caller: string; ids: string[]; mode: Mode }> {
  const open = (db().prepare("SELECT * FROM session_waits WHERE interrupted_at IS NULL").all() as WaitRow[]).filter((r) => !calls.has(r.id));
  const now = new Date().toISOString();
  const mark = db().prepare("UPDATE session_waits SET interrupted_at = ? WHERE id = ?");
  for (const r of open) mark.run(now, r.id);
  return open.map((r) => ({ caller: r.caller_id, ids: JSON.parse(r.ids_json) as string[], mode: r.mode }));
}

/** The wait this session had cut short by a restart, or null. Cleared when the session starts its next turn. */
export function waitInterruptedOf(sessionId: string): InterruptedWait | null {
  const r = db().prepare("SELECT * FROM session_waits WHERE caller_id = ? AND interrupted_at IS NOT NULL ORDER BY since DESC LIMIT 1").get(sessionId) as WaitRow | undefined;
  return r ? viewOf(r) : null;
}

/** A session starting a new turn has left any interrupted wait behind. */
export function forgetInterruptedWaits(sessionId: string): void {
  db().prepare("DELETE FROM session_waits WHERE caller_id = ? AND interrupted_at IS NOT NULL").run(sessionId);
}

/** Test and diagnostics: how many waits are open. */
export function openWaitCount(): number {
  return calls.size;
}

export type WaitOutcome =
  | { pending: string }
  | { pending?: undefined; sessions: SessionRecord[]; timedOut: boolean; aborted: boolean; elapsedMs: number; budgetSec: number };

const clampSec = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/**
 * One daemon block of a wait. Pass `resume` (the id from a `pending` answer) to carry on the same wait.
 * `timeoutSec` is the agent's own ceiling for the whole call; null uses `wait_total_sec`.
 */
export async function waitStep(
  input: { ids: string[]; mode: Mode; timeoutSec: number | null; resume: string | null },
  caller: Caller,
): Promise<WaitOutcome> {
  const total = getSetting("wait_total_sec") as number;
  const block = getSetting("wait_max_sec") as number;
  let call: WaitCall | null = null;
  const started = Date.now();

  if (input.resume) {
    call = calls.get(input.resume) ?? null;
    if (!call || call.caller !== caller.sessionId) throw new SessionError("That wait is no longer open (its turn ended or the daemon restarted). Call subagent_wait again.");
  }

  const ids = call ? call.ids : input.ids.length ? input.ids : listForCaller(caller).map((s) => s.id);
  const mode = call ? call.mode : input.mode;
  const budgetSec = clampSec(Number(input.timeoutSec ?? total) || total, 1, total);
  const deadline = call ? call.deadline : started + budgetSec * 1000;
  const signal = caller.sessionId ? turnSignal(caller.sessionId) : undefined;

  // Register before blocking (not for a wait with nothing running: it returns at once and would only flicker the UI).
  if (!call && caller.sessionId && ids.some((id) => getSession(id)?.status === "running")) {
    const id = `w_${randomBytes(6).toString("hex")}`;
    const onAbort = () => {
      const c = calls.get(id);
      if (c) drop(c);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    call = { id, caller: caller.sessionId, ids, mode, since: started, deadline, detach: () => signal?.removeEventListener("abort", onAbort) };
    calls.set(id, call);
    persist(call);
    announce(caller.sessionId);
  }

  let res;
  try {
    const remainingSec = Math.max((deadline - Date.now()) / 1000, 0);
    res = await wait(caller, ids, { timeoutSec: Math.min(remainingSec, block), mode, signal });
  } catch (err) {
    if (call) drop(call);
    throw err;
  }

  const stillRunning = res.sessions.some((s) => s.status === "running");
  // Budget left and the wait just hit its block limit: let the shim ask again, in this same model-visible call.
  if (call && res.timedOut && !res.aborted && stillRunning && deadline - Date.now() > 250) return { pending: call.id };

  if (call) drop(call);
  return { sessions: res.sessions, timedOut: res.timedOut, aborted: res.aborted, elapsedMs: Date.now() - (call?.since ?? started), budgetSec };
}
