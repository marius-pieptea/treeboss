/**
 * The Docs module over HTTP. `:root` is a root reference (w_… or s_…), like the file API; paths are
 * relative to it and limited to the workspace's docs folder (`docs/` unless set).
 *
 *   GET    /api/docs/:root                          overview: pages with front matter and freshness, HEAD
 *   GET    /api/docs/:root/rev                      { rev, head }: cheap, for polling
 *   PUT    /api/docs/:root/dir                      { dir | null }  where the docs folder is (workspaces only)
 *   POST   /api/docs/:root/folder                   { project? }  create the docs folder with an index page
 *   GET    /api/docs/:root/page?path=               read a page, with its freshness and backlinks
 *   PUT    /api/docs/:root/page                     { path, content, expectedMtime?, create? }
 *   POST   /api/docs/:root/pages                    { path?, title?, kind? }  new page or decision record
 *   POST   /api/docs/:root/page/current             { path }  record that the page is current as of HEAD
 *   POST   /api/docs/:root/generate                 { kind, page?, pages?, stale?, input?, engine?, model?, … }
 *   POST   /api/docs/:root/generate/preview         the same body: what would run, nothing started
 *   GET    /api/docs/:root/runs/:session            what a generation run changed, and what is wrong with it
 *   GET    /api/docs/:root/estimate?path=&mode=     token estimate of attaching a page
 *   GET    /api/sessions/:id/docs                   what a session has attached, with its cost
 *   POST   /api/sessions/:id/docs                   { path, mode? }
 *   DELETE /api/sessions/:id/docs?path=
 */
import { resolveRoot } from "../../workspaces";
import { getSession, viewSession } from "../../sessions/manager";
import { attach, detach, estimatePath, estimateSession, listAttached, type DocAttachMode } from "../../docs/attach";
import { backlinksFor } from "../../docs/backlinks";
import { type GenerateOpts, getRun, planRun, startGeneration, withStaleness } from "../../docs/generate";
import { headSha, pageStaleness } from "../../docs/staleness";
import { createDocsFolder, createPage, docsDirOf, listPages, markCurrent, overview, readPage, setDocsDir, writePage } from "../../docs/store";
import { GEN_KINDS } from "../../docs/prompts";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function genOpts(body: Record<string, any>): GenerateOpts {
  const kind = String(body.kind ?? "");
  if (!GEN_KINDS.includes(kind as any)) throw new HttpError(400, `Unknown kind "${kind}". Kinds: ${GEN_KINDS.join(", ")}.`);
  return {
    kind: kind as GenerateOpts["kind"],
    page: str(body.page),
    pages: Array.isArray(body.pages) ? body.pages.map(String) : null,
    stale: body.stale === true,
    input: str(body.input),
    engine: str(body.engine),
    model: str(body.model),
    effort: str(body.effort),
    agent: str(body.agent),
    pairId: str(body.pairId ?? body.pair_id),
    sessionId: str(body.sessionId ?? body.session_id),
    planFirst: body.planFirst === true || body.plan_first === true,
  };
}

const view = (id: string) => viewSession(getSession(id)!, { withOutput: false });

const sessionRoutes: RouteModule = async (c: Ctx) => {
  const m = c.match(/^\/api\/sessions\/([^/]+)\/docs$/);
  if (!m) return null;
  const s = getSession(m[1]);
  if (!s) throw new HttpError(404, `No session "${m[1]}".`);
  if (c.method === "GET") return json({ attached: listAttached(s.id).filter((a) => a.purpose === "context"), estimate: await estimateSession(s.id) });
  if (c.method === "POST") {
    const mode = (c.body.mode ?? "ref") as DocAttachMode;
    const a = attach(s.id, String(c.body.path ?? ""), { mode });
    return json({ attached: a, estimate: await estimateSession(s.id) }, 201);
  }
  if (c.method === "DELETE") return json({ removed: detach(s.id, c.q("path") ?? ""), estimate: await estimateSession(s.id) });
  return null;
};

export const docsRoutes: RouteModule = async (c) => {
  const sess = await sessionRoutes(c);
  if (sess) return sess;

  const m = c.match(/^\/api\/docs\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const ref = m[1];
  const root = resolveRoot(ref);
  const rest = m[2] ?? "";
  const rootDir = root.dir;
  const wsId = root.kind === "workspace" ? ref : null;
  const { dir: docsDir, custom } = docsDirOf(wsId);

  if (rest === "" && c.method === "GET") {
    const ov = overview(rootDir, docsDir, custom);
    const head = await headSha(rootDir);
    const stale: Record<string, unknown> = {};
    if (c.q("fast") !== "1") for (const { page, st } of await withStaleness(rootDir, ov.pages.filter((p) => p.managed), head)) stale[page.path] = st;
    return json({ docs: ov, head, staleness: stale });
  }

  if (rest === "/rev" && c.method === "GET") {
    const ov = overview(rootDir, docsDir, custom);
    return json({ rev: ov.rev, head: await headSha(rootDir), exists: ov.exists });
  }

  if (rest === "/dir" && c.method === "PUT") {
    if (!wsId) throw new HttpError(400, "The docs folder is set per workspace.");
    const d = setDocsDir(wsId, c.body.dir === null || c.body.dir === "" ? null : String(c.body.dir));
    return json({ ...d, docs: overview(rootDir, d.dir, d.custom) });
  }

  if (rest === "/folder" && c.method === "POST") {
    const r = createDocsFolder(rootDir, docsDir, str(c.body.project) ?? root.name);
    return json({ ...r, docs: overview(rootDir, docsDir, custom) }, 201);
  }

  if (rest === "/page") {
    if (c.method === "GET") {
      const rel = c.q("path") ?? "";
      const page = readPage(rootDir, docsDir, rel);
      const head = await headSha(rootDir);
      const staleness = await pageStaleness(rootDir, page.meta, head);
      return json({ page, head, staleness, backlinks: backlinksFor(rootDir, docsDir, page.path) });
    }
    if (c.method === "PUT") {
      const r = writePage(rootDir, docsDir, String(c.body.path ?? ""), String(c.body.content ?? ""), { expectedMtime: c.body.expectedMtime ?? null, create: c.body.create === true });
      return json(r);
    }
  }

  if (rest === "/pages" && c.method === "POST") {
    const r = createPage(rootDir, docsDir, { path: c.body.path, title: c.body.title, kind: c.body.kind, content: typeof c.body.content === "string" ? c.body.content : undefined });
    return json({ ...r, docs: overview(rootDir, docsDir, custom) }, 201);
  }

  if (rest === "/page/current" && c.method === "POST") {
    const head = await headSha(rootDir);
    if (!head) throw new HttpError(400, "This is not a git repository, so there is no commit to record.");
    const r = markCurrent(rootDir, docsDir, String(c.body.path ?? ""), head);
    return json({ ...r, head });
  }

  if (rest === "/generate" && c.method === "POST") {
    const r = await startGeneration(rootDir, wsId, genOpts(c.body));
    return json({ session: view(r.session.id), targets: r.targets, docsDir: r.docsDir }, 201);
  }
  if (rest === "/generate/preview" && c.method === "POST") {
    const p = await planRun(rootDir, wsId, genOpts(c.body));
    return json({ kind: p.kind, docsDir: p.docsDir, targets: p.targets, head: p.head, by: p.resolved.by, refresh: p.refresh, title: p.title, prompt: p.prompt });
  }

  const rm = /^\/runs\/([^/]+)$/.exec(rest);
  if (rm && c.method === "GET") {
    const run = getRun(rm[1]);
    if (!run) throw new HttpError(404, "That session is not a documentation run.");
    return json({ run });
  }

  if (rest === "/estimate" && c.method === "GET") {
    const mode = (c.q("mode") ?? "ref") as DocAttachMode;
    return json(await estimatePath(rootDir, c.q("path") ?? "", mode, docsDir));
  }

  if (rest === "/pages" && c.method === "GET") {
    return json({ pages: listPages(rootDir, docsDir).pages });
  }
  return null;
};

