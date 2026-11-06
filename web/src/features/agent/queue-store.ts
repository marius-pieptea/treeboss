/**
 * The queue's state (persisted, so a reload keeps what you lined up) and the drain that sends the next
 * message when a turn ends. Nothing auto-sends on load: a message only goes out on a turn ending or on "Send now".
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import { get, post, url } from "@/lib/api";
import type { SessionView } from "@/lib/types";
import { drainsOn, edit, enqueue, move, putBack, remove, takeHead, type QueuedMessage } from "./queue-logic";

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

/** Send one queued message now. On failure it goes back to the front of its queue and false comes back. */
export async function sendQueued(id: string): Promise<boolean> {
  const m = useQueue.getState().queue.find((x) => x.id === id);
  if (!m) return false;
  useQueue.setState((s) => ({ queue: remove(s.queue, id) }));
  try {
    await post(url.session(m.sessionId, "send"), sendBody(m));
    return true;
  } catch (e) {
    useQueue.setState((s) => ({ queue: putBack(s.queue, m) }));
    toast.error(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Stop the running turn, then send this message. */
export async function sendQueuedNow(id: string, running: boolean): Promise<void> {
  const m = useQueue.getState().queue.find((x) => x.id === id);
  if (!m) return;
  if (running) {
    try {
      await post(url.session(m.sessionId, "interrupt"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }
  }
  await sendQueued(id);
}

const draining = new Set<string>();

/** Called on every `turn_end`: a lead's clean finish sends its next queued message. */
export async function drainOnTurnEnd(d: { sessionId: string; rootId: string; status: string }): Promise<void> {
  if (!drainsOn(d) || draining.has(d.sessionId)) return;
  const { head } = takeHead(useQueue.getState().queue, d.sessionId);
  if (!head) return;
  draining.add(d.sessionId);
  try {
    // The daemon may start its own follow-up (a fix turn, a goal check) right after the turn ends; if so the
    // session is not idle and the message waits for that turn's end instead.
    await new Promise((r) => setTimeout(r, 300));
    const detail = await get<{ session: SessionView }>(url.session(d.sessionId)).catch(() => null);
    if (!detail || detail.session.status !== "idle") return;
    await sendQueued(head.id);
  } finally {
    draining.delete(d.sessionId);
  }
}
