/** Pure rules for ask answers: what a turn cost, which answer gets the follow-ups. */
import type { TurnRow } from "@/lib/types";

export const PLAN_FROM_ANSWER = "Turn the answer above into a plan.";

/** Tokens the turn consumed, from the engine's usage report (claude/codex shapes), or null when it gave none. */
export function usageTotals(json: string | null | undefined): { input: number; output: number } | null {
  if (!json) return null;
  let u: any;
  try {
    u = JSON.parse(json);
  } catch {
    return null;
  }
  if (!u || typeof u !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // The daemon stores the camelCase shape; the engines' own reports (snake_case) are read too.
  const input = n(u.inputTokens ?? u.input_tokens) + n(u.cacheReadInputTokens ?? u.cache_read_input_tokens) + n(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens) + n(u.cached_input_tokens);
  const output = n(u.outputTokens ?? u.output_tokens);
  return input + output > 0 ? { input, output } : null;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** "$0.0021 · 7.2k in · 310 out", as much of it as the turn reported. Empty when it reported nothing. */
export function costLine(turn: Pick<TurnRow, "cost_usd" | "usage_json">): string {
  const parts: string[] = [];
  if (turn.cost_usd && turn.cost_usd > 0) parts.push(turn.cost_usd < 0.01 ? `$${turn.cost_usd.toFixed(4)}` : `$${turn.cost_usd.toFixed(2)}`);
  const t = usageTotals(turn.usage_json);
  if (t) parts.push(`${k(t.input)} in`, `${k(t.output)} out`);
  return parts.join(" · ");
}

/** The finished ask turns by id: what the answer footers look up. */
export function askTurnsById(turns: TurnRow[] | undefined): Map<string, TurnRow> {
  const out = new Map<string, TurnRow>();
  for (const t of turns ?? []) if (t.mode === "ask" && t.status === "completed") out.set(t.id, t);
  return out;
}

/** The last text item of each turn (an answer can arrive as several text lines: the footer goes under the last). */
export function lastTextByTurn(items: Array<{ kind: string; id: string; turnId?: string | null }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of items) if (c.kind === "text" && c.turnId) out.set(c.turnId, c.id);
  return out;
}

/** Only the newest finished ask answer offers the follow-ups, and only while the session is idle. */
export function followUpsFor(turnId: string, asks: Map<string, TurnRow>, idle: boolean): boolean {
  if (!idle) return false;
  let newest: TurnRow | null = null;
  for (const t of asks.values()) if (!newest || t.seq > newest.seq) newest = t;
  return newest?.id === turnId;
}
