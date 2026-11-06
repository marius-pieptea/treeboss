/**
 * Text for the composer of a fresh session, not sent: the operator reads it and sends. Other views (the Evidence
 * build hand-off) use this. Same shape as features/design/composer.ts: the composer may not be mounted yet (the
 * right panel was closed), so it takes the text when it mounts or hears the event.
 */
import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";

let pending: string | null = null;

/** Called by the composer when it mounts or hears "composer-prefill": the text waiting for it, once. */
export function takePendingPrefill(): string | null {
  const p = pending;
  pending = null;
  return p;
}

export function prefillNewSession(text: string): void {
  pending = text;
  const ui = useUi.getState();
  ui.setActiveSession(null);
  ui.setRightTab("agent");
  setTimeout(() => bus.emit("composer-prefill"), 40);
}
