import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START preview-proxy\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END preview-proxy\n"); });
/** The inspecting proxy and the run/preview API, against a real upstream and a real daemon server. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { Workspaces } from "../src/workspaces";
import { _resetRuns, stopAllRuns } from "../src/devserver/manager";
import { ensureProxy, injectInspector, relaxCsp, stopProxies } from "../src/preview/proxy";
import { _resetIssues, readIssues } from "../src/preview/issues";
import { formatPick, sanitizePick } from "../src/preview/picks";
import { findChrome } from "../src/browser/chrome";
import { makeDir } from "./helpers";

let upstream: ReturnType<typeof Bun.serve>;
let proxyPort: number;
let srv: ReturnType<typeof startServer>;
const TOKEN = "preview-token";

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, s) {
      const u = new URL(req.url);
      if (req.headers.get("upgrade") === "websocket") return s.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      if (u.pathname === "/") return new Response("<!doctype html><html><head><title>T</title></head><body><h1 id=big>Hello</h1></body></html>", { headers: { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" } });
      if (u.pathname === "/api") return Response.json({ method: req.method, host: req.headers.get("host"), origin: req.headers.get("origin") });
      if (u.pathname === "/go") return new Response(null, { status: 302, headers: { location: `http://localhost:${upstream.port}/` } });
      return new Response("nope", { status: 404 });
    },
    websocket: { message: (ws, m) => void ws.send(`echo:${m}`) },
  });
  proxyPort = ensureProxy(upstream.port as number).port;
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(async () => {
  stopProxies();
  upstream.stop(true);
  srv.stop();
  await stopAllRuns();
  _resetRuns();
});
afterEach(() => _resetIssues());

const via = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${proxyPort}${p}`, init);

describe("preview proxy", () => {
  test("injects the inspector into HTML and lets the page be framed", async () => {
    const res = await via("/");
    const html = await res.text();
    expect(html).toContain('<head><script src="/__trb/inspector.js"></script>');
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    const js = await (await via("/__trb/inspector.js")).text();
    expect(js).toContain("trb-pick");
  });

  test("forwards other requests, rewrites host/origin, keeps redirects inside the proxy", async () => {
    const j = (await (await via("/api", { method: "POST", headers: { origin: `http://127.0.0.1:${proxyPort}` } })).json()) as any;
    expect(j.method).toBe("POST");
    expect(j.host).toBe(`127.0.0.1:${upstream.port}`);
    expect(j.origin).toBe(`http://localhost:${upstream.port}`);
    const r = await via("/go", { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    expect((await via("/missing")).status).toBe(404);
  });

  test("log beacons land in the per-target buffer", async () => {
    const r = await via("/__trb/log", { method: "POST", body: JSON.stringify({ entries: [{ level: "error", text: "boom", page: "/x" }, { level: "failed-request", text: "GET /api -> 500" }, { text: "" }] }) });
    expect(r.status).toBe(204);
    const got = readIssues(upstream.port as number);
    expect(got.map((g) => [g.level, g.text])).toEqual([["error", "boom"], ["failed-request", "GET /api -> 500"]]);
  });

  test("websockets (HMR) pass through", async () => {
    const got = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/hmr`);
      ws.onopen = () => ws.send("hi");
      ws.onmessage = (e) => (ws.close(), resolve(String(e.data)));
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("timeout")), 4000);
    });
    expect(got).toBe("echo:hi");
  });

  // Regression: Vite binds "localhost", often only [::1]. The HMR socket must reach it, or Vite's client
  // loops "connection lost -> reload" and the whole app freezes (same renderer process as the iframe).
  test("websockets reach an IPv6-only dev server (no reload loop)", async () => {
    let v6: ReturnType<typeof Bun.serve>;
    try {
      v6 = Bun.serve({ port: 0, hostname: "::1", fetch: (req, s) => (s.upgrade(req, { data: undefined }) ? undefined : new Response("ok")) as any, websocket: { message: (ws, m) => void ws.send(`v6:${m}`) } });
    } catch {
      return; // no IPv6 loopback on this machine
    }
    try {
      const port = ensureProxy(v6.port as number).port;
      const got = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        ws.onopen = () => ws.send("hi");
        ws.onmessage = (e) => (resolve(String(e.data)), ws.close());
        ws.onclose = () => reject(new Error("closed before a reply"));
        setTimeout(() => reject(new Error("timeout")), 4000);
      });
      expect(got).toBe("v6:hi");
    } finally {
      v6.stop(true);
    }
  });

  test("an unreachable dev server gets a readable 502, and only loopback ports are valid", async () => {
    const dead = ensureProxy(1).port;
    const r = await fetch(`http://127.0.0.1:${dead}/`);
    expect(r.status).toBe(502);
    expect(() => ensureProxy(70000)).toThrow();
  });

  test("helpers", () => {
    expect(injectInspector("<html><body>x</body></html>")).toStartWith('<script src="/__trb/inspector.js"></script>');
    expect(injectInspector("<!doctype html><p>x")).toBe('<!doctype html><script src="/__trb/inspector.js"></script><p>x');
    expect(relaxCsp("frame-ancestors 'none'")).toBeNull();
  });
});

describe("pick formatting", () => {
  test("the page's claims are clamped and the text carries everything", () => {
    const p = sanitizePick({ selector: "#big", tag: "h1", html: "<h1>" + "x".repeat(5000), styles: { color: "red", bad: 5 }, box: { x: 1.4, y: 2, width: 100, height: 20 }, viewport: { width: 800, height: 600, dpr: 2 } }, "http://localhost:3000/");
    expect(p.html.length).toBeLessThanOrEqual(2200);
    expect(p.styles).toEqual({ color: "red" });
    const text = formatPick({ ...p, screenshot: "/tmp/a.png", screenshotNote: null });
    expect(text).toContain("Selector: #big");
    expect(text).toContain("Box: x=1 y=2 100x20px");
    expect(text).toContain("Screenshot (cropped to the element): /tmp/a.png");
    expect(formatPick({ ...p, screenshot: null, screenshotNote: "no chrome" })).toContain("not available (no chrome)");
  });
});

describe("run and preview API", () => {
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as any };
  };

  test("detect, start, logs, stop through the routes", async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "bun s.ts" } }));
    fs.writeFileSync(path.join(dir, "s.ts"), `Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("ok") }); console.log("up");`);
    fs.writeFileSync(path.join(dir, ".env"), "SECRET_KEY=hunter2hunter2\n");
    const w = Workspaces.open(dir);
    const info = await api("GET", `/api/run?root=${w.id}`);
    expect(info.status).toBe(200);
    expect(info.body.detected.services.map((s: any) => s.id)).toEqual(["dev"]);
    expect(info.body.detected.envFiles).toEqual([{ file: ".env", keys: ["SECRET_KEY"] }]);
    expect(JSON.stringify(info.body)).not.toContain("hunter2");

    const started = await api("POST", "/api/run/start", { root: w.id, service: "dev" });
    expect(started.status).toBe(200);
    const port = started.body.instance.port as number;
    let status = "";
    for (let i = 0; i < 100 && status !== "running"; i++) {
      await new Promise((r) => setTimeout(r, 60));
      const l = await api("GET", `/api/run/logs?root=${w.id}&service=dev&since=0`);
      status = l.body.instance.status;
      if (status === "running") expect(l.body.lines.some((x: any) => x.text === "up")).toBe(true);
    }
    expect(status).toBe("running");
    expect((await fetch(`http://127.0.0.1:${port}`).then((r) => r.text()))).toBe("ok");
    expect((await api("POST", "/api/run/start", { root: w.id, service: "nope" })).status).toBe(400);
    await api("POST", "/api/run/stop", { root: w.id, service: "dev" });
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 60));
      if ((await api("GET", `/api/run/logs?root=${w.id}&service=dev`)).body.instance.status === "stopped") break;
    }
    expect((await api("GET", `/api/run?root=${w.id}`)).body.instances[0].status).toBe("stopped");
  });

  test("proxy, issues and pick routes", async () => {
    const p = await api("POST", "/api/preview/proxy", { port: upstream.port });
    expect(p.body.port).toBe(proxyPort);
    expect((await api("POST", "/api/preview/proxy", { port: "x" })).status).toBe(400);
    await via("/__trb/log", { method: "POST", body: JSON.stringify({ entries: [{ level: "error", text: "e1" }] }) });
    const iss = await api("GET", `/api/preview/issues?port=${upstream.port}&clear=1`);
    expect(iss.body.issues.map((i: any) => i.text)).toEqual(["e1"]);
    expect((await api("GET", `/api/preview/issues?port=${upstream.port}`)).body.issues).toEqual([]);

    const pick = await api("POST", "/api/preview/pick", { url: `http://localhost:${upstream.port}/`, screenshot: false, pick: { selector: "#big", tag: "h1", html: "<h1>Hello</h1>", styles: { color: "red" }, box: { x: 8, y: 8, width: 100, height: 30 }, viewport: { width: 800, height: 600, dpr: 1 } } });
    expect(pick.status).toBe(200);
    expect(pick.body.text).toContain("Selector: #big");
    expect((await api("POST", "/api/preview/pick", { url: "x", pick: {} })).status).toBe(400);
  });

  const chrome = findChrome({ fresh: true });
  (chrome ? test : test.skip)("a pick with a screenshot crops the element", async () => {
    const pick = await api("POST", "/api/preview/pick", { url: `http://localhost:${upstream.port}/`, pick: { selector: "#big", tag: "h1", html: "<h1>Hello</h1>", styles: {}, box: { x: 8, y: 8, width: 100, height: 30 }, viewport: { width: 800, height: 600, dpr: 1 } } });
    expect(pick.body.pick.screenshot).toMatch(/\.png$/);
    expect(fs.statSync(pick.body.pick.screenshot).size).toBeGreaterThan(100);
    expect(pick.body.thumbnail).toStartWith("data:image/png;base64,");
  }, 40_000);
});
