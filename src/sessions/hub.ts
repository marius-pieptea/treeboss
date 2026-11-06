/**
 * In-process pub/sub for what is happening: log lines, state changes. The daemon's event
 * stream (SSE) and the web UI subscribe here; persistence is separate (`events` table), so a
 * client that connects late replays from the table and then follows live.
 */
import type { LineMeta } from "../engines/classify";

export type HubEvent =
  | { type: "log"; sessionId: string; rootId: string; eventId: number; turnId: string | null; text: string; kind: string; data: LineMeta | null }
  | { type: "state"; sessionId: string; rootId: string; status: string }
  | { type: "turn_start"; sessionId: string; rootId: string; turnId: string }
  | { type: "browser"; sessionId: string; rootId: string; url: string; action: string }
  | { type: "emulator"; sessionId: string; rootId: string; action: string }
  | { type: "plan"; sessionId: string; rootId: string; what: "question" | "answered" | "plan" | "decided" | "cancelled" }
  | { type: "context"; sessionId: string; rootId: string; tokens: number; max: number | null; compacted?: boolean }
  | { type: "wait"; sessionId: string; rootId: string }
  | { type: "turn_end"; sessionId: string; rootId: string; turnId: string; status: string };

type Listener = (e: HubEvent) => void;
const listeners = new Set<Listener>();

export const Hub = {
  publish(e: HubEvent): void {
    for (const l of listeners) {
      try {
        l(e);
      } catch {}
    }
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  listenerCount: () => listeners.size,
};
