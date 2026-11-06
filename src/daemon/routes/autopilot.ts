/**
 * Unattended execution over HTTP: autopilot runs and scheduled jobs. A workspace is named by its `w_…` id.
 *
 *   GET    /api/autopilot?workspace=w_…                  the runs of a workspace, newest first (log trimmed)
 *   POST   /api/autopilot                                { workspace, spec, budget_usd?, max_tasks?, concurrency?, approval_policy? }
 *   GET    /api/autopilot/:id                            one run, with its full log
 *   POST   /api/autopilot/:id/pause | resume | stop      stop takes { reason? }
 *   POST   /api/autopilot/:id/approve | reject           answer an approval gate
 *
 *   GET    /api/schedules?workspace=w_…                  the jobs of a workspace
 *   POST   /api/schedules                                { workspace, name, cron, kind, payload?, engine?, enabled? }
 *   PATCH  /api/schedules/:id                            any of { name, cron, kind, payload, engine, enabled }
 *   DELETE /api/schedules/:id
 *   POST   /api/schedules/:id/run                        start a job now (its next slot does not move)
 */
import { HttpError, json, type RouteModule } from "../http";
import { approveRun, getRun, listRuns, pauseRun, rejectRun, resumeRun, startRun, stopRun } from "../../autopilot/runner";
import { createSchedule, deleteSchedule, listSchedules, getSchedule, runSchedule, updateSchedule } from "../../autopilot/schedule";
import { Workspaces } from "../../workspaces";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

function workspaceOf(ref: string | null): string {
  if (!ref) throw new HttpError(400, "workspace is required (a w_… id).");
  if (!Workspaces.get(ref)) throw new HttpError(404, `No workspace "${ref}".`);
  return ref;
}

export const autopilotRoutes: RouteModule = async (c) => {
  let m: RegExpMatchArray | null;

  if (c.path === "/api/autopilot" && c.method === "GET") return json({ runs: listRuns(workspaceOf(c.q("workspace"))) });
  if (c.path === "/api/autopilot" && c.method === "POST") {
    const b = c.body;
    const run = startRun(workspaceOf(str(b.workspace)), String(b.spec ?? "").trim(), {
      budget_usd: num(b.budget_usd ?? b.budget),
      max_tasks: num(b.max_tasks),
      concurrency: num(b.concurrency),
      approval_policy: b.approval_policy ?? null,
      open_pr: b.open_pr === true,
    });
    return json({ run }, 201);
  }
  if ((m = c.match(/^\/api\/autopilot\/(ap_[^/]+)$/)) && c.method === "GET") {
    const run = getRun(m[1]);
    if (!run) throw new HttpError(404, `No autopilot run "${m[1]}".`);
    return json({ run });
  }
  if ((m = c.match(/^\/api\/autopilot\/(ap_[^/]+)\/(pause|resume|stop|approve|reject)$/)) && c.method === "POST") {
    const id = m[1];
    const act = {
      pause: () => pauseRun(id),
      resume: () => resumeRun(id),
      stop: () => stopRun(id, str(c.body.reason) ?? undefined),
      approve: () => approveRun(id),
      reject: () => rejectRun(id),
    }[m[2] as "pause" | "resume" | "stop" | "approve" | "reject"];
    return json({ run: act() });
  }

  if (c.path === "/api/schedules" && c.method === "GET") return json({ schedules: listSchedules(workspaceOf(c.q("workspace"))) });
  if (c.path === "/api/schedules" && c.method === "POST") {
    const b = c.body;
    const schedule = createSchedule({
      workspace_id: workspaceOf(str(b.workspace)),
      name: String(b.name ?? ""),
      cron: String(b.cron ?? ""),
      kind: String(b.kind ?? ""),
      payload: b.payload ?? null,
      engine: str(b.engine),
      enabled: b.enabled !== false,
    });
    return json({ schedule }, 201);
  }
  if ((m = c.match(/^\/api\/schedules\/(sc_[^/]+)$/))) {
    if (!getSchedule(m[1])) throw new HttpError(404, `No schedule "${m[1]}".`);
    if (c.method === "PATCH") {
      const b = c.body;
      const patch: Record<string, unknown> = {};
      for (const k of ["name", "cron", "kind", "payload", "engine", "enabled"]) if (k in b) patch[k] = b[k];
      return json({ schedule: updateSchedule(m[1], patch) });
    }
    if (c.method === "DELETE") return json({ removed: deleteSchedule(m[1]) });
  }
  if ((m = c.match(/^\/api\/schedules\/(sc_[^/]+)\/run$/)) && c.method === "POST") {
    const started = runSchedule(m[1]);
    return json({ run: started, schedule: getSchedule(m[1]) });
  }

  return null;
};
