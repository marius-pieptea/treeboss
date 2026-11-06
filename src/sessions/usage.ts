/**
 * Context-size bookkeeping for sessions: how full the engine's window is right now, and how often it
 * compacted. The stream parser produces readings (`engines/context.ts`); this stores them on the session
 * row, publishes them so the UI's meter moves while a turn runs, and shapes them for the API.
 */
import { db } from "../db";
import { canCompact, contextWindow, type ContextSample, type UsageEvent } from "../engines/context";
import { recordLimits } from "../engines/limits";
import { getSetting } from "../settings";
import { Hub } from "./hub";

type Ref = { id: string; root_id: string; engine: string; model: string | null };

export interface ContextView {
  /** Tokens the next request starts from. */
  tokens: number;
  /** The window, or null when no table entry or engine report covers this model. */
  max: number | null;
  /** 0..1, or null without a window. */
  pct: number | null;
  breakdown: { input: number; cache_read: number; cache_creation: number; output: number };
  /** An upper bound rather than a single request's size (codex reports per-turn totals). */
  approx: boolean;
  updated_at: string | null;
}

export interface SessionContext {
  /** null: this engine reported nothing (yet). */
  context: ContextView | null;
  compactions: number;
  /** The engine takes `/compact`, so the UI can offer the button. */
  can_compact: boolean;
}

/** Window to measure against: the operator's override, else what the engine said, else the model table. */
export function windowFor(ref: Pick<Ref, "engine" | "model">, reported?: number | null): number | null {
  const override = getSetting("context_window") as number;
  if (override > 0) return Math.round(override);
  if (reported && reported > 0) return Math.round(reported);
  return contextWindow(ref.engine, ref.model);
}

export function recordContext(ref: Ref, sample: ContextSample): void {
  const max = windowFor(ref, sample.window);
  const detail = { input: sample.input, cache_read: sample.cacheRead, cache_creation: sample.cacheCreation, output: sample.output, approx: Boolean(sample.approx) };
  db()
    .prepare("UPDATE sessions SET context_tokens = ?, context_max = ?, context_json = ?, context_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(sample.tokens, max, JSON.stringify(detail), ref.id);
  Hub.publish({ type: "context", sessionId: ref.id, rootId: ref.root_id, tokens: sample.tokens, max });
}

export function recordUsageEvent(ref: Ref, e: UsageEvent): void {
  if (e.kind === "context") return recordContext(ref, e.sample);
  if (e.kind === "limits") return recordLimits(ref.engine, e.info);
  db().prepare("UPDATE sessions SET compactions = compactions + 1 WHERE id = ?").run(ref.id);
  // The window just shrank: the meter should show the post-compaction size at once, not at the next message.
  if (e.to != null) {
    db().prepare("UPDATE sessions SET context_tokens = ?, context_at = CURRENT_TIMESTAMP WHERE id = ?").run(e.to, ref.id);
  }
  const row = db().prepare("SELECT context_tokens, context_max FROM sessions WHERE id = ?").get(ref.id) as { context_tokens: number | null; context_max: number | null } | undefined;
  Hub.publish({ type: "context", sessionId: ref.id, rootId: ref.root_id, tokens: row?.context_tokens ?? 0, max: row?.context_max ?? null, compacted: true });
}

interface Row {
  engine: string;
  model: string | null;
  context_tokens: number | null;
  context_max: number | null;
  context_json: string | null;
  context_at: string | null;
  compactions: number | null;
}

/** The context block of a session view. The window is re-derived on read so an override applies at once. */
export function contextOf(s: Row): SessionContext {
  const can = canCompact(s.engine);
  const compactions = s.compactions ?? 0;
  if (s.context_tokens == null) return { context: null, compactions, can_compact: can };
  let d: any = {};
  try {
    d = s.context_json ? JSON.parse(s.context_json) : {};
  } catch {}
  const max = windowFor(s, s.context_max);
  return {
    context: {
      tokens: s.context_tokens,
      max,
      pct: max ? Math.min(1, s.context_tokens / max) : null,
      breakdown: { input: d.input ?? 0, cache_read: d.cache_read ?? 0, cache_creation: d.cache_creation ?? 0, output: d.output ?? 0 },
      approx: Boolean(d.approx),
      updated_at: s.context_at,
    },
    compactions,
    can_compact: can,
  };
}
