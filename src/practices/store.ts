/**
 * Practice packs per workspace. Which packs are on, the check thresholds, the enforce mode and what is switched off
 * inside an enabled pack live in one table, created lazily. The pack catalog lives in <TRB home>/practices.json, which
 * the operator may also edit by hand: the custom packs, and the edits to built-in packs (`builtins`, keyed by pack id).
 * A built-in with an entry there is "modified"; resetting it deletes the entry, as recipes do with their defaults.
 *
 * Turning packs on or off, or changing a rule, rewrites one managed block in the workspace's AGENTS.md, mirrored into
 * CLAUDE.md the way memory does it. The block is its own region (its own markers): the memory block and the operator's
 * text are never touched. The block always holds the effective rules: the enabled packs with their edits and the rules
 * switched off here taken out.
 */
import type { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { cleanRule } from "../memory/block";
import { AGENTS_FILE, CLAUDE_FILE, fileIn, mirrorSkipReason, read, writeAtomic } from "../memory/store";
import { db } from "../db";
import { home } from "../paths";
import { UserError } from "../util";
import { Workspaces, owningWorkspace } from "../workspaces";
import { CHECK_IDS, PACKS, STACKS, packById, type PackDef, type PracticeCheck } from "./packs";

export interface Thresholds {
  maxFileLines: number;
  maxFunctionLines: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { maxFileLines: 300, maxFunctionLines: 60 };

/**
 * off: the checks run and their findings are reported only. warn: the same, and they are shown as results of a verify
 * run (no fix turn). fix: a finding starts a fix turn, like a failing command.
 */
export const ENFORCE = ["off", "warn", "fix"] as const;
export type Enforce = (typeof ENFORCE)[number];
export const DEFAULT_ENFORCE: Enforce = "warn";

/** A custom pack: a whole definition, without checks (checks are code, and live in the built-in packs). */
export type CustomPack = Omit<PackDef, "checks">;
/** A built-in pack's edits: its whole editable definition. The id, and which checks it may carry, stay fixed. */
export type PackOverride = Omit<CustomPack, "id"> & { checks: PracticeCheck[] };

/** A pack as the catalog lists it: the effective definition, and where it came from. */
export interface Pack extends PackDef {
  custom: boolean;
  /** A built-in pack with an edit on file (see `builtins`). Never true for a custom pack. */
  modified: boolean;
  /** The checks this pack can carry: its built-in ones. Empty for a custom pack. */
  knownChecks: PracticeCheck[];
}

/** What is switched off inside one enabled pack, in one workspace: rule texts, and check ids. */
export interface Switched {
  rules: string[];
  checks: PracticeCheck[];
}
export type OffMap = Record<string, Switched>;

export interface PracticesView {
  enabled: string[];
  thresholds: Thresholds;
  enforce: Enforce;
  off: OffMap;
}

export const START = "<!-- trb:practices:start -->";
export const END = "<!-- trb:practices:end -->";
const NOTE = "<!-- Managed by trb (Practices). Turn packs on or off there; text outside this block is yours and is never changed. -->";
const MAX_RULES = 8;
const MAX_RULE_CHARS = 200;

/* -------------------------------------------------------------------------- */
/* Catalog: built-in packs, their edits, and the custom ones in practices.json */
/* -------------------------------------------------------------------------- */

const customFile = (): string => path.join(home(), "practices.json");

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "")) : []);

interface Store {
  packs: CustomPack[];
  builtins: Record<string, PackOverride>;
}

/** practices.json as written. A file that does not parse is an error, not an empty catalog. */
function readStore(): Store {
  const text = read(customFile());
  if (text === null) return { packs: [], builtins: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UserError("practices.json is not valid JSON. Fix it by hand first.");
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as { packs?: unknown; builtins?: unknown };
  const list = o.packs ?? [];
  if (!Array.isArray(list)) throw new UserError('practices.json must hold { "packs": [...] }.');
  const edits = o.builtins && typeof o.builtins === "object" && !Array.isArray(o.builtins) ? (o.builtins as Record<string, unknown>) : {};
  const builtins: Record<string, PackOverride> = {};
  for (const [id, v] of Object.entries(edits)) if (packById(id)) builtins[id] = checkOverride(id, v);
  return { packs: list.map((p) => checkCustom(p)), builtins };
}

function writeStore(s: Store): void {
  const body = Object.keys(s.builtins).length ? { packs: s.packs, builtins: s.builtins } : { packs: s.packs };
  writeAtomic(customFile(), JSON.stringify(body, null, 2) + "\n");
}

/** The custom packs as written in practices.json. */
export function readCustom(): CustomPack[] {
  return readStore().packs;
}

const ID = /^[a-z][a-z0-9-]{1,39}$/;
const SKILL = /^[A-Za-z0-9][\w.:-]{0,79}$/;

/** The editable fields of a pack from user input: validated and cleaned. Throws UserError with the reason. */
function fieldsOf(o: Record<string, unknown>): Omit<CustomPack, "id"> {
  const title = String(o.title ?? "").trim();
  if (!title || title.length > 60) throw new UserError("A title is 1 to 60 characters.");
  const summary = String(o.summary ?? "").trim();
  if (summary.length > 200) throw new UserError("A summary is at most 200 characters.");
  const applies = strings(o.appliesTo);
  const appliesTo = applies.length ? applies : ["any"];
  if (!appliesTo.every((s) => (STACKS as readonly string[]).includes(s))) throw new UserError(`appliesTo takes ${STACKS.join(", ")}.`);
  const rules = strings(o.rules).map((r) => cleanRule(r));
  if (!rules.length || rules.length > MAX_RULES) throw new UserError(`A pack has 1 to ${MAX_RULES} rules.`);
  for (const r of rules) {
    if (!r) throw new UserError("A rule cannot be empty.");
    if (r.length > MAX_RULE_CHARS) throw new UserError(`A rule is at most ${MAX_RULE_CHARS} characters.`);
    if (/<!--|-->/.test(r)) throw new UserError("A rule cannot contain HTML comment markers.");
  }
  // Optional: a pack without skills keeps the same shape it always had.
  const skills = [...new Set(strings(o.skills).map((s) => s.trim()).filter(Boolean))];
  for (const s of skills) if (!SKILL.test(s)) throw new UserError("A skill name starts with a letter or digit, then letters, digits, dots, colons or dashes.");
  return { title, summary, appliesTo: [...new Set(appliesTo)] as CustomPack["appliesTo"], rules, ...(skills.length ? { skills } : {}) };
}

/** A custom pack from user input: validated and cleaned. Throws UserError with the reason. */
export function checkCustom(input: unknown): CustomPack {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id = String(o.id ?? "").trim();
  if (!ID.test(id)) throw new UserError("A pack id is 2 to 40 lowercase letters, digits or dashes, starting with a letter.");
  if (packById(id)) throw new UserError(`"${id}" is a built-in pack.`);
  return { id, ...fieldsOf(o) };
}

/**
 * A built-in pack's edit from user input. Its checks must be checks the built-in pack had: a check is code, so an edit
 * can switch one off but not give a pack a new one.
 */
function checkOverride(id: string, input: unknown): PackOverride {
  const d = packById(id);
  if (!d) throw new UserError(`No built-in pack "${id}".`);
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const fields = fieldsOf(o);
  const checks = [...new Set(strings(o.checks))] as PracticeCheck[];
  for (const c of checks) if (!(d.checks ?? []).includes(c)) throw new UserError(`${c} is not a check of ${d.title}.`);
  return { ...fields, checks: CHECK_IDS.filter((c) => checks.includes(c)) };
}

/** A definition in the form it is compared in: a built-in edit that matches the shipped pack is not an edit. */
const normal = (d: { title: string; summary: string; appliesTo: readonly string[]; rules: readonly string[]; skills?: readonly string[]; checks?: readonly string[] }) =>
  JSON.stringify({ title: d.title, summary: d.summary, appliesTo: [...d.appliesTo], rules: [...d.rules], skills: [...(d.skills ?? [])], checks: [...(d.checks ?? [])] });

const applyOverride = (d: PackDef, o: PackOverride): PackDef => ({ id: d.id, title: o.title, summary: o.summary, appliesTo: o.appliesTo, rules: o.rules, ...(o.skills?.length ? { skills: o.skills } : {}), checks: o.checks });

/** Built-in packs first, then the custom ones, in the order they are listed. Built-in packs show their edits. */
export function catalog(): Pack[] {
  const s = readStore();
  const builtin = PACKS.map((d): Pack => {
    const o = s.builtins[d.id];
    const eff = o ? applyOverride(d, o) : d;
    return { ...eff, custom: false, modified: !!o, knownChecks: [...(d.checks ?? [])] };
  });
  return [...builtin, ...s.packs.map((p): Pack => ({ ...p, custom: true, modified: false, knownChecks: [] }))];
}

/** Whether an id is a built-in pack: its edits go in place (saveBuiltin), not to practices.json's custom list. */
export const packIsBuiltin = (id: string): boolean => !!packById(id);

/** Creates a custom pack. Its id must be new, and not a built-in one. */
export function createCustom(input: unknown): CustomPack {
  const pack = checkCustom(input);
  const s = readStore();
  if (s.packs.some((p) => p.id === pack.id)) throw new UserError(`A custom pack "${pack.id}" already exists.`);
  writeStore({ ...s, packs: [...s.packs, pack] });
  return pack;
}

/** Replaces a custom pack's definition. Workspaces that have it on get its new rules in their block. */
export function updateCustom(id: string, input: unknown): CustomPack {
  const s = readStore();
  const i = s.packs.findIndex((p) => p.id === id);
  if (i < 0) throw new UserError(`No custom pack "${id}".`);
  const pack = checkCustom({ ...(input as object), id });
  s.packs[i] = pack;
  writeStore(s);
  for (const row of rowsWith(id)) reRender(row.workspace_id);
  return pack;
}

/**
 * Edits a built-in pack in place (it becomes "modified"). An edit equal to the shipped pack removes the edit, so the
 * pack is not modified any more. Workspaces that have it on get the new rules in their block.
 */
export function saveBuiltin(id: string, input: unknown): Pack {
  const d = packById(id);
  if (!d) throw new UserError(`No built-in pack "${id}".`);
  const o = checkOverride(id, input);
  const s = readStore();
  if (normal(o) === normal({ ...d, checks: d.checks ?? [], skills: d.skills ?? [] })) delete s.builtins[id];
  else s.builtins[id] = o;
  writeStore(s);
  for (const row of rowsWith(id)) reRender(row.workspace_id);
  return catalog().find((p) => p.id === id)!;
}

/** Puts a built-in pack back to what shipped. Workspaces that have it on get the shipped rules in their block. */
export function resetBuiltin(id: string): Pack {
  const d = packById(id);
  if (!d) throw new UserError(`No built-in pack "${id}".`);
  const s = readStore();
  delete s.builtins[id];
  writeStore(s);
  for (const row of rowsWith(id)) reRender(row.workspace_id);
  return catalog().find((p) => p.id === id)!;
}

/**
 * A custom copy of a built-in pack, with its rules and skills. The copy has no checks (those are code): it is a pack
 * the operator owns, and the built-in one is left as it is.
 */
export function forkBuiltin(id: string, newId?: string): Pack {
  const p = catalog().find((x) => x.id === id && !x.custom);
  if (!p) throw new UserError(`No built-in pack "${id}".`);
  const taken = new Set([...catalog().map((x) => x.id)]);
  let copy = newId ?? `${id}-copy`;
  for (let n = 2; !newId && taken.has(copy); n++) copy = `${id}-copy-${n}`;
  const made = createCustom({ id: copy, title: `${p.title} (copy)`.slice(0, 60), summary: p.summary, appliesTo: p.appliesTo, rules: p.rules, skills: p.skills ?? [] });
  return catalog().find((x) => x.id === made.id)!;
}

/** Deleting a custom pack also switches it off in every workspace that had it on. */
export function deleteCustom(id: string): void {
  const s = readStore();
  if (!s.packs.some((p) => p.id === id)) throw new UserError(`No custom pack "${id}".`);
  writeStore({ ...s, packs: s.packs.filter((p) => p.id !== id) });
  for (const row of rowsWith(id)) {
    const enabled = parseIds(row.enabled).filter((x) => x !== id);
    const off = parseOff(row.off);
    delete off[id];
    table().prepare("UPDATE practice_settings SET enabled = ?, off = ? WHERE workspace_id = ?").run(JSON.stringify(enabled), JSON.stringify(off), row.workspace_id);
    reRender(row.workspace_id);
  }
}

/* -------------------------------------------------------------------------- */
/* Per-workspace settings                                                     */
/* -------------------------------------------------------------------------- */

const prepared = new WeakSet<Database>();
function table(): Database {
  const conn = db();
  if (!prepared.has(conn)) {
    conn.exec(`CREATE TABLE IF NOT EXISTS practice_settings (
      workspace_id TEXT PRIMARY KEY,
      enabled TEXT NOT NULL DEFAULT '[]',
      thresholds TEXT NOT NULL DEFAULT '{}',
      enforce TEXT NOT NULL DEFAULT 'warn',
      off TEXT NOT NULL DEFAULT '{}'
    )`);
    // Tables made before the enforce mode and the switches existed.
    const have = (conn.prepare("PRAGMA table_info(practice_settings)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!have.includes("enforce")) conn.exec("ALTER TABLE practice_settings ADD COLUMN enforce TEXT NOT NULL DEFAULT 'warn'");
    if (!have.includes("off")) conn.exec("ALTER TABLE practice_settings ADD COLUMN off TEXT NOT NULL DEFAULT '{}'");
    prepared.add(conn);
  }
  return conn;
}

interface Row {
  workspace_id: string;
  enabled: string;
  thresholds: string;
  enforce: string;
  off: string;
}

function parseIds(json: string): string[] {
  try {
    return strings(JSON.parse(json));
  } catch {
    return [];
  }
}

const safeJson = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
};

/** What is switched off, as stored. A malformed entry is dropped, not an error: the rest still applies. */
function parseOff(json: string): OffMap {
  const raw = safeJson(json);
  const out: OffMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const checks = strings(o.checks).filter((c): c is PracticeCheck => (CHECK_IDS as readonly string[]).includes(c));
    const rules = strings(o.rules);
    if (rules.length || checks.length) out[id] = { rules, checks };
  }
  return out;
}

function rowsWith(id: string): Row[] {
  return (table().prepare("SELECT workspace_id, enabled, thresholds, enforce, off FROM practice_settings").all() as Row[]).filter((r) => parseIds(r.enabled).includes(id));
}

function settingsOf(wsId: string): { enabled: string[]; thresholds: Thresholds; enforce: Enforce; off: OffMap } {
  const r = table().prepare("SELECT workspace_id, enabled, thresholds, enforce, off FROM practice_settings WHERE workspace_id = ?").get(wsId) as Row | undefined;
  if (!r) return { enabled: [], thresholds: { ...DEFAULT_THRESHOLDS }, enforce: DEFAULT_ENFORCE, off: {} };
  return {
    enabled: parseIds(r.enabled),
    thresholds: checkThresholds(safeJson(r.thresholds), DEFAULT_THRESHOLDS),
    enforce: (ENFORCE as readonly string[]).includes(r.enforce) ? (r.enforce as Enforce) : DEFAULT_ENFORCE,
    off: parseOff(r.off),
  };
}

/** Thresholds from user input, over `base`: a field left out keeps its base value. */
export function checkThresholds(input: unknown, base: Thresholds): Thresholds {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = { ...base };
  for (const key of ["maxFileLines", "maxFunctionLines"] as const) {
    if (o[key] === undefined) continue;
    const n = Number(o[key]);
    if (!Number.isInteger(n) || n < 5 || n > 10_000) throw new UserError(`${key} is a whole number from 5 to 10000.`);
    out[key] = n;
  }
  return out;
}

/**
 * What is switched off, from user input, against the catalog: an unknown pack is an error; a rule or check that the pack
 * does not have is dropped (an edit to a pack can remove one, and the list still names it until the next save).
 */
export function checkOff(input: unknown, all: Pack[]): OffMap {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new UserError("off is a map of pack id to the rules and checks switched off.");
  const out: OffMap = {};
  for (const [id, v] of Object.entries(input as Record<string, unknown>)) {
    const p = all.find((x) => x.id === id);
    if (!p) throw new UserError(`No practice pack "${id}".`);
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const rules = [...new Set(strings(o.rules))].filter((r) => p.rules.includes(r));
    const checks = [...new Set(strings(o.checks))].filter((c): c is PracticeCheck => p.knownChecks.includes(c as PracticeCheck));
    if (rules.length || checks.length) out[id] = { rules, checks };
  }
  return out;
}

/** The packs of a set of ids, in catalog order, with what is switched off taken out. */
function packsFor(ids: string[], off: OffMap, all: Pack[] = catalog()): Pack[] {
  return all.filter((p) => ids.includes(p.id)).map((p) => {
    const sw = off[p.id];
    if (!sw) return p;
    return { ...p, rules: p.rules.filter((r) => !sw.rules.includes(r)), checks: p.checks?.filter((c) => !sw.checks.includes(c)) };
  });
}

/**
 * The workspace's enabled packs (only ones that still exist), thresholds, enforce mode and switches. The switches are all
 * the ones on file for packs that exist, enabled or not: a pack switched off keeps its switches for when it is turned on.
 */
export function practicesOf(wsId: string): PracticesView {
  const s = settingsOf(wsId);
  const known = new Set(catalog().map((p) => p.id));
  const enabled = s.enabled.filter((id) => known.has(id));
  const off: OffMap = Object.fromEntries(Object.entries(s.off).filter(([id]) => known.has(id)));
  return { enabled, thresholds: s.thresholds, enforce: s.enforce, off };
}

/** The enabled packs as the workspace's agents follow them: edits applied, switched-off rules and checks taken out. */
export function effectivePacks(wsId: string): Pack[] {
  const v = practicesOf(wsId);
  return packsFor(v.enabled, v.off);
}

/** The checks that run for a workspace: the effective checks of its enabled packs, in CHECK_IDS order. */
export function activeChecks(wsId: string): PracticeCheck[] {
  const packs = effectivePacks(wsId);
  return CHECK_IDS.filter((c) => packs.some((p) => p.checks?.includes(c)));
}

/**
 * Sets the enabled packs, thresholds, enforce mode and switches (a field left out keeps its value), then writes the block.
 * Validates first.
 */
export function setPractices(wsId: string, input: { enabled?: unknown; thresholds?: unknown; enforce?: unknown; off?: unknown }): PracticesView {
  const ws = Workspaces.get(wsId);
  if (!ws) throw new UserError("No such workspace.");
  if (!fs.existsSync(ws.path)) throw new UserError(`${ws.path} no longer exists.`);
  const cur = settingsOf(wsId);
  const all = catalog();
  let enabled = cur.enabled.filter((id) => all.some((p) => p.id === id));
  if (input.enabled !== undefined) {
    if (!Array.isArray(input.enabled)) throw new UserError("enabled is a list of pack ids.");
    const want = strings(input.enabled);
    for (const id of want) if (!all.some((p) => p.id === id)) throw new UserError(`No practice pack "${id}".`);
    enabled = all.map((p) => p.id).filter((id) => want.includes(id));
  }
  const thresholds = checkThresholds(input.thresholds, cur.thresholds);
  const enforce = input.enforce === undefined ? cur.enforce : checkEnforce(input.enforce);
  const off = input.off === undefined ? cur.off : checkOff(input.off, all);
  writeBlocks(ws.path, packsFor(enabled, off, all));
  table()
    .prepare("INSERT OR REPLACE INTO practice_settings (workspace_id, enabled, thresholds, enforce, off) VALUES (?, ?, ?, ?, ?)")
    .run(wsId, JSON.stringify(enabled), JSON.stringify(thresholds), enforce, JSON.stringify(off));
  return practicesOf(wsId);
}

export function checkEnforce(v: unknown): Enforce {
  if (!(ENFORCE as readonly unknown[]).includes(v)) throw new UserError("enforce is off, warn or fix.");
  return v as Enforce;
}

/** Rewrites a workspace's block from its effective packs (after a pack or one of its rules changed). */
function reRender(wsId: string): void {
  const ws = Workspaces.get(wsId);
  if (!ws || !fs.existsSync(ws.path)) return;
  writeBlocks(ws.path, effectivePacks(wsId));
}

/* -------------------------------------------------------------------------- */
/* The managed block                                                          */
/* -------------------------------------------------------------------------- */

/** Where the block is, or null. A damaged block is an error: guessing could eat the operator's text. */
function spanOf(content: string): { start: number; end: number } | null {
  const a = content.indexOf(START);
  const b = content.indexOf(END);
  if (a < 0 && b < 0) return null;
  if (a < 0 || b < 0 || b < a || content.indexOf(START, a + 1) >= 0 || content.indexOf(END, b + 1) >= 0) {
    throw new UserError("The trb practices block in this file is damaged (a start or end marker is missing or repeated). Fix or remove it by hand first.");
  }
  return { start: a, end: b + END.length };
}

/** The lines of each pack that has something to say: its title, its rules, then its skills. A pack with nothing left to say is left out. */
const sectionsOf = (packs: Pack[]): string[] =>
  packs.filter((p) => p.rules.length || p.skills?.length).flatMap((p) => ["", `### ${p.title}`, ...p.rules.map((r) => `- ${r}`), ...(p.skills ?? []).map((s) => `- Use the ${s} skill if available.`)]);

/** The block's lines between its markers. No packs means no block at all. */
function bodyOf(packs: Pack[]): string[] {
  const sections = sectionsOf(packs);
  return sections.length ? ["## Practice packs", NOTE, ...sections] : [];
}

/**
 * The practice rules of the workspace a directory belongs to, as prompt text, for an agent that does not run where
 * AGENTS.md is read (a subagent in a scratch folder). Empty when no pack is on, or the directory is in no workspace.
 * Never throws: a broken practices.json must not fail a turn.
 */
export function practicesBrief(workspaceDir: string): string {
  try {
    const wsId = owningWorkspace(workspaceDir);
    const sections = wsId ? sectionsOf(effectivePacks(wsId)) : [];
    return sections.length ? ["## Practice packs", "This project follows these practices. Follow them in everything you change.", ...sections].join("\n") : "";
  } catch (err) {
    console.warn(`[trb] practices: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

/** The content with the block set to `packs`: replaced in place, appended when absent, removed when empty. Nothing else changes. */
export function spliceBlock(content: string, packs: Pack[]): string {
  const nl = content.includes("\r\n") ? "\r\n" : "\n";
  const span = spanOf(content);
  const body = bodyOf(packs);
  if (!body.length) {
    if (!span) return content;
    // Take the blank line we added with the block, not more.
    const before = content.slice(0, span.start).replace(/(\r?\n){2,}$/, nl);
    const after = content.slice(span.end).replace(/^\r?\n/, "");
    return before + after;
  }
  const block = [START, ...body, END].join(nl);
  if (span) return content.slice(0, span.start) + block + content.slice(span.end);
  if (!content.trim()) return block + nl;
  const tail = /(\r?\n){2,}$/.test(content) ? "" : /\r?\n$/.test(content) ? nl : nl + nl;
  return content + tail + block + nl;
}

/** Both files are computed before either is written, so a damaged CLAUDE.md does not leave AGENTS.md half done. */
function writeBlocks(root: string, packs: Pack[]): void {
  const agents = fileIn(root, AGENTS_FILE);
  const claude = fileIn(root, CLAUDE_FILE);
  const aOld = read(agents);
  const cOld = read(claude);
  const aNew = spliceBlock(aOld ?? "", packs);
  const cNew = mirrorSkipReason(root, agents, claude) ? null : spliceBlock(cOld ?? "", packs);
  const put = (abs: string, old: string | null, next: string) => {
    if (old === next) return;
    // A file that only held our block disappears with it, as the memory block's does.
    if (!next.trim()) {
      if (old !== null) fs.rmSync(abs, { force: true });
    } else writeAtomic(abs, next);
  };
  put(agents, aOld, aNew);
  if (cNew !== null) put(claude, cOld, cNew);
}
