/**
 * Goal mode and plan mode over HTTP.
 *
 *   GET    /api/sessions/:id/goal            the goal, or null
 *   PUT    /api/sessions/:id/goal            set one { text, check?, max_turns?, max_minutes?, start? }
 *   POST   /api/sessions/:id/goal/stop       end it
 *   PUT    /api/sessions/:id/mode            { mode: "plan" | "build" }
 *   POST   /api/sessions/:id/plan/approve    leave plan mode and tell the agent to build the plan
 */
import { getGoal, setGoal, stopGoal } from "../../sessions/goal";
import { getSession, viewSession } from "../../sessions/manager";
import { approvePlan, parseMode, setMode } from "../../sessions/plan";
import { HttpError, json, type RouteModule } from "../http";

export const goalPlanRoutes: RouteModule = (c) => {
  const m = c.match(/^\/api\/sessions\/([^/]+)\/(goal|goal\/stop|mode|plan\/approve)$/);
  if (!m) return null;
  const s = getSession(m[1]);
  if (!s) throw new HttpError(404, `No session "${m[1]}".`);
  const view = () => viewSession(getSession(s.id)!, { withOutput: false });

  if (m[2] === "goal" && c.method === "GET") return json({ goal: getGoal(s.id) });
  if (m[2] === "goal" && c.method === "PUT") {
    const goal = setGoal(s.id, { text: c.body.text, check: c.body.check, maxTurns: c.body.max_turns, maxMinutes: c.body.max_minutes }, { kickoff: c.body.start !== false });
    return json({ goal, session: view() });
  }
  if (m[2] === "goal/stop" && c.method === "POST") return json({ goal: stopGoal(s.id, "stopped by you"), session: view() });
  if (m[2] === "mode" && c.method === "PUT") {
    const mode = parseMode(c.body.mode);
    if (!mode) throw new HttpError(400, 'mode must be "build", "plan" or "ask".');
    return json({ session: viewSession(setMode(s.id, mode), { withOutput: false }) });
  }
  if (m[2] === "plan/approve" && c.method === "POST") return json({ session: viewSession(approvePlan(s.id), { withOutput: false }) });
  return null;
};
