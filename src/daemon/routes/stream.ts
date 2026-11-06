/**
 * One SSE stream of every session's state changes (no log lines unless `logs=1`). The CLI uses this; the web UI uses
 * the live socket. Each event carries an `id:` (the feed's sequence); a reconnect sends `Last-Event-ID` (or
 * `?lastEventId=`) and gets what it missed, or a `reset` when that is no longer kept.
 */
import { followGlobal } from "../live";
import { parseLastEventId } from "../global-feed";
import { type RouteModule } from "../http";

export const streamRoutes: RouteModule = (c) => {
  if (c.path !== "/api/stream" || c.method !== "GET") return null;
  const enc = new TextEncoder();
  let stop: (() => void) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  const lastEventId = parseLastEventId(c.req.headers.get("last-event-id") ?? c.q("lastEventId"));
  const stream = new ReadableStream({
    start(controller) {
      const emit = (event: string, data: unknown, id?: number) => {
        try {
          controller.enqueue(enc.encode(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      stop = followGlobal(c.q("logs") === "1", emit, lastEventId);
      beat = setInterval(() => emit("ping", { t: Date.now() }), 15_000);
      c.req.signal.addEventListener("abort", () => {
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
};
