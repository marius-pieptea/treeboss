/** Model catalogs: GET /api/engines/:id/models[?refresh=1]. Plan limits an engine last reported: GET /api/engines/:id/limits */
import { engineIds } from "../../engines/registry";
import { listModels } from "../../engines/models";
import { getLimits } from "../../engines/limits";
import { refreshReportedLimits } from "../../engines/plan-read";
import { HttpError, json, type RouteModule } from "../http";

export const modelRoutes: RouteModule = async (c) => {
  const lim = c.match(/^\/api\/engines\/([^/]+)\/limits$/);
  if (lim && c.method === "GET") {
    if (!engineIds().includes(lim[1])) throw new HttpError(404, `Unknown engine "${lim[1]}".`);
    await refreshReportedLimits(lim[1]);
    return json(getLimits(lim[1]));
  }
  const m = c.match(/^\/api\/engines\/([^/]+)\/models$/);
  if (!m || c.method !== "GET") return null;
  if (!engineIds().includes(m[1])) throw new HttpError(404, `Unknown engine "${m[1]}".`);
  return json(await listModels(m[1], { refresh: c.q("refresh") === "1" }));
};
