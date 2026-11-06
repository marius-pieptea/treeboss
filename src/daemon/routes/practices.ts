/**
 * Practice packs over HTTP. `:id` is a workspace id (w_…) on the workspace routes, and a pack id on the pack routes.
 *
 *   GET    /api/practices                         { packs, stacks, defaults, checkIds, enforce }
 *                                                 built-in packs first (each with its edits, if any), then custom ones
 *   POST   /api/practices/custom                  { id, title, summary?, appliesTo?, rules, skills? }   a new custom pack
 *   PUT    /api/practices/custom/:id              the same fields   replace one
 *   DELETE /api/practices/custom/:id              remove one (and switch it off where it was on)
 *   PUT    /api/practices/packs/:id              a built-in pack: edit it in place (it becomes modified), with the same
 *                                                fields and `checks` (a subset of its own); a custom pack: replace it
 *   POST   /api/practices/packs/:id/fork          { id? }   a custom copy of a built-in pack (201); the built-in is left as it is
 *   POST   /api/practices/packs/:id/reset         a built-in pack back to what shipped
 *   DELETE /api/practices/packs/:id               a custom pack, as the custom route does
 *   GET    /api/workspaces/:id/practices          { enabled, thresholds, enforce, off }
 *   PUT    /api/workspaces/:id/practices          { enabled?, thresholds?, enforce?, off? }   writes AGENTS.md / CLAUDE.md
 *                                                 enforce: off | warn | fix. off: { [packId]: { rules?, checks? } }, what is switched off
 *   POST   /api/workspaces/:id/practices/check    { files?, changed? }   { packs, checked, findings, skipped }
 *                                                 files: those paths; changed: the uncommitted ones; neither: the whole repo.
 *                                                 skipped: the main stack's files no enabled check reads (not checked mechanically)
 */
import path from "path";
import { applyingTo, checkFiles } from "../../practices/checks";
import { changedFiles, repoFiles } from "../../practices/files";
import { CHECK_IDS, STACKS } from "../../practices/packs";
import { catalog, createCustom, deleteCustom, DEFAULT_ENFORCE, DEFAULT_THRESHOLDS, forkBuiltin, packIsBuiltin, practicesOf, resetBuiltin, saveBuiltin, setPractices, updateCustom } from "../../practices/store";
import { Workspaces } from "../../workspaces";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const MAX_FILES = 20_000;

/** Paths from a request, as relative paths inside the workspace. Anything that leaves it is refused. */
function relativeFiles(given: unknown): string[] {
  if (!Array.isArray(given) || given.length > MAX_FILES) throw new HttpError(400, `files is a list of up to ${MAX_FILES} paths.`);
  return given.map((f) => {
    const p = path.posix.normalize(String(f ?? "").replace(/\\/g, "/"));
    if (!p || p === "." || p === ".." || p.startsWith("../") || path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.includes("\0")) {
      throw new HttpError(400, `"${String(f)}" is not a path inside the workspace.`);
    }
    return p;
  });
}

function checkWorkspace(id: string, root: string, body: Record<string, unknown>) {
  const { enabled } = practicesOf(id);
  const applies = applyingTo(id);
  if (!applies) return { packs: enabled, checked: 0, findings: [], skipped: [] };
  const files = body.files !== undefined ? relativeFiles(body.files) : body.changed ? changedFiles(root) : repoFiles(root);
  if (files.length > MAX_FILES) throw new HttpError(400, `${files.length} files is more than ${MAX_FILES}; pass the files to check.`);
  return { packs: enabled, checked: files.length, ...checkFiles(root, files, applies.checks, applies.thresholds) };
}

export const practicesRoutes: RouteModule = async (c: Ctx) => {
  if (c.path === "/api/practices" && c.method === "GET") return json({ packs: catalog(), stacks: STACKS, defaults: DEFAULT_THRESHOLDS, enforce: DEFAULT_ENFORCE, checkIds: CHECK_IDS });
  if (c.path === "/api/practices/custom" && c.method === "POST") return json({ pack: createCustom(c.body) }, 201);

  let m: RegExpMatchArray | null;
  if ((m = c.path.match(/^\/api\/practices\/custom\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1] ?? "");
    if (c.method === "PUT") return json({ pack: updateCustom(id, c.body) });
    if (c.method === "DELETE") {
      deleteCustom(id);
      return json({ ok: true });
    }
  }

  if ((m = c.path.match(/^\/api\/practices\/packs\/([^/]+)(?:\/(fork|reset))?$/))) {
    const id = decodeURIComponent(m[1] ?? "");
    const action = m[2];
    if (!action && c.method === "PUT") {
      return json({ pack: packIsBuiltin(id) ? saveBuiltin(id, c.body) : updateCustom(id, c.body) });
    }
    if (!action && c.method === "DELETE") {
      deleteCustom(id);
      return json({ ok: true });
    }
    if (action === "fork" && c.method === "POST") {
      const body = (c.body ?? {}) as { id?: unknown };
      return json({ pack: forkBuiltin(id, typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined) }, 201);
    }
    if (action === "reset" && c.method === "POST") return json({ pack: resetBuiltin(id) });
  }

  if ((m = c.path.match(/^\/api\/workspaces\/(w_[^/]+)\/practices(\/check)?$/))) {
    const id = m[1] ?? "";
    const ws = Workspaces.get(id);
    if (!ws) throw new HttpError(404, `No workspace "${id}".`);
    if (!m[2] && c.method === "GET") return json(practicesOf(id));
    if (!m[2] && c.method === "PUT") return json(setPractices(id, c.body));
    if (m[2] && c.method === "POST") return json(checkWorkspace(id, ws.path, c.body));
  }
  return null;
};
