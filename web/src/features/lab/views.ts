import type { NewTab } from "@/lib/store";
import type { Lens } from "./data";

export type LabViewKind = "findings" | "checklists";

const TITLES: Record<LabViewKind, string> = { findings: "Findings", checklists: "Checklists" };

export const viewTab = (kind: LabViewKind): NewTab => ({ kind, title: TITLES[kind] });

export interface FindingsIntent {
  lens?: Lens;
  /** `project`, `diff` or a path. */
  scope?: string;
  /** Open the sweep dialog for the lens. */
  sweep?: boolean;
  /** Show this finding: the list is filtered to the checklist lens and the finding opens. */
  finding?: string;
}

export interface ChecklistsIntent {
  /** The checklist to show, and the item of it to bring into view. */
  checklist?: string;
  item?: string;
}

/** An intent that arrived before its view was mounted (the views load on first use). The view takes it when it appears. */
const pending: { findings: FindingsIntent | null; checklists: ChecklistsIntent | null } = { findings: null, checklists: null };

export const stashFindings = (i: FindingsIntent): void => void (pending.findings = i);
export const stashChecklists = (i: ChecklistsIntent): void => void (pending.checklists = i);

export function takePendingFindings(): FindingsIntent | null {
  const p = pending.findings;
  pending.findings = null;
  return p;
}

export function takePendingChecklists(): ChecklistsIntent | null {
  const p = pending.checklists;
  pending.checklists = null;
  return p;
}
