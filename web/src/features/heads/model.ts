/**
 * Pure logic behind the heads UI: tree shape, "ready to merge", the live activity line, totals, durations.
 * No React and no DOM here, so it is unit-tested directly (tests/web/heads.test.ts).
 */
import type { TranscriptItem } from "@/lib/transcript";
import type { SessionView } from "@/lib/types";

export interface HeadNode {
  head: SessionView;
  children: HeadNode[];
  /** 0 for a direct child of the root. */
  level: number;
}

/**
 * The root's descendants as a tree. `flat` is the server's children list (every descendant, any depth). Input
 * order is kept among siblings (the server sorts by creation), and a head whose parent is missing from the list
 * is attached to the root rather than dropped.
 */
export function buildTree(rootId: string, flat: SessionView[], opts: { includeClosed?: boolean } = {}): HeadNode[] {
  const keep = flat.filter((h) => opts.includeClosed || h.status !== "closed");
  const ids = new Set(keep.map((h) => h.id));
  const kids = new Map<string, SessionView[]>();
  for (const h of keep) {
    const parent = h.parent && (h.parent === rootId || ids.has(h.parent)) ? h.parent : rootId;
    kids.set(parent, [...(kids.get(parent) ?? []), h]);
  }
  const walk = (parent: string, level: number, seen: Set<string>): HeadNode[] =>
    (kids.get(parent) ?? [])
      .filter((h) => !seen.has(h.id))
      .map((head) => ({ head, level, children: walk(head.id, level + 1, new Set([...seen, head.id])) }));
  return walk(rootId, 0, new Set([rootId]));
}

export function flatten(nodes: HeadNode[]): SessionView[] {
  return nodes.flatMap((n) => [n.head, ...flatten(n.children)]);
}

/** Done, has work to show for it, isolated (so there is something to merge), and not yet merged. */
export function isMergeReady(h: SessionView): boolean {
  return h.status === "idle" && (h.finalized ?? true) && h.isolation === "worktree" && !h.merged && !!h.changes && h.changes.files > 0;
}

export function hasUnmergedWork(h: SessionView): boolean {
  return !h.merged && !!h.changes && h.changes.files > 0;
}

/** Settled, and nothing would be lost by closing it (no unmerged work). */
export function isFinished(h: SessionView): boolean {
  return (h.status === "idle" || h.status === "failed") && !hasUnmergedWork(h);
}

export interface Counts {
  total: number;
  working: number;
  idle: number;
  failed: number;
  ready: number;
  merged: number;
}

export function countHeads(heads: SessionView[]): Counts {
  const c: Counts = { total: heads.length, working: 0, idle: 0, failed: 0, ready: 0, merged: 0 };
  for (const h of heads) {
    if (h.status === "running") c.working++;
    else if (h.status === "failed") c.failed++;
    else if (h.status === "idle") c.idle++;
    if (isMergeReady(h)) c.ready++;
    if (h.merged) c.merged++;
  }
  return c;
}

export function totals(sessions: SessionView[]): { cost: number; input: number; output: number } {
  let cost = 0;
  let input = 0;
  let output = 0;
  for (const s of sessions) {
    cost += s.cost_usd ?? 0;
    input += s.tokens.input + s.tokens.cache_read;
    output += s.tokens.output;
  }
  return { cost, input, output };
}

export function formatElapsed(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Wall-clock seconds between two ISO/SQLite timestamps (turns table uses `YYYY-MM-DD HH:MM:SS` UTC). */
export function durationSec(start: string | null | undefined, end: string | null | undefined): number | null {
  const t = (v: string | null | undefined) => {
    if (!v) return NaN;
    return Date.parse(v.includes("T") ? v : `${v.replace(" ", "T")}Z`);
  };
  const a = t(start);
  const b = t(end);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 1000)) : null;
}

export interface Activity {
  kind: "tool" | "text" | "thinking";
  label: string;
  /** A tool call that has not returned yet: the line shimmers. */
  running: boolean;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function shortToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "").replace(/^trb\//, "").replace(/_/g, " ");
}

/**
 * What each session is doing right now, from the tail of the transcript: its latest tool call (running or just
 * finished), thinking spell, or text. One pass over the items, last one per session wins.
 */
export function activityBySession(items: TranscriptItem[]): Map<string, Activity> {
  const out = new Map<string, Activity>();
  for (const it of items) {
    if (it.type === "tool") out.set(it.session, { kind: "tool", label: oneLine(it.arg ? `${shortToolName(it.name)}: ${it.arg}` : shortToolName(it.name), 90), running: it.status === "running" });
    else if (it.type === "thinking") out.set(it.session, { kind: "thinking", label: "thinking…", running: it.active });
    else if (it.type === "text") {
      const first = it.text.split("\n").map((l) => l.trim()).find(Boolean);
      if (first) out.set(it.session, { kind: "text", label: oneLine(first, 90), running: false });
    } else if (it.type === "end" || it.type === "turn") out.delete(it.session);
  }
  return out;
}

/** Roles a pair offers, for the spawn dialog. */
export function pairRoles(pair: { mode: string; roles: Record<string, { engine?: string | null; model?: string | null; effort?: string | null; agent?: string | null; label?: string | null }> | null } | null | undefined) {
  if (!pair || pair.mode !== "roles" || !pair.roles) return [];
  return Object.entries(pair.roles).map(([id, cfg]) => ({ id, label: cfg.label || id, engine: cfg.engine ?? null, model: cfg.model ?? null, effort: cfg.effort ?? null, agent: cfg.agent ?? null }));
}

/** Compact "engine · model @effort" for a card. */
export function engineLabel(h: { engine: string; model: string | null; effort: string | null }): string {
  const model = h.model ? h.model.replace(/^claude-/, "").replace(/^gpt-/, "gpt-") : null;
  return [h.engine, model].filter(Boolean).join(" · ") + (h.effort ? ` @${h.effort}` : "");
}
