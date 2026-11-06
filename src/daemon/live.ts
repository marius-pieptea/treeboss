/**
 * Live data for the web UI over ONE WebSocket per tab.
 *
 * Why not one SSE stream per thing: a browser allows six HTTP/1.1 connections to a host, and a long-lived stream
 * holds one for as long as it is open. The UI follows the global event feed, the open session's log, its heads'
 * logs and the agent browser; a second tab doubles that. Six held connections later every ordinary request queues
 * behind them and the page looks hung ("The daemon is not answering"). WebSockets do not draw on that pool, and one
 * socket can carry any number of subscriptions.
 *
 * Protocol (JSON frames):
 *   client -> { op: "sub", id, stream: "global" | "session" | "browser" | "emulator", session?, tree?, since?, from?, logs?, lastEventId? }
 *   client -> { op: "unsub", id }
 *   server -> { id, event, data, eventId? }   (the same events, with the same payloads, the SSE endpoints send;
 *                                              `eventId` is the global feed's sequence id, as SSE's `id:` line)
 *   server -> { id, event: "error", data: { status, message } } when a subscription cannot be made
 */
import { Hub, type HubEvent } from "../sessions/hub";
import { globalFeed, parseLastEventId, type FeedEntry } from "./global-feed";
import { db } from "../db";
import { descendantsOf, getSession, readLog, type SessionRecord } from "../sessions/manager";
import { followBrowser } from "./routes/x_browser";
import { followEmulator } from "./routes/emulator";
import { isRemoteOn } from "../remote/hosts";
import { tokenIsLive } from "../remote/store";

export type Emit = (event: string, data: unknown, id?: number) => void;

/**
 * Every session's state changes (and, with `logs`, every log line): the feed the whole UI refreshes from. Numbered:
 * `lastEventId` (the last id the client saw) replays what it missed first, or sends `reset` when that is out of the
 * ring. Replay and subscribe run in one synchronous step, so nothing is lost or doubled between them.
 */
export function followGlobal(withLogs: boolean, emit: Emit, lastEventId?: number): () => void {
  const send = (entry: FeedEntry) => {
    if (entry.event.type === "log" && !withLogs) return;
    emit(entry.event.type, entry.event, entry.seq);
  };
  emit("hello", { t: Date.now() }, globalFeed.latest());
  if (lastEventId !== undefined) {
    const missed = globalFeed.since(lastEventId);
    if (missed.reset) emit("reset", { t: Date.now() }, globalFeed.latest());
    else for (const entry of missed.entries) send(entry);
  }
  return globalFeed.subscribe(send);
}

/**
 * A session's log (and, with `tree`, everything under its root): replay from `since`, then follow live, with
 * state and turn events. Subscribes BEFORE replaying and buffers, so no line is lost between the two.
 */
export function followSession(s: SessionRecord, o: { since?: number; tree?: boolean; fromTurn?: boolean }, emit: Emit): () => void {
  let since = o.since ?? 0;
  if (o.fromTurn && s.last_turn_id) {
    const first = db().prepare("SELECT MIN(id) AS id FROM events WHERE turn_id = ?").get(s.last_turn_id) as { id: number | null };
    if (first?.id) since = Math.max(since, first.id - 1);
  }
  const tree = o.tree === true;
  // Which agent a line came from, for a tree view: its role, or the engine when it has none.
  const labels = new Map<string, { label: string; depth: number }>();
  const labelOf = (id: string) => {
    let l = labels.get(id);
    if (!l) {
      const row = getSession(id);
      l = { label: row ? row.role || row.engine : id, depth: row?.depth ?? 0 };
      labels.set(id, l);
    }
    return l;
  };

  const buffered: HubEvent[] = [];
  let replaying = true;
  let lastSent = since;
  const inScope = (e: HubEvent) => (tree ? e.rootId === s.root_id : e.sessionId === s.id);
  const deliver = (e: HubEvent) => {
    if (e.type === "log") {
      if (e.eventId <= lastSent) return;
      lastSent = e.eventId;
      emit("log", { session: e.sessionId, id: e.eventId, turn_id: e.turnId, text: e.text, kind: e.kind, data: e.data, ...labelOf(e.sessionId) });
    } else emit(e.type, e);
  };
  const unsubscribe = Hub.subscribe((e) => {
    if (!inScope(e)) return;
    if (replaying) buffered.push(e);
    else deliver(e);
  });

  const ids = tree ? [s.id, ...descendantsOf(s.id).map((k) => k.id)] : [s.id];
  const rows = ids.flatMap((id) => readLog(id, { sinceId: since, limit: 20000 }).map((r) => ({ ...r, session_id: id }))).sort((a, b) => a.id - b.id);
  for (const r of rows) {
    lastSent = Math.max(lastSent, r.id);
    emit("log", { session: r.session_id, id: r.id, turn_id: r.turn_id, text: r.text, kind: r.kind, data: r.data, ...labelOf(r.session_id) });
  }
  replaying = false;
  for (const e of buffered) deliver(e);
  emit("state", { type: "state", sessionId: s.id, rootId: s.root_id, status: getSession(s.id)?.status ?? s.status });
  return unsubscribe;
}

export interface LiveSocketData {
  kind: "live";
  subs: Map<string, () => void>;
  /** Set when a paired remote device opened this socket: it may not follow the agent browser, and it is checked on every message. */
  remoteId?: string;
}

interface WsLike {
  data: LiveSocketData;
  send(s: string): unknown;
  close?(code?: number, reason?: string): void;
}

const MAX_SUBS_PER_SOCKET = 64;

export const liveSocket = {
  open(_ws: WsLike) {},

  message(ws: WsLike, raw: string | Buffer) {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (ws.data.remoteId && !(isRemoteOn() && tokenIsLive(ws.data.remoteId))) {
      ws.close?.(4401, "Session ended.");
      return;
    }
    const id = String(msg?.id ?? "");
    const send = (event: string, data: unknown, eventId?: number) => {
      try {
        ws.send(JSON.stringify({ id, event, data, ...(eventId !== undefined ? { eventId } : {}) }));
      } catch {}
    };
    const fail = (status: number, message: string) => send("error", { status, message });

    if (msg.op === "unsub") {
      ws.data.subs.get(id)?.();
      ws.data.subs.delete(id);
      return;
    }
    if (msg.op !== "sub" || !id) return;
    ws.data.subs.get(id)?.(); // re-subscribing under the same id replaces it (a reconnect does this)
    ws.data.subs.delete(id);
    if (ws.data.subs.size >= MAX_SUBS_PER_SOCKET) return fail(429, "Too many subscriptions on this connection.");

    try {
      if (msg.stream === "global") {
        ws.data.subs.set(id, followGlobal(msg.logs === true, send, parseLastEventId(msg.lastEventId)));
      } else if (msg.stream === "session") {
        const s = getSession(String(msg.session ?? ""));
        if (!s) return fail(404, `No session "${msg.session}".`);
        ws.data.subs.set(id, followSession(s, { since: Number(msg.since) || 0, tree: msg.tree === true, fromTurn: msg.from === "turn" }, send));
      } else if (msg.stream === "browser") {
        if (ws.data.remoteId) return fail(403, "The agent browser is not available to a remote device.");
        ws.data.subs.set(id, followBrowser(String(msg.session ?? ""), send));
      } else if (msg.stream === "emulator") {
        if (ws.data.remoteId) return fail(403, "The Android emulator is not available to a remote device.");
        ws.data.subs.set(id, followEmulator(send));
      } else fail(400, `Unknown stream "${msg.stream}".`);
    } catch (err: any) {
      fail(500, err?.message ?? "Subscription failed.");
    }
  },

  close(ws: WsLike) {
    for (const stop of ws.data.subs.values()) {
      try {
        stop();
      } catch {}
    }
    ws.data.subs.clear();
  },
};
