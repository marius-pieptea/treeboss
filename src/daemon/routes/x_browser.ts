/**
 * Agent browser API: the live view's data and the operator's take-over controls.
 *
 *   GET  /api/browser/status                  is there a Chrome, and which
 *   GET  /api/browser/:session/state          what the browser is showing (never launches one)
 *   GET  /api/browser/:session/screenshot     the current viewport as a JPEG
 *   GET  /api/browser/:session/stream         SSE: a `state` event whenever the picture or the status changed
 *   POST /api/browser/:session/input          click / scroll / type / key / navigate / back / reload
 *   POST /api/browser/:session/close          close it
 *   POST /api/browser/:session/forget-signins forget the saved logins of this session's project, and clear the open browsers' cookies
 *
 * `:session` is any session id; it resolves to the root of its tree, which is whose browser it is.
 */
import { browserStatus } from "../../browser/chrome";
import { getSetting } from "../../settings";
import { BrowserError, captureFrame, closeBrowser, forgetSignins, getContext, peekState, rootOf, stateOf, watch } from "../../browser/manager";
import { userInput } from "../../browser/input";
import { getSession } from "../../sessions/manager";
import { HttpError, json, type RouteModule } from "../http";

/**
 * Follow a browser's state: a `state` event whenever the picture or the status changed (bursts coalesced to one
 * per ~100ms), `closed` when it goes away. Shared by the SSE endpoint and the multiplexed live socket.
 */
export function followBrowser(session: string, emit: (event: string, data: unknown) => void): () => void {
  const root = rootOf(session);
  let stopped = false;
  let pending = false;
  let unwatch: () => void = () => {};
  unwatch = watch(session, (s) => {
    if (stopped) return;
    if (!s.url && !s.tabs.length) {
      emit("closed", { rootId: root });
      stopped = true;
      unwatch();
      return;
    }
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (!stopped) void stateOf(session).then((fresh) => fresh && !stopped && emit("state", fresh));
    }, 100);
  }) ?? (() => {});
  void stateOf(session).then((s) => s && !stopped && emit("state", s));
  return () => {
    stopped = true;
    unwatch();
  };
}

export const browserExtRoutes: RouteModule = async (c) => {
  if (c.path === "/api/browser/status" && c.method === "GET") return json({ ...(await browserStatus()), enabled: getSetting("agent_browser") === "on" });

  const m = c.match(/^\/api\/browser\/([^/]+)\/(state|screenshot|stream|input|close|forget-signins)$/);
  if (!m) return null;
  const [, session, op] = m;
  const root = rootOf(session);
  if (!root) throw new HttpError(404, `No session "${session}".`);

  try {
    if (op === "state" && c.method === "GET") {
      const state = await stateOf(session);
      return json(state ?? { open: false, rootId: root });
    }

    if (op === "screenshot" && c.method === "GET") {
      if (!peekState(session)) throw new HttpError(404, "No browser is open for this session yet.");
      const ctx = await getContext(session);
      const frame = await captureFrame(ctx);
      return new Response(new Uint8Array(frame.buf), { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-frame-seq": String(frame.seq) } });
    }

    if (op === "input" && c.method === "POST") {
      await userInput(session, c.body as any);
      return json({ ok: true });
    }

    if (op === "forget-signins" && c.method === "POST") {
      const dir = getSession(session)!.base_cwd;
      await forgetSignins(dir);
      return json({ ok: true });
    }

    if (op === "close" && c.method === "POST") return json({ closed: await closeBrowser(root, "closed by the operator") });

    if (op === "stream" && c.method === "GET") {
      if (!peekState(session)) throw new HttpError(404, "No browser is open for this session yet.");
      const enc = new TextEncoder();
      let stop: (() => void) | null = null;
      let beat: ReturnType<typeof setInterval> | null = null;
      const stream = new ReadableStream({
        start(controller) {
          let closed = false;
          const emit = (event: string, data: unknown) => {
            if (closed) return;
            try {
              controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch {
              closed = true;
            }
            if (event === "closed") {
              closed = true;
              try {
                controller.close();
              } catch {}
            }
          };
          stop = followBrowser(session, emit);
          beat = setInterval(() => emit("ping", { t: Date.now() }), 15_000);
          c.req.signal.addEventListener("abort", () => {
            closed = true;
            stop?.();
            if (beat) clearInterval(beat);
          });
        },
        cancel() {
          stop?.();
          if (beat) clearInterval(beat);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
    }
  } catch (err) {
    if (err instanceof BrowserError) throw new HttpError(400, err.message);
    throw err;
  }
  return null;
};
