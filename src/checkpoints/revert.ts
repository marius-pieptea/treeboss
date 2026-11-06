/**
 * Revert the last turn of a head: its files go back to how they were before that turn.
 *
 * Only files can be restored. No engine can roll back its own conversation (`conversationRollback` is false for all
 * of them), so the agent still remembers the turn it was reverted from. The rewind notice (see fork.ts) tells it
 * so on its next prompt. Because of that, the caller must say `filesOnly: true` to go ahead. Every refusal happens
 * before anything on disk is touched.
 */
import { db } from "../db";
import { getEngine } from "../engines/registry";
import { getSession, isTurnLive, SessionError } from "../sessions/manager";
import { rewindSession } from "./fork";

export function engineCanRollBack(engine: string): boolean {
  return getEngine(engine)?.conversationRollback === true;
}

export function revertLastTurn(sessionId: string, opts: { filesOnly?: boolean } = {}) {
  const s = getSession(sessionId);
  if (!s) throw new SessionError(`No session "${sessionId}".`);
  if (s.status === "running" || isTurnLive(sessionId)) throw new SessionError("The session is working. Stop it first, then revert.");
  if (!engineCanRollBack(s.engine) && opts.filesOnly !== true) {
    throw new SessionError(
      `Rolling back the conversation is not supported by the ${s.engine} engine, so a revert can only restore the files, and the agent would still remember the turn. To restore files only, send { "filesOnly": true }.`,
    );
  }
  const last = db().prepare("SELECT id FROM turns WHERE session_id = ? AND status != 'running' ORDER BY seq DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
  if (!last) throw new SessionError("This session has no finished turn to revert.");
  return rewindSession(sessionId, last.id);
}
