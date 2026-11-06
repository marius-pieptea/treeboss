import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { liveSource, liveStats, parseStreamUrl, resetLiveForTests } from "../../web/src/lib/live";

describe("parseStreamUrl", () => {
  test("the three stream URLs the UI used to open as SSE", () => {
    expect(parseStreamUrl("/api/stream")).toEqual({ stream: "global", logs: false });
    expect(parseStreamUrl("/api/stream?logs=1")).toEqual({ stream: "global", logs: true });
    expect(parseStreamUrl("/api/sessions/s_abc/events?since=12&tree=1")).toEqual({ stream: "session", session: "s_abc", tree: true, since: 12 });
    expect(parseStreamUrl("/api/sessions/s_abc/events")).toEqual({ stream: "session", session: "s_abc", tree: false });
    expect(parseStreamUrl("/api/sessions/s_abc/events?from=turn")).toMatchObject({ from: "turn" });
    expect(parseStreamUrl("/api/browser/s_abc/stream")).toEqual({ stream: "browser", session: "s_abc" });
  });
  test("anything else is not a stream", () => {
    expect(parseStreamUrl("/api/sessions")).toBeNull();
    expect(liveSource.bind(null, "/api/nope")).toThrow(/Not a live stream/);
  });
});

/** A WebSocket we can drive by hand. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(id: string, event: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ id, event, data }) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  (globalThis as any).WebSocket = FakeSocket;
  (globalThis as any).location = { protocol: "http:", host: "127.0.0.1:4477" };
  resetLiveForTests();
});
afterEach(() => resetLiveForTests());

describe("one socket for everything", () => {
  test("many subscriptions share one connection to /api/live", () => {
    liveSource("/api/stream");
    liveSource("/api/stream");
    liveSource("/api/sessions/s_1/events?tree=1");
    liveSource("/api/browser/s_1/stream");
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toBe("ws://127.0.0.1:4477/api/live");
    expect(liveStats().subscriptions).toBe(4);
  });

  test("subscriptions made before the socket opens are sent on open; later ones immediately", () => {
    liveSource("/api/stream");
    const ws = FakeSocket.instances[0];
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(ws.sent.map((f) => f.stream)).toEqual(["global"]);
    liveSource("/api/sessions/s_9/events");
    expect(ws.sent.at(-1)).toMatchObject({ op: "sub", stream: "session", session: "s_9" });
    expect(new Set(ws.sent.map((f) => f.id)).size).toBe(2); // distinct ids
  });

  test("events are routed to the right listener by subscription id, shaped like SSE messages", () => {
    const a = liveSource("/api/stream");
    const b = liveSource("/api/sessions/s_1/events");
    const ws = FakeSocket.instances[0];
    ws.open();
    const gotA: any[] = [];
    const gotB: any[] = [];
    a.addEventListener("turn_end", (e) => gotA.push(JSON.parse(e.data)));
    b.addEventListener("log", (e) => gotB.push(JSON.parse(e.data)));
    const [idA, idB] = ws.sent.map((f) => f.id);
    ws.recv(idA, "turn_end", { sessionId: "s_1" });
    ws.recv(idB, "log", { id: 5, text: "hi" });
    ws.recv(idB, "turn_end", { ignored: true }); // nobody listens for this on b
    expect(gotA).toEqual([{ sessionId: "s_1" }]);
    expect(gotB).toEqual([{ id: 5, text: "hi" }]);
  });

  test("closing a source unsubscribes it; closing the last one releases the socket", () => {
    const a = liveSource("/api/stream");
    const b = liveSource("/api/sessions/s_1/events");
    const ws = FakeSocket.instances[0];
    ws.open();
    a.close();
    expect(ws.sent.at(-1)).toMatchObject({ op: "unsub" });
    expect(liveStats().subscriptions).toBe(1);
    expect(ws.readyState).toBe(1);
    b.close();
    expect(liveStats().subscriptions).toBe(0);
    expect(ws.readyState).toBe(3);
    a.close(); // closing twice is harmless
  });

  test("a dropped connection is re-established and each log resumes after the last line seen", async () => {
    const s = liveSource("/api/sessions/s_1/events?tree=1");
    const first = FakeSocket.instances[0];
    first.open();
    const id = first.sent[0].id;
    first.recv(id, "log", { id: 7, text: "a" });
    first.recv(id, "log", { id: 9, text: "b" });
    first.drop();
    await Bun.sleep(520); // first backoff step
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1];
    second.open();
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]).toMatchObject({ op: "sub", stream: "session", session: "s_1", tree: true, since: 9, id });
    void s;
  });

  test("a server refusal reaches onerror; a plain disconnect does not", () => {
    const s = liveSource("/api/sessions/s_gone/events");
    const ws = FakeSocket.instances[0];
    ws.open();
    const errors: unknown[] = [];
    s.onerror = (e) => errors.push(e);
    ws.drop();
    expect(errors).toEqual([]);
    ws.recv(ws.sent[0].id, "error", { status: 404, message: "No session" });
    expect(errors).toEqual([{ status: 404, message: "No session" }]);
  });
});
