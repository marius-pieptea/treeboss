/**
 * One WebSocket for all of a tab's live data.
 *
 * A browser holds at most six HTTP/1.1 connections to a host, and an always-open stream keeps one for as long as it
 * lives. The UI follows the global event feed (from several places), the open session's log, its heads' logs and the
 * agent browser: that is the whole budget for a single tab, and every ordinary request then queues behind it. So
 * every stream goes through this module: one socket, any number of subscriptions, reconnecting with backoff and
 * resuming each log where it left off.
 *
 * `liveSource(url)` takes the same URLs the SSE endpoints take and returns something shaped like an EventSource
 * (`addEventListener`, `close`, `onerror`), so callers did not need to change shape when the transport did.
 */

export type StreamRequest =
  | { stream: "global"; logs?: boolean; lastEventId?: number }
  | { stream: "session"; session: string; tree?: boolean; since?: number; from?: "turn" }
  | { stream: "browser"; session: string }
  | { stream: "emulator" };

/** Map an SSE-style URL to the subscription it stands for. null when it is not a live stream. */
export function parseStreamUrl(href: string): StreamRequest | null {
  const u = new URL(href, "http://x");
  const p = u.pathname;
  if (p === "/api/stream") {
    const last = Number(u.searchParams.get("lastEventId"));
    const lastEventId = Number.isSafeInteger(last) && last >= 0 && u.searchParams.has("lastEventId") ? last : undefined;
    return { stream: "global", logs: u.searchParams.get("logs") === "1", ...(lastEventId !== undefined ? { lastEventId } : {}) };
  }
  let m = /^\/api\/sessions\/([^/]+)\/events$/.exec(p);
  if (m) {
    const since = Number(u.searchParams.get("since") ?? 0) || 0;
    return { stream: "session", session: m[1], tree: u.searchParams.get("tree") === "1", ...(since ? { since } : {}), ...(u.searchParams.get("from") === "turn" ? { from: "turn" as const } : {}) };
  }
  m = /^\/api\/browser\/([^/]+)\/stream$/.exec(p);
  if (m) return { stream: "browser", session: m[1] };
  if (p === "/api/emulator/stream") return { stream: "emulator" };
  return null;
}

/** Shaped like a MessageEvent: `lastEventId` is the feed's sequence id of this event, "" when it has none. */
type Listener = (e: { data: string; lastEventId: string }) => void;

export interface LiveSource {
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  close(): void;
  /** Called only when the server refuses the subscription (an unknown session); transient disconnects are retried silently. */
  onerror: ((e?: unknown) => void) | null;
}

interface Sub {
  id: string;
  req: StreamRequest;
  listeners: Map<string, Set<Listener>>;
  /** The highest log id delivered, so a reconnect replays only what was missed. */
  lastLogId: number;
  /** The highest global feed id delivered (the EventSource Last-Event-ID), so a reconnect replays only what was missed. */
  lastEventId: number | null;
  source: SourceImpl;
}

let socket: WebSocket | null = null;
let connecting = false;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const subs = new Map<string, Sub>();

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/live`;
}

function frame(sub: Sub) {
  const r = sub.req;
  // On a reconnect, resume a log subscription after the last line we saw.
  if (r.stream === "session") return { op: "sub", id: sub.id, ...r, since: Math.max(r.since ?? 0, sub.lastLogId), ...(sub.lastLogId ? { from: undefined } : {}) };
  if (r.stream === "global") return { op: "sub", id: sub.id, ...r, ...(sub.lastEventId !== null ? { lastEventId: sub.lastEventId } : {}) };
  return { op: "sub", id: sub.id, ...r };
}

function ensureConnected(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (connecting || subs.size === 0) return;
  connecting = true;
  const ws = new WebSocket(wsUrl());
  socket = ws;
  ws.onopen = () => {
    connecting = false;
    attempts = 0;
    for (const s of subs.values()) ws.send(JSON.stringify(frame(s)));
  };
  ws.onmessage = (e) => {
    let msg: { id: string; event: string; data: unknown; eventId?: number };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    const sub = subs.get(msg.id);
    if (!sub) return;
    if (msg.event === "log") {
      const id = (msg.data as { id?: number }).id;
      if (typeof id === "number") sub.lastLogId = Math.max(sub.lastLogId, id);
    }
    if (msg.event === "error") {
      sub.source.onerror?.(msg.data);
      return;
    }
    const eventId = typeof msg.eventId === "number" ? msg.eventId : null;
    if (eventId !== null) sub.lastEventId = Math.max(sub.lastEventId ?? 0, eventId);
    const data = JSON.stringify(msg.data);
    for (const l of sub.listeners.get(msg.event) ?? []) l({ data, lastEventId: eventId !== null ? String(eventId) : "" });
  };
  ws.onclose = () => {
    connecting = false;
    if (socket === ws) socket = null;
    if (subs.size === 0) return;
    // Back off, but never give up: the daemon may be restarting.
    const delay = Math.min(5000, 400 * 2 ** Math.min(attempts++, 4));
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(ensureConnected, delay);
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

class SourceImpl implements LiveSource {
  onerror: ((e?: unknown) => void) | null = null;
  private sub: Sub | null;
  constructor(req: StreamRequest) {
    const id = String(nextId++);
    // A global subscription may start from an id the caller already has (`?lastEventId=`), as a reconnect does.
    this.sub = { id, req, listeners: new Map(), lastLogId: 0, lastEventId: req.stream === "global" ? (req.lastEventId ?? null) : null, source: this };
    subs.set(id, this.sub);
    ensureConnected();
    // If the socket is already open this subscription must be announced now (onopen only covers the first connection).
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame(this.sub)));
  }
  addEventListener(type: string, listener: (e: MessageEvent) => void): void {
    if (!this.sub) return;
    const set = this.sub.listeners.get(type) ?? new Set();
    set.add(listener as unknown as Listener);
    this.sub.listeners.set(type, set);
  }
  close(): void {
    const sub = this.sub;
    if (!sub) return;
    this.sub = null;
    subs.delete(sub.id);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "unsub", id: sub.id }));
    // Nothing left to follow: let go of the socket too.
    if (subs.size === 0 && socket) {
      const s = socket;
      socket = null;
      s.close();
    }
  }
}

/** Follow a live stream. Same URLs as the SSE endpoints; one shared WebSocket underneath. */
export function liveSource(href: string): LiveSource {
  const req = parseStreamUrl(href);
  if (!req) throw new Error(`Not a live stream: ${href}`);
  return new SourceImpl(req);
}

/** For tests and diagnostics. */
export function liveStats(): { subscriptions: number; open: boolean } {
  return { subscriptions: subs.size, open: socket?.readyState === WebSocket.OPEN };
}

/** Test seam: forget every subscription and the socket. */
export function resetLiveForTests(): void {
  for (const s of [...subs.values()]) s.source.close();
  subs.clear();
  socket = null;
  connecting = false;
  attempts = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}
