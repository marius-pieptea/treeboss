/**
 * REA's readiness over HTTP: what it can and cannot do on this computer (src/evidence/readiness.ts).
 *
 *   GET /api/rea/readiness?deep=1&fresh=1   { enabled, report }
 *
 * `deep` runs REA's own doctor (it may download the pinned package), so it is honored only while REA is on.
 * `fresh` bypasses the ten-minute cache.
 */
import { getSetting } from "../../settings";
import { reaReadiness } from "../../evidence/readiness";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const flag = (v: string | null) => v === "1" || v === "true";

export const reaRoutes: RouteModule = async (c: Ctx) => {
  if (!c.match(/^\/api\/rea\/readiness$/)) return null;
  if (c.method !== "GET") throw new HttpError(405, "Method not allowed.");
  const enabled = getSetting("rea_mcp") === "on";
  const report = await reaReadiness({ deep: enabled && flag(c.q("deep")), fresh: flag(c.q("fresh")) });
  return json({ enabled, report });
};
