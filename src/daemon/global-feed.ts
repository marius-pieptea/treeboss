/**
 * The global event feed, numbered. Every hub event gets the next sequence id and is kept in a bounded ring, so a
 * client that drops (a daemon restart, a sleeping laptop, a flaky tunnel) can ask for what it missed by its last
 * id instead of reloading everything. Once the id has fallen out of the ring, the answer is a `reset`: invalidate
 * all of it.
 *
 * Ids start from the boot time (in microseconds), not from zero. A client that reconnects to a daemon restarted
 * since it last listened sends an id from the old process; with ids based on boot time that id is far below the
 * new ring, so it resets instead of being mistaken for a position in the new feed.
 */
import { Hub, type HubEvent } from "../sessions/hub";

export const FEED_CAPACITY = 1000;

export interface FeedEntry {
  seq: number;
  event: HubEvent;
}

export type Replay = { reset: true } | { reset: false; entries: FeedEntry[] };

export interface GlobalFeed {
  /** Number and keep one event. Returns the entry it was stored as. */
  record(event: HubEvent): FeedEntry;
  /** The id of the newest event (or the boot base while there are none). */
  latest(): number;
  /** Everything after `lastId`, or a reset when that is no longer (or never was) available. */
  since(lastId: number): Replay;
  /** Called for every event recorded from now on. */
  subscribe(listener: (entry: FeedEntry) => void): () => void;
  listenerCount(): number;
}

export function createFeed(capacity = FEED_CAPACITY, base = Date.now() * 1000): GlobalFeed {
  let seq = base;
  const ring: FeedEntry[] = [];
  const listeners = new Set<(entry: FeedEntry) => void>();
  return {
    record(event) {
      const entry = { seq: ++seq, event };
      ring.push(entry);
      if (ring.length > capacity) ring.shift();
      for (const l of listeners) {
        try {
          l(entry);
        } catch {}
      }
      return entry;
    },
    latest: () => seq,
    since(lastId) {
      // The oldest id still held. The first event after `lastId` must be in the ring, so `lastId` must be at least one below it.
      const oldest = ring.length ? ring[0].seq : seq + 1;
      if (lastId > seq || lastId < oldest - 1) return { reset: true };
      return { reset: false, entries: ring.filter((e) => e.seq > lastId) };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
  };
}

/** The daemon's feed. Subscribed to the hub at load, so it keeps filling even while no client is connected. */
export const globalFeed = createFeed();
Hub.subscribe((e) => {
  globalFeed.record(e);
});

/** A `Last-Event-ID` header or `lastEventId` parameter as an id. Anything that is not a non-negative integer is no id at all. */
export function parseLastEventId(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
