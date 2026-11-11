/** A tiny typed event bus for UI-only signals that do not belong in a store ("focus the composer"). */
type Handler<T> = (payload: T) => void;

export interface BusEvents {
  "focus-composer": void;
  /** Text for the open composer (a picked preview element, console errors): appended to the draft. */
  "composer-insert": { text: string };
  /** Switch the composer's mode (a palette command): the open session's, or the next one's. */
  "composer-mode": { mode: "build" | "plan" | "ask" };
  /** A design intent is waiting for the composer (features/design/composer.ts takePendingDesign). */
  "composer-design": void;
  /** A prompt is waiting for the composer of a fresh session (features/agent/prefill.ts prefillNewSession). */
  "composer-prefill": void;
  /** The Evidence tab should open its new-investigation form (features/evidence/open.ts). */
  "evidence-new-investigation": void;
  /** Open the model chip of the open session (palette: "Switch model…"). */
  "model-switch": void;
  "reveal-in-explorer": { path: string };
  "open-quick-open": void;
  "open-command-palette": void;
  /** Palette: focus the sessions filter with "search inside conversations" on. */
  "sessions-search": void;
  "terminal-run": { terminalId: string; command: string };
  "editor-goto": { path: string; line: number; column?: number };
  "toggle-terminal": void;
  "specs-new-feature": void;
  "specs-architecture": void;
  "docs-new-page": void;
  "docs-new-adr": void;
  "docs-generate": void;
  "roadmap-new-item": void;
  /** The Findings, Bugs and Checklists views pick up the intent features/lab/open.ts left for them. */
  "findings-open": void;
  "bugs-open": void;
  "checklists-open": void;
  /** The QA view picks up the intent features/qa/open.ts left for it. */
  "qa-open": void;
  /** A tab with unsaved edits was closed on purpose: the editor should drop its buffer. */
  "tab-discard": { id: string };
  /** A queued message left the queue and is on its way (features/agent/queue-store.ts): the thread shows it at once. */
  "queue-send-start": { sessionId: string; text: string };
  /** That send failed and the message is back in the queue: the thread drops it. */
  "queue-send-fail": { sessionId: string };
}

const handlers = new Map<string, Set<Handler<any>>>();

export const bus = {
  on<K extends keyof BusEvents>(name: K, h: Handler<BusEvents[K]>): () => void {
    let set = handlers.get(name);
    if (!set) handlers.set(name, (set = new Set()));
    set.add(h);
    return () => set!.delete(h);
  },
  emit<K extends keyof BusEvents>(name: K, ...payload: BusEvents[K] extends void ? [] : [BusEvents[K]]): void {
    for (const h of handlers.get(name) ?? []) h(payload[0]);
  },
};
