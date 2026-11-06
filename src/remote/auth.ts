/**
 * The remote side of authentication: reading a remote token off a request, the origin rule for remote
 * cookies, the /_pair page, and the registry of open sockets so a revoked token's connections are cut.
 */
import { HEADERS } from "../daemon/ui";
import { isRemoteOn } from "./hosts";
import { peekPairCode, pairRateCheck, redeemPairCode } from "./pairing";
import { mintToken, tokenIsLive, verifyToken, type RemoteToken } from "./store";

export const REMOTE_COOKIE = "trb_remote";

export type RemotePrincipal = { kind: "remote"; id: string; label: string };
export type OwnerPrincipal = { kind: "owner"; via: "bearer" | "cookie" };
export type Principal = OwnerPrincipal | RemotePrincipal;

function remoteCookieFrom(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === REMOTE_COOKIE) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A remote token from the cookie or a bearer header. Refused outright while remote access is off. */
export function authenticateRemote(req: Request, peer: string | null): RemotePrincipal | null {
  if (!isRemoteOn()) return null;
  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : remoteCookieFrom(req);
  if (!presented) return null;
  const rec: RemoteToken | null = verifyToken(presented, { ip: peer });
  return rec ? { kind: "remote", id: rec.id, label: rec.label } : null;
}

/**
 * Same-origin rule for a remote cookie: a browser tells us which page made the request (Origin); it must be
 * this very host. Absent Origin (not a cross-page browser request) is let through, as for the owner cookie.
 */
export function remoteOriginOk(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === (req.headers.get("host") ?? "").toLowerCase();
  } catch {
    return false;
  }
}

/* ------------------------------ open sockets ------------------------------ */

interface Closable {
  close(code?: number, reason?: string): void;
}
const sockets = new Map<string, Set<Closable>>();

export function trackSocket(tokenId: string, ws: Closable): void {
  let set = sockets.get(tokenId);
  if (!set) sockets.set(tokenId, (set = new Set()));
  set.add(ws);
}
export function untrackSocket(tokenId: string, ws: Closable): void {
  const set = sockets.get(tokenId);
  set?.delete(ws);
  if (set && set.size === 0) sockets.delete(tokenId);
}
export function closeSocketsFor(tokenId: string, reason = "Device revoked."): void {
  for (const ws of [...(sockets.get(tokenId) ?? [])]) {
    try {
      ws.close(4401, reason);
    } catch {}
  }
  sockets.delete(tokenId);
}
export function closeAllRemoteSockets(reason = "Remote access is off."): void {
  for (const id of [...sockets.keys()]) closeSocketsFor(id, reason);
}
/** Close the sockets of tokens that were revoked or expired, or all of them when remote access went off. */
export function sweepSockets(): void {
  if (!isRemoteOn()) return closeAllRemoteSockets();
  for (const id of [...sockets.keys()]) if (!tokenIsLive(id)) closeSocketsFor(id, "Session ended.");
}
export function openSocketCount(): number {
  let n = 0;
  for (const s of sockets.values()) n += s.size;
  return n;
}

/* --------------------------------- /_pair --------------------------------- */

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Pair device</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0b0d10;color:#e6edf3}main{max-width:26rem}h1{font-size:20px;margin:0 0 8px}p{color:#9aa4ae;margin:8px 0}button{font:inherit;width:100%;padding:14px;border:0;border-radius:10px;background:#7aa2f7;color:#0b0d10;font-weight:600;margin-top:16px}</style></head><body><main>${body}</main></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...HEADERS, ...extra },
  });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function deviceLabel(ua: string | null): string {
  const u = ua ?? "";
  const os = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android" : /Macintosh/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "Device";
  const br = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) || /CriOS/.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "";
  return br ? `${os} ${br}` : os;
}

/**
 * GET shows a confirm button (a link preview or prefetch cannot spend the code); POST spends it and sets the
 * cookie. Both count against the rate limit, and both are 404 while remote access is off.
 */
export async function handlePair(req: Request, url: URL, peer: string | null, secure: boolean): Promise<Response> {
  if (!isRemoteOn()) return new Response("Not found", { status: 404, headers: HEADERS });
  if (req.method !== "GET" && req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: HEADERS });
  const rate = pairRateCheck(peer ?? "");
  if (!rate.ok) return html(`<h1>Too many attempts</h1><p>Try again in ${rate.retryAfterSec} seconds.</p>`, 429, { "retry-after": String(rate.retryAfterSec) });

  const gone = () => html(`<h1>This pairing link has expired</h1><p>Codes work once and last two minutes. Ask for a new QR code on the computer.</p>`, 410);

  if (req.method === "GET") {
    const code = url.searchParams.get("code") ?? "";
    if (!code || code.length > 200 || !peekPairCode(code)) return gone();
    return html(`<h1>Pair this device?</h1><p>It will be able to watch sessions, approve plans, send follow-ups and stop turns on this computer, until you revoke it in Settings.</p><form method="post" action="/_pair"><input type="hidden" name="code" value="${escapeHtml(code)}"><button type="submit">Pair this device</button></form>`);
  }

  // The code in the body is the credential, so this is not a CSRF surface. A browser sends `Origin: null` for a form post
  // from a page served with Referrer-Policy: no-referrer, so "null" passes; a real, different origin does not.
  if (req.headers.get("origin") !== "null" && !remoteOriginOk(req)) return html(`<h1>Refused</h1><p>Cross-origin request.</p>`, 403);
  let code = "";
  try {
    const ct = req.headers.get("content-type") ?? "";
    const text = await req.text();
    if (text.length > 2000) return gone();
    code = ct.includes("json") ? String(JSON.parse(text)?.code ?? "") : (new URLSearchParams(text).get("code") ?? "");
  } catch {}
  const spent = code && code.length <= 200 ? redeemPairCode(code) : null;
  if (!spent) return gone();

  const ua = req.headers.get("user-agent");
  const { token, record } = mintToken({ label: spent.label || deviceLabel(ua), ip: peer, userAgent: ua });
  const maxAge = Math.max(60, Math.floor((Date.parse(record.expires_at) - Date.now()) / 1000));
  const cookie = `${REMOTE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  return new Response(null, { status: 303, headers: { location: "/remote", "set-cookie": cookie, "cache-control": "no-store", ...HEADERS } });
}
