/**
 * What sessions have attached (specs, plans and documentation pages), as one API.
 *
 *   GET    /api/sessions/:id/attachments          what is attached, with the cost of each
 *   POST   /api/sessions/:id/attachments          { path, mode? }  attach (the kind follows from the path)
 *   DELETE /api/sessions/:id/attachments?path=    detach
 *   GET    /api/attachments/:root/candidates      everything the workspace offers to attach, grouped
 *   GET    /api/attachments/:root/estimate?path=&mode=   token estimate of attaching one thing
 *
 * `:root` is a workspace reference (w_…). The older /specs and /docs routes stay for their own screens.
 */
import fs from "fs";
import path from "path";
import { resolveRoot } from "../../workspaces";
import { getSession } from "../../sessions/manager";
import { plansDirOf } from "../../sessions/plansdir";
import { attachAny, detachAny, estimatePathAny, estimateSessionAny, listAll, planSummary, type AttachMode } from "../../attachments";
import { CONSTITUTION_PATH } from "../../specs/templates";
import { overview as specsOverview } from "../../specs/store";
import { headSha } from "../../docs/staleness";
import { withStaleness } from "../../docs/generate";
import { docsDirOf, overview as docsOverview } from "../../docs/store";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const mode = (v: unknown): AttachMode => (v === "inline" ? "inline" : "ref");

export const attachmentsRoutes: RouteModule = async (c: Ctx) => {
  const sm = c.match(/^\/api\/sessions\/([^/]+)\/attachments$/);
  if (sm) {
    const s = getSession(sm[1]);
    if (!s) throw new HttpError(404, `No session "${sm[1]}".`);
    if (c.method === "GET") return json({ attached: listAll(s.id), estimate: await estimateSessionAny(s.id) });
    if (c.method === "POST") {
      const a = attachAny(s.id, String(c.body.path ?? ""), { mode: mode(c.body.mode) });
      return json({ attached: a, estimate: await estimateSessionAny(s.id) }, 201);
    }
    if (c.method === "DELETE") {
      const ok = detachAny(s.id, c.q("path") ?? "");
      return json({ removed: ok, estimate: await estimateSessionAny(s.id) });
    }
    return null;
  }

  const m = c.match(/^\/api\/attachments\/([^/]+)\/(candidates|estimate)$/);
  if (!m || c.method !== "GET") return null;
  const ref = m[1];
  const root = resolveRoot(ref);
  const rootDir = root.dir;
  const { dir: docsDir, custom } = docsDirOf(root.kind === "workspace" ? ref : null);

  if (m[2] === "estimate") {
    const rel = c.q("path") ?? "";
    return json(await estimatePathAny({ base_cwd: rootDir }, rel, mode(c.q("mode")), docsDir));
  }

  const ov = specsOverview(rootDir);
  const specsList = [
    ...(ov.constitution.exists ? [{ path: CONSTITUTION_PATH, title: "Constitution", sub: "Principles" }] : []),
    ...[...ov.features].reverse().map((f) => ({ path: f.dir, title: f.title, sub: `${f.status === "in-progress" ? "in progress" : f.status}${f.tasks.total ? ` · ${f.tasks.done}/${f.tasks.total}` : ""}` })),
  ];

  const plansDir = plansDirOf(rootDir);
  let planFiles: string[] = [];
  try {
    planFiles = fs.readdirSync(path.join(rootDir, plansDir)).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 40);
  } catch {}
  const plansList = planFiles.map((f) => {
    const rel = `${plansDir}/${f}`;
    const sum = planSummary(rootDir, rel);
    return { path: rel, title: sum.title, sub: sum.status ?? "plan" };
  });

  const dov = docsOverview(rootDir, docsDir, custom);
  const head = await headSha(rootDir);
  const stale = new Map<string, string>();
  if (c.q("fast") !== "1") for (const { page, st } of await withStaleness(rootDir, dov.pages.filter((p) => p.managed), head)) stale.set(page.path, st.state);
  const docsList = dov.pages.map((p) => ({ path: p.path, title: p.title, sub: stale.get(p.path) ?? "unmanaged" }));
  return json({ specs: specsList, plans: plansList, docs: docsList });
};
