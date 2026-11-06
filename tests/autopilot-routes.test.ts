import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { autopilotRoutes } from "../src/daemon/routes/autopilot";
import { HttpError, makeCtx, type RouteModule } from "../src/daemon/http";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { listRuns } from "../src/autopilot/runner";
import { listSchedules } from "../src/autopilot/schedule";
import { interruptAll, setTurnRunner } from "../src/sessions/manager";
import { RootError, Workspaces } from "../src/workspaces";
import { UserError } from "../src/util";
import { makeRepo, resetState } from "./helpers";

/** Call the module the way the server does: a Ctx built from the request, and the module's Response. */
async function call(route: RouteModule, method: string, path: string, body: Record<string, any> = {}): Promise<{ status: number; json: any }> {
  const url = new URL(`http://127.0.0.1${path}`);
  const req = new Request(url, { method });
  try {
    const res = await route(makeCtx(req, url, body));
    if (!res) throw new Error(`no route answered ${method} ${path}`);
    return { status: res.status, json: await res.json() };
  } catch (err: any) {
    // The server answers these from its catch: HTTP errors and roots with their own status, user errors with 400.
    if (err instanceof HttpError || err instanceof RootError) return { status: err.status, json: { error: err.message } };
    if (err instanceof UserError) return { status: 400, json: { error: err.message } };
    throw err;
  }
}

const turn = (): TurnResult => ({ success: true, output: "done", sessionId: null, resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" }) as unknown as TurnResult;

let wsId = "";

beforeEach(() => {
  resetState();
  listRuns();
  listSchedules();
  db().exec("DELETE FROM autopilot_runs; DELETE FROM schedules");
  setTurnRunner(async () => turn());
  const dir = makeRepo({
    "specs/001-demo/spec.md": "# Feature Specification: Demo\n",
    "specs/001-demo/tasks.md": "# Tasks\n\n## Phase 1\n\n- [ ] T001 One\n- [x] T002 Done\n",
  });
  wsId = Workspaces.open(dir).id;
});

afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

describe("autopilot routes", () => {
  test("starting a run needs a workspace, a spec, and returns the run", async () => {
    const none = await call(autopilotRoutes, "POST", "/api/autopilot", { spec: "001-demo" });
    expect(none.status).toBe(400);
    const unknown = await call(autopilotRoutes, "POST", "/api/autopilot", { workspace: "w_nope", spec: "001-demo" });
    expect(unknown.status).toBe(404);
    const bad = await call(autopilotRoutes, "POST", "/api/autopilot", { workspace: wsId, spec: "999-none" });
    expect(bad.status).toBe(404);
    const started = await call(autopilotRoutes, "POST", "/api/autopilot", { workspace: wsId, spec: "001-demo", approval_policy: { every: 1 }, budget_usd: 5 });
    expect(started.status).toBe(201);
    expect(started.json.run.status).toBe("running");
    expect(started.json.run.approval_policy).toEqual({ merge: false, tagged: false, every: 1 });
    expect(started.json.run.budget_usd).toBe(5);
    const id = started.json.run.id;
    expect(id).toMatch(/^ap_/);
    const list = await call(autopilotRoutes, "GET", `/api/autopilot?workspace=${wsId}`);
    expect(list.json.runs.map((r: any) => r.id)).toContain(id);
  });

  test("get returns the log, and the operator actions move the status", async () => {
    const started = await call(autopilotRoutes, "POST", "/api/autopilot", { workspace: wsId, spec: "001-demo", approval_policy: { every: 1 } });
    const id = started.json.run.id;
    const one = await call(autopilotRoutes, "GET", `/api/autopilot/${id}`);
    expect(one.json.run.log.length).toBeGreaterThan(0);
    expect((await call(autopilotRoutes, "GET", "/api/autopilot/ap_missing")).status).toBe(404);
    const stopped = await call(autopilotRoutes, "POST", `/api/autopilot/${id}/stop`, { reason: "enough" });
    expect(stopped.json.run.status).toBe("stopped");
    expect(stopped.json.run.reason).toBe("enough");
    const again = await call(autopilotRoutes, "POST", `/api/autopilot/${id}/stop`, {});
    expect(again.status).toBe(400);
    const approve = await call(autopilotRoutes, "POST", `/api/autopilot/${id}/approve`, {});
    expect(approve.status).toBe(400);
  });
});

describe("schedule routes", () => {
  test("create, list, patch, run now and delete", async () => {
    const bad = await call(autopilotRoutes, "POST", "/api/schedules", { workspace: wsId, name: "x", cron: "0 9 * *", kind: "verify" });
    expect(bad.status).toBe(400);
    const created = await call(autopilotRoutes, "POST", "/api/schedules", { workspace: wsId, name: "Nightly", cron: "0 2 * * *", kind: "prompt", payload: { prompt: "Summarise" } });
    expect(created.status).toBe(201);
    const id = created.json.schedule.id;
    expect(id).toMatch(/^sc_/);
    expect((await call(autopilotRoutes, "GET", `/api/schedules?workspace=${wsId}`)).json.schedules).toHaveLength(1);

    const off = await call(autopilotRoutes, "PATCH", `/api/schedules/${id}`, { enabled: false });
    expect(off.json.schedule.enabled).toBe(false);
    expect(off.json.schedule.next_run_at).toBeNull();

    const ran = await call(autopilotRoutes, "POST", `/api/schedules/${id}/run`, {});
    expect(ran.json.run.session_id).toMatch(/^s_/);
    expect(ran.json.schedule.last_session_id).toBe(ran.json.run.session_id);

    expect((await call(autopilotRoutes, "DELETE", `/api/schedules/${id}`)).json).toEqual({ removed: true });
    expect((await call(autopilotRoutes, "PATCH", `/api/schedules/${id}`, { enabled: true })).status).toBe(404);
  });
});
