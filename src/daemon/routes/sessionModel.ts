/**
 * Change a session's model between turns.
 *
 *   PUT /api/sessions/:id/model   { model?, effort?, force? }   -> { session, from, to, warning, uncached_next_turn, context_tokens }
 *   PUT /api/sessions/:id/pair    { pair: id | null, adopt? }          -> { session }   attach or detach a Hydra pair (idle leads)
 */
import { getSession, SessionError, viewSession } from "../../sessions/manager";
import { setSessionModel } from "../../sessions/model";
import { setSessionPair } from "../../sessions/pairattach";
import { HttpError, json, type RouteModule } from "../http";

export const sessionModelRoutes: RouteModule = async (c) => {
  const pm = c.match(/^\/api\/sessions\/([^/]+)\/pair$/);
  if (pm && c.method === "PUT") {
    if (!getSession(pm[1])) throw new HttpError(404, `No session "${pm[1]}".`);
    try {
      return json({ session: viewSession(setSessionPair(pm[1], c.body.pair ?? null, { adoptLead: c.body.adopt === true }), { withOutput: false }) });
    } catch (e) {
      if (e instanceof SessionError) throw new HttpError(/working|closed/.test(e.message) ? 409 : 400, e.message);
      throw e;
    }
  }
  const m = c.match(/^\/api\/sessions\/([^/]+)\/model$/);
  if (!m || c.method !== "PUT") return null;
  if (!getSession(m[1])) throw new HttpError(404, `No session "${m[1]}".`);
  if (c.body.model === undefined && c.body.effort === undefined) throw new HttpError(400, "Pass model and/or effort.");
  try {
    const r = await setSessionModel(m[1], { model: c.body.model, effort: c.body.effort, force: c.body.force === true });
    return json({ session: viewSession(r.session, { withOutput: false }), from: r.from, to: r.to, warning: r.warning, uncached_next_turn: r.uncached_next_turn, context_tokens: r.context_tokens });
  } catch (e) {
    if (e instanceof SessionError) throw new HttpError(e.message.startsWith("Set by the pair") || /keeps its model|closed|working/.test(e.message) ? 409 : 400, e.message);
    throw e;
  }
};
