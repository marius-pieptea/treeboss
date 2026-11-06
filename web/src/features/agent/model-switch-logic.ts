/** Pure rules for the model chip of a session that already exists. */
import type { SessionView } from "@/lib/types";

/** The context size (tokens) from which a model switch gets a confirmation step: the next turn re-reads all of it uncached. */
export const CONFIRM_TOKENS = 50_000;

export type ModelChipState =
  | { kind: "locked"; reason: string }
  | { kind: "busy" }
  /** A pair's model: the operator may still override it for this session, after a confirmation. */
  | { kind: "pair" }
  | { kind: "switchable" };

export function modelChipState(s: Pick<SessionView, "status" | "model_lock">): ModelChipState {
  const pair = s.model_lock === "Set by the pair";
  if (s.model_lock && !pair) return { kind: "locked", reason: s.model_lock };
  if (s.status === "running") return { kind: "busy" };
  return pair ? { kind: "pair" } : { kind: "switchable" };
}

export const modelChipTitle = (st: ModelChipState, pending: boolean): string => {
  if (st.kind === "locked") return `${st.reason}. Start a new session to change the engine.`;
  if (st.kind === "pair") return "Run with a Hydra pair. Click to change or detach it. Start a new session to change the engine.";
  if (st.kind === "busy") return "Change the model between turns: wait for this one to finish. Start a new session to change the engine.";
  return pending ? "Model changed: applies to the next turn. Click to change it again. Start a new session to change the engine." : "Change the model for the next turn. Start a new session to change the engine.";
};

/** Whether picking another model should ask first: only when there is a big conversation to re-read without the cache. */
export const needsConfirm = (s: Pick<SessionView, "turns" | "context">, changesModel: boolean): boolean => changesModel && s.turns > 0 && (s.context?.tokens ?? 0) > CONFIRM_TOKENS;

export const compactTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export const uncachedNote = (s: Pick<SessionView, "turns" | "context">): string | null => {
  if (s.turns === 0) return null;
  const t = s.context?.tokens ?? 0;
  // A small conversation costs next to nothing to re-read: only name the size when it is worth knowing.
  return `Next turn re-reads the conversation without cache${t >= 10_000 ? ` (~${compactTokens(t)} tokens)` : ""}: costs more once.`;
};
