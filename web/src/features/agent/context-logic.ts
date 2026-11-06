/**
 * Pure logic behind the context meter and the handoff hint. No React, so it is unit-tested directly
 * (tests/web/context.test.ts).
 */
import type { SessionView } from "@/lib/types";

export type ContextLevel = "ok" | "warn" | "high" | "unknown";

/** "84k", "1.2M": the same short form the daemon writes into the compaction line. */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/** Amber from 70%, red from 90%. */
export function contextLevel(pct: number | null | undefined): ContextLevel {
  if (pct == null || !Number.isFinite(pct)) return "unknown";
  if (pct >= 0.9) return "high";
  if (pct >= 0.7) return "warn";
  return "ok";
}

export const HANDOFF_HINT_AT = 0.8;

/** Offer a handoff once the window is 80% full on a lead that can still take a turn. */
export function shouldHintHandoff(s: Pick<SessionView, "context" | "status" | "depth"> | null | undefined): boolean {
  const pct = s?.context?.pct;
  return !!s && s.depth === 0 && s.status !== "closed" && pct != null && pct >= HANDOFF_HINT_AT;
}

export interface MeterModel {
  level: ContextLevel;
  /** "84k / 200k", "84k" when the window is unknown. */
  label: string;
  /** 0..1 for the ring; 0 when unknown. */
  fill: number;
  title: string;
}

/** What the meter shows for a session; null when the engine has reported nothing, so the composer stays quiet. */
export function meterModel(s: Pick<SessionView, "context" | "compactions"> | null | undefined): MeterModel | null {
  const c = s?.context;
  if (!c) return null;
  const pct = c.pct ?? null;
  const label = c.max ? `${fmtTokens(c.tokens)} / ${fmtTokens(c.max)}` : fmtTokens(c.tokens);
  const parts = [`${c.tokens.toLocaleString()} tokens of context${c.max ? ` (${Math.round((pct ?? 0) * 100)}% of ${c.max.toLocaleString()})` : ""}`];
  if (c.approx) parts.push("approximate: this engine reports per-turn totals");
  if (s?.compactions) parts.push(`compacted ${s.compactions}×`);
  return { level: contextLevel(pct), label, fill: pct ?? 0, title: parts.join(" · ") };
}

/** The breakdown rows for the popover, largest first, zeros dropped. */
export function breakdownRows(s: Pick<SessionView, "context"> | null | undefined): Array<{ key: string; label: string; tokens: number }> {
  const b = s?.context?.breakdown;
  if (!b) return [];
  return [
    { key: "cache_read", label: "Cached input", tokens: b.cache_read },
    { key: "cache_creation", label: "Newly cached", tokens: b.cache_creation },
    { key: "input", label: "Fresh input", tokens: b.input },
    { key: "output", label: "Last reply", tokens: b.output },
  ]
    .filter((r) => r.tokens > 0)
    .sort((a, z) => z.tokens - a.tokens);
}

/** Tailwind classes per level, so the ring, the label and the sessions list agree. */
export const LEVEL_TEXT: Record<ContextLevel, string> = { ok: "text-fg-muted", warn: "text-amber", high: "text-red", unknown: "text-fg-faint" };
export const LEVEL_STROKE: Record<ContextLevel, string> = { ok: "stroke-accent", warn: "stroke-amber", high: "stroke-red", unknown: "stroke-fg-faint" };
export const LEVEL_BG: Record<ContextLevel, string> = { ok: "bg-accent", warn: "bg-amber", high: "bg-red", unknown: "bg-fg-faint" };
