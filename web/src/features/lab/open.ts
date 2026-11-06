import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";
import { stashBugs, stashChecklists, stashFindings, viewTab, type BugsIntent, type ChecklistsIntent, type FindingsIntent } from "./views";

/** Open Findings, set up for a pass: the palette commands and other modules use this. */
export function openFindings(intent: FindingsIntent = {}): void {
  stashFindings(intent);
  useUi.getState().openTab(viewTab("findings"));
  setTimeout(() => bus.emit("findings-open"), 60);
}

/** Open Bugs, on one bug when given. */
export function openBugs(intent: BugsIntent = {}): void {
  stashBugs(intent);
  useUi.getState().openTab(viewTab("bugs"));
  setTimeout(() => bus.emit("bugs-open"), 60);
}

/** Open Checklists, on a checklist and an item of it when given. */
export function openChecklists(intent: ChecklistsIntent = {}): void {
  stashChecklists(intent);
  useUi.getState().openTab(viewTab("checklists"));
  setTimeout(() => bus.emit("checklists-open"), 60);
}

export function openQa(): void {
  useUi.getState().openTab(viewTab("qa"));
}
