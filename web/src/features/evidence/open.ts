import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";

/** An intent that arrived before the Evidence tab was mounted. The tab takes it when it appears. */
let pending = false;

export const takePendingNewInvestigation = (): boolean => {
  const p = pending;
  pending = false;
  return p;
};

/** Open the Evidence tab with the new-investigation form up: the palette command uses this. */
export function openNewInvestigation(): void {
  pending = true;
  useUi.getState().openTab({ kind: "evidence", title: "Evidence" });
  setTimeout(() => bus.emit("evidence-new-investigation"), 60);
}
