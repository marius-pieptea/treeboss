/**
 * Handoff and compaction: /api/sessions/:id/{handoff,compact}
 *
 *   POST handoff {preview: true}                  the summary a handoff would carry, nothing started
 *   POST handoff {summary?, engine?, model?, effort?, agent?, pair?, instructions?}
 *                                                 start the continuing session (summary: the operator's edit)
 *   GET  handoff                                  what this session was told when it was started from one
 *   POST compact                                  send /compact to an engine that takes it
 */
import { canCompact } from "../../engines/context";
import { getSession, send, viewSession } from "../../sessions/manager";
import { handoff, handoffInto, summarize } from "../../sessions/handoff";
import { HttpError, json, type RouteModule } from "../http";

export const handoffRoutes: RouteModule = async (c) => {
  let m: RegExpMatchArray | null;
  if ((m = c.match(/^\/api\/sessions\/([^/]+)\/handoff$/))) {
    const s = getSession(m[1]);
    if (!s) throw new HttpError(404, `No session "${m[1]}".`);
    if (c.method === "GET") return json({ handoff: handoffInto(s.id) });
    if (c.method === "POST") {
      if (c.body.preview) return json(await summarize(s.id, { useModel: c.body.model_summary !== false }));
      const r = await handoff(s.id, {
        engine: c.body.engine,
        model: c.body.model,
        effort: c.body.effort,
        agent: c.body.agent,
        pairId: c.body.pair,
        instructions: c.body.instructions,
        summary: c.body.summary,
        useModel: c.body.model_summary !== false,
      });
      return json({ session: viewSession(r.session, { withOutput: false }), summary: r.summary, method: r.method, handoff_id: r.handoffId }, 201);
    }
  }
  if ((m = c.match(/^\/api\/sessions\/([^/]+)\/compact$/)) && c.method === "POST") {
    const s = getSession(m[1]);
    if (!s) throw new HttpError(404, `No session "${m[1]}".`);
    if (!canCompact(s.engine)) throw new HttpError(400, `${s.engine} has no /compact. Hand the session off instead.`);
    return json({ session: viewSession(send({ operator: true }, s.id, "/compact"), { withOutput: false }) });
  }
  return null;
};
