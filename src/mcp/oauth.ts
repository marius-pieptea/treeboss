/**
 * OAuth sign-in for remote (http) MCP servers, per the MCP authorization spec: protected-resource metadata
 * (RFC 9728) names the authorization server, its metadata (RFC 8414) names the endpoints, the client registers
 * itself (RFC 7591) unless the operator brings a client id, and the code flow uses PKCE (S256) and `resource`
 * (RFC 8707). Servers on the older spec (no resource metadata) are tried at their own origin and default paths.
 *
 * The daemon does the flow, not the engine: engines run headless and cannot open a browser. The access token
 * is refreshed before each turn and handed to every engine as an `Authorization` header, so it works the same
 * for Claude, Codex, Cursor and OpenCode.
 */
import { createHash, randomBytes } from "crypto";
import { db } from "../db";
import { VERSION } from "../version";
import { UserError } from "../util";
import { McpStore } from "./store";

export const OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";
const FLOW_TTL_MS = 10 * 60_000;
/** Refresh this long before the token says it expires: a turn should not start on a token about to die. */
const REFRESH_EARLY_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

interface AuthServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface Client {
  client_id: string;
  client_secret?: string;
  /** "none", "client_secret_post" or "client_secret_basic". */
  auth_method: string;
  redirect_uri: string;
  /** False when the operator supplied it: never re-registered or replaced. */
  registered: boolean;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms, or null when the server did not say. */
  expires_at: number | null;
  scope?: string;
}

interface Row {
  name: string;
  url: string;
  resource: string;
  scope: string | null;
  as: AuthServer;
  client: Client | null;
  tokens: Tokens | null;
}

export interface OAuthStatus {
  /** Has a usable (or refreshable) token for the server's current URL. */
  signedIn: boolean;
  expiresAt: string | null;
  scope: string | null;
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

function load(name: string): Row | null {
  const r = db().prepare("SELECT * FROM mcp_oauth WHERE name = ?").get(name) as any;
  if (!r) return null;
  try {
    return { name: r.name, url: r.url, resource: r.resource, scope: r.scope, as: JSON.parse(r.as_json), client: r.client_json ? JSON.parse(r.client_json) : null, tokens: r.tokens_json ? JSON.parse(r.tokens_json) : null };
  } catch {
    return null;
  }
}

function save(row: Row): void {
  db()
    .prepare(
      `INSERT INTO mcp_oauth (name, url, resource, scope, as_json, client_json, tokens_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(name) DO UPDATE SET url = excluded.url, resource = excluded.resource, scope = excluded.scope, as_json = excluded.as_json,
         client_json = excluded.client_json, tokens_json = excluded.tokens_json, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(row.name, row.url, row.resource, row.scope, JSON.stringify(row.as), row.client ? JSON.stringify(row.client) : null, row.tokens ? JSON.stringify(row.tokens) : null);
}

/** Forget the tokens (sign out). The client registration is kept so signing in again skips registering. */
export function signOut(name: string): boolean {
  return db().prepare("UPDATE mcp_oauth SET tokens_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE name = ? AND tokens_json IS NOT NULL").run(name).changes > 0;
}

export function forgetOAuth(name: string): void {
  db().prepare("DELETE FROM mcp_oauth WHERE name = ?").run(name);
}

/** The stored row, only while it still belongs to the server's current URL (an edited URL is a different server). */
function current(name: string): Row | null {
  const row = load(name);
  const rec = McpStore.get(name);
  return row && rec?.transport === "http" && rec.url === row.url ? row : null;
}

export function oauthStatus(name: string): OAuthStatus {
  const t = current(name)?.tokens;
  const live = !!t && (!!t.refresh_token || t.expires_at === null || t.expires_at > Date.now());
  return { signedIn: live, expiresAt: live && t!.expires_at ? new Date(t!.expires_at).toISOString() : null, scope: live ? (t!.scope ?? null) : null };
}

/** The bearer header to send, from what is stored now (no network). Empty when not signed in. */
export function oauthHeaders(name: string, headers: Record<string, string>): Record<string, string> {
  if (Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) return headers; // the operator's own header wins
  const t = current(name)?.tokens;
  if (!t || (t.expires_at !== null && t.expires_at <= Date.now())) return headers;
  return { ...headers, Authorization: `Bearer ${t.access_token}` };
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json", "mcp-protocol-version": "2025-06-18" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const v = await res.json();
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** One parameter of a `WWW-Authenticate: Bearer k="v", …` header. */
export function challengeParam(header: string | null, key: string): string | null {
  if (!header) return null;
  const m = new RegExp(`(?:^|[\\s,])${key}\\s*=\\s*(?:"([^"]*)"|([^\\s,]+))`, "i").exec(header);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** RFC 8414 / OIDC well-known locations for an issuer, path-aware, in the order the MCP spec asks for. */
function asMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const p = u.pathname.replace(/\/+$/, "");
  if (!p) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  return [`${u.origin}/.well-known/oauth-authorization-server${p}`, `${u.origin}/.well-known/openid-configuration${p}`, `${u.origin}${p}/.well-known/openid-configuration`];
}

interface Discovery {
  resource: string;
  scope: string | null;
  as: AuthServer;
}

export async function discover(serverUrl: string): Promise<Discovery> {
  const server = new URL(serverUrl);
  server.hash = "";
  let challenge: string | null = null;
  try {
    const res = await fetch(server, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "trb", version: VERSION } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    challenge = res.headers.get("www-authenticate");
    await res.arrayBuffer().catch(() => {});
  } catch (err: any) {
    throw new UserError(`Could not reach ${serverUrl}: ${err?.cause?.code ?? err?.message ?? err}`);
  }

  const path = server.pathname.replace(/\/+$/, "");
  const prmUrls = [challengeParam(challenge, "resource_metadata"), path ? `${server.origin}/.well-known/oauth-protected-resource${path}` : null, `${server.origin}/.well-known/oauth-protected-resource`].filter((u): u is string => !!u);
  let prm: any = null;
  for (const u of prmUrls) {
    const v = await getJson(u);
    // Only real metadata counts: a server that answers every path with JSON is not advertising OAuth.
    if (v && (Array.isArray(v.authorization_servers) || typeof v.resource === "string")) {
      prm = v;
      break;
    }
  }

  const issuers: string[] = Array.isArray(prm?.authorization_servers) && prm.authorization_servers.length ? prm.authorization_servers.map(String) : [server.origin];
  let meta: any = null;
  for (const issuer of issuers) {
    for (const u of asMetadataUrls(issuer)) if ((meta = await getJson(u))?.authorization_endpoint) break;
    if (meta?.authorization_endpoint) break;
    meta = null;
  }
  // The 2025-03-26 fallback: no metadata at all, the endpoints sit at the server's origin.
  const as: AuthServer = meta
    ? { issuer: String(meta.issuer ?? issuers[0]), authorization_endpoint: String(meta.authorization_endpoint), token_endpoint: String(meta.token_endpoint), registration_endpoint: meta.registration_endpoint ? String(meta.registration_endpoint) : undefined }
    : { issuer: server.origin, authorization_endpoint: `${server.origin}/authorize`, token_endpoint: `${server.origin}/token`, registration_endpoint: `${server.origin}/register` };
  if (!prm && !meta && !challenge) throw new UserError(`${serverUrl} does not ask for OAuth sign-in (no 401 challenge and no OAuth metadata). If it needs a key, add it as a header instead.`);

  const scope = challengeParam(challenge, "scope") ?? (Array.isArray(prm?.scopes_supported) && prm.scopes_supported.length ? prm.scopes_supported.join(" ") : null);
  return { resource: typeof prm?.resource === "string" ? prm.resource : server.toString(), scope, as };
}

/* -------------------------------------------------------------------------- */
/* Client registration and token requests                                     */
/* -------------------------------------------------------------------------- */

async function register(as: AuthServer, redirectUri: string): Promise<Client> {
  if (!as.registration_endpoint) throw new UserError(`The authorization server (${as.issuer}) does not let apps register themselves. Register an OAuth app there with the redirect URI ${redirectUri}, then sign in with its client ID.`);
  let res: Response;
  try {
    res = await fetch(as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_name: "treeboss", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new UserError(`Could not register with ${as.registration_endpoint}: ${err?.message ?? err}`);
  }
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.client_id) throw new UserError(`Client registration at ${as.registration_endpoint} failed (HTTP ${res.status}${body?.error ? `: ${body.error_description ?? body.error}` : ""}). Register an OAuth app with the redirect URI ${redirectUri} and sign in with its client ID.`);
  const method = String(body.token_endpoint_auth_method ?? (body.client_secret ? "client_secret_post" : "none"));
  return { client_id: String(body.client_id), client_secret: body.client_secret ? String(body.client_secret) : undefined, auth_method: method, redirect_uri: redirectUri, registered: true };
}

async function tokenRequest(as: AuthServer, client: Client, params: Record<string, string>): Promise<Tokens> {
  const form = new URLSearchParams(params);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.client_secret && client.auth_method === "client_secret_basic") {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}`;
  } else {
    form.set("client_id", client.client_id);
    if (client.client_secret) form.set("client_secret", client.client_secret);
  }
  const res = await fetch(as.token_endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = Object.fromEntries(new URLSearchParams(text)); // some servers (GitHub) answer form-encoded
  }
  if (!res.ok || !body?.access_token) throw new UserError(`The token request failed (HTTP ${res.status}${body?.error ? `: ${body.error_description ?? body.error}` : ""}).`);
  const ttl = Number(body.expires_in);
  return { access_token: String(body.access_token), refresh_token: body.refresh_token ? String(body.refresh_token) : undefined, expires_at: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : null, scope: body.scope ? String(body.scope) : undefined };
}

/* -------------------------------------------------------------------------- */
/* The sign-in flow                                                           */
/* -------------------------------------------------------------------------- */

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pending = new Map<string, { name: string; verifier: string; redirectUri: string; at: number }>();

function sweep(): void {
  for (const [k, v] of pending) if (Date.now() - v.at > FLOW_TTL_MS) pending.delete(k);
}

/**
 * Start signing in to an http server: discover, register if needed, and return the URL to open in a browser.
 * `redirectUri` is where this daemon answers OAUTH_CALLBACK_PATH. A client id from the operator replaces registration.
 */
export async function beginSignIn(name: string, redirectUri: string, opts: { clientId?: string | null; clientSecret?: string | null } = {}): Promise<{ authorizeUrl: string }> {
  const rec = McpStore.get(name);
  if (!rec) throw new UserError(`No MCP server "${name}".`);
  if (rec.transport !== "http" || !rec.url) throw new UserError(`"${name}" is a stdio server; only http servers sign in with OAuth.`);
  const found = await discover(rec.url);
  const prev = load(name);
  let client: Client | null = null;
  if (opts.clientId?.trim()) client = { client_id: opts.clientId.trim(), client_secret: opts.clientSecret?.trim() || undefined, auth_method: opts.clientSecret?.trim() ? "client_secret_post" : "none", redirect_uri: redirectUri, registered: false };
  // Reuse a client registered with the same authorization server for this redirect; a supplied one is kept until replaced.
  else if (prev?.client && prev.as.issuer === found.as.issuer && (!prev.client.registered || prev.client.redirect_uri === redirectUri)) client = prev.client;
  else client = await register(found.as, redirectUri);
  if (!client.registered) client = { ...client, redirect_uri: redirectUri };

  save({ name, url: rec.url, resource: found.resource, scope: found.scope, as: found.as, client, tokens: prev?.url === rec.url ? prev.tokens : null });

  sweep();
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  pending.set(state, { name, verifier, redirectUri, at: Date.now() });
  const u = new URL(found.as.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", client.client_id);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("resource", found.resource);
  if (found.scope) u.searchParams.set("scope", found.scope);
  return { authorizeUrl: u.toString() };
}

/** The browser came back: trade the code for tokens. Returns the server's name. */
export async function finishSignIn(params: URLSearchParams): Promise<string> {
  sweep();
  const state = params.get("state") ?? "";
  const flow = pending.get(state);
  if (!flow) throw new UserError("This sign-in link has expired or was already used. Start again from Settings > MCP.");
  pending.delete(state);
  const error = params.get("error");
  if (error) throw new UserError(`${flow.name}: the server declined the sign-in (${params.get("error_description") ?? error}).`);
  const code = params.get("code");
  if (!code) throw new UserError(`${flow.name}: the server sent no authorization code.`);
  const row = load(flow.name);
  if (!row?.client) throw new UserError(`${flow.name}: sign-in state is gone. Start again.`);
  const tokens = await tokenRequest(row.as, row.client, { grant_type: "authorization_code", code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, resource: row.resource });
  save({ ...row, tokens });
  return flow.name;
}

const refreshing = new Map<string, Promise<void>>();

/** Refresh a token that is expired or about to be. A refused refresh signs the server out; a network failure leaves it. */
export async function ensureFreshToken(name: string): Promise<void> {
  const row = current(name);
  const t = row?.tokens;
  if (!row || !row.client || !t?.refresh_token || t.expires_at === null || t.expires_at - Date.now() > REFRESH_EARLY_MS) return;
  const inflight = refreshing.get(name);
  if (inflight) return inflight;
  const run = (async () => {
    try {
      const next = await tokenRequest(row.as, row.client!, { grant_type: "refresh_token", refresh_token: t.refresh_token!, resource: row.resource });
      save({ ...row, tokens: { ...next, refresh_token: next.refresh_token ?? t.refresh_token, scope: next.scope ?? t.scope } });
    } catch (err) {
      if (err instanceof UserError) signOut(name);
    } finally {
      refreshing.delete(name);
    }
  })();
  refreshing.set(name, run);
  return run;
}

/** Before a turn: refresh every enabled http server's token that needs it, in parallel. Never throws. */
export async function refreshMcpTokens(names?: string[] | null): Promise<void> {
  const servers = McpStore.list().filter((s) => s.enabled && s.transport === "http" && (!names || names.includes(s.name)));
  await Promise.all(servers.map((s) => ensureFreshToken(s.name).catch(() => {})));
}

/** The page the browser lands on after the server redirects back. */
export function callbackPage(ok: boolean, message: string): Response {
  const esc = message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const html = `<!doctype html><meta charset="utf-8"><title>treeboss</title><body><p>${esc}</p><p>You can close this tab.</p><script>setTimeout(()=>window.close(),${ok ? 1500 : 60000})</script></body>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
