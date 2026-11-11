/**
 * Where unsent messages are, for the workspace switcher and the session lists: so a half-written message is not
 * forgotten when the operator moves on. Each hook re-renders only when its answer changes, not on every keystroke.
 */
import { useMemo, useSyncExternalStore } from "react";
import { draftCounts, draftKey, draftedSessions, drafts } from "./drafts";

const subscribe = (fn: () => void) => drafts.subscribe(fn);

/** Unsent agent messages per workspace id; a workspace with none is absent. */
export function useDraftCounts(): Record<string, number> {
  // A string snapshot: equal counts compare equal, so typing in a draft that already exists re-renders nothing.
  const sig = useSyncExternalStore(subscribe, () => JSON.stringify(draftCounts(drafts.all())));
  return useMemo(() => JSON.parse(sig) as Record<string, number>, [sig]);
}

/** The session ids with an unsent message. */
export function useDraftedSessions(): ReadonlySet<string> {
  const sig = useSyncExternalStore(subscribe, () => draftedSessions(drafts.all()).join(" "));
  return useMemo(() => new Set(sig ? sig.split(" ") : []), [sig]);
}

/** Whether the workspace's not-yet-started session has an unsent message. */
export function useNewSessionDraft(wsId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => !!drafts.all()[draftKey(wsId, null)]);
}
