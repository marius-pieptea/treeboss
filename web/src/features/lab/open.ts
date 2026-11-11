import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";
import { stashChecklists, stashFindings, viewTab, type ChecklistsIntent, type FindingsIntent } from "./views";

/** Open Findings, set up for a pass: the palette commands and other modules use this. */
export function openFindings(intent: FindingsIntent = {}): void {
  stashFindings(intent);
  useUi.getState().openTab(viewTab("findings"));
  setTimeout(() => bus.emit("findings-open"), 60);
}

/** Open Checklists, on a checklist and an item of it when given. */
export function openChecklists(intent: ChecklistsIntent = {}): void {
  stashChecklists(intent);
  useUi.getState().openTab(viewTab("checklists"));
  setTimeout(() => bus.emit("checklists-open"), 60);
}
