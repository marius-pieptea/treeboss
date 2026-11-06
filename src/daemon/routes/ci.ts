/**
 * CI and pull requests over HTTP. `:workspaceId` is a workspace id (w_…); the PRs and the workflow live in that
 * folder. Sessions are addressed by their id (s_…).
 *
 *   POST   /api/ci/:workspaceId/workflow              { write?, overwrite? }  the workflow for the folder; with write, it is written
 *   GET    /api/prs?workspace=&state=                 the PRs of a workspace (open by default), with session and checks state
 *   POST   /api/sessions/:id/pr                       { base?, draft? }  push the session's branch and open its PR (or return its open one)
 *   POST   /api/prs/:workspaceId/:n/merge             { method?: squash|merge|rebase, deleteBranch? }
 *   GET    /api/prs/:workspaceId/:n/checks            the PR's checks, and the row in session_prs refreshed
 *
 * Errors from gh (missing, signed out, failing checks) come back with their status and a sentence for the operator.
 */
import { resolveRoot } from "../../workspaces";
import { listWorkspacePrs, PrError, prMerge, refreshPr, sessionToPr, type MergeMethod } from "../../ci/pr";
import { planWorkflow, writeWorkflow } from "../../ci/workflow";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PrError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

async function guardAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PrError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

const STATES = ["open", "closed", "merged", "all"] as const;
const METHODS: MergeMethod[] = ["squash", "merge", "rebase"];

export const ciRoutes: RouteModule = async (c: Ctx) => {
  let m: RegExpMatchArray | null;

  if ((m = c.match(/^\/api\/ci\/([^/]+)\/workflow$/)) && c.method === "POST") {
    const dir = resolveRoot(decodeURIComponent(m[1]!)).dir;
    const plan = guard(() => planWorkflow(dir));
    if (c.body.write !== true) return json({ plan });
    const written = guard(() => writeWorkflow(dir, { overwrite: c.body.overwrite === true }));
    return json({ plan: written.plan, written: true, path: written.path }, 201);
  }

  if (c.match(/^\/api\/prs$/) && c.method === "GET") {
    const ws = str(c.q("workspace"));
    if (!ws) throw new HttpError(400, "Name the workspace: ?workspace=w_…");
    const state = (str(c.q("state")) ?? "open") as (typeof STATES)[number];
    if (!STATES.includes(state)) throw new HttpError(400, "state must be open, closed, merged or all.");
    const prs = await guardAsync(() => listWorkspacePrs(ws, state));
    return json({ prs });
  }

  if ((m = c.match(/^\/api\/sessions\/([^/]+)\/pr$/)) && c.method === "POST") {
    const b = c.body;
    const r = await guardAsync(() => sessionToPr(decodeURIComponent(m![1]!), { base: str(b.base), draft: b.draft === true }));
    return json({ pr: r.pr, created: r.created }, r.created ? 201 : 200);
  }

  if ((m = c.match(/^\/api\/prs\/([^/]+)\/(\d+)\/merge$/)) && c.method === "POST") {
    const ws = decodeURIComponent(m[1]!);
    const n = Number(m[2]);
    const dir = resolveRoot(ws).dir;
    const method = (str(c.body.method) ?? "squash") as MergeMethod;
    if (!METHODS.includes(method)) throw new HttpError(400, "The merge method must be squash, merge or rebase.");
    await guardAsync(() => prMerge(dir, n, { method, deleteBranch: c.body.deleteBranch === true }));
    const { pr } = await guardAsync(() => refreshPr(ws, n));
    return json({ pr });
  }

  if ((m = c.match(/^\/api\/prs\/([^/]+)\/(\d+)\/checks$/)) && c.method === "GET") {
    const ws = decodeURIComponent(m[1]!);
    const { pr, detail, checks } = await guardAsync(() => refreshPr(ws, Number(m![2])));
    return json({ pr, detail, checks });
  }

  return null;
};
