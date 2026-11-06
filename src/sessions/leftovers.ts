/**
 * Processes an agent started in the background during a turn and left running once the turn ended: a dev server,
 * a watcher, a test runner, a browser. The engine runs in its own process group (see proctree.ts), so the group is
 * remembered per turn and reaped when its session closes, when the daemon starts over closed sessions, and on the
 * reaper's sweep once the session has been idle for `leftover_reap_hours`.
 *
 * Windows has no process groups, and a dead engine pid cannot be tree-killed with taskkill, so nothing is recorded
 * there: leftovers stay as they always were.
 *
 * The caller decides whether a session may be reaped (never while a turn of it is live). This module only signals
 * the groups it was given.
 */
import { db } from "../db";
import type { McpRunConfig } from "../engines/registry";
import { DETACH_GROUP, groupAlive, groupProcesses, groupProcessCount, signalGroup, type GroupProcess } from "../proctree";

/** How long a group gets to exit on SIGTERM before it is killed. */
export const GROUP_GRACE_MS = 1500;

/** Remember the process group of a turn's engine process, as soon as it is spawned. */
export function recordTurnGroup(sessionId: string, turnId: string, pid: number): void {
  if (!DETACH_GROUP) return;
  db().prepare("INSERT OR REPLACE INTO turn_groups (turn_id, session_id, pgid) VALUES (?, ?, ?)").run(turnId, sessionId, pid);
}

/**
 * Words that identify one MCP server's process: its command and its arguments, short words and flags left out.
 * A process matches when it has all the words of one signature.
 */
export function mcpSignatures(mcp: McpRunConfig): string[][] {
  const out: string[][] = [];
  for (const spec of Object.values(mcp)) {
    if (spec.type !== "stdio") continue;
    const sig = [spec.command, ...spec.args].filter((t) => t.length >= 4 && !t.startsWith("-"));
    if (sig.length) out.push(sig);
  }
  return out;
}

/** The processes of a group that are one of this turn's MCP servers (matched by command line), and what they started. */
export function mcpTree(procs: GroupProcess[], mcp: McpRunConfig, pgid: number): GroupProcess[] {
  const sigs = mcpSignatures(mcp);
  const seen = new Map<number, GroupProcess>();
  const queue = procs.filter((p) => p.pid !== pgid && sigs.some((sig) => sig.every((t) => p.args.includes(t))));
  for (const p of queue) seen.set(p.pid, p);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const p of procs) {
      if (p.ppid !== parent.pid || seen.has(p.pid)) continue;
      seen.set(p.pid, p);
      queue.push(p);
    }
  }
  return [...seen.values()];
}

/**
 * The turn's engine has settled. This turn's MCP servers are stopped now (they serve nothing once the engine is gone,
 * and they are large). If nothing else is left in its group the record is dropped; otherwise it is kept for the
 * reaper. Returns what is still running besides the MCP servers, and how many MCP processes were stopped.
 */
export function endTurnGroup(turnId: string, mcp: McpRunConfig = {}): { left: number; mcpStopped: number } {
  const row = db().prepare("SELECT pgid FROM turn_groups WHERE turn_id = ?").get(turnId) as { pgid: number } | undefined;
  if (!row) return { left: 0, mcpStopped: 0 };
  const procs = groupProcesses(row.pgid);
  if (!procs) {
    const left = groupProcessCount(row.pgid);
    if (left === 0) forgetGroup(turnId);
    return { left, mcpStopped: 0 };
  }
  const mcpProcs = mcpTree(procs, mcp, row.pgid);
  if (mcpProcs.length) stopProcesses(mcpProcs.map((p) => p.pid));
  const left = procs.length - mcpProcs.length;
  if (left === 0) forgetGroup(turnId);
  return { left, mcpStopped: mcpProcs.length };
}

/** SIGTERM the given processes, SIGKILL those still alive after the grace. */
function stopProcesses(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }, GROUP_GRACE_MS).unref?.();
}

/** Sessions that have remembered groups, with the time their last turn finished (null: none has). */
export function sessionsWithGroups(): Array<{ session_id: string; status: string; last_turn_end: string | null }> {
  return db()
    .prepare(
      `SELECT s.id AS session_id, s.status AS status,
              (SELECT MAX(t.finished_at) FROM turns t WHERE t.session_id = s.id) AS last_turn_end
         FROM sessions s
        WHERE EXISTS (SELECT 1 FROM turn_groups g WHERE g.session_id = s.id)`,
    )
    .all() as Array<{ session_id: string; status: string; last_turn_end: string | null }>;
}

/**
 * Stop every group a session's turns left running: SIGTERM now, SIGKILL after the grace. A group is forgotten once it
 * is gone. The caller must not pass a session with a live turn. Logs one line through `log` when anything was running.
 */
export function reapGroups(sessionId: string, why: string, log: (text: string) => void): { processes: number; groups: number } {
  const rows = db().prepare("SELECT turn_id, pgid FROM turn_groups WHERE session_id = ?").all(sessionId) as Array<{ turn_id: string; pgid: number }>;
  let processes = 0;
  let groups = 0;
  for (const row of rows) {
    const count = groupProcessCount(row.pgid);
    if (count === 0) {
      forgetGroup(row.turn_id);
      continue;
    }
    processes += count;
    groups++;
    signalGroup(row.pgid, "SIGTERM");
    setTimeout(() => {
      if (groupAlive(row.pgid)) signalGroup(row.pgid, "SIGKILL");
      forgetGroup(row.turn_id);
    }, GROUP_GRACE_MS).unref?.();
  }
  if (processes) log(`[trb] stopped ${processes} background process(es) in ${groups} group(s) left by earlier turns (${why}).`);
  return { processes, groups };
}

function forgetGroup(turnId: string): void {
  try {
    db().prepare("DELETE FROM turn_groups WHERE turn_id = ?").run(turnId);
  } catch {
    // The database may already be closed (a test tore it down, or the daemon is stopping): nothing left to forget.
  }
}
