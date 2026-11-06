/**
 * Rewind and fork, the two things an operator does with a checkpoint.
 *
 *  - rewind: put the session's own files back to how they were before a turn. Files only: the engine's
 *    memory of the turn stays, so the agent's next prompt starts with a notice saying what happened.
 *  - fork: open a NEW lead in its own worktree whose files start exactly at the end of a turn, briefed with the
 *    conversation up to that turn. The original session is untouched.
 */
import { db } from "../db";
import { clean } from "../util";
import { continuationPrompt } from "../sessions/handoff";
import { appendLog, createLead, getSession, isTurnLive, SessionError, type SessionRecord } from "../sessions/manager";
import { checkpointBefore, checkpointOfTurn, CheckpointError, rewindTo, setRewindNotice, type Checkpoint, type RewindResult } from "./store";

interface TurnRow {
  id: string;
  seq: number;
  prompt: string;
  output: string | null;
  status: string;
}

function turnRow(sessionId: string, turnId: string): TurnRow {
  const t = db().prepare("SELECT id, seq, prompt, output, status FROM turns WHERE session_id = ? AND id = ?").get(sessionId, turnId) as TurnRow | undefined;
  if (!t) throw new SessionError(`Session ${sessionId} has no turn "${turnId}".`);
  return t;
}

const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text);

export function rewindSession(sessionId: string, turnId: string): RewindResult & { turn: number } {
  const s = getSession(sessionId);
  if (!s) throw new SessionError(`No session "${sessionId}".`);
  if (s.status === "closed") throw new SessionError("This session is closed, and its checkpoints were removed when it closed.");
  if (s.status === "running" || isTurnLive(sessionId)) throw new SessionError("The session is working. Stop it first, then rewind.");
  const turn = turnRow(sessionId, turnId);
  const target = checkpointBefore(sessionId, turn.seq);
  if (!target) throw new SessionError(`There is no checkpoint from before turn ${turn.seq} (the directory may not be a git repository).`);
  let result: RewindResult;
  try {
    result = rewindTo(sessionId, s.cwd, target);
  } catch (err) {
    if (err instanceof CheckpointError) throw new SessionError(err.message);
    throw err;
  }
  setRewindNotice(
    sessionId,
    `[trb] The files in the working directory were rewound to how they were before your turn ${turn.seq}. Everything you changed in turn ${turn.seq} and after it is gone from disk, even though you remember doing it. Re-read what you need before editing, and do not assume those changes exist.`,
  );
  appendLog(s, s.last_turn_id, `[checkpoint] rewound to before turn ${turn.seq}: ${result.restored} file(s) restored, ${result.removed} removed${result.failed.length ? `, ${result.failed.length} could not be written (${result.failed.slice(0, 3).join(", ")})` : ""}. The state it replaced is saved as ${result.undo?.ref}.`, "info");
  return { ...result, turn: turn.seq };
}

/** The conversation up to and including `upTo`, from what trb stores. */
export function forkSummary(s: SessionRecord, upTo: number): string {
  const turns = (db().prepare("SELECT id, seq, prompt, output, status FROM turns WHERE session_id = ? AND seq <= ? ORDER BY seq").all(s.id, upTo) as TurnRow[]).filter((t) => t.status !== "running");
  const parts: string[] = [];
  parts.push(`## Goal\n${cut((turns[0]?.prompt ?? s.brief ?? s.title).trim(), 2500)}`);
  const later = turns.slice(1).filter((t) => t.prompt.trim());
  if (later.length) parts.push(`## Later requests\n${later.slice(-8).map((t) => `- (turn ${t.seq}) ${cut(t.prompt.replace(/\s+/g, " ").trim(), 220)}`).join("\n")}`);
  const answered = turns.filter((t) => t.output?.trim()).slice(-2);
  parts.push(`## Current state\n${answered.length ? answered.map((t) => `Turn ${t.seq} ended ${t.status}:\n${cut(t.output!.trim(), 1800)}`).join("\n\n") : "No answer was recorded yet."}`);
  parts.push(`The working files are exactly as they were at the end of turn ${upTo} of ${s.id}.`);
  return cut(parts.join("\n\n"), 8000);
}

export interface ForkInput {
  instructions?: string | null;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  agent?: string | null;
  pairId?: string | null;
}

export function forkSession(sessionId: string, turnId: string, input: ForkInput = {}): { session: SessionRecord; checkpoint: Checkpoint; turn: number } {
  const from = getSession(sessionId);
  if (!from) throw new SessionError(`No session "${sessionId}".`);
  if (from.depth > 0) throw new SessionError("Only a lead session can be forked.");
  const turn = turnRow(sessionId, turnId);
  if (from.status === "closed") throw new SessionError("This session is closed, and its checkpoints were removed when it closed.");
  const cp = checkpointOfTurn(sessionId, turnId);
  if (!cp) throw new SessionError(`Turn ${turn.seq} has no checkpoint (the directory may not be a git repository, or the turn is still running).`);

  const override = clean(input.engine);
  const switched = Boolean(override && override !== from.engine);
  const pairId = clean(input.pairId) ?? (override ? null : from.pair_id);
  const inherit = !pairId && !switched;
  const session = createLead({
    prompt: continuationPrompt(from, forkSummary(from, turn.seq), clean(input.instructions) ?? `Continue from the end of turn ${turn.seq}. Your files are as they were then. Try a different approach if the operator says so below; otherwise carry on with the open tasks.`),
    title: `Fork: ${from.title}`.slice(0, 100),
    engine: pairId && !override ? null : (override ?? from.engine),
    model: clean(input.model) ?? (inherit ? from.model : null),
    effort: clean(input.effort) ?? (inherit ? from.effort : null),
    pairId,
    agent: clean(input.agent) ?? from.agent,
    cwd: from.base_cwd,
    subagents: Boolean(from.subagents),
    isolate: true,
    startRef: cp.commit_sha,
  });
  db().prepare("UPDATE sessions SET handoff_from = ? WHERE id = ?").run(from.id, session.id);
  appendLog(from, from.last_turn_id, `[checkpoint] forked turn ${turn.seq} into ${session.id}.`, "info");
  return { session: getSession(session.id)!, checkpoint: cp, turn: turn.seq };
}
