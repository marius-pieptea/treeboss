/** Pure helpers for session search and replay. No React, so they are easy to reason about. */

export interface TranscriptHit {
  session_id: string;
  root_id: string;
  seq: number;
  role: "user" | "assistant" | "tool";
  snippet: string;
  title: string;
  engine: string;
  base_cwd: string;
  started_at: string;
  depth: number;
}

export interface Filters {
  workspace: string;
  engine: string;
  /** `YYYY-MM-DD` or "". */
  since: string;
  until: string;
}

export const NO_FILTERS: Filters = { workspace: "", engine: "", since: "", until: "" };

/** The daemon wraps matched words in U+0001 and U+0002. */
export function splitSnippet(s: string): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let hit = false;
  let buf = "";
  for (const ch of s) {
    if (ch === "\u0001" || ch === "\u0002") {
      if (buf) out.push({ text: buf, hit });
      buf = "";
      hit = ch === "\u0001";
    } else buf += ch;
  }
  if (buf) out.push({ text: buf, hit });
  return out;
}

export function searchUrl(q: string, f: Filters): string {
  const p = new URLSearchParams({ q });
  for (const k of ["workspace", "engine", "since", "until"] as const) if (f[k]) p.set(k, f[k]);
  return `/api/search/sessions?${p.toString()}`;
}

export const exportUrl = (sessionId: string) => `/api/search/sessions/${encodeURIComponent(sessionId)}/export.html`;

export const ROLE_LABEL: Record<TranscriptHit["role"], string> = { user: "You", assistant: "Agent", tool: "Tools" };

/** `YYYY-MM-DD` for `days` ago (UTC, matching what the daemon compares against). */
export function daysAgo(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Group hits by session, keeping the order the best hit of each first appeared. */
export function groupBySession(hits: TranscriptHit[]): Array<{ session_id: string; title: string; engine: string; base_cwd: string; hits: TranscriptHit[] }> {
  const map = new Map<string, { session_id: string; title: string; engine: string; base_cwd: string; hits: TranscriptHit[] }>();
  for (const h of hits) {
    const g = map.get(h.session_id) ?? { session_id: h.session_id, title: h.title, engine: h.engine, base_cwd: h.base_cwd, hits: [] };
    g.hits.push(h);
    map.set(h.session_id, g);
  }
  return [...map.values()];
}
