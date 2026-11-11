/**
 * The message queue: what you type while a turn is running waits here and goes out, in order, when the turn
 * ends. Pure list operations, so they are unit-tested directly (tests/web/queue.test.ts); the store and the
 * drain live in queue-store.ts.
 */
import type { DesignIntent } from "@/features/design/composer";

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  /** A design turn queued from the composer: the daemon wraps the text in the design instructions. */
  design?: DesignIntent;
  /** The context chips that were on the composer when it was queued. */
  context?: Array<{ kind: string; value: string; label: string }>;
}

export const forSession = (q: QueuedMessage[], sessionId: string | null | undefined) => q.filter((m) => m.sessionId === sessionId);

export const enqueue = (q: QueuedMessage[], m: QueuedMessage): QueuedMessage[] => [...q, m];

export const remove = (q: QueuedMessage[], id: string): QueuedMessage[] => q.filter((m) => m.id !== id);

/** Replace a message's text. An empty edit leaves it as it was (deleting is its own button). */
export function edit(q: QueuedMessage[], id: string, text: string): QueuedMessage[] {
  const t = text.trim();
  if (!t) return q;
  return q.map((m) => (m.id === id ? { ...m, text: t } : m));
}

/** Move a message one place up or down among its own session's messages; other sessions keep their slots. */
export function move(q: QueuedMessage[], id: string, dir: -1 | 1): QueuedMessage[] {
  const m = q.find((x) => x.id === id);
  if (!m) return q;
  const mine = forSession(q, m.sessionId);
  const from = mine.findIndex((x) => x.id === id);
  const to = from + dir;
  if (to < 0 || to >= mine.length) return q;
  const next = [...mine];
  [next[from], next[to]] = [next[to], next[from]];
  let i = 0;
  return q.map((x) => (x.sessionId === m.sessionId ? next[i++] : x));
}

/** The first message for a session, and the queue without it. */
export function takeHead(q: QueuedMessage[], sessionId: string): { head: QueuedMessage | null; rest: QueuedMessage[] } {
  const head = q.find((m) => m.sessionId === sessionId) ?? null;
  return { head, rest: head ? remove(q, head.id) : q };
}

/** Put a message that failed to send back at the front of its session's messages. */
export function putBack(q: QueuedMessage[], m: QueuedMessage): QueuedMessage[] {
  const at = q.findIndex((x) => x.sessionId === m.sessionId);
  return at === -1 ? [...q, m] : [...q.slice(0, at), m, ...q.slice(at)];
}

/** Only a lead's turn that finished cleanly sends the next message; a stopped or failed turn holds the queue. */
export function drainsOn(turnEnd: { sessionId: string; rootId: string; status: string }): boolean {
  return turnEnd.sessionId === turnEnd.rootId && turnEnd.status === "completed";
}

/**
 * Why the daemon refused a send, when the refusal is about timing: the session's turn is still live ("working",
 * e.g. an interrupt that has not landed yet) or still being recorded ("finishing"). Both are worth asking again a
 * moment later; anything else is a real failure.
 */
export function busyKind(error: string): "working" | "finishing" | null {
  if (/is still working/i.test(error)) return "working";
  if (/is still finishing/i.test(error)) return "finishing";
  return null;
}

/** One line for a strip row: the first line of the text, clipped. */
export function preview(text: string, max = 90): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
