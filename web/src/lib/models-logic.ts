/**
 * Pure logic behind the model and effort pickers: searching a long catalog, deciding what a changed engine
 * keeps, and working out where a pair role's blank fields come from. No React, no network, so it is unit
 * tested directly and shared by every place that picks a model.
 */
import type { Agent } from "./types";

export interface ModelInfo {
  id: string;
  label: string;
  group?: string;
  hint?: string;
  default?: boolean;
  efforts?: string[];
}

export interface ModelCatalog {
  engine: string;
  source: "cli" | "static";
  models: ModelInfo[];
  efforts: string[];
  fetchedAt: string;
  error?: string;
}

/** Rows rendered at once. An engine can list hundreds of models; the search box is how you reach the rest. */
export const ROW_CAP = 100;

/** Effort levels offered when an engine is not known yet (an unset engine, a catalog still loading). */
export const GENERIC_EFFORTS = ["low", "medium", "high"];

/* ------------------------------------------------------------------- search */

const BOUNDARY = /[-_./\s:]/;

/** The score of a letters-in-order match: the weakest, only used when nothing matches better. */
const FUZZY_SCORE = 8;

/** How well one query token matches one model. 0 means it does not. */
function tokenScore(m: ModelInfo, t: string): number {
  const id = m.id.toLowerCase();
  const label = m.label.toLowerCase();
  if (id === t) return 100;
  if (id.startsWith(t)) return 80;
  if (label.startsWith(t)) return 70;
  const at = id.indexOf(t);
  if (at > 0) return BOUNDARY.test(id[at - 1]) ? 60 : 50; // a hit at a word start beats one mid-word
  if (at === 0) return 80;
  if (label.includes(t)) return 40;
  if ((m.group ?? "").toLowerCase().includes(t)) return 25;
  if ((m.hint ?? "").toLowerCase().includes(t)) return 15;
  // Letters in order ("g53c" finds "gpt-5.3-codex"): a weak match, but better than hiding it.
  let i = 0;
  for (const ch of id) if (ch === t[i]) i++;
  return i === t.length && t.length >= 2 ? FUZZY_SCORE : 0;
}

/** Every whitespace-separated token must match somewhere; the score is their sum. 0: not a match. */
export function rankModel(m: ModelInfo, query: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 1;
  let total = 0;
  for (const t of tokens) {
    const s = tokenScore(m, t);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

export interface ModelGroup {
  group: string | null;
  items: ModelInfo[];
}

export interface ModelSearch {
  groups: ModelGroup[];
  /** Matches before the cap. */
  total: number;
  shown: number;
  /** How many matches the cap hid ("N more: keep typing"). */
  more: number;
  /** True when groups are real provider headings (no query); a ranked list is one headingless group. */
  grouped: boolean;
}

/**
 * With no query: the catalog in its own order, under provider headings. With one: a single ranked list (the
 * provider moves into each row, since ranking across headings would be unreadable). Either way capped.
 */
export function searchModels(models: ModelInfo[], query: string, cap = ROW_CAP): ModelSearch {
  const q = query.trim();
  if (!q) {
    const order: Array<string | null> = [];
    const by = new Map<string | null, ModelInfo[]>();
    for (const m of models) {
      const g = m.group ?? null;
      if (!by.has(g)) {
        by.set(g, []);
        order.push(g);
      }
      by.get(g)!.push(m);
    }
    const groups: ModelGroup[] = [];
    let shown = 0;
    for (const g of order) {
      if (shown >= cap) break;
      const items = by.get(g)!.slice(0, cap - shown);
      shown += items.length;
      groups.push({ group: g, items });
    }
    return { groups, total: models.length, shown, more: models.length - shown, grouped: true };
  }
  let ranked = models
    .map((m, i) => ({ m, i, s: rankModel(m, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  // Letters-in-order matches are a last resort: once anything matches for real, they are noise ("model-29" would
  // otherwise drag in "model-129"). A candidate is fuzzy-only when every token scored the weakest value.
  const tokenCount = q.split(/\s+/).filter(Boolean).length;
  if (ranked.some((x) => x.s > FUZZY_SCORE * tokenCount)) ranked = ranked.filter((x) => x.s > FUZZY_SCORE * tokenCount);
  const items = ranked.slice(0, cap).map((x) => x.m);
  return { groups: items.length ? [{ group: null, items }] : [], total: ranked.length, shown: items.length, more: ranked.length - items.length, grouped: false };
}

/**
 * The model the user typed, offered as a custom entry. Not offered when it is already an exact id (it would
 * duplicate a row) or when there is nothing typed. Any id is accepted: lists lag behind new models.
 */
export function customRow(query: string, models: ModelInfo[]): string | null {
  const q = query.trim();
  if (!q) return null;
  return models.some((m) => m.id === q) ? null : q;
}

/** A value not in the loaded catalog is shown as custom. null while there is nothing to compare against. */
export function isCustomModel(value: string, catalog: ModelCatalog | undefined): boolean {
  if (!value || !catalog || catalog.models.length === 0) return false;
  return !catalog.models.some((m) => m.id === value);
}

/* ------------------------------------------------------------------- efforts */

/** The levels for a model: its own list when the engine reports one (codex does), else the engine's. */
export function effortOptions(catalog: ModelCatalog | undefined, modelId: string): string[] {
  if (!catalog) return GENERIC_EFFORTS;
  const m = modelId ? catalog.models.find((x) => x.id === modelId) : undefined;
  if (m?.efforts && m.efforts.length) return m.efforts;
  return catalog.efforts;
}

/** The selectable levels with the current value kept even when the list does not know it. "" (default) is not in the list. */
export function effortChoices(options: string[], current: string): string[] {
  const list = [...new Set(options.filter(Boolean))];
  if (current && !list.includes(current)) list.push(current);
  return list;
}

/* ------------------------------------------------------- changing the engine */

/** A model id means nothing to another engine: keep it only when the new engine's catalog lists it. */
export function modelAfterEngineChange(model: string, nextCatalog: ModelCatalog | undefined): string {
  if (!model) return "";
  return nextCatalog?.models.some((m) => m.id === model) ? model : "";
}

/** Keep an effort only when the new engine accepts it (an engine with no effort control keeps none). */
export function effortAfterEngineChange(effort: string, nextEfforts: string[] | undefined): string {
  if (!effort) return "";
  return nextEfforts?.includes(effort) ? effort : "";
}

/* -------------------------------------------------- where a role's blanks come from */

export type InheritSource = "role" | "heads" | "agent" | "lead";

export interface Inherited {
  source: InheritSource;
  /** The value that will apply ("" when nothing sets it: the engine's own default). */
  value: string;
  /** For a hint: where it comes from, e.g. `agent “Reviewer”`. */
  from: string;
}

export interface RoleLike {
  engine: string;
  model: string;
  effort: string;
}

export interface InheritContext {
  /** The pair's heads config. null in a by-role pair, where that layer does not exist. */
  heads: RoleLike | null;
  /** The agent the role runs as, if it names one that exists. */
  agent: Pick<Agent, "title" | "engine" | "model" | "effort"> | null;
  /** The lead the heads are opened by: what a head falls back to. */
  lead: RoleLike;
}

const nz = (s: string | null | undefined): string => (s ?? "").trim();

/** engine: the role's own, then the pair's heads config, then the agent's preference, then the lead's. */
export function inheritedEngine(role: RoleLike, ctx: InheritContext): Inherited {
  if (nz(role.engine)) return { source: "role", value: nz(role.engine), from: "this role" };
  if (ctx.heads && nz(ctx.heads.engine)) return { source: "heads", value: nz(ctx.heads.engine), from: "the pair's heads config" };
  if (ctx.agent && nz(ctx.agent.engine)) return { source: "agent", value: nz(ctx.agent.engine), from: `agent “${ctx.agent.title}”` };
  return { source: "lead", value: nz(ctx.lead.engine), from: "the lead" };
}

/**
 * model: same order, but a model id only counts when it belongs to the engine that ends up running, which is
 * the same rule the daemon applies (a pair's claude model is never handed to codex).
 */
export function inheritedModel(role: RoleLike, ctx: InheritContext): Inherited {
  const engine = inheritedEngine(role, ctx).value;
  if (nz(role.model)) return { source: "role", value: nz(role.model), from: "this role" };
  const headsEngine = nz(ctx.heads?.engine) || nz(ctx.agent?.engine) || nz(ctx.lead.engine);
  if (ctx.heads && nz(ctx.heads.model) && headsEngine === engine) return { source: "heads", value: nz(ctx.heads.model), from: "the pair's heads config" };
  const agentEngine = nz(ctx.agent?.engine) || nz(ctx.lead.engine);
  if (ctx.agent && nz(ctx.agent.model) && agentEngine === engine) return { source: "agent", value: nz(ctx.agent.model), from: `agent “${ctx.agent.title}”` };
  if (nz(ctx.lead.model) && nz(ctx.lead.engine) === engine) return { source: "lead", value: nz(ctx.lead.model), from: "the lead" };
  return { source: "lead", value: "", from: "the engine's own default" };
}

/** effort: role, then heads config, then the agent, then the lead's. */
export function inheritedEffort(role: RoleLike, ctx: InheritContext): Inherited {
  if (nz(role.effort)) return { source: "role", value: nz(role.effort), from: "this role" };
  if (ctx.heads && nz(ctx.heads.effort)) return { source: "heads", value: nz(ctx.heads.effort), from: "the pair's heads config" };
  if (ctx.agent && nz(ctx.agent.effort)) return { source: "agent", value: nz(ctx.agent.effort), from: `agent “${ctx.agent.title}”` };
  if (nz(ctx.lead.effort)) return { source: "lead", value: nz(ctx.lead.effort), from: "the lead" };
  return { source: "lead", value: "", from: "the engine's own default" };
}

/** The muted text shown inside an empty field: "from agent “Reviewer”: claude". Empty when the role sets it. */
export function inheritHint(i: Inherited): string {
  if (i.source === "role") return "";
  return i.value ? `from ${i.from}: ${i.value}` : i.from.startsWith("the engine") ? "engine default" : `from ${i.from}`;
}

/** Engines that front other vendors' models: only there does a model's own mark say something its engine's mark does not. */
export function showsModelMark(engine: string | null | undefined, model: string | null | undefined): boolean {
  return !!model && (engine === "cursor" || engine === "opencode");
}

/** The short form of an inheritance hint for a narrow field: "from the lead: high" -> "high". A hint with no value stays whole. */
export function hintValue(hint: string | undefined): string {
  if (!hint) return "";
  const at = hint.lastIndexOf(": ");
  return at >= 0 ? hint.slice(at + 2) : hint;
}

/** A model id as a person would say it, without the vendor prefix the engine's icon already shows: "claude-sonnet-5-5" -> "Sonnet 5.5". Other ids stay as they are. */
export function shortModelName(id: string | null | undefined): string {
  if (!id) return "";
  const tail = id.slice(id.lastIndexOf("/") + 1);
  if (!tail.startsWith("claude-")) return id;
  const parts = tail.slice(7).split("-").filter((p) => !/^\d{8}$/.test(p));
  const words: string[] = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && /^\d+(\.\d+)*$/.test(words[words.length - 1] ?? "")) words[words.length - 1] += `.${p}`;
    else words.push(/^\d+$/.test(p) ? p : p[0].toUpperCase() + p.slice(1));
  }
  return words.join(" ") || id;
}

export type ModelFamily = "anthropic" | "openai" | "google" | "xai" | "cursor" | "opencode";

/** Which model family an id belongs to, by its name (and so which mark it wears). null when there is no mark for it. */
export function modelFamily(model: string | null | undefined): ModelFamily | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (/(^|[/_-])(claude|opus|sonnet|haiku|fable|anthropic)/.test(m)) return "anthropic";
  if (/(^|[/_-])(gpt|chatgpt|o[134](-|$)|codex|openai)/.test(m)) return "openai";
  if (/(^|[/_-])gemini/.test(m)) return "google";
  if (/(^|[/_-])grok/.test(m)) return "xai";
  if (/(^|[/_-])(composer|cursor)/.test(m)) return "cursor";
  if (m.startsWith("opencode")) return "opencode";
  return null;
}
