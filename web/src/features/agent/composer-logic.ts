/**
 * The composer's pure logic: slash commands, @-mentions, what a pair implies for the pickers, and the
 * small formatting helpers the live strip uses. No React, so it is unit-tested directly.
 */
import type { Agent, EngineInfo, Pair } from "@/lib/types";
import { sameAssignment } from "../settings/agents-logic";
import { fuzzyScore } from "../../lib/fuzzy";
import { modelFamily, shortModelName } from "../../lib/models-logic";

/* ------------------------------------------------------------------ slash commands */

export type SlashName = "new" | "clear" | "pair" | "agent" | "model" | "engine" | "effort" | "interrupt" | "design";

export interface SlashDef {
  name: SlashName;
  args: string;
  help: string;
}

export const SLASH_COMMANDS: SlashDef[] = [
  { name: "new", args: "", help: "Start a new session" },
  { name: "clear", args: "", help: "Start a new session (alias)" },
  { name: "pair", args: "<name|none>", help: "Choose the Hydra pair for the next session" },
  { name: "agent", args: "<name|none>", help: "Run the next session as a specialized agent" },
  { name: "engine", args: "<engine>", help: "Choose the engine for the next session" },
  { name: "model", args: "<model>", help: "Choose the model for the next session" },
  { name: "effort", args: "<low|medium|high>", help: "Choose the reasoning effort" },
  { name: "interrupt", args: "", help: "Stop the running turn" },
  { name: "design", args: "[brief | url | code | wire | review]", help: "A design turn: brainstorm a design system, wire tokens, review the UI" },
];

export interface ParsedSlash {
  name: SlashName;
  arg: string;
}

/**
 * A message is a command only when it is a single line that starts with a known `/name`. Anything else, a
 * path like `/etc/hosts` included, is an ordinary prompt: a mistyped command must not be swallowed.
 */
export function parseSlash(text: string): ParsedSlash | null {
  const t = text.trim();
  if (!t.startsWith("/") || t.includes("\n")) return null;
  const m = /^\/([a-z]+)(?:\s+(.*))?$/i.exec(t);
  if (!m) return null;
  const name = m[1].toLowerCase() as SlashName;
  const def = SLASH_COMMANDS.find((c) => c.name === name);
  if (!def) return null;
  const arg = (m[2] ?? "").trim();
  if (def.args && !arg) return null; // `/pair` with nothing to apply: let the suggestion list guide instead
  return { name, arg };
}

/** While the whole input is `/` plus letters, suggest matching commands. */
export function slashSuggestions(text: string): SlashDef[] {
  const m = /^\/([a-z]*)$/i.exec(text);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

/* ------------------------------------------------------------------ skill suggestions */

const NAME_WORDS = /[-._\s]+/;
const TEXT_WORDS = /[^\p{L}\p{N}]+/u;

/**
 * Rank skills for a typed `/query`. The name counts most (exact, prefix, a word of the name, inside it, then
 * letters in order), then the description (a word of it, then inside it). So `/rev` finds `code-review`, and
 * `/review` finds a skill whose description says it reviews. An empty query lists every skill by name.
 */
export function matchSkills<T extends { name: string; description: string }>(query: string, skills: T[]): T[] {
  const q = query.toLowerCase();
  if (!q) return [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const scored: Array<{ skill: T; score: number }> = [];
  for (const skill of skills) {
    const score = skillScore(q, skill);
    if (score > 0) scored.push({ skill, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name)).map((x) => x.skill);
}

function skillScore(q: string, { name, description }: { name: string; description: string }): number {
  const n = name.toLowerCase();
  const d = description.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.split(NAME_WORDS).some((w) => w.startsWith(q))) return 60;
  if (n.includes(q)) return 40;
  if (d.split(TEXT_WORDS).some((w) => w.startsWith(q))) return 30;
  if (d.includes(q)) return 20;
  // Letters in order ("crv" → code-review), only once there are two of them: one letter matches nearly everything.
  return q.length >= 2 && fuzzyScore(q, n) ? 10 : 0;
}

/* ------------------------------------------------------------------ @-mentions */

export interface MentionToken {
  /** Index of the `@`. */
  start: number;
  /** Text typed after it. */
  query: string;
}

/** The `@word` the caret is inside, if any. The `@` must start the input or follow whitespace (so emails are not mentions). */
export function findMentionToken(text: string, caret: number): MentionToken | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** Replace the `@query` with the chosen path (backtick-quoted if it has spaces) and a trailing space. */
export function applyMention(text: string, token: MentionToken, path: string, caret: number): { text: string; caret: number } {
  const tail = text.slice(caret);
  // One space after, unless the text already continues with one.
  const gap = /^\s/.test(tail) ? "" : " ";
  const inserted = (/\s/.test(path) ? `\`${path}\`` : path) + gap;
  const next = text.slice(0, token.start) + inserted + tail;
  return { text: next, caret: token.start + inserted.length };
}

/* ------------------------------------------------------------------ pickers */

export interface PickerState {
  engine: string;
  model: string;
  effort: string;
  pairId: string;
  worktree: boolean;
}

export const DEFAULT_PICKER: PickerState = { engine: "claude", model: "", effort: "", pairId: "", worktree: false };

/** What a pair decides for the lead. The server resolves the same way; the UI just shows it. */
export function pairDefaults(pair: Pair | undefined | null): { engine: string; model: string; effort: string } | null {
  if (!pair) return null;
  return { engine: pair.lead_engine ?? "", model: pair.lead_model ?? "", effort: pair.lead_effort ?? "" };
}

export function headsSummary(pair: Pair): string {
  if (pair.mode === "roles" && pair.roles) {
    const roles = Object.entries(pair.roles).map(([r, c]) => `${r}: ${c.engine ?? "default"}${c.model && c.model !== "default" ? ` ${c.model}` : ""}`);
    return roles.join(" · ") || "roles";
  }
  return `${pair.heads_engine ?? "default"}${pair.heads_model ? ` ${pair.heads_model}` : ""}${pair.heads_effort ? ` @${pair.heads_effort}` : ""}`;
}

/* ------------------------------------------------------------------ pair chip */

export interface PairSide {
  engine: string | null;
  model: string | null;
}

/** "default" and blank mean the same thing: no model chosen. */
function realModel(model: string | null | undefined): string | null {
  return model && model !== "default" ? model : null;
}

/**
 * The lead and the heads as the chip shows them. Heads fields may be null: with no heads engine they run on the lead's
 * engine, and with no heads model of their own they take the lead's model in that case.
 */
export function pairSides(pair: Pair): { lead: PairSide; heads: PairSide } {
  const lead = { engine: pair.lead_engine, model: realModel(pair.lead_model) };
  const heads = pair.heads_engine ? { engine: pair.heads_engine, model: realModel(pair.heads_model) } : { engine: pair.lead_engine, model: realModel(pair.heads_model ?? pair.lead_model) };
  return { lead, heads };
}

/**
 * The two model names the chip writes beside its marks ("Sonnet 5.5", "Haiku 5.5"), or null. Names appear only when the
 * marks cannot tell the sides apart: same engine, same model family (so the same mark), and different model ids.
 */
export function pairChipNames(pair: Pair): [string, string] | null {
  const { lead, heads } = pairSides(pair);
  if (!lead.model || !heads.model || lead.engine !== heads.engine) return null;
  const family = modelFamily(lead.model);
  if (!family || family !== modelFamily(heads.model)) return null;
  const names: [string, string] = [shortModelName(lead.model), shortModelName(heads.model)];
  return names[0] !== names[1] ? names : null;
}

function engineLabel(id: string | null, engines: EngineInfo[] | undefined): string {
  if (!id) return "default";
  return engines?.find((e) => e.id === id)?.label ?? id;
}

/**
 * What a pair says in a few words, for the chip's title and aria-label: "Sonnet 5.5 leads Haiku 5.5", "Claude leads
 * Codex". A side with no model is named by its engine; a roles pair says how many roles it has.
 */
export function pairSummary(pair: Pair, engines?: EngineInfo[]): string {
  const { lead, heads } = pairSides(pair);
  const leadName = shortModelName(lead.model) || engineLabel(lead.engine, engines);
  if (pair.mode === "roles") {
    const n = Object.keys(pair.roles ?? {}).length;
    return `${leadName} leads ${n} ${n === 1 ? "role" : "roles"}`;
  }
  return `${leadName} leads ${shortModelName(heads.model) || engineLabel(heads.engine, engines)}`;
}

/** Why an engine/pair combination cannot start, or null. Mirrors the daemon's refusal so the UI says it first. */
export function leadProblem(engines: EngineInfo[] | undefined, engine: string, hasPair: boolean): string | null {
  const e = engines?.find((x) => x.id === engine);
  if (!e) return engines ? `Unknown engine "${engine}".` : null;
  if (!e.installed) return `${e.label} is not installed.`;
  if (hasPair && e.mcp === "none") return `${e.label} cannot lead a Hydra pair: trb's tools are not wired for it. Pick claude, codex or cursor.`;
  return null;
}

export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  codex: [],
  cursor: ["auto"],
  opencode: [],
  agy: [],
  grok: [],
};

export const EFFORTS = ["low", "medium", "high"] as const;

/* ------------------------------------------------------------------ live strip formatting */

export function formatElapsed(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The daemon stores SQLite `YYYY-MM-DD HH:MM:SS` in UTC; ISO strings also work. */
export function parseDbTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : null;
}

export function turnDurationSec(started: string | null | undefined, finished: string | null | undefined): number | null {
  const a = parseDbTime(started);
  const b = parseDbTime(finished);
  return a !== null && b !== null ? Math.max(0, Math.round((b - a) / 1000)) : null;
}

/* ------------------------------------------------------------------ persistence */

const PREFS_KEY = "trb.composer.v1";

export function loadPicker(): PickerState {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    // A pair is chosen per conversation, never inherited: it turns the lead into a head-spawner. Older saves may hold one.
    if (raw) return { ...DEFAULT_PICKER, ...JSON.parse(raw), pairId: "" };
  } catch {}
  return DEFAULT_PICKER;
}

export function savePicker(p: PickerState): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...p, pairId: "" }));
  } catch {}
}

/* ------------------------------------------------------------------ specialized agents */

const AGENT_KEY = (workspaceId: string) => `trb.composer.agent.${workspaceId}`;

/** The agent last chosen in this workspace ("" for none). Per workspace: a reviewer agent for one repo is noise in another. */
export function loadAgentChoice(workspaceId: string): string {
  try {
    return localStorage.getItem(AGENT_KEY(workspaceId)) ?? "";
  } catch {
    return "";
  }
}

export function saveAgentChoice(workspaceId: string, name: string): void {
  try {
    if (name) localStorage.setItem(AGENT_KEY(workspaceId), name);
    else localStorage.removeItem(AGENT_KEY(workspaceId));
  } catch {}
}

/** An agent by exact name or title, else the first whose name or title contains the query. */
export function matchAgent(agents: Agent[], query: string): Agent | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return agents.find((a) => a.name === q || a.title.toLowerCase() === q) ?? agents.find((a) => a.name.includes(q) || a.title.toLowerCase().includes(q)) ?? null;
}

/**
 * Choosing an agent that has an engine preference moves the engine picker to it, unless a pair is chosen (the
 * pair binds the lead). Its model and effort come along only when it names an engine, since a model id means
 * nothing to a different engine.
 */
export function agentPickerPatch(agent: Agent | null, hasPair: boolean): Partial<PickerState> | null {
  if (!agent || hasPair || !agent.engine) return null;
  return { engine: agent.engine, model: agent.model ?? "", ...(agent.effort ? { effort: agent.effort } : {}) };
}

/** The skills a session will have: the user's explicit choice, else the agent's assignment, else null (every enabled skill). */
export function effectiveSkills(override: string[] | null, agent: Pick<Agent, "skills"> | null): string[] | null {
  return override ?? agent?.skills ?? null;
}

/** "all enabled", "3 of 7", "none": the skills chip. Only enabled skills count, since a disabled one stays off. */
export function skillsChipLabel(list: string[] | null, enabled: string[]): string {
  if (list === null) return "all enabled";
  const n = list.filter((x) => enabled.includes(x)).length;
  return n === 0 ? "none" : `${n} of ${enabled.length}`;
}

/** After the user ticks skills: null when the result equals what the agent (or "everything enabled") already gives, so nothing is sent. */
export function normalizeSkillsOverride(next: string[], base: string[] | null, enabled: string[]): string[] | null {
  const reference = base === null ? enabled : base.filter((x) => enabled.includes(x));
  const nextEnabled = next.filter((x) => enabled.includes(x));
  return sameAssignment(nextEnabled, reference) ? null : next;
}

export interface CreateInput {
  prompt: string;
  cwd: string;
  worktree: boolean;
  pairId: string;
  engine: string;
  model: string;
  effort: string;
  agent: string;
  /** Null: the user did not change the skills. */
  skills: string[] | null;
}

/**
 * The body for starting a session. A pair decides the lead's engine/model/effort; without one they are sent as
 * chosen. `agent` and `skills` are sent only when they mean something: an agent that was picked, a skills list
 * the user changed.
 */
export function buildCreatePayload(i: CreateInput): Record<string, unknown> {
  return {
    prompt: i.prompt,
    cwd: i.cwd,
    isolate: i.worktree,
    ...(i.pairId ? { pair: i.pairId } : { engine: i.engine, model: i.model || undefined, effort: i.effort || undefined }),
    ...(i.agent ? { agent: i.agent } : {}),
    ...(i.skills !== null ? { skills: i.skills } : {}),
  };
}
