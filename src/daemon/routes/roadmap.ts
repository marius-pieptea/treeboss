/**
 * The Roadmap module over HTTP. `:root` is a root reference (w_… or s_…), like the file API. The roadmap
 * is one markdown file (ROADMAP.md at the root unless the workspace says otherwise); every route reads or
 * edits that file and answers with the new state.
 *
 *   GET    /api/roadmap/:root                         state: lanes, items, progress, links, sessions, rev
 *   POST   /api/roadmap/:root/create                  { project? }  write the template (never replaces a file)
 *   PUT    /api/roadmap/:root/prefs                   { path }  where the roadmap lives (workspace-relative .md)
 *   GET    /api/roadmap/:root/choices                 specs/ folders and docs files a link can point at
 *   POST   /api/roadmap/:root/items                   { lane, title, description?, tags?, spec?, docs?, target?, index?, rev? }
 *   PATCH  /api/roadmap/:root/items/:id               { title?, done?, description?, tags?, spec?, docs?, target?, rev? }
 *   POST   /api/roadmap/:root/items/:id/move          { lane, index?, rev? }
 *   DELETE /api/roadmap/:root/items/:id?rev=
 *   POST   /api/roadmap/:root/items/:id/start         { kind: spec|build, engine?, model?, effort?, agent?, pairId?, isolate?, sessionId? }
 *   POST   /api/roadmap/:root/lanes                   { name, rev? }
 *   POST   /api/roadmap/:root/lanes/rename            { from, to, rev? }
 *   POST   /api/roadmap/:root/lanes/delete            { name, rev? }   (only an empty lane)
 *
 * `rev` is optional optimistic concurrency: if the file changed since that rev, the edit is refused (409).
 */
import { resolveRoot } from "../../workspaces";
import { getSession, viewSession } from "../../sessions/manager";
import { addRoadmapItem, addRoadmapLane, createRoadmap, deleteRoadmapItem, deleteRoadmapLane, listDocChoices, listSpecChoices, moveRoadmapItem, readRoadmap, renameRoadmapLane, RoadmapConflict, roadmapPath, setRoadmapPath, updateRoadmapItem } from "../../roadmap/store";
import { startFromItem } from "../../roadmap/sessions";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
/** A field the caller may clear: undefined = leave, "" or null = clear. */
const nullable = (b: Record<string, any>, k: string): string | null | undefined => (k in b ? str(b[k]) : undefined);

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RoadmapConflict) throw new HttpError(409, e.message);
    throw e;
  }
}

export const roadmapRoutes: RouteModule = async (c: Ctx) => {
  const m = c.match(/^\/api\/roadmap\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const dir = resolveRoot(m[1]!).dir;
  const rest = m[2] ?? "";
  const rev = str(c.body.rev) ?? c.q("rev");

  if (rest === "" && c.method === "GET") return json({ roadmap: readRoadmap(dir) });
  if (rest === "create" && c.method === "POST") return json({ roadmap: guard(() => createRoadmap(dir, str(c.body.project))) }, 201);
  if (rest === "prefs" && c.method === "PUT") {
    setRoadmapPath(dir, String(c.body.path ?? ""));
    return json({ roadmap: readRoadmap(dir) });
  }
  if (rest === "choices" && c.method === "GET") return json({ specs: listSpecChoices(dir), docs: listDocChoices(dir), path: roadmapPath(dir) });

  if (rest === "items" && c.method === "POST") {
    const b = c.body;
    const r = guard(() =>
      addRoadmapItem(
        dir,
        { lane: String(b.lane ?? ""), title: String(b.title ?? ""), description: typeof b.description === "string" ? b.description : undefined, tags: strs(b.tags ?? b.tag), spec: str(b.spec), docs: str(b.docs), target: str(b.target), done: b.done === true, index: typeof b.index === "number" ? b.index : null },
        rev,
      ),
    );
    return json({ roadmap: r.state, id: r.id }, 201);
  }

  let im: RegExpMatchArray | null;
  if ((im = rest.match(/^items\/([^/]+)$/))) {
    const key = decodeURIComponent(im[1]!);
    if (c.method === "PATCH") {
      const b = c.body;
      const patch: Record<string, unknown> = {};
      if ("title" in b) patch.title = String(b.title ?? "");
      if ("done" in b) patch.done = b.done === true;
      if ("description" in b) patch.description = String(b.description ?? "");
      if ("tags" in b || "tag" in b) patch.tags = strs(b.tags ?? b.tag) ?? [];
      for (const k of ["spec", "docs", "target"] as const) {
        const v = nullable(b, k);
        if (v !== undefined) patch[k] = v;
      }
      const r = guard(() => updateRoadmapItem(dir, key, patch, rev));
      return json({ roadmap: r.state, id: r.id });
    }
    if (c.method === "DELETE") return json({ roadmap: guard(() => deleteRoadmapItem(dir, key, rev)).state });
  }
  if ((im = rest.match(/^items\/([^/]+)\/move$/)) && c.method === "POST") {
    const r = guard(() => moveRoadmapItem(dir, decodeURIComponent(im![1]!), String(c.body.lane ?? ""), typeof c.body.index === "number" ? c.body.index : null, rev));
    return json({ roadmap: r.state, id: r.id });
  }
  if ((im = rest.match(/^items\/([^/]+)\/start$/)) && c.method === "POST") {
    const b = c.body;
    const { session, itemId } = guard(() =>
      startFromItem(dir, decodeURIComponent(im![1]!), b.kind === "build" ? "build" : "spec", {
        engine: str(b.engine),
        model: str(b.model),
        effort: str(b.effort),
        agent: str(b.agent),
        pairId: str(b.pairId ?? b.pair_id),
        isolate: b.isolate === true,
        sessionId: str(b.sessionId ?? b.session_id),
      }),
    );
    return json({ session: viewSession(getSession(session.id)!, { withOutput: false }), id: itemId, roadmap: readRoadmap(dir) }, 201);
  }

  if (rest === "lanes" && c.method === "POST") return json({ roadmap: guard(() => addRoadmapLane(dir, String(c.body.name ?? ""), rev)) }, 201);
  if (rest === "lanes/rename" && c.method === "POST") return json({ roadmap: guard(() => renameRoadmapLane(dir, String(c.body.from ?? ""), String(c.body.to ?? ""), rev)) });
  if (rest === "lanes/delete" && c.method === "POST") return json({ roadmap: guard(() => deleteRoadmapLane(dir, String(c.body.name ?? ""), rev)) });

  throw new HttpError(404, `No roadmap route ${c.method} ${c.path}.`);
};
