/**
 * Releases over HTTP: the range, the agent-drafted notes, the drafts, the published records and the publish. `root` is a
 * root reference (w_… or s_…), as the deploy routes take it. Product notes are keyed by product id.
 *
 *   GET    /api/releases/:root                                  the version, tags, drafts, published releases and sessions
 *   GET    /api/releases/:root/range?base=&prs=1                the range from a base (a tag, a sha, a date, or empty for the last tag)
 *   POST   /api/releases/:root/draft                            { base?, bump?, audience? } start a changelog session (201)
 *   GET    /api/releases/:root/drafts/:version                  one draft, with its notes
 *   PUT    /api/releases/:root/drafts/:version                  { body } the operator's edit of the notes
 *   POST   /api/releases/:root/drafts/:version/revise           { instructions } a follow-up in the session that wrote it (202)
 *   POST   /api/releases/:root/drafts/:version/publish          { push?, ghRelease?, deploy? } commit, tag, and the optional steps
 *   POST   /api/releases/:root/releases/:version/undo           { deleteRemoteTag? } revert the release commit and remove its tag
 *   GET    /api/releases/product/:productId                     the product's repos and their latest releases, and its notes
 *   POST   /api/releases/product/:productId/draft               { audience? } start a combined product note (201)
 *   POST   /api/releases/product/:productId/notes/:name/publish { push? } commit and tag a product note
 */
import fs from "fs";
import path from "path";
import { resolveRoot, Workspaces, type Workspace } from "../../workspaces";
import { getProduct, productWorkspaces } from "../../products/store";
import { candidates, detectVersionFiles, gitIn, listPackageRoots, listTags, parseBase, primaryVersion, rangeOf, RELEASE_BUMPS, type ReleaseBump } from "../../releases/range";
import { DRAFTS_DIR, listDrafts, listReleases, PRODUCTS_DIR, publishDraft, publishProductNote, readDraft, undoRelease, updateDraft, assertVersion, type ReleaseDoc } from "../../releases/store";
import { AUDIENCES, releaseSessionsOf, reviseDraft, sessionOfToken, startChangelogSession, startProductReleaseNotes, type Audience } from "../../releases/draft";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The workspace a root reference points at. A session's folder is registered as a workspace on first use. */
function workspaceOf(ref: string | null): Workspace {
  if (!ref) throw new HttpError(400, "root is required (a workspace or session id).");
  if (ref.startsWith("w_")) {
    const w = Workspaces.get(ref);
    if (!w) throw new HttpError(404, `No workspace "${ref}".`);
    return w;
  }
  return Workspaces.open(resolveRoot(ref).dir);
}

function audienceOf(v: unknown): Audience | null {
  if (v === undefined || v === null || v === "") return null;
  if (!AUDIENCES.includes(v as Audience)) throw new HttpError(400, `audience must be one of: ${AUDIENCES.join(", ")}.`);
  return v as Audience;
}

function bumpOf(v: unknown): ReleaseBump | null {
  if (v === undefined || v === null || v === "") return null;
  if (!RELEASE_BUMPS.includes(v as ReleaseBump)) throw new HttpError(400, `bump must be one of: ${RELEASE_BUMPS.join(", ")}.`);
  return v as ReleaseBump;
}

/** A draft or a release record as the web and the CLI read it. */
function docView(d: ReleaseDoc, withBody = true) {
  const session = sessionOfToken(d.meta.draft);
  return { version: d.version, file: d.file, status: d.meta.status ?? null, meta: d.meta, sessionId: session?.session_id ?? null, ...(withBody ? { body: d.body } : {}) };
}

function versionView(root: string) {
  const files = detectVersionFiles(root);
  const primary = primaryVersion(files);
  return primary ? { file: primary.file, version: primary.version, candidates: candidates(primary.version), packages: listPackageRoots(root), files: files.map((f) => ({ file: f.file, version: f.version, stack: f.stack })) } : null;
}

export const releasesRoutes: RouteModule = async (c: Ctx) => {
  const method = c.method;
  const b = c.body;
  let m: RegExpMatchArray | null;

  if ((m = c.match(/^\/api\/releases\/product\/([^/]+)\/notes\/([^/]+)\/publish$/)) && method === "POST") {
    const product = getProduct(decodeURIComponent(m[1]!));
    if (!product) throw new HttpError(404, "No such product.");
    return json(publishProductNote(product.id, decodeURIComponent(m[2]!), { push: b.push === true }));
  }

  if ((m = c.match(/^\/api\/releases\/product\/([^/]+)\/draft$/)) && method === "POST") {
    const product = getProduct(decodeURIComponent(m[1]!));
    if (!product) throw new HttpError(404, "No such product.");
    return json(startProductReleaseNotes(product.id, { audience: audienceOf(b.audience) }), 201);
  }

  if ((m = c.match(/^\/api\/releases\/product\/([^/]+)$/)) && method === "GET") {
    const product = getProduct(decodeURIComponent(m[1]!));
    if (!product) throw new HttpError(404, "No such product.");
    const repos = productWorkspaces(product.id);
    const first = repos[0];
    return json({
      product: { id: product.id, name: product.name, slug: product.slug },
      repos: repos.map((r) => {
        const latest = listReleases(r.path)[0] ?? null;
        return { workspaceId: r.workspace_id, name: r.name, role: r.role, latest: latest ? { version: latest.version, date: latest.meta.date ?? null, tag: latest.meta.tag ?? null } : null };
      }),
      notes: first && fs.existsSync(path.join(first.path, PRODUCTS_DIR)) ? fs.readdirSync(path.join(first.path, PRODUCTS_DIR)).filter((f) => f.endsWith(".md")).sort().reverse().map((f) => `${PRODUCTS_DIR.replace(/\\/g, "/")}/${f}`) : [],
    });
  }

  if ((m = c.match(/^\/api\/releases\/([^/]+)$/)) && method === "GET") {
    const ws = workspaceOf(decodeURIComponent(m[1]!));
    const dirty = gitIn(ws.path, ["status", "--porcelain"]).out.trim() !== "";
    const head = gitIn(ws.path, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
    return json({
      workspace: { id: ws.id, name: ws.name, path: ws.path },
      version: versionView(ws.path),
      head: { sha: gitIn(ws.path, ["rev-parse", "--short", "HEAD"]).out.trim(), branch: head && head !== "HEAD" ? head : null },
      dirty,
      tags: listTags(ws.path),
      releases: listReleases(ws.path).map((d) => docView(d, false)),
      drafts: listDrafts(ws.path).map((d) => docView(d, false)),
      sessions: releaseSessionsOf(ws.id).map((s) => ({ sessionId: s.session_id, kind: s.kind, subject: s.subject, createdAt: s.created_at })),
      draftsDir: DRAFTS_DIR.replace(/\\/g, "/"),
    });
  }

  if ((m = c.match(/^\/api\/releases\/([^/]+)\/range$/)) && method === "GET") {
    const ws = workspaceOf(decodeURIComponent(m[1]!));
    const range = rangeOf(ws.path, parseBase(c.q("base")), { prs: c.q("prs") === "1" || c.q("prs") === "true" });
    return json({ range });
  }

  if ((m = c.match(/^\/api\/releases\/([^/]+)\/draft$/)) && method === "POST") {
    const ws = workspaceOf(decodeURIComponent(m[1]!));
    return json(startChangelogSession(ws.id, { base: str(b.base), bump: bumpOf(b.bump), audience: audienceOf(b.audience) }), 201);
  }

  if ((m = c.match(/^\/api\/releases\/([^/]+)\/drafts\/([^/]+)$/))) {
    const ws = workspaceOf(decodeURIComponent(m[1]!));
    const version = assertVersion(decodeURIComponent(m[2]!));
    if (method === "GET") {
      const d = readDraft(ws.path, version);
      if (!d) throw new HttpError(404, `No draft ${version}.`);
      return json({ draft: docView(d) });
    }
    if (method === "PUT") {
      if (typeof b.body !== "string") throw new HttpError(400, "body is required (the notes, as Markdown).");
      return json({ draft: docView(updateDraft(ws.path, version, b.body)) });
    }
  }

  if ((m = c.match(/^\/api\/releases\/([^/]+)\/drafts\/([^/]+)\/revise$/)) && method === "POST") {
    const ws = workspaceOf(decodeURIComponent(m[1]!));
    return json(reviseDraft(ws.id, assertVersion(decodeURIComponent(m[2]!)), String(b.instructions ?? "")), 202);
  }

  if ((m = c.match(/^\/api\/releases\/([^/]+)\/drafts\/([^/]+)\/publish$/)) && method === "POST") {
    const ws = workspaceOf(decodeURIComponent(m[1]!));
    const version = assertVersion(decodeURIComponent(m[2]!));
    return json(
      publishDraft(ws.id, version, {
        push: b.push === true,
        ghRelease: b.ghRelease === true,
        deploy: str(b.deploy),
        package: str(b.package),
      }),
    );
  }

  if ((m = c.match(/^\/api\/releases\/([^/]+)\/releases\/([^/]+)\/undo$/)) && method === "POST") {
    const ws = workspaceOf(decodeURIComponent(m[1]!));
    return json(undoRelease(ws.id, assertVersion(decodeURIComponent(m[2]!)), { deleteRemoteTag: b.deleteRemoteTag === true }));
  }

  return null;
};

