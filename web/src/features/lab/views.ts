import type { NewTab } from "@/lib/store";
import type { Lens } from "./data";

/** The Lab's views, each its own tab: the findings, the bugs logged from the browser, and the launch checklists of the project. */
export type LabViewKind = "findings" | "bugs" | "checklists" | "qa";

const TITLES: Record<LabViewKind, string> = { findings: "Findings", bugs: "Bugs", checklists: "Checklists", qa: "QA" };

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

export interface BugsIntent {
  /** Scroll to this bug and highlight it. */
  finding?: string;
}

export interface ChecklistsIntent {
  /** The checklist to show, and the item of it to bring into view. */
  checklist?: string;
  item?: string;
}

/** An intent that arrived before its view was mounted (the views load on first use). The view takes it when it appears. */
const pending: { findings: FindingsIntent | null; bugs: BugsIntent | null; checklists: ChecklistsIntent | null } = { findings: null, bugs: null, checklists: null };

export const stashFindings = (i: FindingsIntent): void => void (pending.findings = i);
export const stashBugs = (i: BugsIntent): void => void (pending.bugs = i);
export const stashChecklists = (i: ChecklistsIntent): void => void (pending.checklists = i);

export function takePendingFindings(): FindingsIntent | null {
  const p = pending.findings;
  pending.findings = null;
  return p;
}

export function takePendingBugs(): BugsIntent | null {
  const p = pending.bugs;
  pending.bugs = null;
  return p;
}

export function takePendingChecklists(): ChecklistsIntent | null {
  const p = pending.checklists;
  pending.checklists = null;
  return p;
}
