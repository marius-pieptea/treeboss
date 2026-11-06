/**
 * Turns a session tree's log lines into a transcript: what a chat UI renders.
 *
 * The daemon stores one typed line per event (see engines/classify.ts). A transcript is those lines
 * with each tool call merged with its result, thinking collapsed, and turn boundaries marked. Pure and
 * incremental: `appendLine` can be fed live, one line at a time, and gives the same result as replaying
 * the whole log.
 */
import type { LogLine, TurnRow } from "./types";

export type TranscriptItem =
  | { type: "user"; id: string; session: string; turnId: string; text: string }
  | { type: "turn"; id: string; session: string; turnId: string; n: number }
  | { type: "text"; id: string; session: string; turnId: string | null; text: string }
  | { type: "tool"; id: string; session: string; turnId: string | null; name: string; arg: string; status: "running" | "ok" | "err"; size?: string; detail?: string }
  | { type: "thinking"; id: string; session: string; turnId: string | null; active: boolean }
  | { type: "compact"; id: string; session: string; turnId: string | null; from: number | null; to: number | null }
  | { type: "note"; id: string; session: string; turnId: string | null; text: string; tone: "info" | "warn" }
  | { type: "end"; id: string; session: string; turnId: string | null; ok: boolean; text: string };

export interface TranscriptState {
  items: TranscriptItem[];
  /** Highest log id applied, so a reconnect can resume with `since`. */
  lastId: number;
  /** Per-session running tool calls (oldest first), to attach results to. */
  open: Record<string, number[]>;
  turnCount: Record<string, number>;
}

export const emptyTranscript = (): TranscriptState => ({ items: [], lastId: 0, open: {}, turnCount: {} });

const TURN_HEADER = /^\[trb\] s_[0-9a-f]+ \(.*\) — (turn \d+|follow-up|fresh retry)/;

/** Noise worth hiding: protocol chatter that tells a reader nothing. */
function isNoise(l: LogLine): boolean {
  const d = l.data?.detail ?? l.text;
  return /^session started/.test(d) || /^rate limit: allowed/.test(d) || /^\[trb\] .* in \//.test(l.text);
}

/** Close the session's live "thinking" marker: whatever the model does next (text, a tool call, the end) means it is no longer thinking. */
function endThinking(items: TranscriptItem[], session: string): void {
  for (let i = items.length - 1; i >= 0 && i >= items.length - 40; i--) {
    const it = items[i];
    if (it.type === "thinking" && it.active && it.session === session) items[i] = { ...it, active: false };
  }
}

/**
 * Apply one log line. Returns a new state; items are only appended or replaced, never reordered, so React
 * keys stay stable.
 */
export function appendLine(state: TranscriptState, l: LogLine): TranscriptState {
  if (l.id <= state.lastId) return state; // already applied (a reconnect replays an overlap)
  const items = state.items.slice();
  const open = { ...state.open };
  const turnCount = { ...state.turnCount };
  const turnId = l.turn_id ?? null;
  const kind = l.data?.kind ?? l.kind;
  const base = { id: `l${l.id}`, session: l.session, turnId };

  const last = items[items.length - 1];

  if (kind === "info" && TURN_HEADER.test(l.text)) {
    turnCount[l.session] = (turnCount[l.session] ?? 0) + 1;
    items.push({ type: "turn", ...base, turnId: turnId ?? "", n: turnCount[l.session] });
  } else if (kind === "info" && l.data?.compact) {
    items.push({ type: "compact", ...base, from: l.data.compact.from, to: l.data.compact.to });
  } else if (kind === "tool") {
    endThinking(items, l.session);
    const idx = items.length;
    items.push({ type: "tool", ...base, name: l.data?.name ?? "tool", arg: l.data?.arg ?? "", status: "running" });
    (open[l.session] ??= []).push(idx);
    open[l.session] = [...open[l.session]];
  } else if (kind === "tool_ok" || kind === "tool_err") {
    const queue = open[l.session] ?? [];
    const name = l.data?.name;
    // Results arrive in order for one session: match the oldest running call with this name, else the oldest.
    let at = queue.findIndex((i) => (items[i] as { name: string }).name === name);
    if (at === -1) at = queue.length ? 0 : -1;
    if (at !== -1) {
      const itemIdx = queue[at];
      const t = items[itemIdx] as Extract<TranscriptItem, { type: "tool" }>;
      items[itemIdx] = { ...t, status: kind === "tool_ok" ? "ok" : "err", size: l.data?.size, detail: l.data?.detail };
      open[l.session] = queue.filter((_, i) => i !== at);
    } else {
      // A result with no call we saw (joined mid-turn): show it standalone.
      items.push({ type: "tool", ...base, name: name ?? "tool", arg: "", status: kind === "tool_ok" ? "ok" : "err", size: l.data?.size, detail: l.data?.detail });
    }
  } else if (kind === "thinking") {
    if (last?.type === "thinking" && last.session === l.session && last.active) {
      /* collapse consecutive thinking */
    } else items.push({ type: "thinking", ...base, active: true });
  } else if (kind === "text") {
    endThinking(items, l.session);
    items.push({ type: "text", ...base, text: l.text });
  } else if (kind === "done" || kind === "fail") {
    items.push({ type: "end", ...base, ok: kind === "done", text: l.data?.detail ?? l.text });
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type === "thinking" && it.active && it.session === l.session) items[i] = { ...it, active: false };
    }
    open[l.session] = [];
  } else if (kind === "stderr") {
    items.push({ type: "note", ...base, text: l.data?.detail ?? l.text, tone: "warn" });
  } else if (!isNoise(l)) {
    items.push({ type: "note", ...base, text: l.data?.detail ?? l.text, tone: /^⚠|error|fail/i.test(l.text) ? "warn" : "info" });
  }
  return { items, lastId: l.id, open, turnCount };
}

export function buildTranscript(lines: LogLine[], turns: TurnRow[] = [], session?: string): TranscriptState {
  let state = emptyTranscript();
  const byTurn = new Map(turns.map((t) => [t.id, t]));
  const seenTurns = new Set<string>();
  for (const l of lines) {
    // A user prompt precedes the first line of each of this session's own turns.
    if (session && l.session === session && l.turn_id && !seenTurns.has(l.turn_id)) {
      seenTurns.add(l.turn_id);
      const t = byTurn.get(l.turn_id);
      if (t) state = { ...state, items: [...state.items, { type: "user", id: `u${t.id}`, session, turnId: t.id, text: t.prompt }] };
    }
    state = appendLine(state, l);
  }
  return state;
}

/** Collapse consecutive tool calls into one display group: "Ran 3 commands · Read 2 files". */
export interface ToolGroup {
  type: "tools";
  id: string;
  session: string;
  tools: Array<Extract<TranscriptItem, { type: "tool" }>>;
}
export type DisplayItem = Exclude<TranscriptItem, { type: "tool" }> | ToolGroup;

export function groupTools(items: TranscriptItem[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  for (const it of items) {
    if (it.type !== "tool") {
      out.push(it);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev?.type === "tools" && prev.session === it.session) prev.tools.push(it);
    else out.push({ type: "tools", id: `g${it.id}`, session: it.session, tools: [it] });
  }
  return out;
}

const VERBS: Record<string, [string, string]> = {
  Bash: ["ran a command", "ran {n} commands"],
  Read: ["read a file", "read {n} files"],
  Write: ["wrote a file", "wrote {n} files"],
  Edit: ["edited a file", "edited {n} files"],
  MultiEdit: ["edited a file", "edited {n} files"],
  Grep: ["searched", "searched {n} times"],
  Glob: ["listed files", "listed files {n} times"],
  WebFetch: ["fetched a page", "fetched {n} pages"],
  WebSearch: ["searched the web", "searched the web {n} times"],
  Task: ["delegated", "delegated {n} times"],
  TodoWrite: ["updated the plan", "updated the plan {n} times"],
};

/** "Ran 3 commands, read 2 files, edited a file": the one-line summary of a group. */
export function summarizeTools(tools: Array<{ name: string }>): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const parts = [...counts.entries()].map(([name, n]) => {
    const v = VERBS[name];
    if (v) return n === 1 ? v[0] : v[1].replace("{n}", String(n));
    const short = name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
    return n === 1 ? `called ${short}` : `called ${short} ×${n}`;
  });
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
