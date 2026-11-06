/**
 * Run panel and preview inspection API.
 *
 *   GET  /api/run?root=            what is detected (services, database tasks, env KEYS) and what is running
 *   POST /api/run/{start,stop,restart}   { root, service }
 *   GET  /api/run/logs?root&service&since    log lines after a cursor
 *   POST /api/preview/proxy        { port } -> { port }: the inspecting proxy in front of a dev server
 *   GET  /api/preview/issues?port&level&clear   console errors and failed requests
 *   POST /api/preview/pick         { url, pick } -> the text for the composer, plus a screenshot when possible
 *
 * `root` is a workspace (w_…) or session (s_…) ref, so a head's worktree is its own project: its own
 * instances, its own port.
 */
import fs from "fs";
import { detect } from "../../devserver/detect";
import { RunError, installRunHooks, listInstances, readLogs, restartService, startService, stopService } from "../../devserver/manager";
import { ensureProxy } from "../../preview/proxy";
import { issueCount, readIssues } from "../../preview/issues";
import { formatPick, sanitizePick } from "../../preview/picks";
import { shootElement } from "../../preview/shot";
import { getSession } from "../../sessions/manager";
import { owningWorkspace, resolveRoot } from "../../workspaces";
import { HttpError, json, type RouteModule } from "../http";

function loopbackPort(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new HttpError(400, "A port between 1 and 65535 is required.");
  return n;
}

export const devserverRoutes: RouteModule = async (c) => {
  if (c.path !== "/api/run" && !c.path.startsWith("/api/run/") && !c.path.startsWith("/api/preview/")) return null;
  installRunHooks();

  try {
    if (c.path === "/api/run" && c.method === "GET") {
      const root = resolveRoot(c.q("root") ?? "");
      const real = fs.realpathSync(root.dir);
      return json({ root: root.ref, dir: real, detected: detect(real), instances: listInstances(real) });
    }

    let m: RegExpMatchArray | null;
    if ((m = c.match(/^\/api\/run\/(start|stop|restart)$/)) && c.method === "POST") {
      const root = resolveRoot(String(c.body.root ?? ""));
      const service = String(c.body.service ?? "");
      if (!service) throw new HttpError(400, "service is required.");
      // A session worktree lives outside its workspace folder: name the workspace from the session's base folder.
      const base = root.kind === "session" ? getSession(root.ref)?.base_cwd : null;
      const workspaceId = (base ? owningWorkspace(base) : null) ?? undefined;
      const input = { rootDir: root.dir, owner: root.ref, service, workspaceId };
      if (m[1] === "stop") return json({ instance: stopService(root.dir, service) });
      return json({ instance: m[1] === "start" ? await startService(input) : await restartService(input) });
    }

    if (c.path === "/api/run/logs" && c.method === "GET") {
      const root = resolveRoot(c.q("root") ?? "");
      const since = Number(c.q("since") ?? 0) || 0;
      const real = fs.realpathSync(root.dir);
      return json(readLogs(real, c.q("service") ?? "", since));
    }

    if (c.path === "/api/preview/proxy" && c.method === "POST") return json(ensureProxy(loopbackPort(c.body.port)));

    if (c.path === "/api/preview/issues" && c.method === "GET") {
      const port = loopbackPort(c.q("port"));
      return json({ issues: readIssues(port, { level: c.q("level") ?? undefined, clear: c.q("clear") === "1" }), count: issueCount(port) });
    }

    if (c.path === "/api/preview/pick" && c.method === "POST") {
      const url = String(c.body.url ?? "");
      const clean = sanitizePick(c.body.pick, url);
      if (!clean.selector) throw new HttpError(400, "pick.selector is required.");
      const shot = c.body.screenshot === false ? { error: "turned off" } : await shootElement({ url, selector: clean.selector, viewport: clean.viewport });
      const pick = { ...clean, screenshot: "path" in shot ? shot.path : null, screenshotNote: "error" in shot ? shot.error : null };
      let thumbnail: string | null = null;
      if (pick.screenshot) {
        try {
          const buf = fs.readFileSync(pick.screenshot);
          if (buf.length < 400_000) thumbnail = `data:image/png;base64,${buf.toString("base64")}`;
        } catch {}
      }
      return json({ text: formatPick(pick), pick, thumbnail });
    }
  } catch (err) {
    if (err instanceof RunError) throw new HttpError(400, err.message);
    throw err;
  }
  return null;
};
