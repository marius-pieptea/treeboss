/**
 * How big an engine's context window is, and how to read a "context used" number out of a stream.
 *
 * The number is what the NEXT request will start from: for claude, the last assistant message's
 * input + cache read + cache creation + output. It is not a running sum of turns (that is `cliUsage`,
 * which feeds cost). Engines that do not report enough get `null`, and the UI says "unknown" rather
 * than guessing.
 */

/** One reading of how full the context is. `window` is set when the engine told us its own size. */
export interface ContextSample {
  tokens: number;
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  /** The engine's own window size, when its stream carried one (claude `modelUsage`, codex `token_count`). */
  window?: number | null;
  /** Derived from per-turn totals rather than a single request: an upper bound, not exact. */
  approx?: boolean;
}

/** What the stream parser tells its owner as a turn runs. */
export type UsageEvent = { kind: "context"; sample: ContextSample } | { kind: "limits"; info: unknown } | { kind: "compact"; from: number | null; to: number | null; trigger?: string | null };

export const DEFAULT_WINDOW = 200_000;

/** Model-id fragments by family, checked in order. Longest evidence wins: an explicit `[1m]` beats the family. */
export function contextWindow(engine: string, model: string | null | undefined, override = 0): number | null {
  if (override > 0) return Math.round(override);
  const m = (model ?? "").toLowerCase();
  const explicit = /\[(\d+(?:\.\d+)?)(k|m)\]/.exec(m);
  if (explicit) return Math.round(Number(explicit[1]) * (explicit[2] === "m" ? 1_000_000 : 1_000));
  switch (engine) {
    case "claude":
      // The 5-5 family (opus, sonnet, haiku) all run on a 1M window; bare aliases resolve to it.
      if (/-5-5/.test(m) || /^(opus|sonnet|haiku)$/.test(m)) return 1_000_000;
      return DEFAULT_WINDOW;
    case "fake":
      return DEFAULT_WINDOW;
    case "codex":
      return 400_000;
    case "cursor":
      if (/gpt-5|codex/.test(m)) return 400_000;
      if (/gemini/.test(m)) return 1_000_000;
      return DEFAULT_WINDOW;
    case "agy":
      return 1_000_000;
    case "grok":
      // xAI's pricing table: 4.3 and 4.20 run on 1M, 4.5 to 4.7 on 500k; grok-build and anything unlisted on 256k.
      if (/grok-4\.(20|3)(?!\d)/.test(m)) return 1_000_000;
      if (/grok-4\.[5-7](?!\d)/.test(m)) return 500_000;
      return 256_000;
    default:
      if (/gpt-5|codex/.test(m)) return 400_000;
      if (/gemini/.test(m)) return 1_000_000;
      if (/claude|opus|sonnet|haiku|fable/.test(m)) return DEFAULT_WINDOW;
      return null;
  }
}

/** Engines whose CLI takes `/compact` as a prompt. Others have no manual compaction we can drive. */
export function canCompact(engine: string): boolean {
  return engine === "claude" || engine === "fake";
}

/** "84k", "1.2M": the compact form the log line and the meter share. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/** The line the stream writes, and `classifyLine` reads back. One format, one place. */
export function compactLine(label: string, from: number | null, to: number | null): string {
  return `[${label}] Context compacted: ${formatTokens(from)} → ${formatTokens(to)}`;
}

const COMPACT_RE = /Context compacted:\s*(\S+)\s*→\s*(\S+)/;

function parseTokens(s: string): number | null {
  const m = /^([\d.]+)([kM]?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "M" ? Math.round(n * 1_000_000) : m[2] === "k" ? Math.round(n * 1_000) : Math.round(n);
}

export function parseCompactLine(text: string): { from: number | null; to: number | null } | null {
  const m = COMPACT_RE.exec(text);
  return m ? { from: parseTokens(m[1]), to: parseTokens(m[2]) } : null;
}
