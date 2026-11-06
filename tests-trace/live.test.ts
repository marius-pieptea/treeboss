import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START live\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END live\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { createLead, interruptAll } from "../src/sessions/manager";
import { makeDir, resetState, settled } from "./helpers";

const TOKEN = "live-test";
let srv: ReturnType<typeof startServer>;
beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
  setDaemonContext({ url: srv.url, token: TOKEN });
});
afterAll(() => {
  setDaemonContext(null);
  srv.stop();
});
beforeEach(() => resetState());
afterEach(async () => {
  await interruptAll();
});

interface Client {
  ws: WebSocket;
  frames: Array<{ id: string; event: string; data: any }>;
  send(o: unknown): void;
  waitFor(pred: (f: { id: string; event: string; data: any }) => boolean, ms?: number): Promise<{ id: string; event: string; data: any }>;
}

function connect(headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/api/live`, { headers } as any);
    const frames: Client["frames"] = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
    ws.addEventListener("error", () => reject(new Error("ws error")));
    ws.addEventListener("open", () =>
      resolve({
        ws,
        frames,
        send: (o) => ws.send(JSON.stringify(o)),
        async waitFor(pred, ms = 5000) {
          const end = Date.now() + ms;
          for (;;) {
            const f = frames.find(pred);
            if (f) return f;
            if (Date.now() > end) throw new Error(`timed out; saw: ${frames.map((x) => `${x.id}:${x.event}`).join(", ")}`);
            await Bun.sleep(10);
          }
        },
      }),
    );
  });
}

describe("auth", () => {
  test("needs credentials, and refuses a foreign origin", async () => {
    await expect(connect({})).rejects.toThrow();
    await expect(connect({ authorization: `Bearer ${TOKEN}`, origin: "http://evil.example" })).rejects.toThrow();
    (await connect({ authorization: `Bearer ${TOKEN}`, origin: srv.url })).ws.close();
  });
});

describe("one socket, many streams", () => {
  test("the global feed and a session's log arrive on the same connection, keyed by subscription", async () => {
    const c = await connect();
    c.send({ op: "sub", id: "g", stream: "global" });
    await c.waitFor((f) => f.id === "g" && f.event === "hello");
    const lead = createLead({ prompt: "SAY streaming over a socket\nWRITE a.txt x", engine: "fake", cwd: makeDir() });
    c.send({ op: "sub", id: "s", stream: "session", session: lead.id });
    await c.waitFor((f) => f.id === "g" && f.event === "turn_end", 15000);
    await c.waitFor((f) => f.id === "s" && f.event === "log" && f.data.text === "streaming over a socket");
    const tool = await c.waitFor((f) => f.id === "s" && f.event === "log" && f.data.kind === "tool");
    expect(tool.data).toMatchObject({ session: lead.id, data: { name: "Write", arg: "a.txt" } });
    expect(c.frames.some((f) => f.id === "g" && f.event === "log")).toBe(false); // logs are opt-in on the global feed
    c.ws.close();
  });

  test("a session subscription replays what was already logged, then follows; `since` skips the replayed part", async () => {
    const lead = await settled(createLead({ prompt: "SAY first answer", engine: "fake", cwd: makeDir() }).id);
    const c = await connect();
    c.send({ op: "sub", id: "all", stream: "session", session: lead.id });
    await c.waitFor((f) => f.id === "all" && f.event === "state");
    const replayed = c.frames.filter((f) => f.id === "all" && f.event === "log");
    expect(replayed.some((f) => f.data.text === "first answer")).toBe(true);
    const last = Math.max(...replayed.map((f) => f.data.id));
    c.send({ op: "sub", id: "after", stream: "session", session: lead.id, since: last });
    await c.waitFor((f) => f.id === "after" && f.event === "state");
    expect(c.frames.filter((f) => f.id === "after" && f.event === "log")).toHaveLength(0);
    c.ws.close();
  });

  test("tree subscriptions carry the heads' lines with their role label and depth", async () => {
    const lead = await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeDir() }).id);
    const c = await connect();
    c.send({ op: "sub", id: "t", stream: "session", session: lead.id, tree: true });
    await c.waitFor((f) => f.id === "t" && f.event === "state");
    const { createChild } = await import("../src/sessions/manager");
    const kid = createChild({ caller: { sessionId: lead.id }, brief: "SAY from the head", role: undefined });
    const line = await c.waitFor((f) => f.id === "t" && f.event === "log" && f.data.text === "from the head");
    expect(line.data).toMatchObject({ session: kid.id, depth: 1, label: "fake" });
    c.ws.close();
  });

  test("unsubscribing stops delivery for that id only", async () => {
    const c = await connect();
    c.send({ op: "sub", id: "a", stream: "global" });
    c.send({ op: "sub", id: "b", stream: "global" });
    await c.waitFor((f) => f.id === "b" && f.event === "hello");
    c.send({ op: "unsub", id: "a" });
    await Bun.sleep(50);
    createLead({ prompt: "SAY x", engine: "fake", cwd: makeDir() });
    await c.waitFor((f) => f.id === "b" && f.event === "turn_start");
    expect(c.frames.filter((f) => f.id === "a" && f.event === "turn_start")).toHaveLength(0);
    c.ws.close();
  });

  test("an unknown session or stream is an error frame, not a dead socket", async () => {
    const c = await connect();
    c.send({ op: "sub", id: "x", stream: "session", session: "s_nope" });
    expect((await c.waitFor((f) => f.id === "x" && f.event === "error")).data).toMatchObject({ status: 404 });
    c.send({ op: "sub", id: "y", stream: "telepathy" });
    expect((await c.waitFor((f) => f.id === "y" && f.event === "error")).data).toMatchObject({ status: 400 });
    c.send({ op: "sub", id: "ok", stream: "global" });
    await c.waitFor((f) => f.id === "ok" && f.event === "hello"); // still alive
    c.send("not json");
    c.ws.close();
  });

  test("subscriptions are dropped with the socket: no listener leak", async () => {
    const { Hub } = await import("../src/sessions/hub");
    await Bun.sleep(150); // let any earlier test's socket finish closing before taking the baseline
    const before = Hub.listenerCount();
    const c = await connect();
    for (let i = 0; i < 5; i++) c.send({ op: "sub", id: `g${i}`, stream: "global" });
    await c.waitFor((f) => f.id === "g4" && f.event === "hello");
    expect(Hub.listenerCount()).toBe(before + 5);
    c.ws.close();
    for (let i = 0; i < 100 && Hub.listenerCount() > before; i++) await Bun.sleep(10);
    expect(Hub.listenerCount()).toBe(before);
  });

  test("a socket cannot hoard subscriptions", async () => {
    const c = await connect();
    for (let i = 0; i < 70; i++) c.send({ op: "sub", id: `n${i}`, stream: "global" });
    const refused = await c.waitFor((f) => f.event === "error" && f.data.status === 429);
    expect(refused.id).toMatch(/^n6[4-9]$/);
    c.ws.close();
  });
});
