import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";

/** What to show when the QA view opens: a feature's pane, or a bug on its feature's pane. */
export interface QaIntent {
  feature?: string;
  bug?: string;
}

let pending: QaIntent | null = null;

/** Open the QA view, on a feature or a bug when given. A view that is not mounted yet takes the intent when it mounts. */
export function openQa(intent?: QaIntent): void {
  pending = intent && (intent.feature || intent.bug) ? { ...intent } : null;
  useUi.getState().openTab({ kind: "qa", title: "QA" });
  bus.emit("qa-open");
}

export function takeQaIntent(): QaIntent | null {
  const i = pending;
  pending = null;
  return i;
}
