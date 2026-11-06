import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFeed, parseLastEventId } from "../src/daemon/global-feed";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { Hub, type HubEvent } from "../src/sessions/hub";

const TOKEN = "global-feed-test";
const bearer = { authorization: `Bearer ${TOKEN}` };
let srv: ReturnType<typeof startServer>;
beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
  setDaemonContext({ url: srv.url, token: TOKEN });
});
afterAll(() => {
  setDaemonContext(null);
  srv.stop();
});

const state = (sessionId: string, status = "idle"): HubEvent => ({ type: "state", sessionId, rootId: sessionId, status });

describe("the numbered feed", () => {
  test("every event gets the next id, in order, above the boot base", () => {
    const feed = createFeed(10, 1000);
    const a = feed.record(state("s_a"));
    const b = feed.record(state("s_b"));
    expect([a.seq, b.seq]).toEqual([1001, 1002]);
    expect(feed.latest()).toBe(1002);
    expect(feed.since(1001)).toEqual({ reset: false, entries: [b] });
    expect(feed.since(1002)).toEqual({ reset: false, entries: [] });
  });

  test("a subscriber sees each event as it is recorded, with its id", () => {
    const feed = createFeed(10, 0);
    const seen: number[] = [];
    const stop = feed.subscribe((entry) => seen.push(entry.seq));
    feed.record(state("s_a"));
    stop();
    feed.record(state("s_a"));
    expect(seen).toEqual([1]);
  });

  test("the ring is bounded: an id that has fallen out of it resets, the one just before the oldest does not", () => {
    const feed = createFeed(3, 0);
    for (let i = 0; i < 5; i++) feed.record(state(`s_${i}`));
    // Held: 3, 4, 5. Asking after 1 means 2 is needed, and 2 is gone.
    expect(feed.since(1)).toEqual({ reset: true });
    const replay = feed.since(2);
    expect(replay.reset).toBe(false);
    if (!replay.reset) expect(replay.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  test("an id past the newest (a previous daemon's, or a corrupt one) resets", () => {
    const feed = createFeed(10, 0);
    feed.record(state("s_a"));
    expect(feed.since(99)).toEqual({ reset: true });
  });

  test("a Last-Event-ID is an id only when it is a non-negative integer", () => {
    expect(parseLastEventId("12")).toBe(12);
    expect(parseLastEventId(12)).toBe(12);
    expect(parseLastEventId("0")).toBe(0);
    for (const bad of [null, undefined, "", "  ", "-1", "1.5", "abc", "9007199254740993"]) expect(parseLastEventId(bad)).toBeUndefined();
  });
});

/** Read an SSE response in the background into parsed events. */
function openStream(path: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const events: Array<{ id?: string; event: string; data: any }> = [];
  const done = (async () => {
    const res = await fetch(`${srv.url}${path}`, { headers: { ...bearer, ...headers }, signal: ac.signal });
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        for (let end = buf.indexOf("\n\n"); end >= 0; end = buf.indexOf("\n\n")) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const ev: { id?: string; event: string; data: any } = { event: "message", data: null };
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) ev.id = line.slice(4);
            else if (line.startsWith("event: ")) ev.event = line.slice(7);
            else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
          }
          events.push(ev);
        }
      }
    } catch {}
  })();
  return {
    events,
    stop: async () => {
      ac.abort();
      await done;
    },
  };
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const ours = <T extends { event: string; data: any }>(events: T[]): T[] => events.filter((e) => typeof e.data?.sessionId === "string" && e.data.sessionId.startsWith("s_feed_"));

describe("the SSE stream: ids, replay, reset", () => {
  test("events carry ids; a reconnect with Last-Event-ID gets exactly what it missed, in order", async () => {
    const first = openStream("/api/stream");
    await until(() => first.events.some((e) => e.event === "hello"));
    const hello = first.events.find((e) => e.event === "hello")!;
    expect(hello.id).toBeDefined();

    Hub.publish(state("s_feed_a", "running"));
    Hub.publish({ type: "turn_start", sessionId: "s_feed_a", rootId: "s_feed_a", turnId: "t1" });
    Hub.publish({ type: "turn_end", sessionId: "s_feed_a", rootId: "s_feed_a", turnId: "t1", status: "done" });
    await until(() => ours(first.events).length === 3);
    const [s1, t1, e1] = ours(first.events);
    expect(s1.event).toBe("state");
    expect(e1.event).toBe("turn_end");
    for (const ev of [s1, t1, e1]) expect(ev.id).toBeDefined();
    expect(Number(s1.id)).toBeGreaterThan(Number(hello.id));
    expect(Number(t1.id)).toBeGreaterThan(Number(s1.id));
    expect(Number(e1.id)).toBeGreaterThan(Number(t1.id));
    await first.stop();

    // Two more while nobody is listening.
    Hub.publish(state("s_feed_b", "running"));
    Hub.publish(state("s_feed_b", "idle"));

    const second = openStream("/api/stream", { "last-event-id": e1.id! });
    await until(() => ours(second.events).length === 2);
    const missed = ours(second.events);
    expect(second.events.some((e) => e.event === "reset")).toBe(false);
    expect(missed.map((e) => e.data.sessionId)).toEqual(["s_feed_b", "s_feed_b"]);
    expect(missed.map((e) => e.data.status)).toEqual(["running", "idle"]);
    expect(Number(missed[0].id)).toBeGreaterThan(Number(e1.id));
    await second.stop();
  });

  test("the query form works the same as the header", async () => {
    const first = openStream("/api/stream");
    await until(() => first.events.some((e) => e.event === "hello"));
    const latest = first.events.find((e) => e.event === "hello")!.id!;
    await first.stop();
    Hub.publish(state("s_feed_q", "idle"));
    const again = openStream(`/api/stream?lastEventId=${latest}`);
    await until(() => ours(again.events).length === 1);
    expect(ours(again.events)[0].data.sessionId).toBe("s_feed_q");
    await again.stop();
  });

  test("an id from before the ring (here: an id from an earlier boot) gets a reset, not a replay", async () => {
    const s = openStream("/api/stream?lastEventId=1");
    await until(() => s.events.some((e) => e.event === "reset"));
    const events = s.events.map((e) => e.event);
    expect(events.slice(0, 2)).toEqual(["hello", "reset"]);
    expect(events).not.toContain("state");
    await s.stop();
  });

  test("an id the ring has rolled past resets after a burst of more than the ring holds", async () => {
    const first = openStream("/api/stream");
    await until(() => first.events.some((e) => e.event === "hello"));
    const old = first.events.find((e) => e.event === "hello")!.id!;
    await first.stop();
    for (let i = 0; i < 1100; i++) Hub.publish(state("s_feed_flood", "idle"));
    const late = openStream("/api/stream", { "last-event-id": old });
    await until(() => late.events.some((e) => e.event === "reset"));
    expect(late.events.some((e) => e.event === "state")).toBe(false);
    await late.stop();
  });

  test("log lines are numbered too, but only sent to a client that asked for them", async () => {
    const plain = openStream("/api/stream");
    await until(() => plain.events.some((e) => e.event === "hello"));
    const from = plain.events.find((e) => e.event === "hello")!.id!;
    await plain.stop();
    Hub.publish({ type: "log", sessionId: "s_feed_log", rootId: "s_feed_log", eventId: 1, turnId: null, text: "hi", kind: "text", data: null });
    Hub.publish(state("s_feed_log", "idle"));
    const withLogs = openStream(`/api/stream?logs=1&lastEventId=${from}`);
    await until(() => ours(withLogs.events).length === 2);
    expect(ours(withLogs.events).map((e) => e.event)).toEqual(["log", "state"]);
    await withLogs.stop();
    const noLogs = openStream(`/api/stream?lastEventId=${from}`);
    await until(() => ours(noLogs.events).length === 1);
    expect(ours(noLogs.events).map((e) => e.event)).toEqual(["state"]);
    await noLogs.stop();
  });
});

describe("the live socket: the same feed on a subscription", () => {
  test("a global subscription with lastEventId replays what was missed, with eventId on each frame", async () => {
    const frames: Array<{ id: string; event: string; data: any; eventId?: number }> = [];
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/api/live`, { headers: bearer } as any);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));

    ws.send(JSON.stringify({ op: "sub", id: "g", stream: "global" }));
    await until(() => frames.some((f) => f.event === "hello"));
    const from = frames.find((f) => f.event === "hello")!.eventId!;
    ws.close();

    Hub.publish(state("s_feed_ws", "running"));
    Hub.publish(state("s_feed_ws", "idle"));

    const ws2Frames: typeof frames = [];
    const ws2 = new WebSocket(`${srv.url.replace("http", "ws")}/api/live`, { headers: bearer } as any);
    await new Promise<void>((resolve) => ws2.addEventListener("open", () => resolve()));
    ws2.addEventListener("message", (e) => ws2Frames.push(JSON.parse(String(e.data))));
    ws2.send(JSON.stringify({ op: "sub", id: "g", stream: "global", lastEventId: from }));
    await until(() => ws2Frames.filter((f) => f.data?.sessionId === "s_feed_ws").length === 2);
    const replayed = ws2Frames.filter((f) => f.data?.sessionId === "s_feed_ws");
    expect(replayed.map((f) => f.data.status)).toEqual(["running", "idle"]);
    expect(replayed.every((f) => typeof f.eventId === "number")).toBe(true);
    expect(replayed[0].eventId!).toBeGreaterThan(from);
    expect(ws2Frames.some((f) => f.event === "reset")).toBe(false);
    ws2.close();
  });
});
