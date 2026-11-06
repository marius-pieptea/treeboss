/**
 * The checklist editor's form, as pure functions: a definition (what the catalog API takes) to a form and back, the checks a
 * form needs before it is saved, and the moves that reorder items. The server validates again (src/checklists/custom.ts);
 * these checks only let the editor say what is wrong before a save.
 */
import type { CatalogDef, CatalogItem, ItemKind, Severity } from "./data";

/** The note the store writes on an item a project disabled (src/checklists/project.ts). */
export const DISABLED_NOTE = "disabled for this project";

export interface ItemForm {
  /** A key for the row while it is edited. Not saved. */
  key: number;
  id: string;
  text: string;
  category: string;
  severity: Severity;
  kind: ItemKind;
  check: string;
  hint: string;
}

export interface ChecklistForm {
  id: string;
  title: string;
  summary: string;
  /** The tags as typed: comma-separated. */
  appliesTo: string;
  items: ItemForm[];
  /** A checklist not saved yet (a new one or a fork). Its id can still be typed. */
  isNew: boolean;
}

const CHECKLIST_ID = /^[a-z][a-z0-9-]{1,39}$/;
const TAG = /^[a-z][a-z0-9-]{0,29}$/;
export const MAX_ITEMS = 100;

let nextKey = 1;
const key = () => nextKey++;

export const splitTags = (s: string): string[] => [...new Set(s.split(",").map((t) => t.trim()).filter(Boolean))];

export function toForm(def: CatalogDef, opts: { isNew?: boolean } = {}): ChecklistForm {
  return {
    id: def.id,
    title: def.title,
    summary: def.summary,
    appliesTo: def.appliesTo.join(", "),
    items: def.items.map((i) => ({ key: key(), id: i.id, text: i.text, category: i.category, severity: i.severity, kind: i.kind, check: i.check ?? "", hint: i.hint })),
    isNew: !!opts.isNew,
  };
}

/** The definition the form stands for. A check is kept only on an auto item (the server refuses one anywhere else). */
export function toDefinition(f: ChecklistForm): CatalogDef {
  return {
    id: f.id.trim(),
    title: f.title.trim(),
    summary: f.summary.trim(),
    appliesTo: splitTags(f.appliesTo),
    items: f.items.map((i): CatalogItem => ({
      id: i.id.trim(),
      text: i.text.trim(),
      category: i.category.trim(),
      severity: i.severity,
      kind: i.kind,
      hint: i.hint.trim(),
      ...(i.kind === "auto" && i.check ? { check: i.check } : {}),
    })),
  };
}

/** The first thing wrong with the form, in words. Null when it can be saved. */
export function formProblem(f: ChecklistForm): string | null {
  if (!CHECKLIST_ID.test(f.id.trim())) return "The id is 2 to 40 lowercase letters, digits or dashes, starting with a letter.";
  if (!f.title.trim() || f.title.trim().length > 60) return "The title is 1 to 60 characters.";
  if (f.summary.trim().length > 200) return "The summary is at most 200 characters.";
  const tags = splitTags(f.appliesTo);
  if (tags.length > 10 || !tags.every((t) => TAG.test(t))) return "Tags are up to 10, lowercase letters, digits or dashes.";
  if (!f.items.length) return "A checklist has at least one item.";
  if (f.items.length > MAX_ITEMS) return `A checklist has at most ${MAX_ITEMS} items.`;
  const ids = new Set<string>();
  for (const [n, i] of f.items.entries()) {
    const where = `Item ${n + 1}`;
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(i.id.trim())) return `${where}: the id is 2 to 40 lowercase letters, digits or dashes.`;
    if (ids.has(i.id.trim())) return `${where}: the id "${i.id.trim()}" is used by another item.`;
    ids.add(i.id.trim());
    if (!i.text.trim() || i.text.trim().length > 200) return `${where}: the text is 1 to 200 characters.`;
    if (!i.category.trim() || i.category.trim().length > 40) return `${where}: the category is 1 to 40 characters.`;
    if (!i.hint.trim() || i.hint.trim().length > 500) return `${where}: the hint (what to do when it does not pass) is 1 to 500 characters.`;
    if (i.kind === "auto" && !i.check) return `${where}: an automatic item needs its check.`;
  }
  return null;
}

/** Whether two forms hold the same definition (the save button is off until they differ). */
export const sameForm = (a: ChecklistForm, b: ChecklistForm): boolean => JSON.stringify(toDefinition(a)) === JSON.stringify(toDefinition(b));

/** A new item row, after the last one. Its id is left for the author to name. */
export function blankItem(category = "General"): ItemForm {
  return { key: key(), id: "", text: "", category, severity: "recommended", kind: "agent", check: "", hint: "" };
}

/** An empty new checklist. The id is free until saved. */
export function blankForm(): ChecklistForm {
  return { id: "", title: "", summary: "", appliesTo: "", items: [blankItem()], isNew: true };
}

/** A copy of a checklist under a new id, not saved yet. */
export function forkForm(source: ChecklistForm, id: string, title: string): ChecklistForm {
  return { ...source, id, title, isNew: true, items: source.items.map((i) => ({ ...i, key: key() })) };
}

/** The list with the item at `index` moved one place up (-1) or down (1). Other positions do not change. */
export function moveItem<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const to = index + dir;
  if (to < 0 || to >= list.length) return list;
  const out = [...list];
  [out[index], out[to]] = [out[to]!, out[index]!];
  return out;
}

/** The check a kind allows: an auto item names one, others name none. */
export function checkFor(kind: ItemKind, check: string): string {
  return kind === "auto" ? check : "";
}

/** A checklist id from a title, for a fork or a new one that has no id yet. */
export const idFrom = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Whether an item is one a project disabled (the note on its line, pinned by hand). */
export const isDisabledItem = (i: { status: string; source: string | null; note: string | null }): boolean => i.status === "na" && i.source === "manual" && i.note === DISABLED_NOTE;
