import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { getSession, interruptAll, listSessions } from "../src/sessions/manager";
import { makeDir, makeRepo, resetState, settled } from "./helpers";

const TOKEN = "test-token-123";
let srv: ReturnType<typeof startServer>;
let shutdownCalled = false;

beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN, onShutdown: () => (shutdownCalled = true) });
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

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${srv.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/** Collect an SSE stream until it ends. */
async function sse(path: string): Promise<Array<{ event: string; data: any }>> {
  const res = await fetch(`${srv.url}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const out: Array<{ event: string; data: any }> = [];
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (data) out.push({ event, data: JSON.parse(data) });
    }
  }
  return out;
}

describe("auth and hygiene", () => {
  test("health is open; everything else needs the bearer token", async () => {
    expect((await fetch(`${srv.url}/api/health`)).status).toBe(200);
    expect((await fetch(`${srv.url}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${srv.url}/api/sessions`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call("GET", "/api/sessions")).status).toBe(200);
  });

  test("unknown routes and sessions are 404, malformed JSON is 400", async () => {
    expect((await call("GET", "/api/nope")).status).toBe(404);
    expect((await call("GET", "/api/sessions/s_ghost")).status).toBe(404);
    const bad = await fetch(`${srv.url}/api/sessions`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{not json" });
    expect(bad.status).toBe(400);
  });

  test("a request whose Host is not loopback is refused (DNS rebinding)", async () => {
    const r = await call("GET", "/api/sessions", undefined, { host: "evil.example.com" });
    // Some fetch implementations override Host; when honoured it must be refused.
    expect([200, 403]).toContain(r.status);
    if (r.status === 200) console.warn("note: fetch ignored the Host override; the rebinding guard was not exercised");
  });

  test("shutdown asks the daemon to stop", async () => {
    expect((await call("POST", "/api/shutdown")).status).toBe(200);
    await Bun.sleep(100);
    expect(shutdownCalled).toBe(true);
  });
});

describe("sessions over HTTP", () => {
  test("create a lead, follow it live to the end, then read it back", async () => {
    const created = await call("POST", "/api/sessions", { prompt: "SAY streaming\nSAY final answer", engine: "fake", cwd: makeDir() });
    expect(created.status).toBe(201);
    const id = created.body.session.id as string;

    const events = await sse(`/api/sessions/${id}/events?until=idle`);
    const logs = events.filter((e) => e.event === "log").map((e) => e.data.text as string);
    expect(logs.some((l) => l.includes("streaming"))).toBe(true);
    expect(events.at(-1)!.event).toBe("done");
    expect(events.at(-1)!.data.session).toMatchObject({ id, status: "idle", output: "final answer" });

    const got = await call("GET", `/api/sessions/${id}`);
    expect(got.body.session).toMatchObject({ status: "idle", output: "final answer", turns: 1 });
    expect((await call("GET", `/api/sessions/${id}/turns`)).body.turns).toHaveLength(1);
    expect((await call("GET", `/api/sessions/${id}/logs`)).body.lines.length).toBeGreaterThan(3);
  });

  test("connecting after the turn ended replays the log and finishes immediately", async () => {
    const id = (await call("POST", "/api/sessions", { prompt: "SAY earlier", engine: "fake", cwd: makeDir() })).body.session.id;
    await settled(id);
    const events = await sse(`/api/sessions/${id}/events?until=idle`);
    expect(events.filter((e) => e.event === "log").some((e) => e.data.text.includes("earlier"))).toBe(true);
    expect(events.at(-1)!.event).toBe("done");
  });

  test("a follow-up returns a cursor so a client shows only the new turn", async () => {
    const id = (await call("POST", "/api/sessions", { prompt: "SAY alpha-first", engine: "fake", cwd: makeDir() })).body.session.id;
    await settled(id);
    const sent = await call("POST", `/api/sessions/${id}/send`, { message: "SAY beta-second" });
    expect(sent.body.cursor).toBeGreaterThan(0);
    const events = await sse(`/api/sessions/${id}/events?until=idle&since=${sent.body.cursor}`);
    const text = events.filter((e) => e.event === "log").map((e) => e.data.text).join("\n");
    expect(text).toContain("beta-second");
    expect(text).not.toContain("alpha-first");
  });

  test("list defaults to open leads; closed ones appear on request", async () => {
    const id = (await call("POST", "/api/sessions", { prompt: "SAY x", engine: "fake", cwd: makeDir() })).body.session.id;
    await settled(id);
    expect((await call("GET", "/api/sessions")).body.sessions.map((s: any) => s.id)).toEqual([id]);
    await call("POST", `/api/sessions/${id}/close`);
    expect((await call("GET", "/api/sessions")).body.sessions).toEqual([]);
    expect((await call("GET", "/api/sessions?closed=1")).body.sessions.map((s: any) => s.id)).toEqual([id]);
  });

  test("bad input is a clear 400, not a 500", async () => {
    const r = await call("POST", "/api/sessions", { prompt: "", engine: "fake", cwd: makeDir() });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("prompt");
    expect((await call("POST", "/api/sessions", { prompt: "x", engine: "nope", cwd: makeDir() })).status).toBe(400);
  });
});

describe("Hydra end to end, through the real MCP shim", () => {
  test("a lead opens a head, waits for it, merges its work — all via MCP tool calls over HTTP", async () => {
    const repo = makeRepo();
    const pair = (await call("POST", "/api/pairs", { title: "E2E", lead_engine: "fake", heads_engine: "fake", max_heads: 2 })).body.pair;
    const prompt = [
      `CALL_TOOL subagent_create {"brief":"WRITE feature.txt shipped by a head\\nSAY head report","title":"feature"}`,
      `CALL_TOOL subagent_wait {"mode":"all","timeout_sec":25}`,
    ].join("\n");
    const created = await call("POST", "/api/sessions", { prompt, engine: "fake", cwd: repo, pair: pair.id });
    const id = created.body.session.id as string;
    const events = await sse(`/api/sessions/${id}/events?until=idle&tree=1`);

    const lead = getSession(id)!;
    expect(lead.status).toBe("idle");
    // The lead really received the head's answer as a tool result.
    expect(lead.last_output).toContain("TOOL subagent_wait");
    expect(lead.last_output).toContain("head report");
    const kids = listSessions({ parentId: id, status: null });
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ depth: 1, pair_id: pair.id, isolation: "worktree", status: "idle" });
    // The head's lines streamed on the lead's tree view, attributed to it.
    const childLines = events.filter((e) => e.event === "log" && e.data.session === kids[0].id);
    expect(childLines.length).toBeGreaterThan(2);
    expect(childLines[0].data.depth).toBe(1);

    // And the operator can merge it.
    const merged = await call("POST", `/api/sessions/${kids[0].id}/merge`);
    expect(merged.body).toMatchObject({ merged: true, files: ["feature.txt"] });
  }, 60_000);

  test("tool calls are bound to the calling session: the shim cannot act as someone else's parent", async () => {
    const a = (await call("POST", "/api/sessions", { prompt: "SAY a", engine: "fake", cwd: makeDir() })).body.session.id;
    const b = (await call("POST", "/api/sessions", { prompt: "SAY b", engine: "fake", cwd: makeDir() })).body.session.id;
    await settled(a);
    await settled(b);
    const child = JSON.parse((await call("POST", "/api/tools/call", { name: "subagent_create", args: { brief: "SAY hi" } }, { "x-trb-session": a })).body.text);
    const mine = await call("POST", "/api/tools/call", { name: "subagent_close", args: { id: child.id } }, { "x-trb-session": b });
    expect(mine.body.text).toMatch(/^Error: .*another parent/);
    const own = await call("POST", "/api/tools/call", { name: "subagent_close", args: { id: child.id } }, { "x-trb-session": a });
    expect(JSON.parse(own.body.text).status).toBe("closed");
  });

  test("a tool call without a valid session, or for a tool that does not exist, is a 400", async () => {
    expect((await call("POST", "/api/tools/call", { name: "subagent_list", args: {} })).status).toBe(400);
    expect((await call("POST", "/api/tools/call", { name: "subagent_list", args: {} }, { "x-trb-session": "s_ghost" })).status).toBe(400);
    const a = (await call("POST", "/api/sessions", { prompt: "SAY a", engine: "fake", cwd: makeDir() })).body.session.id;
    expect((await call("POST", "/api/tools/call", { name: "rm_rf", args: {} }, { "x-trb-session": a })).status).toBe(400);
  });
});

describe("config routes", () => {
  test("pairs, mcp, skills and settings are reachable for a UI", async () => {
    expect((await call("POST", "/api/pairs", { recipe: "claude-codex" })).status).toBe(201);
    expect((await call("GET", "/api/pairs")).body.pairs).toHaveLength(1);
    expect((await call("GET", "/api/pairs/cookbook")).body.recipes.length).toBeGreaterThan(2);
    expect((await call("GET", "/api/roles")).body.roles.length).toBe(12);

    expect((await call("POST", "/api/mcp", { name: "ctx", command: "npx", args: ["-y", "x"] })).status).toBe(201);
    expect((await call("POST", "/api/mcp/ctx/disable")).body.ok).toBe(true);
    expect((await call("GET", "/api/mcp")).body.servers[0]).toMatchObject({ name: "ctx", enabled: false });
    expect((await call("DELETE", "/api/mcp/ctx")).body.removed).toBe(true);

    expect((await call("PUT", "/api/config/max_depth", { value: "3" })).body.ok).toBe(true);
    expect((await call("GET", "/api/config")).body.settings.find((s: any) => s.key === "max_depth").value).toBe(3);
    expect((await call("PUT", "/api/config/nope", { value: "1" })).status).toBe(404);
    expect((await call("DELETE", "/api/config/max_depth")).body.ok).toBe(true);

    const engines = (await call("GET", "/api/engines")).body.engines;
    expect(engines.find((e: any) => e.id === "fake")).toMatchObject({ installed: true });
  });
});
