import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START remote-auth\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END remote-auth\n"); });
/**
 * The remote-access auth boundary. Everything here runs on loopback: nothing binds to the network, and
 * "remote" requests are loopback requests with the Host header (or the credential) of a remote device.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { interruptAll } from "../src/sessions/manager";
import { killAllTerminals } from "../src/terminal/pty";
import { db } from "../src/db";
import { resetSetting, setSetting } from "../src/settings";
import { allowedRemoteHosts, hostAllowed, migrateRemoteMode, ownerMayAuthenticate, remoteMode } from "../src/remote/hosts";
import { listenStatus, stopListener } from "../src/remote/listener";
import { isRfc1918, isTailnetIPv4, pickLan, refreshTailscale, resetNetworkCacheForTests } from "../src/remote/network";
import { createPairCode, resetPairingForTests } from "../src/remote/pairing";
import { remoteAllowed } from "../src/remote/policy";
import { clearTokensForTests, mintToken, verifyToken } from "../src/remote/store";
import { openSocketCount, sweepSockets } from "../src/remote/auth";
import { resetState } from "./helpers";

const TOKEN = "remote-test-owner-token";
let srv: ReturnType<typeof startServer>;

// Nothing here binds a network address: the second listener is a recorder, interfaces are injected, and
// `tailscale` is a script in a temp dir whose answer the tests switch through a state file.
const served: Array<{ host: string; port: number; stopped: boolean }> = [];
const LAN_IFACES = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
  "br-1234": [{ address: "172.18.0.1", family: "IPv4", internal: false }],
  utun4: [{ address: "100.64.1.1", family: "IPv4", internal: false }],
  bridge100: [{ address: "192.168.64.1", family: "IPv4", internal: false }],
  en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
};
let tsDir: string;
const tsState = (state: "ok" | "stopped" | "nodns") => fs.writeFileSync(path.join(tsDir, "state"), state);
const savedEnv = { ...process.env };
const restoreEnv = (k: string) => (savedEnv[k] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[k]));

beforeAll(() => {
  tsDir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-fake-ts-"));
  fs.writeFileSync(
    path.join(tsDir, "tailscale"),
    `#!/bin/sh
dir=$(dirname "$0"); state=$(cat "$dir/state")
if [ "$state" = stopped ]; then echo "Tailscale is stopped." >&2; exit 1; fi
case "$1" in
  ip) echo 100.101.102.103 ;;
  status) if [ "$state" = nodns ]; then echo '{"BackendState":"Running","Self":{"DNSName":"","TailscaleIPs":["100.101.102.103"]}}'; else echo '{"BackendState":"Running","Self":{"DNSName":"Mac.tail1234.ts.net.","TailscaleIPs":["100.101.102.103"]}}'; fi ;;
esac
`,
    { mode: 0o755 },
  );
  process.env.TRB_TAILSCALE_BIN = path.join(tsDir, "tailscale");
  process.env.TRB_REMOTE_INTERFACES = JSON.stringify(LAN_IFACES);
  tsState("ok");
  srv = startServer({
    port: 0,
    token: TOKEN,
    remoteServe: (host, port) => {
      const rec = { host, port, stopped: false };
      served.push(rec);
      return { stop: () => void (rec.stopped = true) };
    },
  });
  setDaemonContext({ url: srv.url, token: TOKEN });
});
afterAll(() => {
  setDaemonContext(null);
  killAllTerminals();
  srv.stop();
  restoreEnv("TRB_TAILSCALE_BIN");
  restoreEnv("TRB_REMOTE_INTERFACES");
  fs.rmSync(tsDir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.TRB_REMOTE_INTERFACES = JSON.stringify(LAN_IFACES);
  process.env.TRB_TAILSCALE_BIN = path.join(tsDir, "tailscale");
  tsState("ok");
  stopListener();
  served.length = 0;
  resetNetworkCacheForTests();
  resetState();
  clearTokensForTests();
  resetPairingForTests();
});
afterEach(async () => {
  await interruptAll();
});

const owner = { authorization: `Bearer ${TOKEN}` };
const call = async (method: string, p: string, o: { headers?: Record<string, string>; body?: unknown } = {}) => {
  const res = await fetch(`${srv.url}${p}`, {
    method,
    headers: { ...(o.headers ?? {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    redirect: "manual",
  });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, body: ct.includes("json") ? await res.json() : await res.text() } as { status: number; headers: Headers; body: any };
};
const cookieOf = (token: string) => ({ cookie: `trb_remote=${encodeURIComponent(token)}` });

/** Pair a device through the real endpoints and return its cookie header. */
async function pairDevice(): Promise<{ cookie: Record<string, string>; token: string }> {
  setSetting("remote_mode", "lan");
  const made = await call("POST", "/api/remote/pair", { headers: owner, body: { label: "Test phone" } });
  expect(made.status).toBe(201);
  const code = new URL(made.body.url).searchParams.get("code")!;
  const page = await call("GET", `/_pair?code=${code}`);
  expect(page.status).toBe(200);
  const spent = await fetch(`${srv.url}/_pair`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `code=${code}`, redirect: "manual" });
  expect(spent.status).toBe(303);
  const token = decodeURIComponent(/trb_remote=([^;]+)/.exec(spent.headers.get("set-cookie")!)![1]);
  return { cookie: cookieOf(token), token };
}

describe("default off", () => {
  test("remote access is off out of the box", async () => {
    expect((await call("GET", "/api/config", { headers: owner })).body.settings.find((s: any) => s.key === "remote_mode").value).toBe("off");
    expect(remoteMode()).toBe("off");
    expect(served).toHaveLength(0);
  });

  test("no pairing page, no pair codes, and a token minted anyway is refused", async () => {
    expect((await call("GET", "/_pair?code=abc")).status).toBe(404);
    expect((await fetch(`${srv.url}/_pair`, { method: "POST", body: "code=abc" })).status).toBe(404);
    const made = await call("POST", "/api/remote/pair", { headers: owner });
    expect(made.status).toBe(400);
    expect(made.body.error).toContain("off");
    const { token } = mintToken({ label: "x" });
    expect((await call("GET", "/api/sessions", { headers: cookieOf(token) })).status).toBe(401);
    expect((await call("GET", "/api/sessions", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  test("the daemon still binds loopback by default", () => {
    expect(srv.server.hostname).toBe("127.0.0.1");
  });
});

describe("pairing", () => {
  test("a code is spent exactly once; the confirm page does not spend it", async () => {
    setSetting("remote_mode", "lan");
    const { code } = createPairCode();
    expect((await call("GET", `/_pair?code=${code}`)).status).toBe(200);
    expect((await call("GET", `/_pair?code=${code}`)).status).toBe(200);
    const post = () => fetch(`${srv.url}/_pair`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `code=${code}`, redirect: "manual" });
    const first = await post();
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/remote");
    const cookie = first.headers.get("set-cookie")!;
    expect(cookie).toContain("trb_remote=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect((await post()).status).toBe(410);
  });

  test("an expired code is refused", async () => {
    setSetting("remote_mode", "lan");
    const { code } = createPairCode({ now: Date.now() - 3 * 60_000 });
    expect((await call("GET", `/_pair?code=${code}`)).status).toBe(410);
    const r = await fetch(`${srv.url}/_pair`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `code=${code}`, redirect: "manual" });
    expect(r.status).toBe(410);
  });

  test("only the owner can mint a code", async () => {
    const { cookie } = await pairDevice();
    expect((await call("POST", "/api/remote/pair", { headers: cookie })).status).toBe(403);
    expect((await call("POST", "/api/remote/pair", {})).status).toBe(401);
  });

  test("guessing is rate limited, per peer and with Retry-After", async () => {
    setSetting("remote_mode", "lan");
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 14; i++) {
      last = await fetch(`${srv.url}/_pair`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `code=guess${i}`, redirect: "manual" });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 410)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    // Even a good code is refused while limited.
    const { code } = createPairCode();
    expect((await call("GET", `/_pair?code=${code}`)).status).toBe(429);
  });

  test("a pair POST from another origin is refused", async () => {
    setSetting("remote_mode", "lan");
    const { code } = createPairCode();
    const r = await fetch(`${srv.url}/_pair`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://evil.example" }, body: `code=${code}`, redirect: "manual" });
    expect(r.status).toBe(403);
    // The code survives a refused attempt.
    expect((await call("GET", `/_pair?code=${code}`)).status).toBe(200);
  });

  test("a browser form post from the no-referrer confirm page (Origin: null) pairs", async () => {
    setSetting("remote_mode", "lan");
    const { code } = createPairCode();
    const r = await fetch(`${srv.url}/_pair`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" }, body: `code=${code}`, redirect: "manual" });
    expect(r.status).toBe(303);
  });

  test("the plaintext token is never stored", async () => {
    const { token } = await pairDevice();
    const rows = db().prepare("SELECT * FROM remote_tokens").all() as any[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].token_hash).toHaveLength(64);
  });

  test("tokens expire", () => {
    const { token } = mintToken({ label: "old", now: Date.now() - 40 * 86_400_000 });
    expect(verifyToken(token)).toBeNull();
    const fresh = mintToken({ label: "new" });
    expect(verifyToken(fresh.token)?.label).toBe("new");
  });
});

describe("what a remote token can do", () => {
  test("the compact view's API works", async () => {
    const { cookie } = await pairDevice();
    expect((await call("GET", "/api/remote/me", { headers: cookie })).body.kind).toBe("remote");
    expect((await call("GET", "/api/sessions", { headers: cookie })).status).toBe(200);
    // Unknown session: the route is reached (404 from the handler), not refused by the policy.
    expect((await call("GET", "/api/sessions/s_none", { headers: cookie })).status).toBe(404);
    expect((await call("POST", "/api/sessions/s_none/send", { headers: cookie, body: { message: "hi" } })).status).toBe(400);
    expect((await call("GET", "/api/sessions/s_none/plan-state", { headers: cookie })).status).toBe(404);
  });

  test("everything else is refused (default deny)", async () => {
    const { cookie } = await pairDevice();
    const denied: Array<[string, string]> = [
      ["GET", "/api/config"],
      ["POST", "/api/config/default_engine"],
      ["PUT", "/api/config/remote_mode"],
      ["POST", "/api/sessions"],
      ["POST", "/api/sessions/s_x/close"],
      ["POST", "/api/sessions/s_x/merge"],
      ["POST", "/api/sessions/s_x/spawn"],
      ["POST", "/api/sessions/s_x/handoff"],
      ["POST", "/api/sessions/s_x/goal"],
      ["PUT", "/api/sessions/s_x/model"],
      ["GET", "/api/workspaces"],
      ["POST", "/api/workspaces"],
      ["GET", "/api/browse"],
      ["GET", "/api/mcp"],
      ["POST", "/api/mcp"],
      ["GET", "/api/skills"],
      ["POST", "/api/skills/import/start"],
      ["GET", "/api/agents"],
      ["GET", "/api/pairs"],
      ["GET", "/api/doctor"],
      ["POST", "/api/shutdown"],
      ["POST", "/api/tools/call"],
      ["GET", "/api/git/w_x/status"],
      ["POST", "/api/git/w_x/commit"],
      ["GET", "/api/docs/w_x/pages"],
      ["GET", "/api/roadmap/w_x"],
      ["GET", "/api/specs/w_x"],
      ["GET", "/api/browser/s_x/stream"],
      ["POST", "/api/ui/ticket"],
      ["GET", "/api/remote/status"],
      ["POST", "/api/remote/pair"],
      ["GET", "/api/remote/tokens"],
      ["DELETE", "/api/remote/tokens/rt_x"],
      ["POST", "/api/remote/revoke-all"],
    ];
    for (const [method, p] of denied) {
      const r = await call(method, p, { headers: cookie, body: method === "GET" || method === "DELETE" ? undefined : {} });
      expect([method, p, r.status]).toEqual([method, p, 403]);
    }
  });

  test("terminals and files are separate, live grants", async () => {
    const { cookie } = await pairDevice();
    expect((await call("GET", "/api/terminals", { headers: cookie })).status).toBe(403);
    expect((await call("POST", "/api/terminals", { headers: cookie, body: {} })).status).toBe(403);
    expect((await call("GET", "/api/fs/w_x/tree", { headers: cookie })).status).toBe(403);

    setSetting("remote_allow_terminal", "on");
    expect((await call("GET", "/api/terminals", { headers: cookie })).status).toBe(200);
    setSetting("remote_allow_terminal", "off");
    expect((await call("GET", "/api/terminals", { headers: cookie })).status).toBe(403);

    setSetting("remote_allow_files", "read");
    expect((await call("GET", "/api/fs/w_nope/tree", { headers: cookie })).status).not.toBe(403);
    expect((await call("PUT", "/api/fs/w_nope/file", { headers: cookie, body: {} })).status).toBe(403);
    expect((await call("DELETE", "/api/fs/w_nope/file", { headers: cookie })).status).toBe(403);
    setSetting("remote_allow_files", "write");
    expect((await call("PUT", "/api/fs/w_nope/file", { headers: cookie, body: {} })).status).not.toBe(403);
    resetSetting("remote_allow_files");
    expect((await call("GET", "/api/fs/w_nope/tree", { headers: cookie })).status).toBe(403);
  });

  test("no credentials, a wrong token, or the owner token as a cookie of the wrong name all fail", async () => {
    await pairDevice();
    expect((await call("GET", "/api/sessions")).status).toBe(401);
    expect((await call("GET", "/api/sessions", { headers: cookieOf("trbr_" + "0".repeat(64)) })).status).toBe(401);
    expect((await call("GET", "/api/sessions", { headers: { cookie: `trb_remote=${TOKEN}` } })).status).toBe(401);
  });

  test("a cross-origin write with a remote cookie is refused", async () => {
    const { cookie } = await pairDevice();
    const r = await call("POST", "/api/sessions/s_none/interrupt", { headers: { ...cookie, origin: "http://evil.example" }, body: {} });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("Cross-origin");
  });

  test("owner-only routes still work for the owner", async () => {
    await pairDevice();
    expect((await call("GET", "/api/remote/status", { headers: owner })).body.tokens).toHaveLength(1);
    expect((await call("GET", "/api/remote/me", { headers: owner })).body.kind).toBe("owner");
  });
});

describe("revocation", () => {
  test("a revoked device is refused on its next request and listed no more", async () => {
    const { cookie } = await pairDevice();
    const [t] = (await call("GET", "/api/remote/tokens", { headers: owner })).body.tokens;
    expect(t.label).toBe("Test phone");
    expect((await call("GET", "/api/sessions", { headers: cookie })).status).toBe(200);
    expect((await call("DELETE", `/api/remote/tokens/${t.id}`, { headers: owner })).status).toBe(200);
    expect((await call("GET", "/api/sessions", { headers: cookie })).status).toBe(401);
    expect((await call("GET", "/api/remote/tokens", { headers: owner })).body.tokens).toHaveLength(0);
    expect((await call("DELETE", `/api/remote/tokens/${t.id}`, { headers: owner })).status).toBe(404);
  });

  test("revoke-all, and turning remote access off, refuse every device", async () => {
    const a = await pairDevice();
    const b = await pairDevice();
    setSetting("remote_mode", "off");
    expect((await call("GET", "/api/sessions", { headers: a.cookie })).status).toBe(401);
    setSetting("remote_mode", "lan");
    expect((await call("GET", "/api/sessions", { headers: b.cookie })).status).toBe(200);
    expect((await call("POST", "/api/remote/revoke-all", { headers: owner, body: {} })).body.revoked).toBe(2);
    expect((await call("GET", "/api/sessions", { headers: a.cookie })).status).toBe(401);
    expect((await call("GET", "/api/sessions", { headers: b.cookie })).status).toBe(401);
  });
});

const wsUrl = () => srv.url.replace("http", "ws") + "/api/live";
function openSocket(headers: Record<string, string>): Promise<{ ws: WebSocket; closed: Promise<number>; frames: any[] } | { error: true }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(), { headers } as any);
    const frames: any[] = [];
    let closeResolve!: (c: number) => void;
    const closed = new Promise<number>((r) => (closeResolve = r));
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    ws.onclose = (e) => closeResolve(e.code);
    ws.onopen = () => resolve({ ws, closed, frames });
    ws.onerror = () => resolve({ error: true });
  });
}
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(20);
  expect(cond()).toBe(true);
};

describe("the live socket", () => {
  test("refused without credentials and while remote access is off", async () => {
    expect("error" in (await openSocket({}))).toBe(true);
    const { token } = mintToken({ label: "x" });
    expect("error" in (await openSocket(cookieOf(token)))).toBe(true);
  });

  test("a paired device can follow sessions but not the agent browser; revoking cuts the socket", async () => {
    const { cookie } = await pairDevice();
    const s = await openSocket(cookie);
    if ("error" in s) throw new Error("socket refused");
    await until(() => openSocketCount() === 1);
    s.ws.send(JSON.stringify({ op: "sub", id: "g", stream: "global" }));
    await until(() => s.frames.some((f) => f.id === "g" && f.event === "hello"));
    s.ws.send(JSON.stringify({ op: "sub", id: "b", stream: "browser", session: "s_x" }));
    await until(() => s.frames.some((f) => f.id === "b" && f.event === "error"));
    expect(s.frames.find((f) => f.id === "b").data.status).toBe(403);

    const [t] = (await call("GET", "/api/remote/tokens", { headers: owner })).body.tokens;
    await call("DELETE", `/api/remote/tokens/${t.id}`, { headers: owner });
    expect(await s.closed).toBe(4401);
    await until(() => openSocketCount() === 0);
  });

  test("turning remote access off closes open sockets on the next sweep", async () => {
    const { cookie } = await pairDevice();
    const s = await openSocket(cookie);
    if ("error" in s) throw new Error("socket refused");
    await until(() => openSocketCount() === 1);
    setSetting("remote_mode", "off");
    sweepSockets();
    expect(await s.closed).toBe(4401);
  });

  test("a remote device cannot open a terminal socket unless granted", async () => {
    const { cookie } = await pairDevice();
    const r = await fetch(`${srv.url}/api/terminals/t_x/ws`, { headers: { ...cookie, upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    expect(r.status).toBe(403);
  });

  test("a socket from another origin is refused for a remote cookie", async () => {
    const { cookie } = await pairDevice();
    expect("error" in (await openSocket({ ...cookie, origin: "http://evil.example" }))).toBe(true);
  });
});

describe("hosts and peers", () => {
  test("off: loopback names only", () => {
    expect(hostAllowed("127.0.0.1:4477")).toBe(true);
    expect(hostAllowed("localhost")).toBe(true);
    for (const h of ["192.168.1.20:4477", "100.101.102.103", "mac.tail1234.ts.net", "evil.example"]) expect(hostAllowed(h)).toBe(false);
  });

  test("lan: exactly the detected LAN address, nothing else", () => {
    setSetting("remote_mode", "lan");
    expect(allowedRemoteHosts()).toEqual(["192.168.1.20"]);
    expect(hostAllowed("192.168.1.20:4477")).toBe(true);
    expect(hostAllowed("127.0.0.1:4477")).toBe(true);
    for (const h of ["10.0.0.5", "172.20.1.1", "192.168.1.21", "172.17.0.1", "100.101.102.103", "mac.tail1234.ts.net", "evil.example", "8.8.8.8"]) expect([h, hostAllowed(h)]).toEqual([h, false]);
  });

  test("tailscale: exactly the tailnet name and address; the LAN address is refused", () => {
    setSetting("remote_mode", "tailscale");
    expect(allowedRemoteHosts()).toEqual(["mac.tail1234.ts.net", "100.101.102.103"]);
    expect(hostAllowed("mac.tail1234.ts.net")).toBe(true);
    expect(hostAllowed("Mac.Tail1234.ts.net:4477")).toBe(true);
    expect(hostAllowed("100.101.102.103:4477")).toBe(true);
    for (const h of ["192.168.1.20:4477", "100.101.102.104", "other.tail1234.ts.net", "mac.tail1234.ts.net.evil.example", "evil.example"]) expect([h, hostAllowed(h)]).toEqual([h, false]);
  });

  test("tailscale without MagicDNS: the address only", () => {
    tsState("nodns");
    setSetting("remote_mode", "tailscale");
    expect(allowedRemoteHosts()).toEqual(["100.101.102.103"]);
  });

  test("switching back to off refuses the remote names again", () => {
    setSetting("remote_mode", "lan");
    expect(hostAllowed("192.168.1.20")).toBe(true);
    setSetting("remote_mode", "off");
    expect(hostAllowed("192.168.1.20")).toBe(false);
  });

  test("address ranges", () => {
    for (const ip of ["10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.255.255"]) expect(isRfc1918(ip)).toBe(true);
    for (const ip of ["11.0.0.1", "192.169.0.1", "172.15.0.1", "172.32.0.1", "300.1.1.1", "1.2.3", "example.com", "100.100.1.1"]) expect(isRfc1918(ip)).toBe(false);
    for (const ip of ["100.64.0.1", "100.101.102.103", "100.127.255.255"]) expect(isTailnetIPv4(ip)).toBe(true);
    for (const ip of ["100.63.0.1", "100.128.0.1", "10.0.0.1", "100.1.1"]) expect(isTailnetIPv4(ip)).toBe(false);
  });

  test("the owner's credentials count only on loopback, from loopback", () => {
    expect(ownerMayAuthenticate("127.0.0.1:4477", "127.0.0.1")).toBe(true);
    expect(ownerMayAuthenticate("localhost:4477", "::1")).toBe(true);
    expect(ownerMayAuthenticate("192.168.1.20:4477", "127.0.0.1")).toBe(false);
    expect(ownerMayAuthenticate("trb.example.com", "127.0.0.1")).toBe(false);
    expect(ownerMayAuthenticate("127.0.0.1:4477", "192.168.1.9")).toBe(false);
    expect(ownerMayAuthenticate("127.0.0.1:4477", null)).toBe(false);
  });

  test("a non-loopback Host is refused while off; the owner token is refused on one while on", async () => {
    expect((await call("GET", "/api/health", { headers: { host: "192.168.1.20:4477" } })).status).toBe(403);
    setSetting("remote_mode", "lan");
    expect((await call("GET", "/api/health", { headers: { host: "192.168.1.20:4477" } })).status).toBe(200);
    const asOwner = await call("GET", "/api/sessions", { headers: { ...owner, host: "192.168.1.20:4477" } });
    expect(asOwner.status).toBe(401);
    // A paired device does work on that Host.
    const { token } = mintToken({ label: "lan phone" });
    const asRemote = await call("GET", "/api/sessions", { headers: { host: "192.168.1.20:4477", ...cookieOf(token) } });
    expect(asRemote.status).toBe(200);
    // A name that is neither listed nor a private literal is refused outright.
    expect((await call("GET", "/api/health", { headers: { host: "rebind.evil.example" } })).status).toBe(403);
  });

  test("the app shell reached by a LAN name allows its own socket origin in the CSP", async () => {
    setSetting("remote_mode", "lan");
    const r = await fetch(`${srv.url}/`, { headers: { host: "192.168.1.20:4477" } });
    const csp = r.headers.get("content-security-policy") ?? "";
    if (r.status === 200) expect(csp).toContain("ws://192.168.1.20:4477");
    const loop = await fetch(`${srv.url}/`);
    expect(loop.headers.get("content-security-policy") ?? "").not.toContain("192.168");
  });
});

describe("policy table", () => {
  const off = { terminal: false, files: "off" as const };
  test("allowed", () => {
    for (const [m, p] of [
      ["GET", "/api/sessions"],
      ["GET", "/api/sessions/s_1"],
      ["GET", "/api/sessions/s_1/logs"],
      ["POST", "/api/sessions/s_1/send"],
      ["POST", "/api/sessions/s_1/interrupt"],
      ["POST", "/api/sessions/s_1/plan/answer"],
      ["POST", "/api/sessions/s_1/plan/plans/p_1/approve"],
      ["POST", "/api/sessions/s_1/plan/plans/p_1/request-changes"],
      ["HEAD", "/api/sessions"],
    ])
      expect([m, p, remoteAllowed(m, p, off).ok]).toEqual([m, p, true]);
  });
  test("denied, including near misses", () => {
    for (const [m, p] of [
      ["DELETE", "/api/sessions/s_1"],
      ["PATCH", "/api/sessions/s_1"],
      ["GET", "/api/sessions/s_1/events"],
      ["GET", "/api/stream"],
      ["GET", "/api/sessions/s_1/send"],
      ["POST", "/api/sessions"],
      ["POST", "/api/sessions/s_1/close"],
      ["POST", "/api/sessions/s_1/plan/plans/p_1/promote"],
      ["PUT", "/api/sessions/s_1/plan/plans/p_1/file"],
      ["GET", "/api/sessions/s_1/send/extra"],
      ["GET", "/api/sessions/"],
      ["GET", "/api/SESSIONS"],
      ["GET", "/api/sessions/s_1/../../config"],
      ["GET", "/api/terminals"],
      ["GET", "/api/fs/w_1/tree"],
      ["PUT", "/api/fs/w_1/file"],
      ["GET", "/_pair"],
      ["GET", "/api/x"],
    ])
      expect([m, p, remoteAllowed(m, p, off).ok]).toEqual([m, p, false]);
  });
});

describe("remote_mode", () => {
  const status = async () => (await call("GET", "/api/remote/status", { headers: owner })).body;
  const pairUrl = async (body: unknown = {}) => call("POST", "/api/remote/pair", { headers: owner, body });

  test("only off, lan and tailscale are accepted, and the old switches are gone", () => {
    expect(() => setSetting("remote_mode", "on")).toThrow(/off.*lan.*tailscale/);
    expect(() => setSetting("remote_mode", "wan")).toThrow();
    for (const k of ["remote_access", "remote_bind", "remote_hosts"]) expect(() => setSetting(k, "x")).toThrow(/Unknown setting/);
  });

  test("the second listener binds exactly one address, never 0.0.0.0", () => {
    setSetting("remote_mode", "lan");
    expect(served).toEqual([{ host: "192.168.1.20", port: srv.port, stopped: false }]);
    expect(listenStatus()).toMatchObject({ mode: "lan", address: "192.168.1.20" });
    setSetting("remote_mode", "tailscale");
    expect(served).toHaveLength(2);
    expect(served[0].stopped).toBe(true); // the LAN address is released first
    expect(served[1]).toMatchObject({ host: "100.101.102.103", stopped: false });
    setSetting("remote_mode", "off");
    expect(served[1].stopped).toBe(true);
    expect(listenStatus().address).toBeNull();
    expect(served.some((x) => x.host === "0.0.0.0" || x.host === "127.0.0.1")).toBe(false);
    expect(srv.server.hostname).toBe("127.0.0.1");
  });

  test("LAN detection skips docker, bridge, VM and tailscale interfaces and prefers en0", () => {
    expect(pickLan(LAN_IFACES as any)).toEqual({ ip: "192.168.1.20", iface: "en0" });
    const { en0: _gone, ...virtualOnly } = LAN_IFACES;
    expect(pickLan(virtualOnly as any)).toBeNull();
    expect(pickLan({ eth0: [{ address: "10.0.0.7", family: "IPv4", internal: false }], docker0: LAN_IFACES.docker0 } as any)?.ip).toBe("10.0.0.7");
    expect(pickLan({ en0: [{ address: "169.254.1.1", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }] } as any)).toBeNull();
  });

  test("lan is refused when there is no usable address", () => {
    const { en0: _gone, ...virtualOnly } = LAN_IFACES;
    process.env.TRB_REMOTE_INTERFACES = JSON.stringify(virtualOnly);
    resetNetworkCacheForTests();
    expect(() => setSetting("remote_mode", "lan")).toThrow(/No local network address/);
    expect(remoteMode()).toBe("off");
  });

  test("tailscale is refused, in plain words, when it is not installed or not running", () => {
    process.env.TRB_TAILSCALE_BIN = "none";
    resetNetworkCacheForTests();
    expect(() => setSetting("remote_mode", "tailscale")).toThrow(/not installed/);
    process.env.TRB_TAILSCALE_BIN = path.join(tsDir, "tailscale");
    tsState("stopped");
    resetNetworkCacheForTests();
    expect(() => setSetting("remote_mode", "tailscale")).toThrow(/not running or not signed in/);
    expect(remoteMode()).toBe("off");
    expect(served).toHaveLength(0);
  });

  test("status reports the mode, the bound address, the detected link and the LAN warning", async () => {
    expect((await status()).base.origin).toBeNull();
    setSetting("remote_mode", "lan");
    const lan = await status();
    expect(lan).toMatchObject({ mode: "lan", enabled: true, listen: { address: "192.168.1.20" }, detected: { lan: { ip: "192.168.1.20", iface: "en0" } } });
    expect(lan.base.origin).toBe(`http://192.168.1.20:${new URL(srv.url).port}`);
    expect(lan.base.reachable).toBe(true);
    expect(lan.base.warning).toContain("anyone on the same");
    setSetting("remote_mode", "tailscale");
    const ts = await status();
    expect(ts.base.origin).toBe(`http://mac.tail1234.ts.net:${new URL(srv.url).port}`);
    expect(ts.base.warning).toBeNull();
    expect(ts.detected.tailscale).toMatchObject({ state: "ok", ip: "100.101.102.103", dnsName: "mac.tail1234.ts.net" });
  });

  test("the pairing link is never a localhost link", async () => {
    expect((await pairUrl()).status).toBe(400); // off
    expect((await pairUrl({ local: true })).status).toBe(400); // --local does not bypass off
    for (const mode of ["lan", "tailscale"] as const) {
      setSetting("remote_mode", mode);
      const r = await pairUrl({ label: "x" });
      expect(r.status).toBe(201);
      const u = new URL(r.body.url);
      expect(["127.0.0.1", "localhost", "[::1]", "::1"]).not.toContain(u.hostname);
      expect(u.hostname).toBe(mode === "lan" ? "192.168.1.20" : "mac.tail1234.ts.net");
      expect(r.body.local).toBe(false);
      expect(r.body.qr_svg).toContain("<svg");
    }
    // Tailscale went down after enabling: no link at all, never a fallback to loopback.
    tsState("stopped");
    resetNetworkCacheForTests();
    await refreshTailscale(); // the background probe answers; until then the state reads as "checking"
    const down = await pairUrl();
    expect(down.status).toBe(400);
    expect(down.body.error).toContain("not running");
    expect(JSON.stringify(down.body)).not.toContain("127.0.0.1");
  });

  test("--local is explicit, flagged, and only works with a mode on", async () => {
    setSetting("remote_mode", "lan");
    const r = await pairUrl({ local: true });
    expect(r.status).toBe(201);
    expect(r.body.local).toBe(true);
    expect(r.body.reachable).toBe(false);
    expect(r.body.url).toContain("127.0.0.1");
    expect(r.body.note).toContain("development and tests");
  });

  test("switching the mode closes every open remote socket at once", async () => {
    const { cookie } = await pairDevice();
    const s = await openSocket(cookie);
    if ("error" in s) throw new Error("socket refused");
    await until(() => openSocketCount() === 1);
    setSetting("remote_mode", "tailscale");
    expect(await s.closed).toBe(4401);
    await until(() => openSocketCount() === 0);
  });

  test("a device paired in one mode cannot use the old Host after a switch", async () => {
    const { cookie } = await pairDevice();
    const via = (host: string) => call("GET", "/api/sessions", { headers: { ...cookie, host } });
    expect((await via("192.168.1.20:4477")).status).toBe(200);
    setSetting("remote_mode", "tailscale");
    expect((await via("192.168.1.20:4477")).status).toBe(403);
    expect((await via("mac.tail1234.ts.net")).status).toBe(200);
  });

  test("the owner token is refused on a remote Host in every mode", async () => {
    for (const [mode, host] of [["lan", "192.168.1.20:4477"], ["tailscale", "mac.tail1234.ts.net"]] as const) {
      setSetting("remote_mode", mode);
      expect((await call("GET", "/api/sessions", { headers: { ...owner, host } })).status).toBe(401);
      expect((await call("GET", "/api/health", { headers: { host } })).status).toBe(200);
    }
  });

  test("old settings migrate: on+lan -> lan, on+loopback -> off, off -> off; the old rows go", () => {
    const put = (k: string, v: string) => db().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(k, v);
    const rows = () => (db().prepare("SELECT key FROM settings WHERE key LIKE 'remote_%'").all() as Array<{ key: string }>).map((r) => r.key).sort();
    put("remote_access", "on");
    put("remote_bind", "lan");
    migrateRemoteMode();
    expect(remoteMode()).toBe("lan");
    expect(rows()).toEqual(["remote_mode"]);

    db().exec("DELETE FROM settings");
    put("remote_access", "on");
    put("remote_bind", "loopback");
    put("remote_hosts", "trb.example.com");
    migrateRemoteMode();
    expect(remoteMode()).toBe("off");
    expect(rows()).toEqual(["remote_mode"]);

    db().exec("DELETE FROM settings");
    put("remote_access", "off");
    put("remote_bind", "lan");
    migrateRemoteMode();
    expect(remoteMode()).toBe("off");

    // Idempotent, and an explicit new value is never overwritten by a leftover old row.
    db().exec("DELETE FROM settings");
    put("remote_mode", "tailscale");
    put("remote_access", "on");
    put("remote_bind", "lan");
    migrateRemoteMode();
    migrateRemoteMode();
    expect(remoteMode()).toBe("tailscale");
    expect(rows()).toEqual(["remote_mode"]);
  });
});
