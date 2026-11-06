/**
 * The web UI's delivery and sign-in.
 *
 * The built app (web/dist) is plain static files, served without auth: it contains no secrets. What is
 * protected is the API. A browser gets in through a one-time ticket: `trb ui` asks the daemon for one
 * (over the bearer-authenticated API), opens `/_auth?ticket=…`, and the daemon trades it for an HttpOnly,
 * SameSite=Strict cookie holding the session token. The token itself never appears in a URL or in page
 * script.
 */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

export const COOKIE = "trb_session";
const TICKET_TTL_MS = 60_000;
const tickets = new Map<string, number>();

export function mintTicket(): string {
  const now = Date.now();
  for (const [t, exp] of tickets) if (exp < now) tickets.delete(t);
  const ticket = randomBytes(24).toString("hex");
  tickets.set(ticket, now + TICKET_TTL_MS);
  return ticket;
}

/** Single use: a replayed URL (browser history, a screenshot) is worthless. */
export function redeemTicket(ticket: string): boolean {
  const exp = tickets.get(ticket);
  tickets.delete(ticket);
  return exp !== undefined && exp >= Date.now();
}

export function cookieFrom(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`;
}

export function webRoot(): string {
  if (process.env.TRB_WEB_DIR) return path.resolve(process.env.TRB_WEB_DIR);
  // The installed trb.exe lives in resources/bin and the UI in resources/web, so a `trb` on PATH finds it without TRB_WEB_DIR.
  const beside = path.resolve(path.dirname(process.execPath), "..", "web");
  if (fs.existsSync(path.join(beside, "index.html"))) return beside;
  return path.resolve(import.meta.dir, "..", "..", "web", "dist");
}

export function uiBuilt(): boolean {
  return fs.existsSync(path.join(webRoot(), "index.html"));
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  // The browser panel previews dev servers on this machine, and the web.
  "frame-src http://127.0.0.1:* http://localhost:* https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const HEADERS = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
};

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>trb</title><body style="font:15px system-ui;background:#0b0d10;color:#c9d1d9;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:34rem"><h1 style="font-weight:600">The UI is not built yet</h1><p>The daemon is running, but <code>web/dist</code> does not exist.</p><pre style="background:#161b22;padding:1rem;border-radius:8px">bun run build:web</pre><p style="opacity:.7">Then reload this page.</p></div>`;

/** Serve a built asset, or `index.html` for any other path (client-side routes). */
export function serveStatic(pathname: string, host?: string): Response {
  // Reached through a LAN address or a tailnet name (the daemon only admits those while remote_mode is lan or tailscale):
  // the page's own socket needs that origin in connect-src, since not every browser reads 'self' as ws://.
  const remoteHost = host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host) && /^[A-Za-z0-9.:-]+$/.test(host) ? host : null;
  const headers = remoteHost ? { ...HEADERS, "content-security-policy": CSP.replace("connect-src 'self'", `connect-src 'self' ws://${remoteHost} wss://${remoteHost}`) } : HEADERS;
  if (!uiBuilt()) return new Response(NOT_BUILT, { status: 503, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
  const root = webRoot();
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const abs = path.resolve(root, rel);
  let file = abs;
  const inside = abs === root || abs.startsWith(root + path.sep);
  const isFile = inside && fs.existsSync(abs) && fs.statSync(abs).isFile();
  const isAsset = path.extname(rel) !== "";
  if (!isFile) {
    // A missing asset is a 404, not the app shell: a broken script URL must not come back as HTML.
    if (isAsset) return new Response("Not found", { status: 404, headers });
    file = path.join(root, "index.html");
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const hashed = file.includes(`${path.sep}assets${path.sep}`);
  return new Response(Bun.file(file), {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      ...headers,
    },
  });
}
