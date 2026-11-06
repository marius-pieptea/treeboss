/**
 * Which sub-view a session tab should show when opened from elsewhere ("Diff" on a head card opens the tab on
 * Changes). The shared tab model has no room for it, so the request is parked here and consumed on mount; a
 * custom event covers a tab that is already open.
 */
export type SessionPane = "conversation" | "changes" | "files" | "info";

const pending = new Map<string, SessionPane>();
const EVENT = "trb:session-view";

export function requestSessionPane(sessionId: string, view: SessionPane): void {
  pending.set(sessionId, view);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { sessionId, view } }));
}

/** Take (and clear) the parked request for a session. */
export function takeSessionPane(sessionId: string): SessionPane | null {
  const v = pending.get(sessionId) ?? null;
  pending.delete(sessionId);
  return v;
}

export function onSessionPane(sessionId: string, fn: (v: SessionPane) => void): () => void {
  const on = (e: Event) => {
    const d = (e as CustomEvent).detail as { sessionId: string; view: SessionPane };
    if (d.sessionId === sessionId) {
      pending.delete(sessionId);
      fn(d.view);
    }
  };
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}
