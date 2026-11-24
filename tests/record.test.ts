import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { startServer } from "../src/daemon/server";
import { withRecording } from "../src/daemon/record";

const TOKEN = "record-test-token";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const roots: string[] = [];
const fresh = () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trb-rec-")), "out");
  roots.push(path.dirname(dir));
  return dir;
};
const lines = (dir: string, name: string) =>
  fs
    .readFileSync(path.join(dir, `${name}.ndjson`), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const written = async (dir: string, name: string, n = 1) => {
  for (let i = 0; i < 100; i++) {
    const f = path.join(dir, `${name}.ndjson`);
    if (fs.existsSync(f) && fs.readFileSync(f, "utf-8").trim().split("\n").length >= n) return;
    await sleep(20);
  }
  throw new Error(`no ${name}.ndjson line appeared in ${dir}`);
};

let srv: ReturnType<typeof startServer> | null = null;
beforeEach(() => {
  delete process.env.TRB_RECORD_DIR;
});
afterEach(() => {
  srv?.stop();
  srv = null;
  delete process.env.TRB_RECORD_DIR;
});
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe("daemon recorder, through a real daemon", () => {
  test("a JSON GET and a POST each append one line, without credentials", async () => {
    const dir = fresh();
    process.env.TRB_RECORD_DIR = dir;
    srv = startServer({ port: 0, token: TOKEN });
    const auth = { authorization: `Bearer ${TOKEN}`, cookie: `trb=${TOKEN}`, "x-probe": "kept" };

    const get = await fetch(`${srv.url}/api/health?a=1&b=2&b=3`, { headers: auth });
    expect(get.status).toBe(200);
    const post = await fetch(`${srv.url}/api/widgets/new`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "w", n: [1, 2] }) });
    expect(post.status).toBe(404);
    const postJson = await post.json();
    expect((postJson as any).error).toContain("No route POST /api/widgets/new");
    await written(dir, "health");
    await written(dir, "widgets");

    const [g] = lines(dir, "health");
    expect(g.method).toBe("GET");
    expect(g.path).toBe("/api/health");
    expect(g.query).toEqual({ a: "1", b: ["2", "3"] });
    expect(g.status).toBe(200);
    expect(g.body).toBeNull();
    expect(g.resBody.ok).toBe(true);
    expect(g.resHeaders["content-type"]).toBe("application/json");
    expect(typeof g.t).toBe("number");
    expect(g.headers["x-probe"]).toBe("kept");
    expect(g.headers.authorization).toBeUndefined();
    expect(g.headers.cookie).toBeUndefined();

    const [p] = lines(dir, "widgets");
    expect(p.method).toBe("POST");
    expect(p.path).toBe("/api/widgets/new");
    expect(p.body).toEqual({ name: "w", n: [1, 2] });
    expect(p.status).toBe(404);
    expect(p.resBody).toEqual(postJson);
    expect(p.headers.authorization).toBeUndefined();
    expect(p.headers.cookie).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain(TOKEN);
  });

  test("with TRB_RECORD_DIR unset, nothing is created and the response is unchanged", async () => {
    const dir = fresh();
    srv = startServer({ port: 0, token: TOKEN });
    const res = await fetch(`${srv.url}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
    await sleep(100);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.dirname(dir)) && fs.readdirSync(path.dirname(dir))).toEqual([]);
  });

  test("a request outside /api is not recorded", async () => {
    const dir = fresh();
    process.env.TRB_RECORD_DIR = dir;
    srv = startServer({ port: 0, token: TOKEN });
    await fetch(`${srv.url}/nope`);
    await sleep(100);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("withRecording, around a handler", () => {
  const req = (p: string, init?: RequestInit) => new Request(`http://127.0.0.1:1${p}`, init);

  test("with no directory it hands back the very same handler", () => {
    const h = async () => new Response("x");
    expect(withRecording(undefined, h)).toBe(h);
    expect(withRecording("", h)).toBe(h);
  });

  test("an SSE response is recorded as a stream with no body and still reaches the caller whole", async () => {
    const dir = fresh();
    const h = withRecording(dir, async () => new Response("event: a\ndata: 1\n\n", { headers: { "content-type": "text/event-stream" } }));
    const res = await h(req("/api/sessions/s_1/events?tree=1", { headers: { authorization: "Bearer x" } }));
    expect(await res!.text()).toBe("event: a\ndata: 1\n\n");
    await written(dir, "sessions");
    const [l] = lines(dir, "sessions");
    expect(l.stream).toBe(true);
    expect(l.status).toBe(200);
    expect("resBody" in l).toBe(false);
    expect(l.headers.authorization).toBeUndefined();
  });

  test("a WebSocket upgrade, answered with no Response, is recorded as a stream", async () => {
    const dir = fresh();
    const h = withRecording(dir, async () => undefined as unknown as Response);
    const res = await h(req("/api/live", { headers: { upgrade: "websocket" } }));
    expect(res).toBeUndefined();
    await written(dir, "live");
    const [l] = lines(dir, "live");
    expect(l.stream).toBe(true);
    expect(l.status).toBeNull();
  });

  test("a body over 256 KB is cut and flagged, and the caller still gets all of it", async () => {
    const dir = fresh();
    const big = "x".repeat(300 * 1024);
    const h = withRecording(dir, async (r: Request) => new Response(await r.text(), { headers: { "content-type": "text/plain" } }));
    const res = await h(req("/api/echo", { method: "POST", headers: { "content-type": "text/plain" }, body: big }));
    expect((await res!.text()).length).toBe(big.length);
    await written(dir, "echo");
    const [l] = lines(dir, "echo");
    expect(l.body.length).toBe(256 * 1024);
    expect(l.resBody.length).toBe(256 * 1024);
    expect(l.truncated).toBe(true);
  });

  test("a recording failure never reaches the caller", async () => {
    const blocker = path.join(fresh() + "-file");
    fs.mkdirSync(path.dirname(blocker), { recursive: true });
    fs.writeFileSync(blocker, "not a directory");
    roots.push(path.dirname(blocker));
    const h = withRecording(path.join(blocker, "sub"), async () => new Response("fine"));
    const res = await h(req("/api/x"));
    expect(await res!.text()).toBe("fine");
    await sleep(100);
  });

  test("a handler that throws still throws, unrecorded", async () => {
    const dir = fresh();
    const h = withRecording(dir, async () => {
      throw new Error("boom");
    });
    await expect(h(req("/api/x"))).rejects.toThrow("boom");
  });
});
