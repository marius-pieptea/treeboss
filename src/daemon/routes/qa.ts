/**
 * The QA pipeline over HTTP. `:root` is a root reference (w_… or s_…), like the lab API. Types are in qa/types.ts (the
 * wire half). Errors are `{ error }`: 400 for a bad request, 404 for a missing feature, run, plan or pipeline, 409 when a
 * pipeline is already running or a job is working on the plan.
 *
 *   GET    /api/qa/:root                               -> QaBoard
 *   GET    /api/qa/:root/features/:id                  -> FeatureDetail
 *   GET    /api/qa/:root/runs/:id                      -> RunReply
 *   POST   /api/qa/:root/pipelines   PipelineRequest   -> 201 { pipeline: PipelineView }
 *   POST   /api/qa/:root/pipelines/:id/continue        -> { pipeline }   a held pipeline goes on to its next stage
 *   POST   /api/qa/:root/pipelines/:id/stop            -> { pipeline }   running jobs finish, nothing new starts (idempotent)
 *   DELETE /api/qa/:root/plans/:slug                   -> { ok: true }   the plan file and its runs
 *
 * Bugs are edited through the Lab routes (PATCH /api/lab/:root/findings/:id, POST /api/lab/:root/bugs).
 */
import { resolveRoot } from "../../workspaces";
import { continuePipeline, deletePlan, featureDetail, qaBoard, runReply, startPipeline, stopPipeline } from "../../qa/jobs";
import { planSlug, QaConflict, QaNotFound } from "../../qa/plan";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const dec = (v: unknown): string => decodeURIComponent(String(v));

async function handle(c: Ctx): Promise<Response | null> {
  const m = c.match(/^\/api\/qa\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const dir = resolveRoot(m[1]!).dir;
  const rest = m[2] ?? "";

  if (rest === "" && c.method === "GET") return json(qaBoard(dir));

  const feature = /^features\/([^/]+)$/.exec(rest);
  if (feature && c.method === "GET") return json(featureDetail(dir, dec(feature[1])));

  const run = /^runs\/([^/]+)$/.exec(rest);
  if (run && c.method === "GET") return json(runReply(dir, dec(run[1])));

  if (rest === "pipelines" && c.method === "POST") return json({ pipeline: startPipeline(dir, c.body) }, 201);
  const act = /^pipelines\/([^/]+)\/(continue|stop)$/.exec(rest);
  if (act && c.method === "POST") return json({ pipeline: act[2] === "continue" ? continuePipeline(dir, dec(act[1])) : stopPipeline(dir, dec(act[1])) });

  const plan = /^plans\/([^/]+)$/.exec(rest);
  if (plan && c.method === "DELETE") {
    deletePlan(dir, planSlug(dec(plan[1])));
    return json({ ok: true });
  }
  throw new HttpError(404, `No QA route ${c.method} ${c.path}.`);
}

export const qaRoutes: RouteModule = async (c) => {
  try {
    return await handle(c);
  } catch (e) {
    if (e instanceof QaNotFound) throw new HttpError(404, e.message);
    if (e instanceof QaConflict) throw new HttpError(409, e.message);
    throw e;
  }
};
