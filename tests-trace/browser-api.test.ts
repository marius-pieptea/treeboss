import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START browser-api\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END browser-api\n"); });
/** The agent browser over HTTP and through the real MCP shim: what the live view and a model actually talk to. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import path from "path";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { createLead, interruptAll } from "../src/sessions/manager";
import { findChrome } from "../src/browser/chrome";
import { shutdownBrowsers } from "../src/browser/manager";
import { makeDir, resetState, settled } from "./helpers";

const TOKEN = "browser-api-token";
const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
const chrome = findChrome({ fresh: true });
if (!chrome) console.warn("[browser api tests] SKIPPED: no Chrome found (set TRB_CHROME to run them)");
const t = chrome ? test : test.skip;

let srv: ReturnType<typeof startServer>;
let site: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  site = Bun.serve({ port: 0, fetch: () => new Response(`<!doctype html><title>Live</title><h1 style="color:#c0392b">Hello live view</h1><button onclick="document.title='Clicked'">Press</button>`, { headers: { "content-type": "text/html" } }) });
  base = `http://127.0.0.1:${site.port}`;
  srv = startServer({ port: 0, token: TOKEN });
  setDaemonContext({ url: srv.url, token: TOKEN });
});
afterAll(async () => {
  setDaemonContext(null);
  srv.stop();
  site.stop(true);
  await shutdownBrowsers();
});
afterEach(async () => {
  await interruptAll();
});

const bearer = { authorization: `Bearer ${TOKEN}` };
const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { ...bearer, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, body: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) } as { status: number; headers: Headers; body: any };
};
const lead = async () => {
  resetState();
  return (await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeDir() }).id)).id;
};

/** Talk to the shim the way an engine does: spawn it, speak JSON-RPC over stdio. */
async function shim(sessionId: string, env: Record<string, string>) {
  const child = Bun.spawn(["bun", "run", MAIN, "mcp-serve"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, TRB_URL: srv.url, TRB_TOKEN: TOKEN, TRB_SESSION: sessionId, ...env } });
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const waiting = new Map<number, (m: any) => void>();
  void (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      buf += dec.decode(r.value);
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          waiting.get(m.id)?.(m);
        } catch {}
      }
    }
  })();
  let id = 0;
  const rpc = (method: string, params?: any) =>
    new Promise<any>((resolve) => {
      const my = ++id;
      waiting.set(my, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    });
  return { rpc, close: () => child.kill() };
}

describe("status and sessions", () => {
  t("status reports the Chrome it found", async () => {
    const r = await api("GET", "/api/browser/status");
    expect(r.body).toMatchObject({ available: true, executable: chrome!.path });
    expect(typeof r.body.version === "string" || r.body.version === null).toBe(true);
  });

  t("unknown sessions are 404; the API needs credentials", async () => {
    expect((await api("GET", "/api/browser/s_nope/state")).status).toBe(404);
    expect((await fetch(`${srv.url}/api/browser/status`)).status).toBe(401);
  });

  t("state never launches a browser; screenshot and stream say there is none yet", async () => {
    const id = await lead();
    expect((await api("GET", `/api/browser/${id}/state`)).body).toMatchObject({ open: false });
    expect((await api("GET", `/api/browser/${id}/screenshot`)).status).toBe(404);
    expect((await api("GET", `/api/browser/${id}/stream`)).status).toBe(404);
  });
});

describe("the live view's API", () => {
  t("operator input opens a page, state and a JPEG frame follow, and click changes the page", async () => {
    const id = await lead();
    const nav = await api("POST", `/api/browser/${id}/input`, { kind: "navigate", url: base + "/" });
    expect(nav.status).toBe(200);
    const state = (await api("GET", `/api/browser/${id}/state`)).body;
    expect(state).toMatchObject({ open: true, url: base + "/", title: "Live", width: 1280, height: 800, actor: "you", busy: false });
    expect(state.tabs).toHaveLength(1);
    const shot = await api("GET", `/api/browser/${id}/screenshot`);
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
    expect([shot.body[0], shot.body[1]]).toEqual([0xff, 0xd8]);
    // Find the button's centre with the agent tool path, then click it as the operator.
    const { executeBrowserTool } = await import("../src/browser/tools");
    const { getContext } = await import("../src/browser/manager");
    const box = await (await getContext(id)).page.getByRole("button", { name: "Press" }).boundingBox();
    await api("POST", `/api/browser/${id}/input`, { kind: "click", x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    expect((await api("GET", `/api/browser/${id}/state`)).body.title).toBe("Clicked");
    void executeBrowserTool;
  });

  t("bad input is a 400 with the reason, not a 500", async () => {
    const id = await lead();
    expect((await api("POST", `/api/browser/${id}/input`, { kind: "navigate", url: "file:///etc/passwd" })).body.error).toMatch(/not allowed/);
    expect((await api("POST", `/api/browser/${id}/input`, { kind: "click", x: "a", y: 1 })).status).toBe(400);
    expect((await api("POST", `/api/browser/${id}/input`, { kind: "dance" })).status).toBe(400);
  });

  t("the event stream announces changes, carries what the agent is doing, and ends when the browser closes", async () => {
    const id = await lead();
    await api("POST", `/api/browser/${id}/input`, { kind: "navigate", url: base + "/" });
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/api/browser/${id}/stream`, { headers: bearer, signal: ac.signal });
    const events: Array<{ event: string; data: any }> = [];
    const dec = new TextDecoder();
    let buf = "";
    const reader = (async () => {
      try {
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1] ?? "message";
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (data) events.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {}
    })();
    const until = async (pred: () => boolean, ms = 6000) => {
      const end = Date.now() + ms;
      while (!pred() && Date.now() < end) await Bun.sleep(30);
      expect(pred()).toBe(true);
    };
    await until(() => events.some((e) => e.event === "state"));
    const first = events.filter((e) => e.event === "state").at(-1)!.data;
    // An agent action shows up with its label while it runs.
    const { executeBrowserTool } = await import("../src/browser/tools");
    void executeBrowserTool("browser_navigate", { url: base + "/?x=1" }, { sessionId: id });
    await until(() => events.some((e) => e.event === "state" && /Opening/.test(e.data.lastAction ?? "") && e.data.actor === "agent"));
    await until(() => events.some((e) => e.event === "state" && e.data.seq > first.seq && !e.data.busy && e.data.url.endsWith("?x=1")));
    // Closing ends the stream.
    await api("POST", `/api/browser/${id}/close`);
    await until(() => events.some((e) => e.event === "closed"));
    ac.abort();
    await reader;
  });

  t("agent actions are published on the hub for the UI to react to", async () => {
    const id = await lead();
    const { Hub } = await import("../src/sessions/hub");
    const seen: any[] = [];
    const off = Hub.subscribe((e) => e.type === "browser" && seen.push(e));
    const { executeBrowserTool } = await import("../src/browser/tools");
    await executeBrowserTool("browser_navigate", { url: base + "/" }, { sessionId: id });
    off();
    expect(seen[0]).toMatchObject({ type: "browser", sessionId: id, rootId: id });
    expect(seen[0].action).toContain("Opening");
  });
});

describe("through the real MCP shim", () => {
  t("browser tools are listed only when the daemon turned them on for the turn", async () => {
    const id = await lead();
    const off = await shim(id, { TRB_BROWSER: "0" });
    const on = await shim(id, { TRB_BROWSER: "1" });
    await off.rpc("initialize", { protocolVersion: "2025-06-18" });
    await on.rpc("initialize", { protocolVersion: "2025-06-18" });
    const offTools = (await off.rpc("tools/list")).result.tools.map((x: any) => x.name);
    const onTools = (await on.rpc("tools/list")).result.tools.map((x: any) => x.name);
    expect(offTools.some((n: string) => n.startsWith("browser_"))).toBe(false);
    expect(offTools).toContain("subagent_create");
    expect(onTools).toEqual(expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_screenshot", "subagent_create"]));
    // Unlisted means uncallable.
    expect((await off.rpc("tools/call", { name: "browser_navigate", arguments: { url: base } })).error.message).toMatch(/Unknown tool/);
    off.close();
    on.close();
  });

  t("a screenshot comes back as an MCP image block next to its text; a failure is isError", async () => {
    const id = await lead();
    const s = await shim(id, { TRB_BROWSER: "1" });
    await s.rpc("initialize", { protocolVersion: "2025-06-18" });
    const nav = await s.rpc("tools/call", { name: "browser_navigate", arguments: { url: base + "/" } });
    expect(nav.result.isError).toBe(false);
    expect(nav.result.content[0].text).toContain("Live");
    const shot = await s.rpc("tools/call", { name: "browser_screenshot", arguments: {} });
    const types = shot.result.content.map((c: any) => c.type);
    expect(types).toEqual(["text", "image"]);
    const img = shot.result.content[1];
    expect(img.mimeType).toBe("image/jpeg");
    expect(Buffer.from(img.data, "base64")[0]).toBe(0xff);
    const bad = await s.rpc("tools/call", { name: "browser_navigate", arguments: { url: "file:///etc/passwd" } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/^Error:/);
    s.close();
  });
});
