/**
 * A loopback reverse proxy for ONE dev-server port, used when the operator turns on Inspect in the preview.
 *
 * Why it exists: the preview iframe is cross-origin, so the app cannot look inside it. Serving the page
 * through here lets us add one script (see inspector.ts) that reports console errors and handles picking.
 *
 * Safety:
 *  - the target is a fixed loopback port chosen when the proxy is created; there is no way to ask it for
 *    anything else (no SSRF, no open relay);
 *  - it is a separate listener, not a path on the daemon, and the app asks the browser to open it on the
 *    OTHER loopback name than the app, so the signed-in session cookie is never sent to it;
 *  - the daemon API is not reachable through it: only what the dev server itself serves, plus /__trb/*.
 */
import { INSPECTOR_JS, INSPECTOR_PATH, LOG_PATH } from "./inspector";
import { recordIssues } from "./issues";

const MAX_PROXIES = 8;
const MAX_LOG_BODY = 64 * 1024;

interface Proxy {
  target: number;
  port: number;
  server: ReturnType<typeof Bun.serve>;
}

interface WsData {
  target: number;
  path: string;
  protocols: string[];
  up: WebSocket | null;
  queue: Array<string | Buffer | ArrayBuffer | Uint8Array>;
}

const proxies = new Map<number, Proxy>();

const DROP_REQ = new Set(["host", "connection", "accept-encoding", "content-length", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "cookie2"]);
const DROP_RES = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "x-frame-options", "keep-alive"]);

/** Remove only the frame-ancestors directive: the rest of the page's CSP stays. */
export function relaxCsp(value: string): string | null {
  const kept = value
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors\b/i.test(d));
  return kept.length ? kept.join("; ") : null;
}

/** Put the inspector script tag into an HTML document: after <head>, else at the very top. */
export function injectInspector(html: string): string {
  const tag = `<script src="${INSPECTOR_PATH}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + tag + html.slice(doctype[0].length);
  return tag + html;
}

async function forward(target: number, req: Request, url: URL): Promise<Response> {
  const headers = new Headers();
  for (const [k, v] of req.headers) if (!DROP_REQ.has(k.toLowerCase())) headers.set(k, v);
  // The dev server believes it is being used directly.
  const self = `http://localhost:${target}`;
  if (headers.has("origin")) headers.set("origin", self);
  if (headers.has("referer")) headers.set("referer", self + "/");
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  let lastErr: unknown;
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      return await fetch(`http://${host}:${target}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: "manual" });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function handle(target: number, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === INSPECTOR_PATH) return new Response(INSPECTOR_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
  if (url.pathname === LOG_PATH && req.method === "POST") {
    const text = await req.text();
    if (text.length > MAX_LOG_BODY) return new Response("too large", { status: 413 });
    try {
      recordIssues(target, JSON.parse(text)?.entries);
    } catch {}
    return new Response(null, { status: 204 });
  }

  let up: Response;
  try {
    up = await forward(target, req, url);
  } catch {
    return new Response(`<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:2em;color:#555">Could not reach the dev server on port ${target}. Is it running?</body>`, { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const headers = new Headers();
  for (const [k, v] of up.headers) {
    const lk = k.toLowerCase();
    if (DROP_RES.has(lk)) continue;
    if (lk === "content-security-policy") {
      const relaxed = relaxCsp(v);
      if (relaxed) headers.set(k, relaxed);
      continue;
    }
    if (lk === "location") {
      // Keep redirects inside the proxy.
      headers.set(k, v.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${target}`), ""));
      continue;
    }
    if (lk === "set-cookie") {
      headers.append(k, v.replace(/;\s*domain=[^;]*/i, ""));
      continue;
    }
    headers.set(k, v);
  }
  const type = up.headers.get("content-type") ?? "";
  if (/text\/html/i.test(type) && req.method !== "HEAD") {
    const html = await up.text();
    headers.set("cache-control", "no-store");
    return new Response(injectInspector(html), { status: up.status, headers });
  }
  return new Response(req.method === "HEAD" ? null : up.body, { status: up.status, headers });
}

export function ensureProxy(target: number): { port: number } {
  if (!Number.isInteger(target) || target < 1 || target > 65535) throw new Error("Bad port.");
  const have = proxies.get(target);
  if (have) return { port: have.port };
  if (proxies.size >= MAX_PROXIES) {
    const oldest = proxies.keys().next().value as number;
    proxies.get(oldest)?.server.stop(true);
    proxies.delete(oldest);
  }
  const server = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const u = new URL(req.url);
        const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (srv.upgrade(req, { data: { target, path: u.pathname + u.search, protocols, up: null, queue: [] } satisfies WsData, headers: protocols.length ? { "sec-websocket-protocol": protocols[0] } : undefined })) return undefined as unknown as Response;
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      try {
        return await handle(target, req);
      } catch (err: any) {
        return new Response(`Preview proxy error: ${err?.message ?? err}`, { status: 502 });
      }
    },
    websocket: {
      open(ws) {
        const d = ws.data;
        // Like the HTTP side: dev servers (Vite binds "localhost", often IPv6 only) may not listen on 127.0.0.1.
        // Without the fallback the page's HMR socket never opens and Vite's client reloads the page in a loop.
        const connect = (hosts: string[]) => {
          const up = new WebSocket(`ws://${hosts[0]}:${d.target}${d.path}`, { protocols: d.protocols, headers: { origin: `http://localhost:${d.target}` } } as any);
          up.binaryType = "arraybuffer";
          d.up = up;
          let opened = false;
          up.onopen = () => {
            opened = true;
            for (const m of d.queue.splice(0)) up.send(m as any);
          };
          up.onmessage = (e) => ws.send(e.data as any);
          let handled = false;
          const fail = () => {
            if (handled) return; // error and close both fire for one failed attempt
            handled = true;
            if (!opened && hosts.length > 1) connect(hosts.slice(1));
            else ws.close();
          };
          up.onclose = fail;
          up.onerror = fail;
        };
        connect(["127.0.0.1", "[::1]"]);
      },
      message(ws, m) {
        const up = ws.data.up;
        if (up && up.readyState === WebSocket.OPEN) up.send(m as any);
        else ws.data.queue.push(m as any);
      },
      close(ws) {
        try {
          ws.data.up?.close();
        } catch {}
      },
    },
  });
  proxies.set(target, { target, port: server.port as number, server });
  return { port: server.port as number };
}

export function stopProxies(): void {
  for (const p of proxies.values()) p.server.stop(true);
  proxies.clear();
}

/** Which dev-server port a proxy port fronts (for routes that receive the proxied URL). */
export function targetOfProxy(port: number): number | null {
  for (const p of proxies.values()) if (p.port === port) return p.target;
  return null;
}
