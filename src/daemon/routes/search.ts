/** Session search and replay API. */
import { exportHtml } from "../../search/export";
import { replaySession, searchTranscripts } from "../../search/index";
import { Workspaces } from "../../workspaces";
import { HttpError, json, type RouteModule } from "../http";

export const searchRoutes: RouteModule = (c) => {
  let m: RegExpMatchArray | null;

  if (c.path === "/api/search/sessions" && c.method === "GET") {
    // `workspace` is a workspace id (w_…) or a directory.
    const ws = c.q("workspace");
    const dir = ws ? (ws.startsWith("w_") ? (Workspaces.get(ws)?.path ?? "\0none") : ws) : null;
    const r = searchTranscripts(c.q("q") ?? "", { workspace: dir, engine: c.q("engine"), since: c.q("since"), until: c.q("until"), limit: Number(c.q("limit") ?? 40) || 40 });
    return json(r);
  }

  if ((m = c.match(/^\/api\/search\/sessions\/([^/]+)\/replay$/)) && c.method === "GET") {
    const r = replaySession(m[1]);
    if (!r) throw new HttpError(404, "No such session.");
    return json(r);
  }

  if ((m = c.match(/^\/api\/search\/sessions\/([^/]+)\/export\.html$/)) && c.method === "GET") {
    const r = replaySession(m[1]);
    if (!r) throw new HttpError(404, "No such session.");
    const name = `session-${m[1]}.html`;
    return new Response(exportHtml(r, { exportedAt: new Date().toISOString().slice(0, 10) }), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        // Defence in depth: the file is script-free, and this keeps even an inline preview inert.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return null;
};
