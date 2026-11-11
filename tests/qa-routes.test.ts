import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "fs";
import path from "path";
import { findChrome } from "../src/browser/chrome";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import type { RunTurnOptions, TurnResult } from "../src/engines/runner";
import { createBugFinding } from "../src/lab/findings";
import { startQaDriver, stopQaDriver } from "../src/qa/jobs";
import { jobOfSession } from "../src/qa/registry";
import { runsOfSession, setOutcome } from "../src/qa/runs";
import { interruptAll, setTurnRunner } from "../src/sessions/manager";
import { resetSetting, setSetting } from "../src/settings";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState } from "./helpers";

setDefaultTimeout(60_000);

const TOKEN = "qa-test-token";
const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let srv: ReturnType<typeof startServer>;
let dir: string;
let root: string;
let hold: boolean;
const gates: Array<() => void> = [];

const FEATURES = "# Features\n## Checkout\nid: checkout\nwhere: /cart\nPays.\n## Invite\nid: invite\nwhere: /team\nInvites.\n";
const PLAN = "---\ntitle: Checkout flow\n---\n## Steps\n1. [s-open] Open the cart\n   path: /cart\n   expect: Two items\n";

beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(() => srv.stop());
beforeEach(() => {
  resetState();
  db().exec("DELETE FROM qa_runs; DELETE FROM qa_jobs; DELETE FROM qa_pipelines");
  process.env.TRB_CHROME = process.execPath;
  findChrome({ fresh: true });
  setSetting("agent_browser", "on");
  dir = makeRepo({ "a.txt": "x\n", "lab/features.md": FEATURES, "lab/qa/checkout.md": PLAN });
  root = Workspaces.open(dir).id;
  hold = false;
  setTurnRunner(async (o: RunTurnOptions) => {
    if (hold) await new Promise<void>((r) => gates.push(r));
    const session = o.key.slice(0, o.key.indexOf("-"));
    const job = jobOfSession(session);
    if (job?.stage === "test") for (const r of runsOfSession(session)) for (const s of r.steps) setOutcome(r.id as never, s.id as never, { state: "pass", at: 1, note: "ok" });
    return ok("done");
  });
  startQaDriver();
});
afterEach(async () => {
  stopQaDriver();
  for (const g of gates.splice(0)) g();
  await interruptAll();
  setTurnRunner(null);
  resetSetting("agent_browser");
});

async function call(p: string, method = "GET", body?: unknown, auth = true) {
  const res = await fetch(`${srv.url}/api/qa/${p}`, { method, headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const at = (rest = "") => `${root}${rest ? `/${rest}` : ""}`;
const request = (stages: object, o: object = {}) => ({ stages, scope: { kind: "all" }, pace: "auto", driver: { kind: "agent" }, ...o });
async function ended() {
  for (let i = 0; i < 400; i++) {
    const b = (await call(at())).data;
    if (b.pipeline?.control.kind === "ended") return b;
    await sleep(25);
  }
  throw new Error("the pipeline did not end");
}

describe("the board and its reads", () => {
  test("auth is required, and an unknown root is a 404", async () => {
    expect((await call(at(), "GET", undefined, false)).status).toBe(401);
    expect((await call("w_nope")).status).toBe(404);
  });

  test("GET the board", async () => {
    const r = await call(at());
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ browser: true, map: { exists: true, activity: { kind: "idle" } }, bugsWithoutFeature: [], plansWithoutFeature: [], pipeline: null });
    expect(r.data.features.map((f: any) => [f.id, f.plan.kind])).toEqual([["checkout", "ready"], ["invite", "missing"]]);
  });

  test("GET a feature's detail; an unknown feature is a 404", async () => {
    const r = await call(at("features/checkout"));
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ feature: { id: "checkout" }, plan: { title: "Checkout flow", path: "lab/qa/checkout.md" }, runs: [], lastRun: null });
    expect(r.data.plan.steps[0]).toEqual({ id: "s-open", action: "Open the cart", expected: "Two items", path: "/cart", last: null });
    const missing = await call(at("features/nope"));
    expect(missing.status).toBe(404);
    expect(missing.data).toEqual({ error: 'No feature "nope".' });
  });

  test("GET a run: a bad id is 400, another project's or an unknown run is 404", async () => {
    await call(at("pipelines"), "POST", request({ test: { batching: "each" } }));
    const b = await ended();
    const id = (await call(at("features/checkout"))).data.runs[0].id;
    const r = await call(at(`runs/${id}`));
    expect(r.status).toBe(200);
    expect(r.data.summary).toMatchObject({ id, feature: "checkout", finished: true, counts: { pass: 1 } });
    expect(r.data.run.steps[0].outcome.state).toBe("pass");
    expect(b.pipeline.jobs).toHaveLength(1);
    expect((await call(at("runs/Bad Id"))).status).toBe(400);
    expect((await call(at("runs/qa_nope"))).status).toBe(404);
    const other = Workspaces.open(makeRepo({ "a.txt": "y\n" })).id;
    expect((await call(`${other}/runs/${id}`)).status).toBe(404);
  });

  test("a route that does not exist is a 404, and the old routes are gone", async () => {
    expect((await call(at("nothing"))).status).toBe(404);
    for (const old of ["plans", "features"]) expect((await call(at(old))).status).toBe(404);
    for (const old of ["e2e", "batches/x/cancel", "features/map", "plans"]) expect((await call(at(old), "POST", {})).status).toBe(404);
  });
});

describe("pipelines", () => {
  test("POST starts a pipeline: 201 with its view, and the board shows it", async () => {
    hold = true;
    const r = await call(at("pipelines"), "POST", request({ test: { batching: "each" } }, { note: "  careful  ", baseUrl: "http://localhost:3000/" }));
    expect(r.status).toBe(201);
    const id = r.data.pipeline.id;
    expect(id).toMatch(/^qap_/);
    expect(r.data.pipeline).toMatchObject({
      config: { stages: { test: { batching: "each" } }, scope: { kind: "all" }, pace: "auto", note: "careful", baseUrl: "http://localhost:3000" },
      control: { kind: "running", stage: "test" },
    });
    expect(r.data.pipeline.jobs).toHaveLength(1);
    expect(r.data.pipeline.jobs[0]).toMatchObject({ stage: "test", units: ["checkout"], pair: false, state: "running", error: null });
    expect(r.data.pipeline.stages.map((s: any) => s.stage)).toEqual(["map", "plan", "test", "fix"]);
    const board = (await call(at())).data;
    expect(board.pipeline.id).toBe(id);
    expect(board.features[0].activity.test).toMatchObject({ kind: "working" });
  });

  test("bad bodies are 400 with the parseConfig message", async () => {
    const bad = async (body: unknown, msg: string) => {
      const r = await call(at("pipelines"), "POST", body);
      expect(r.status).toBe(400);
      expect(r.data.error).toContain(msg);
    };
    await bad({ ...request({}) }, "Pick at least one stage.");
    await bad(request({ plan: { batching: "each" } }, { scope: { kind: "bugs", ids: ["bug-a"] } }), "A list of bugs can only be fixed: choose the Fix stage alone.");
    await bad(request({ plan: { batching: "each" } }, { scope: { kind: "features", ids: ["nope"] } }), 'No feature "nope".');
    await bad(request({ plan: { batching: "each" } }, { driver: { kind: "pair", pairId: "nope" } }), 'No Hydra pair "nope". See `trb pair list`.');
    await bad(request({ plan: { batching: "x" } }), 'batching must be "each" or "together".');
    await bad(request({ plan: { batching: "each" } }, { pace: "fast" }), 'pace must be "auto" or "step".');
    await bad(request({ plan: { batching: "each" } }, { baseUrl: "ftp://x" }), "baseUrl must be an http or https address.");
  });

  test("the agent browser must be on for map, plan and test, and not for fix", async () => {
    setSetting("agent_browser", "off");
    const r = await call(at("pipelines"), "POST", request({ map: {} }));
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("trb config set agent_browser on");
    createBugFinding(dir, { title: "A bug", body: "x", bug: { url: "http://localhost:3000/x", capture: null, shot: "none", kind: "functional", feature: null }, impact: "medium", effort: "s" });
    hold = true;
    expect((await call(at("pipelines"), "POST", request({ fix: { batching: "each" } }))).status).toBe(201);
  });

  test("a second start while one runs is a 409", async () => {
    hold = true;
    await call(at("pipelines"), "POST", request({ test: { batching: "each" } }));
    const r = await call(at("pipelines"), "POST", request({ test: { batching: "each" } }));
    expect(r.status).toBe(409);
    expect(r.data).toEqual({ error: "A QA pipeline is already running in this project. Stop it or wait for it." });
  });

  test("continue: 200 when held, 409 when not, 404 for an unknown pipeline", async () => {
    const started = await call(at("pipelines"), "POST", request({ test: { batching: "each" }, fix: { batching: "each" } }, { pace: "step" }));
    const id = started.data.pipeline.id;
    for (let i = 0; i < 200 && (await call(at())).data.pipeline.control.kind !== "held"; i++) await sleep(25);
    const held = (await call(at())).data.pipeline;
    expect(held.control).toEqual({ kind: "held", after: "test", next: "fix" });
    const c = await call(at(`pipelines/${id}/continue`), "POST");
    expect(c.status).toBe(200);
    expect(["running", "ended"]).toContain(c.data.pipeline.control.kind);
    const again = await call(at(`pipelines/${id}/continue`), "POST");
    expect(again.status).toBe(409);
    expect(again.data).toEqual({ error: "The pipeline is not waiting to continue." });
    const none = await call(at("pipelines/qap_nope/continue"), "POST");
    expect(none.status).toBe(404);
    expect(none.data).toEqual({ error: 'No pipeline "qap_nope".' });
  });

  test("stop: running becomes stopping then ended; it is idempotent; an unknown pipeline is a 404", async () => {
    hold = true;
    const id = (await call(at("pipelines"), "POST", request({ test: { batching: "each" } }))).data.pipeline.id;
    const s = await call(at(`pipelines/${id}/stop`), "POST");
    expect(s.status).toBe(200);
    expect(s.data.pipeline.control).toEqual({ kind: "stopping", stage: "test" });
    expect((await call(at(`pipelines/${id}/stop`), "POST")).data.pipeline.control.kind).toBe("stopping");
    hold = false;
    for (const g of gates.splice(0)) g();
    const b = await ended();
    expect(b.pipeline.control).toMatchObject({ kind: "ended", reason: "stopped" });
    expect((await call(at(`pipelines/${id}/stop`), "POST")).data.pipeline.control.kind).toBe("ended");
    expect((await call(at("pipelines/qap_nope/stop"), "POST")).status).toBe(404);
  });
});

describe("deleting a plan", () => {
  test("200 removes the file and its runs; 400 for a bad name; 404 for a missing plan; 409 while a job works on it", async () => {
    hold = true;
    await call(at("pipelines"), "POST", request({ test: { batching: "each" } }));
    const busy = await call(at("plans/checkout"), "DELETE");
    expect(busy.status).toBe(409);
    expect(busy.data).toEqual({ error: 'A job is working on "checkout". Wait for it.' });
    hold = false;
    for (const g of gates.splice(0)) g();
    await ended();
    const r = await call(at("plans/checkout"), "DELETE");
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "lab/qa/checkout.md"))).toBe(false);
    expect(db().prepare("SELECT COUNT(*) AS n FROM qa_runs").get()).toEqual({ n: 0 });
    expect((await call(at("plans/checkout"), "DELETE")).status).toBe(404);
    expect((await call(at("plans/Bad_Name"), "DELETE")).status).toBe(400);
  });
});
