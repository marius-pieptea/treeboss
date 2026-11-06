/**
 * The plan questionnaire and the plan files over HTTP.
 *
 *   GET  /api/sessions/:id/plan-state                      the pending question, answered history, current plan, depth
 *   POST /api/sessions/:id/plan/answer                     { question_id?, choice?, choices?, custom?, skip? }
 *   PUT  /api/sessions/:id/plan/depth                      { depth: "quick" | "spec" }: what the next plan becomes
 *   GET  /api/sessions/:id/plan/file[?plan=<id>]           the plan's markdown as it stands now: { plan, path, text, mtime, from_file }
 *   PUT  /api/sessions/:id/plan/plans/:pid/file            { text, expected_mtime? }: save an edit made in the viewer
 *   POST /api/sessions/:id/plan/plans/:pid/approve         { edits?: { title?, summary?, steps? } }: leave plan mode and build it
 *   POST /api/sessions/:id/plan/plans/:pid/request-changes { note }: keep planning, with the note (the file is revised in place)
 *   POST /api/sessions/:id/plan/plans/:pid/skip            leave plan mode without building the plan
 *   POST /api/sessions/:id/plan/plans/:pid/promote         turn the plan into a spec feature: { plan, feature, dir }
 *   POST /api/sessions/:id/plan/plans/:pid/materialize     give a plan from before plan files a file
 *   GET|PUT /api/workspaces/:id/plans-dir                  the folder plans are written to (default "plans"); PUT { dir: null } resets it
 */
import { db } from "../../db";
import { getSession, viewSession } from "../../sessions/manager";
import { answerQuestion, approvePlanRecord, materializePlan, planState, promotePlan, readPlan, requestChanges, savePlanFile, setPlanDepth, skipPlan } from "../../sessions/planq";
import { plansDirOf, setPlansDir } from "../../sessions/plansdir";
import { HttpError, json, type RouteModule } from "../http";

export const planqRoutes: RouteModule = (c) => {
  const ws = c.match(/^\/api\/workspaces\/([^/]+)\/plans-dir$/);
  if (ws) {
    const w = db().prepare("SELECT id, path FROM workspaces WHERE id = ?").get(ws[1]) as { id: string; path: string } | undefined;
    if (!w) throw new HttpError(404, `No workspace "${ws[1]}".`);
    if (c.method === "GET") return json({ dir: plansDirOf(w.path) });
    if (c.method === "PUT") return json({ dir: setPlansDir(w.id, c.body.dir ?? null) });
    return null;
  }

  const m = c.match(/^\/api\/sessions\/([^/]+)\/(plan-state|plan\/answer|plan\/depth|plan\/file|plan\/plans\/([^/]+)\/(approve|request-changes|skip|promote|materialize|file))$/);
  if (!m) return null;
  const s = getSession(m[1]);
  if (!s) throw new HttpError(404, `No session "${m[1]}".`);
  const view = (id: string) => viewSession(getSession(id)!, { withOutput: false });

  if (m[2] === "plan-state" && c.method === "GET") return json(planState(s.id));
  if (m[2] === "plan/answer" && c.method === "POST") {
    const question = answerQuestion(s.id, { question_id: c.body.question_id, choice: c.body.choice, choices: c.body.choices, custom: c.body.custom, skip: c.body.skip === true });
    return json({ question, state: planState(s.id) });
  }
  if (m[2] === "plan/depth" && c.method === "PUT") return json({ depth: setPlanDepth(s.id, c.body.depth) });
  if (m[2] === "plan/file" && c.method === "GET") {
    const r = readPlan(s.id, c.q("plan"));
    return json({ plan: r.plan, path: r.path, text: r.text, mtime: r.mtime, from_file: r.fromFile });
  }
  if (m[4] === "file" && c.method === "PUT") {
    const r = savePlanFile(s.id, m[3], String(c.body.text ?? ""), typeof c.body.expected_mtime === "number" ? c.body.expected_mtime : null);
    return json({ plan: r.plan, mtime: r.mtime });
  }
  if (m[4] === "approve" && c.method === "POST") {
    const r = approvePlanRecord(s.id, m[3], c.body.edits ?? null);
    return json({ plan: r.plan, feature: r.feature, session: view(s.id) });
  }
  if (m[4] === "request-changes" && c.method === "POST") {
    const r = requestChanges(s.id, m[3], c.body.note);
    return json({ plan: r.plan, session: view(s.id) });
  }
  if (m[4] === "skip" && c.method === "POST") {
    const r = skipPlan(s.id, m[3]);
    return json({ plan: r.plan, session: view(s.id) });
  }
  if (m[4] === "promote" && c.method === "POST") {
    const r = promotePlan(s.id, m[3]);
    return json({ plan: r.plan, feature: r.feature, dir: r.dir });
  }
  if (m[4] === "materialize" && c.method === "POST") return json({ plan: materializePlan(s.id, m[3]) });
  return null;
};
