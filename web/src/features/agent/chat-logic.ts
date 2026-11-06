/**
 * Pure logic behind the Chat view, the shelf above the composer, the settings dot and the Chat | Trace choice.
 * No React here, so it is unit-tested directly (tests/web/chatui.test.ts).
 *
 * The Chat view is a calmer rendering of the same TranscriptItems the Trace view draws: nothing is stored or
 * fetched differently, things are only folded away (tool bursts, head activity) or hidden (turn dividers, notes).
 */
import type { TranscriptItem } from "@/lib/transcript";
import { parsePlanReadyLine } from "./plan-logic";
import { summarizeTools } from "@/lib/transcript";
import type { SessionView } from "@/lib/types";
import { activityBySession, isMergeReady, shortToolName, type Activity } from "@/features/heads/model";
import { waitingInfo } from "./waiting-logic";

type ToolItem = Extract<TranscriptItem, { type: "tool" }>;

/* ------------------------------------------------------------------ view mode (Chat | Trace) */

export type ViewMode = "chat" | "trace";

type Store = Pick<Storage, "getItem" | "setItem">;

const DEFAULT_KEY = "trb.agent.view.default";
const sessionKey = (sid: string) => `trb.agent.view.${sid}`;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const isMode = (v: unknown): v is ViewMode => v === "chat" || v === "trace";

/** The mode last chosen for new sessions; Chat until the user picks otherwise. */
export function loadDefaultViewMode(store: Store | null = defaultStore()): ViewMode {
  try {
    const v = store?.getItem(DEFAULT_KEY);
    if (isMode(v)) return v;
  } catch {}
  return "chat";
}

/** This session's own choice, else the default. */
export function loadViewMode(sid: string | null, store: Store | null = defaultStore()): ViewMode {
  try {
    const v = sid ? store?.getItem(sessionKey(sid)) : null;
    if (isMode(v)) return v;
  } catch {}
  return loadDefaultViewMode(store);
}

/** Remember the choice for this session, and as the default for sessions opened later. */
export function saveViewMode(sid: string | null, mode: ViewMode, store: Store | null = defaultStore()): void {
  try {
    if (sid) store?.setItem(sessionKey(sid), mode);
    store?.setItem(DEFAULT_KEY, mode);
  } catch {}
}

export const otherMode = (m: ViewMode): ViewMode => (m === "chat" ? "trace" : "chat");

/**
 * "Continue in terminal" resumes the engine's own session interactively. While a turn runs that would be a second
 * writer on one engine session, so it is offered only when the session is idle and has something to resume.
 */
export function terminalResume(s: Pick<SessionView, "status" | "turns">): { enabled: boolean; reason: string | null } {
  if (s.turns === 0) return { enabled: false, reason: "Nothing to continue yet: send a message first." };
  if (s.status === "running") return { enabled: false, reason: "A turn is running. Continue in the terminal once it finishes, so two writers never share one session." };
  if (s.status === "closed") return { enabled: false, reason: "This session is closed." };
  if (s.status === "failed") return { enabled: false, reason: "The last turn failed. Retry it here first." };
  return { enabled: true, reason: null };
}

/* ------------------------------------------------------------------ chat items */

export type ChatItem =
  | { kind: "user"; id: string; text: string; turnId?: string | null }
  | { kind: "text"; id: string; text: string; turnId?: string | null }
  | { kind: "tools"; id: string; tools: ToolItem[]; summary: string; running: boolean; verb: string | null }
  | { kind: "thinking"; id: string }
  | { kind: "failure"; id: string; text: string }
  | { kind: "compact"; id: string; from: number | null; to: number | null }
  | { kind: "plan"; id: string; version: number; title: string; steps: number; path: string | null }
  | { kind: "head"; id: string; session: string; activity: Activity | null; result: string | null };

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

const TEST_RUN = /\b(test|tests|vitest|jest|pytest|mocha|playwright|cargo test|go test)\b/i;

/** What a running tool is doing, as a short verb phrase: "Running tests…", "Reading a file…". */
export function toolVerb(tool: { name: string; arg: string }): string {
  const n = tool.name.toLowerCase();
  if (n === "bash" || n === "shell") return TEST_RUN.test(tool.arg) ? "Running tests…" : "Running a command…";
  if (n === "read" || n === "listdir" || n === "ls") return "Reading files…";
  if (n === "write" || n === "edit" || n === "multiedit" || n.startsWith("edit")) return "Editing files…";
  if (n === "grep" || n === "glob" || n === "websearch") return "Searching…";
  if (n === "webfetch") return "Fetching a page…";
  if (n === "task" || n.includes("subagent")) return "Delegating…";
  if (n === "todowrite") return "Updating the plan…";
  if (n.endsWith("plan_ask")) return "Waiting for your answer…";
  if (n.endsWith("plan_submit")) return "Writing up the plan…";
  return `Using ${shortToolName(tool.name)}…`;
}

/**
 * The Chat view's items. Lines from the focus session become messages and one muted line per run of tool calls;
 * everything another session (a head) does folds into ONE card per head, placed where that head first spoke.
 * Hidden on purpose: turn dividers, protocol notes, successful end markers, finished thinking.
 */
export function deriveChat(items: TranscriptItem[], focusSession: string | undefined): ChatItem[] {
  const out: ChatItem[] = [];
  const headIndex = new Map<string, number>();
  const bySession = new Map<string, TranscriptItem[]>();
  for (const it of items) {
    if (focusSession && it.session !== focusSession) {
      let list = bySession.get(it.session);
      if (!list) bySession.set(it.session, (list = []));
      list.push(it);
    }
  }
  const acts = activityBySession(items);

  for (const it of items) {
    if (focusSession && it.session !== focusSession) {
      // A head's own prompt and turn markers say nothing the card does not.
      if (it.type === "user" || it.type === "turn") continue;
      if (!headIndex.has(it.session)) {
        headIndex.set(it.session, out.length);
        out.push({ kind: "head", id: `h:${it.session}`, session: it.session, activity: null, result: null });
      }
      continue;
    }
    switch (it.type) {
      case "user":
        out.push({ kind: "user", id: it.id, text: it.text, turnId: it.turnId });
        break;
      case "text":
        out.push({ kind: "text", id: it.id, text: it.text, turnId: it.turnId });
        break;
      case "tool": {
        const last = out[out.length - 1];
        if (last?.kind === "tools") {
          last.tools.push(it);
        } else out.push({ kind: "tools", id: `t${it.id}`, tools: [it], summary: "", running: false, verb: null });
        break;
      }
      case "thinking":
        if (it.active) out.push({ kind: "thinking", id: it.id });
        break;
      case "end":
        if (!it.ok) out.push({ kind: "failure", id: it.id, text: it.text });
        break;
      case "compact":
        out.push({ kind: "compact", id: it.id, from: it.from, to: it.to });
        break;
      case "note": {
        // The daemon logs "plan v2 ready: … → plans/….md" when a plan lands: it becomes a chip that opens the plan.
        const plan = parsePlanReadyLine(it.text);
        if (plan) out.push({ kind: "plan", id: it.id, ...plan });
        break;
      }
      default:
        break; // turn dividers
    }
  }

  // Only the newest item can still be thinking: one followed by anything else is stale.
  for (let i = out.length - 2; i >= 0; i--) if (out[i].kind === "thinking") out.splice(i, 1);

  for (const c of out) {
    if (c.kind === "tools") {
      const running = c.tools.filter((t) => t.status === "running");
      c.running = running.length > 0;
      c.verb = running.length ? toolVerb(running[running.length - 1]) : null;
      c.summary = summarizeTools(c.tools);
    } else if (c.kind === "head") {
      const a = acts.get(c.session) ?? null;
      c.activity = a;
      const texts = (bySession.get(c.session) ?? []).filter((x): x is Extract<TranscriptItem, { type: "text" }> => x.type === "text");
      const lastText = texts[texts.length - 1]?.text.split("\n").map((l) => l.trim()).find(Boolean);
      c.result = lastText ? oneLine(lastText.replace(/^[#>*\-\s`]+/, ""), 140) : null;
    }
  }
  return out;
}

/** Whether the thread already shows a live affordance (so no extra "Working…" is needed under it). */
export function hasLiveTail(chat: ChatItem[]): boolean {
  const last = chat[chat.length - 1];
  if (!last) return false;
  if (last.kind === "thinking") return true;
  if (last.kind === "tools") return last.running;
  if (last.kind === "head") return !!last.activity?.running;
  return last.kind === "text";
}

/** One line for a head card while it works: "reading auth module…". */
export function headLine(head: Pick<SessionView, "status" | "title">, c: { activity: Activity | null; result: string | null }): string {
  if (head.status === "running") return c.activity?.label ?? "working…";
  if (head.status === "failed") return c.result ?? "failed";
  return c.result ?? head.title;
}

export const diffStat = (h: Pick<SessionView, "changes">): { files: number; plus: number; minus: number } | null =>
  h.changes && h.changes.files > 0 ? { files: h.changes.files, plus: h.changes.insertions, minus: h.changes.deletions } : null;

export { isMergeReady };

/* ------------------------------------------------------------------ the shelf */

export type ChipState = "running" | "done" | "failed";

export interface ShelfChip {
  id: string;
  label: string;
  engine: string;
  title: string;
  state: ChipState;
  /** The lead is blocked in subagent_wait on this head (set only when true). */
  awaited?: boolean;
}

export interface Shelf {
  lead: { engine: string; status: SessionView["status"]; /** Set only while the lead is blocked in subagent_wait. */ waiting?: { names: string[]; sinceMs: number } };
  heads: ShelfChip[];
}

const chipState = (s: SessionView["status"]): ChipState => (s === "running" ? "running" : s === "failed" ? "failed" : "done");

/**
 * The strip above the composer: the lead plus one chip per open head. Null when the session has neither a pair nor
 * heads, so a plain single-agent session carries no extra chrome.
 */
export function shelfFor(session: SessionView | null, children: SessionView[]): Shelf | null {
  if (!session) return null;
  const heads = children.filter((c) => c.status !== "closed");
  if (!session.pair && heads.length === 0) return null;
  const waiting = waitingInfo(session);
  return {
    lead: { engine: session.engine, status: session.status, ...(waiting ? { waiting: { names: waiting.names, sinceMs: waiting.sinceMs } } : {}) },
    heads: heads.map((h) => ({ id: h.id, label: h.role ?? h.engine, engine: h.engine, title: h.title, state: chipState(h.status), ...(waiting?.ids.includes(h.id) ? { awaited: true } : {}) })),
  };
}

/* ------------------------------------------------------------------ settings dot */

export interface SettingsState {
  effort: string;
  pairTitle: string | null;
  agentTitle: string | null;
  /** "all enabled" is the default; anything else counts as changed. */
  skillsLabel: string;
  worktree: boolean;
}

/**
 * What differs from the defaults in the settings popover, so the sliders button can carry a dot and a tooltip.
 * Engine and model are not counted: they sit on the composer as their own chip.
 */
export function settingsSummary(s: SettingsState): { count: number; items: string[] } {
  const items: string[] = [];
  if (s.effort) items.push(`effort ${s.effort}`);
  if (s.pairTitle) items.push(`pair ${s.pairTitle}`);
  if (s.agentTitle) items.push(`agent ${s.agentTitle}`);
  if (s.skillsLabel !== "all enabled") items.push(`skills ${s.skillsLabel}`);
  if (s.worktree) items.push("isolated worktree");
  return { count: items.length, items };
}

/* ------------------------------------------------------------------ folded instructions */

const INSTRUCTIONS = "\n\n<!-- trb:instructions ";

/**
 * A prompt trb built around the operator's words (a design turn): what they typed, the tag the daemon put on
 * it, and the instructions that follow, which the thread folds away. Plain prompts come back unchanged.
 */
export function splitInstructions(text: string): { text: string; label: string | null; instructions: string | null } {
  const at = text.indexOf(INSTRUCTIONS);
  if (at < 0) return { text, label: null, instructions: null };
  const head = text.slice(at + INSTRUCTIONS.length);
  const end = head.indexOf(" -->");
  if (end < 0) return { text, label: null, instructions: null };
  return { text: text.slice(0, at), label: head.slice(0, end).trim(), instructions: head.slice(end + 4).replace(/^\n/, "") };
}

/**
 * `/skill-name …` as typed in the composer: the skill's name and the words after it. The daemon resolves the name the
 * same way (exact, else a single prefix match), so a `/word` that is no enabled skill comes back unchanged.
 */
export function splitSkillCall(text: string, enabled: string[]): { skill: string | null; text: string } {
  const m = /^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return { skill: null, text };
  const word = m[1].toLowerCase();
  let skill = enabled.find((n) => n === word);
  if (!skill) {
    const hits = enabled.filter((n) => n.startsWith(word) || n.split(/[-._]+/).some((w) => w.startsWith(word)));
    if (hits.length === 1) skill = hits[0];
  }
  return skill ? { skill, text: (m[2] ?? "").trim() } : { skill: null, text };
}

export { splitContext } from "../context/wrap";
