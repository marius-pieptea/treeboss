/**
 * The queue's state (persisted, so a reload keeps what you lined up) and the drain that sends the next
 * message when a turn ends. Nothing auto-sends on load: a message only goes out on a turn ending or on "Send now".
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import { get, post, url } from "@/lib/api";
import { bus } from "@/lib/bus";
import type { SessionView } from "@/lib/types";
import { busyKind, drainsOn, edit, enqueue, move, putBack, remove, takeHead, type QueuedMessage } from "./queue-logic";

interface QueueState {
  queue: QueuedMessage[];
  add(m: Omit<QueuedMessage, "id">): void;
  remove(id: string): void;
  edit(id: string, text: string): void;
  move(id: string, dir: -1 | 1): void;
  clear(sessionId: string): void;
}

let n = 0;
const newId = () => `q_${Date.now().toString(36)}_${(n++).toString(36)}`;

export const useQueue = create<QueueState>()(
  persist(
    (set) => ({
      queue: [],
      add: (m) => set((s) => ({ queue: enqueue(s.queue, { ...m, id: newId() }) })),
      remove: (id) => set((s) => ({ queue: remove(s.queue, id) })),
      edit: (id, text) => set((s) => ({ queue: edit(s.queue, id, text) })),
      move: (id, dir) => set((s) => ({ queue: move(s.queue, id, dir) })),
      clear: (sessionId) => set((s) => ({ queue: s.queue.filter((m) => m.sessionId !== sessionId) })),
    }),
    { name: "trb.queue", partialize: (s) => ({ queue: s.queue }) },
  ),
);

const sendBody = (m: QueuedMessage) => ({ message: m.text, ...(m.design ? { design: m.design } : {}), ...(m.context?.length ? { context: m.context } : {}) });

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Take a message off the queue and let the thread show it as on its way, before the daemon has answered. */
function take(id: string): QueuedMessage | null {
  const m = useQueue.getState().queue.find((x) => x.id === id);
  if (!m) return null;
  useQueue.setState((s) => ({ queue: remove(s.queue, id) }));
  bus.emit("queue-send-start", { sessionId: m.sessionId, text: m.text });
  return m;
}

/** A send that did not go out: back to the front of its queue, out of the thread, and said why (unless `error` is null). */
function giveBack(m: QueuedMessage, error: string | null): void {
  useQueue.setState((s) => ({ queue: putBack(s.queue, m) }));
  bus.emit("queue-send-fail", { sessionId: m.sessionId });
  if (error) toast.error(error);
}

interface DeliverOptions {
  /** Which "busy" refusals to ask again on, and for how long in all. */
  retry: Array<"working" | "finishing">;
  patienceMs: number;
  /** A refusal because the session is still working puts the message back without a toast (the drain: it goes out on that turn's end). */
  quietWhenWorking?: boolean;
}

/** Post a taken message. True when the daemon took it; otherwise it is back in the queue. */
async function deliver(m: QueuedMessage, o: DeliverOptions): Promise<boolean> {
  const until = Date.now() + o.patienceMs;
  for (;;) {
    try {
      await post(url.session(m.sessionId, "send"), sendBody(m));
      return true;
    } catch (e) {
      const msg = errText(e);
      const busy = busyKind(msg);
      if (busy && o.retry.includes(busy) && Date.now() < until) {
        await sleep(250);
        continue;
      }
      giveBack(m, busy === "working" && o.quietWhenWorking ? null : msg);
      return false;
    }
  }
}

/**
 * Stop the running turn, then send this message. It leaves the queue and shows in the thread at once; the
 * interrupt and the send happen behind it, and a failure puts it back.
 */
export async function sendQueuedNow(id: string, running: boolean): Promise<void> {
  const m = take(id);
  if (!m) return;
  if (running) {
    try {
      await post(url.session(m.sessionId, "interrupt"));
    } catch (e) {
      giveBack(m, errText(e));
      return;
    }
  }
  // The interrupt gives up waiting after 5 s, and a stopped turn may still be being recorded: ask again until it is free.
  await deliver(m, { retry: ["working", "finishing"], patienceMs: 8000 });
}

const draining = new Set<string>();

/** Called on every `turn_end`: a lead's clean finish sends its next queued message. */
export async function drainOnTurnEnd(d: { sessionId: string; rootId: string; status: string }): Promise<void> {
  if (!drainsOn(d) || draining.has(d.sessionId)) return;
  if (!takeHead(useQueue.getState().queue, d.sessionId).head) return;
  draining.add(d.sessionId);
  try {
    // The daemon may start its own follow-up (a fix turn, a goal check) right after the turn ends; if so the
    // session is not idle and the message waits for that turn's end instead.
    await sleep(300);
    const detail = await get<{ session: SessionView }>(url.session(d.sessionId)).catch(() => null);
    if (!detail || detail.session.status !== "idle") return;
    // The head now: it may have been sent by hand, removed or reordered while we looked.
    const head = takeHead(useQueue.getState().queue, d.sessionId).head;
    const m = head ? take(head.id) : null;
    if (m) await deliver(m, { retry: ["finishing"], patienceMs: 3000, quietWhenWorking: true });
  } finally {
    draining.delete(d.sessionId);
  }
}
