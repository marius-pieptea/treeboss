/**
 * Attach a Hydra pair to a lead session that already exists, or detach it.
 *
 * A session keeps its pair on the row, and a lead's turns read it every time (the heads and rules preamble goes in
 * front of each prompt, and `subagent_create` reads the parent's pair), so attaching is one UPDATE plus a log line.
 * The lead keeps its own engine and model: only the heads and the rules come from the pair. Heads already open keep
 * the pair they were created under.
 */
import { db } from "../db";
import { getEngine } from "../engines/registry";
import { HydraPairs } from "../hydra/pairs";
import { Hub } from "./hub";
import { appendLog, getSession, SessionError, type SessionRecord } from "./manager";

const modelOf = (m: string | null | undefined): string | null => (!m || m === "default" || m === "auto" ? null : m);

/**
 * `adoptLead`: the session takes the pair's lead model and effort, so it never shows one model while a pair says
 * another. That needs the pair's lead engine to be the session's own (engines cannot share a conversation).
 */
export function setSessionPair(id: string, pairId: string | null, opts: { adoptLead?: boolean } = {}): SessionRecord {
  const s = getSession(id);
  if (!s) throw new SessionError(`No session "${id}".`);
  if (s.status === "closed") throw new SessionError("This session is closed.");
  if (s.status === "running") throw new SessionError(`Session ${id} is working. Change the pair between turns.`);
  if (s.depth !== 0) throw new SessionError("Only a lead session can have a pair: a head follows the pair it was opened under.");
  const want = pairId && pairId.trim() ? pairId.trim() : null;
  if (want === (s.pair_id ?? null)) return s;

  let line: string;
  if (want) {
    const pair = HydraPairs.get(want);
    if (!pair) throw new SessionError(`No pair "${want}".`);
    if (opts.adoptLead && pair.lead_engine && pair.lead_engine !== s.engine) throw new SessionError(`${pair.title} leads with ${pair.lead_engine}, and this session runs on ${s.engine}. Continue with the pair in a new session instead.`);
    if (getEngine(s.engine)?.mcp === "none") throw new SessionError(`${s.engine} cannot call the subagent tools, so it cannot lead a pair. Hand the session off to an engine that can.`);
    line = opts.adoptLead
      ? `[pair] Hydra pair attached: ${pair.title}. The lead now follows the pair's model; heads and rules apply from the next turn.`
      : `[pair] Hydra pair attached: ${pair.title}. This session keeps its own engine and model; heads and rules follow the pair from the next turn.`;
  } else {
    line = `[pair] Hydra pair detached. Heads already open keep running; new ones are no longer constrained by a pair.`;
  }
  // `subagents` gates the subagent tools and the pair preamble: a lead started without heads gets them now.
  db().prepare("UPDATE sessions SET pair_id = ?, subagents = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(want, want ? 1 : s.subagents, id);
  if (want && opts.adoptLead) {
    const pair = HydraPairs.get(want)!;
    const model = modelOf(pair.lead_model) ?? s.model;
    const effort = pair.lead_effort || s.effort;
    if (model !== s.model || effort !== s.effort) db().prepare("UPDATE sessions SET model = ?, effort = ?, model_pending = 1, model_manual = 0 WHERE id = ?").run(model, effort, id);
  }
  const next = getSession(id)!;
  appendLog(next, null, line, "info");
  Hub.publish({ type: "state", sessionId: next.id, rootId: next.root_id, status: next.status });
  return next;
}
