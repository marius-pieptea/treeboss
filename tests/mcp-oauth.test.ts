import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { McpStore, buildRunMcpConfig } from "../src/mcp/store";
import { challengeParam, ensureFreshToken, oauthStatus } from "../src/mcp/oauth";
import { db } from "../src/db";
import { resetState } from "./helpers";

const TOKEN = "oauth-test-token";
let srv: ReturnType<typeof startServer>;

/** An MCP server behind OAuth, with its authorization server on the same origin (the shape most hosted servers have). */
function protectedServer(opts: { dcr?: boolean; ttl?: number } = {}) {
  const codes = new Map<string, { challenge: string; redirect: string; resource: string }>();
  const state = { registered: 0, issued: 0, refreshed: 0, valid: new Set<string>(), lastResource: "" };
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const origin = u.origin;
      if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/auth`], scopes_supported: ["read", "write"] });
      if (u.pathname === "/.well-known/oauth-authorization-server/auth")
        return Response.json({ issuer: `${origin}/auth`, authorization_endpoint: `${origin}/auth/authorize`, token_endpoint: `${origin}/auth/token`, ...(opts.dcr === false ? {} : { registration_endpoint: `${origin}/auth/register` }) });
      if (u.pathname === "/auth/register") {
        state.registered++;
        const body: any = await req.json();
        expect(body.token_endpoint_auth_method).toBe("none");
        return Response.json({ client_id: "dyn-client", redirect_uris: body.redirect_uris }, { status: 201 });
      }
      if (u.pathname === "/auth/authorize") {
        // Stands in for the user approving: straight back to the redirect with a code.
        const code = `code-${codes.size}`;
        codes.set(code, { challenge: u.searchParams.get("code_challenge")!, redirect: u.searchParams.get("redirect_uri")!, resource: u.searchParams.get("resource")! });
        expect(u.searchParams.get("code_challenge_method")).toBe("S256");
        expect(u.searchParams.get("scope")).toBe("read write");
        return Response.redirect(`${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}`, 302);
      }
      if (u.pathname === "/auth/token") {
        const f = new URLSearchParams(await req.text());
        state.lastResource = f.get("resource") ?? "";
        const issue = () => {
          const at = `at-${++state.issued}`;
          state.valid.add(at);
          return Response.json({ access_token: at, refresh_token: `rt-${state.issued}`, expires_in: opts.ttl ?? 3600, token_type: "Bearer", scope: "read write" });
        };
        if (f.get("grant_type") === "refresh_token") {
          state.refreshed++;
          return f.get("refresh_token")?.startsWith("rt-") ? issue() : Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const c = codes.get(f.get("code") ?? "");
        const verified = c && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge && f.get("redirect_uri") === c.redirect;
        if (!verified) return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(f.get("code")!);
        return issue();
      }
      if (u.pathname === "/mcp") {
        const auth = req.headers.get("authorization") ?? "";
        if (!state.valid.has(auth.replace(/^Bearer /, ""))) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
        const msg: any = await req.json();
        return Response.json({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize" ? { protocolVersion: "2025-06-18", serverInfo: { name: "guarded", version: "1" }, capabilities: {} } : { tools: [{ name: "secret" }] } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { s, state, url: `http://127.0.0.1:${s.port}/mcp` };
}

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/** What the operator's browser does: open the authorize URL and follow the redirects back to the daemon. */
const approve = async (authorizeUrl: string) => {
  const res = await fetch(authorizeUrl);
  return { status: res.status, text: await res.text() };
};

const runHeaders = (name: string) => {
  const spec = buildRunMcpConfig({ sessionId: "s_x", subagents: false, daemonUrl: srv.url, token: TOKEN })[name];
  return spec?.type === "http" ? spec.headers ?? {} : {};
};

beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
  setDaemonContext({ url: srv.url, token: TOKEN });
});
afterAll(() => {
  setDaemonContext(null);
  srv.stop();
});
beforeEach(() => {
  resetState();
  db().exec("DELETE FROM mcp_oauth");
});

describe("MCP OAuth sign-in", () => {
  test("challenge parameters parse quoted and bare values", () => {
    expect(challengeParam('Bearer realm="x", resource_metadata="https://h/.well-known/oauth-protected-resource", scope=read', "resource_metadata")).toBe("https://h/.well-known/oauth-protected-resource");
    expect(challengeParam('Bearer realm="x", scope=read', "scope")).toBe("read");
    expect(challengeParam(null, "scope")).toBeNull();
  });

  test("test says to sign in; sign-in registers, exchanges with PKCE, and sessions get the bearer header", async () => {
    const p = protectedServer();
    McpStore.put({ name: "guarded", url: p.url });

    const before = await call("POST", "/api/mcp/guarded/test");
    expect(before.body).toMatchObject({ ok: false, authRequired: true });
    expect(runHeaders("guarded")).toEqual({});

    const start = await call("POST", "/api/mcp/guarded/oauth/start", {});
    expect(start.status).toBe(200);
    expect(start.body.redirectUri).toBe(`${srv.url}/oauth/mcp/callback`);
    const back = await approve(start.body.authorizeUrl);
    expect(back.status).toBe(200);
    expect(back.text).toContain("Signed in to guarded");
    expect(p.state.registered).toBe(1);
    expect(p.state.lastResource).toBe(p.url);

    expect(oauthStatus("guarded").signedIn).toBe(true);
    expect((await call("GET", "/api/mcp")).body.servers[0].oauth).toMatchObject({ signedIn: true, scope: "read write" });
    expect(runHeaders("guarded")).toEqual({ Authorization: "Bearer at-1" });
    expect((await call("POST", "/api/mcp/guarded/test")).body).toMatchObject({ ok: true, tools: [{ name: "secret" }] });

    // The callback's state is single use.
    expect((await approve(start.body.authorizeUrl.replace(/state=[^&]+/, "state=forged"))).status).toBe(400);

    // Signing in again reuses the registered client.
    await approve((await call("POST", "/api/mcp/guarded/oauth/start", {})).body.authorizeUrl);
    expect(p.state.registered).toBe(1);

    expect((await call("POST", "/api/mcp/guarded/oauth/logout")).body.signedOut).toBe(true);
    expect(oauthStatus("guarded").signedIn).toBe(false);
    expect(runHeaders("guarded")).toEqual({});
    p.s.stop(true);
  });

  test("an expiring token is refreshed; the operator's own Authorization header wins; a new URL drops the sign-in", async () => {
    const p = protectedServer({ ttl: 60 }); // inside the refresh margin from the start
    McpStore.put({ name: "guarded", url: p.url });
    await approve((await call("POST", "/api/mcp/guarded/oauth/start", {})).body.authorizeUrl);
    expect(runHeaders("guarded")).toEqual({ Authorization: "Bearer at-1" });

    await ensureFreshToken("guarded");
    expect(p.state.refreshed).toBe(1);
    expect(runHeaders("guarded")).toEqual({ Authorization: "Bearer at-2" });

    McpStore.put({ name: "guarded", url: p.url, headers: { authorization: "Bearer mine" } });
    expect(runHeaders("guarded")).toEqual({ authorization: "Bearer mine" });

    McpStore.put({ name: "guarded", url: `${p.url}/v2` });
    expect(oauthStatus("guarded").signedIn).toBe(false);
    expect(runHeaders("guarded")).toEqual({});

    McpStore.remove("guarded");
    expect(db().prepare("SELECT COUNT(*) AS n FROM mcp_oauth").get()).toEqual({ n: 0 });
    p.s.stop(true);
  });

  test("without client registration the operator's client id is used; a server with no OAuth is refused", async () => {
    const p = protectedServer({ dcr: false });
    McpStore.put({ name: "guarded", url: p.url });
    const refused = await call("POST", "/api/mcp/guarded/oauth/start", {});
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/client ID/);

    const start = await call("POST", "/api/mcp/guarded/oauth/start", { clientId: "my-app" });
    expect(new URL(start.body.authorizeUrl).searchParams.get("client_id")).toBe("my-app");
    await approve(start.body.authorizeUrl);
    expect(oauthStatus("guarded").signedIn).toBe(true);
    p.s.stop(true);

    const open = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }) });
    McpStore.put({ name: "open", url: `http://127.0.0.1:${open.port}/mcp` });
    expect((await call("POST", "/api/mcp/open/oauth/start", {})).body.error).toMatch(/does not ask for OAuth/);
    open.stop(true);
  });
});
