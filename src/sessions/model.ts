/**
 * Changing a session's model between turns, on the same engine.
 *
 * The model lives on the session row and every turn reads it, so a switch is one UPDATE plus a log line: the next
 * turn passes `--model` next to its resume flag. Only the operator can do this (HTTP/CLI); the subagent tools do
 * not expose it. A session governed by a Hydra pair keeps the pair's model.
 */
import { db } from "../db";
import { effortsFor, listModels } from "../engines/models";
import { Hub } from "./hub";
import { appendLog, getSession, SessionError, type SessionRecord } from "./manager";
import { modelLock } from "./modellock";

export interface ModelSwitchInput {
  /** A model id, or "default" / "" / null for the engine's own default. */
  model?: string | null;
  /** An effort level, "" / null to clear it; omitted leaves it alone. */
  effort?: string | null;
  /** The operator overrides a pair's model for this one session (heads and the pair itself are untouched). */
  force?: boolean;
}

export interface ModelSwitchResult {
  session: SessionRecord;
  from: string | null;
  to: string | null;
  /** Set when the id is not in the engine's catalog (the catalog may be incomplete): the switch went through. */
  warning: string | null;
  /** The next turn re-reads the whole conversation without the prompt cache. */
  uncached_next_turn: boolean;
  context_tokens: number | null;
}

const isDefault = (m: string | null | undefined) => !m || m === "default" || m === "auto";
const label = (m: string | null) => m ?? "default";

export async function setSessionModel(id: string, input: ModelSwitchInput): Promise<ModelSwitchResult> {
  const s = getSession(id);
  if (!s) throw new SessionError(`No session "${id}".`);
  const lock = modelLock(s);
  const pairLocked = lock === "Set by the pair";
  // The pair owns its models against agents; the operator can still override it for one session, on purpose.
  if (lock && !(pairLocked && input.force)) throw new SessionError(pairLocked ? "Set by the pair: this session keeps the pair's model. Switching it detaches this session from the pair's model: confirm to override." : lock + ".");
  if (s.status === "running") throw new SessionError(`Session ${id} is working. Change the model between turns.`);

  const wantsModel = input.model !== undefined;
  const to = wantsModel ? (isDefault(input.model) ? null : String(input.model).trim()) : s.model;
  let warning: string | null = null;
  if (wantsModel && to) {
    const cat = await listModels(s.engine).catch(() => null);
    if (cat && cat.models.length && !cat.models.some((m) => m.id === to)) {
      warning = `"${to}" is not in ${s.engine}'s model list${cat.error ? ` (${cat.error})` : ""}; trying it anyway.`;
    }
  }

  let effort = s.effort;
  if (input.effort !== undefined) {
    const e = input.effort ? String(input.effort).trim() : null;
    const allowed = effortsFor(s.engine);
    if (e && allowed.length && !allowed.includes(e)) throw new SessionError(`Effort "${e}" is not one ${s.engine} accepts (${allowed.join(", ")}).`);
    if (e && !allowed.length) throw new SessionError(`${s.engine} has no effort control.`);
    effort = e;
  }

  const modelChanged = wantsModel && to !== s.model;
  const effortChanged = effort !== s.effort;
  if (!modelChanged && !effortChanged) return { session: s, from: s.model, to: s.model, warning, uncached_next_turn: false, context_tokens: s.context_tokens };

  db().prepare("UPDATE sessions SET model = ?, effort = ?, model_manual = 1, model_pending = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(to, effort, id);
  const next = getSession(id)!;
  const parts: string[] = [];
  if (modelChanged) parts.push(`Model changed: ${label(s.model)} → ${label(to)}`);
  if (effortChanged) parts.push(`Effort changed: ${s.effort ?? "default"} → ${effort ?? "default"}`);
  appendLog(next, null, `[model] ${parts.join("; ")} (applies to the next turn)${pairLocked ? "; pair model overridden by the operator" : ""}`, "info");
  Hub.publish({ type: "state", sessionId: next.id, rootId: next.root_id, status: next.status });
  // A new model has no cache of this conversation. Effort alone keeps it, and a first turn has nothing to lose.
  const uncached = modelChanged && s.turns > 0;
  return { session: next, from: s.model, to, warning, uncached_next_turn: uncached, context_tokens: s.context_tokens };
}

