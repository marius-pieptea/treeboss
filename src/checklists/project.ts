/**
 * A checklist as one project sees it: the effective catalog definition (custom.ts), the project-only items in its file, and
 * the file reconciled to that definition (files.ts). Every reader of an attached checklist goes through projectChecklist().
 *
 * The project's own edits live in the same file: a project-only item (a `(custom)` line) and an item disabled for this project
 * (status na, source manual, note DISABLED_NOTE). Disabling is pinned like a tick, so the checks and the audits leave it alone.
 */
import { UserError } from "../util";
import type { Checklist, ChecklistItem } from "./catalog";
import { checkItem, checklistById } from "./custom";
import { shipChecklistFindings } from "../lab/findings";
import { addItemLine, reconcileChecklistFile, removeItemLine, type ChecklistFile, type ItemAnswer } from "./files";

export const DISABLED_NOTE = "disabled for this project";

export interface ProjectChecklist {
  /** The definition, with the project-only items appended after the catalog's. */
  checklist: Checklist;
  file: ChecklistFile;
}

/** The checklist as this project sees it, with its file brought up to date. Null when the checklist is not attached (or not in the catalog). */
export function projectChecklist(root: string, id: string): ProjectChecklist | null {
  const def = checklistById(id);
  if (!def) return null;
  const file = reconcileChecklistFile(root, def);
  if (!file) return null;
  // An item the definition dropped no longer fails anything: its finding is closed with its line.
  if (file.dropped.length) shipChecklistFindings(root, def.id, (id) => !file.dropped.includes(id));
  return { checklist: { ...def, items: [...def.items, ...file.projectItems.values()] }, file };
}

/** Whether an answer is the project's own "disabled for this project" (not a check's, an agent's, or a dismissal in Lab). */
export const isDisabled = (a: ItemAnswer): boolean => a.status === "na" && a.source === "manual" && a.note === DISABLED_NOTE;

/** The answer that disables an item for this project. Evidence is kept, so the item still shows what it was. */
export const disabledAnswer = (cur: ItemAnswer): ItemAnswer => ({ status: "na", source: "manual", evidence: cur.evidence, message: null, reason: null, note: DISABLED_NOTE });

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/, "");

/**
 * A project-only item from user input. Agent or manual only: an automatic check belongs to the catalog. The id comes from the
 * text when none is given, and is unique within the checklist. Throws UserError with the reason.
 */
export function newProjectItem(c: Checklist, input: unknown): ChecklistItem {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (String(o.kind ?? "") === "auto") throw new UserError("A project item is agent or manual. An automatic check is part of the catalog definition.");
  const taken = new Set(c.items.map((i) => i.id));
  let id = String(o.id ?? "").trim();
  if (!id) {
    const base = `p-${slug(String(o.text ?? "")) || "item"}`.slice(0, 40).replace(/-+$/, "");
    id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`.slice(0, 40);
  }
  if (taken.has(id)) throw new UserError(`${c.id} already has an item "${id}".`);
  const item = checkItem({ ...o, id, check: undefined });
  return { ...item, custom: true };
}

/** Adds a project-only item to an attached checklist's file. */
export function addProjectItem(root: string, c: Checklist, input: unknown): ChecklistItem {
  const item = newProjectItem(c, input);
  addItemLine(root, c.id, item);
  return item;
}

/** Removes a project-only item. A catalog item cannot be removed from one project: disable it instead. */
export function removeProjectItem(root: string, c: Checklist, itemId: string): void {
  const item = c.items.find((i) => i.id === itemId);
  if (!item) throw new UserError(`${c.id} has no item "${itemId}".`);
  if (!item.custom) throw new UserError(`${itemId} is a catalog item: disable it for this project instead.`);
  removeItemLine(root, c.id, itemId);
}
