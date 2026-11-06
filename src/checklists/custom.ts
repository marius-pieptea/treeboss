/**
 * The checklist catalog the operator can edit. The effective catalog is the built-ins (catalog.ts) with the operator's edits
 * on top, plus the custom checklists, all in <home>/checklists.json:
 *
 *   { "checklists": [ { id, title, summary, appliesTo, items: [...] }, ... ] }
 *
 * An entry whose id is a built-in's id is an override: it replaces that built-in wholesale ("modified"), and "reset to
 * default" removes it. Any other entry is a custom checklist, and "delete" removes it. A built-in cannot be deleted. Saving
 * an override that equals the built-in removes the override, so the file only holds real edits.
 *
 * Every reader of the catalog goes through effectiveCatalog() / checklistById() / defaultChecklistsFor() here, never the
 * built-in list. A file that does not parse is an error, as practices.json is (see practices/store.ts).
 */
import path from "path";
import { home } from "../paths";
import { read, writeAtomic } from "../memory/store";
import { UserError } from "../util";
import { shipChecklistFindings } from "../lab/findings";
import { BUILTIN_CHECKLISTS, CHECK_IDS, type Checklist, type ChecklistItem, type CheckId, type ItemKind, type Severity } from "./catalog";

export const MAX_ITEMS = 100;
const CHECKLIST_ID = /^[a-z][a-z0-9-]{1,39}$/;
const ITEM_ID = /^[a-z][a-z0-9-]{1,39}$/;
const TAG = /^[a-z][a-z0-9-]{0,29}$/;
const SEVERITIES: readonly Severity[] = ["required", "recommended"];
const KINDS: readonly ItemKind[] = ["auto", "agent", "manual"];

const storeFile = (): string => path.join(home(), "checklists.json");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string => String(v ?? "").trim();

/** One item from user input: validated and cleaned. Throws UserError with the reason. */
export function checkItem(input: unknown): ChecklistItem {
  const o = obj(input);
  const id = text(o.id);
  if (!ITEM_ID.test(id)) throw new UserError(`An item id is 2 to 40 lowercase letters, digits or dashes, starting with a letter ("${id}").`);
  const label = `Item ${id}`;
  const t = text(o.text);
  if (!t || t.length > 200) throw new UserError(`${label}: the text is 1 to 200 characters.`);
  const category = text(o.category);
  if (!category || category.length > 40) throw new UserError(`${label}: the category is 1 to 40 characters.`);
  const severity = text(o.severity) as Severity;
  if (!SEVERITIES.includes(severity)) throw new UserError(`${label}: severity is required or recommended.`);
  const kind = text(o.kind) as ItemKind;
  if (!KINDS.includes(kind)) throw new UserError(`${label}: kind is auto, agent or manual.`);
  const hint = text(o.hint);
  if (!hint || hint.length > 500) throw new UserError(`${label}: the hint (what to do when it does not pass) is 1 to 500 characters.`);
  const base = { id, text: t, category, severity, kind, hint };
  const check = text(o.check);
  if (kind === "auto") {
    if (!(CHECK_IDS as readonly string[]).includes(check)) throw new UserError(`${label}: an auto item names its check: one of ${CHECK_IDS.join(", ")}.`);
    return { ...base, check: check as CheckId };
  }
  if (check) throw new UserError(`${label}: only an auto item names a check. Make it auto, or clear the check.`);
  return base;
}

/** A checklist from user input: validated and cleaned. Throws UserError with the reason. */
export function checkChecklist(input: unknown): Checklist {
  const o = obj(input);
  const id = text(o.id);
  if (!CHECKLIST_ID.test(id)) throw new UserError("A checklist id is 2 to 40 lowercase letters, digits or dashes, starting with a letter.");
  const title = text(o.title);
  if (!title || title.length > 60) throw new UserError("A title is 1 to 60 characters.");
  const summary = text(o.summary);
  if (summary.length > 200) throw new UserError("A summary is at most 200 characters.");
  const tags = Array.isArray(o.appliesTo) ? o.appliesTo.map(text).filter(Boolean) : [];
  const appliesTo = [...new Set(tags)];
  if (appliesTo.length > 10 || !appliesTo.every((t) => TAG.test(t))) throw new UserError("appliesTo is up to 10 tags, lowercase letters, digits or dashes (such as marketing, saas, mobile, api).");
  if (!Array.isArray(o.items) || !o.items.length || o.items.length > MAX_ITEMS) throw new UserError(`A checklist has 1 to ${MAX_ITEMS} items.`);
  const items = o.items.map(checkItem);
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) throw new UserError(`Two items have the id "${it.id}". Item ids are unique within a checklist.`);
    seen.add(it.id);
  }
  return { id, title, summary, appliesTo, items };
}

/** The stored entries, validated. A file that does not parse is an error, not an empty catalog. */
function readStore(): Checklist[] {
  const raw = read(storeFile());
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UserError("checklists.json is not valid JSON. Fix it by hand first.");
  }
  const list = (parsed as { checklists?: unknown })?.checklists;
  if (!Array.isArray(list)) throw new UserError('checklists.json must hold { "checklists": [...] }.');
  return list.map(checkChecklist);
}

function writeStore(list: Checklist[]): void {
  writeAtomic(storeFile(), JSON.stringify({ checklists: list }, null, 2) + "\n");
}

/** The fields that define a checklist, in a fixed order, for comparing with the built-in. */
const canon = (c: Checklist): string =>
  JSON.stringify({
    id: c.id,
    title: c.title,
    summary: c.summary,
    appliesTo: c.appliesTo,
    items: c.items.map((i) => ({ id: i.id, text: i.text, category: i.category, severity: i.severity, kind: i.kind, check: i.check ?? null, hint: i.hint })),
  });

const builtinOf = (id: string): Checklist | undefined => BUILTIN_CHECKLISTS.find((b) => b.id === id);

/** The catalog as the code and the operator see it: built-ins (or their overrides), then the custom checklists. */
export function effectiveCatalog(): Checklist[] {
  const stored = readStore();
  const byId = new Map<string, Checklist>();
  for (const c of stored) if (!byId.has(c.id)) byId.set(c.id, c);
  const builtin = new Set(BUILTIN_CHECKLISTS.map((b) => b.id));
  return [...BUILTIN_CHECKLISTS.map((b) => byId.get(b.id) ?? b), ...[...byId.values()].filter((c) => !builtin.has(c.id))];
}

export function checklistById(id: string): Checklist | null {
  return effectiveCatalog().find((c) => c.id === id) ?? null;
}

/** Recipes and products map to tags. A tag names what a checklist applies to (see Checklist.appliesTo). */
const RECIPE_TAGS: Record<string, string[]> = {
  "saas-next": ["saas", "marketing"],
  "expo-app": ["mobile"],
  nextjs: ["marketing"],
  "vite-react": ["marketing"],
  "hono-api": ["api"],
};

/**
 * The checklists a new workspace or product should start with. Takes a recipe id (saas-next, expo-app, ...) or
 * tags (marketing, saas, mobile, api), in any mix. Catalog order. Unknown names give none.
 */
export function defaultChecklistsFor(recipeOrTags: string | string[]): Checklist[] {
  const names = Array.isArray(recipeOrTags) ? recipeOrTags : [recipeOrTags];
  const tags = new Set(names.flatMap((n) => RECIPE_TAGS[n] ?? [n]));
  return effectiveCatalog().filter((c) => c.appliesTo.some((t) => tags.has(t)));
}

/** A checklist as the catalog page shows it: whether it came with trb, and whether an edit replaces the shipped one. */
export interface CatalogEntry extends Checklist {
  builtin: boolean;
  /** A built-in with an override in checklists.json. "Reset to default" removes the override. */
  modified: boolean;
}

export function catalogEntries(): CatalogEntry[] {
  const overridden = new Set(readStore().map((c) => c.id));
  return effectiveCatalog().map((c) => {
    const builtin = !!builtinOf(c.id);
    return { ...c, builtin, modified: builtin && overridden.has(c.id) };
  });
}

/**
 * Saves a checklist's definition under its id: a built-in becomes an override, a custom one is replaced. The id must already
 * exist and cannot change (fork to make a new one). An override equal to the built-in is dropped instead.
 */
export function saveChecklist(id: string, input: unknown): Checklist {
  const c = checkChecklist(input);
  if (c.id !== id) throw new UserError(`The id cannot change: fork "${id}" to make "${c.id}".`);
  const base = builtinOf(id);
  const list = readStore();
  const at = list.findIndex((x) => x.id === id);
  if (!base && at < 0) throw new UserError(`No checklist "${id}".`);
  const same = !!base && canon(c) === canon(base);
  const next = [...list];
  if (at >= 0) {
    if (same) next.splice(at, 1);
    else next[at] = c;
  } else if (!same) next.push(c);
  writeStore(next);
  return c;
}

/**
 * A new custom checklist. With `forkOf`, every field the input leaves out is copied from that checklist (a built-in or a
 * custom one). The id must be new: a built-in's id is taken.
 */
export function createChecklist(input: unknown, forkOf?: string | null): Checklist {
  const o = obj(input);
  let merged: Record<string, unknown> = o;
  if (forkOf) {
    const source = checklistById(forkOf);
    if (!source) throw new UserError(`No checklist "${forkOf}" to fork.`);
    merged = { ...source, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) };
  }
  const c = checkChecklist(merged);
  const list = readStore();
  if (builtinOf(c.id) || list.some((x) => x.id === c.id)) throw new UserError(`A checklist "${c.id}" already exists. Pick another id.`);
  writeStore([...list, c]);
  return c;
}

/** Puts a built-in back to what shipped. A custom checklist has no default to go back to. */
export function resetChecklist(id: string): Checklist {
  const base = builtinOf(id);
  if (!base) throw new UserError("Only checklists that came with trb have a default to go back to.");
  const list = readStore();
  if (list.some((x) => x.id === id)) writeStore(list.filter((x) => x.id !== id));
  return base;
}

/**
 * Removes a custom checklist from the catalog. Projects that had it attached keep their file (their answers are theirs);
 * the checklist simply stops being listed for them, and its open Lab findings in the given project folders are shipped.
 * A built-in cannot be deleted: reset it instead.
 */
export function deleteChecklist(id: string, projectRoots: readonly string[]): void {
  if (builtinOf(id)) throw new UserError(`${id} came with trb: reset it to its default instead.`);
  const list = readStore();
  if (!list.some((x) => x.id === id)) throw new UserError(`No custom checklist "${id}".`);
  writeStore(list.filter((x) => x.id !== id));
  for (const root of projectRoots) shipChecklistFindings(root, id);
}
