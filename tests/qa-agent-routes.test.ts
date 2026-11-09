import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import type { RunTurnOptions, TurnResult } from "../src/engines/runner";
import { interruptAll, setTurnRunner } from "../src/sessions/manager";
import { setSetting } from "../src/settings";
import { startQaDriver, stopQaDriver } from "../src/qa/sessions";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState, settled } from "./helpers";

const TOKEN = "qa-agent-test-token";
const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });

let srv: ReturnType<typeof startServer>;
let dir: string;
let root: string;

beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
  startQaDriver();
});
afterAll(() => {
  stopQaDriver();
  srv.stop();
});
beforeEach(() => {
  resetState();
  setTurnRunner(null);
  db().exec("DELETE FROM qa_runs; DELETE FROM qa_sessions; DELETE FROM qa_batches");
  dir = makeRepo({ "a.txt": "x\n" });
  root = Workspaces.open(dir).id;
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

async function call(p: string, method = "GET", body?: unknown) {
  const res = await fetch(`${srv.url}/api/qa/${root}/${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const MAP = "# Features\n\n## Checkout\nid: checkout\nwhere: /cart\nA buyer pays.\n\n## Invite a teammate\nAn owner invites someone.\n";

describe("QA agent routes", () => {
  test("agent sessions that drive the app are refused, with the fix, while the agent browser is off", async () => {
    setSetting("agent_browser", "off");
    await call("plans", "POST", { title: "Cart" });
    await call("plans/cart", "PATCH", { edit: { op: "add", step: { action: "Open the cart" }, after: "start" } });
    for (const [p, body] of [
      ["plans/cart/runs", { agent: true }],
      ["plans/cart/explore", {}],
      ["features/map", {}],
      ["e2e", {}],
    ] as const) {
      const r = await call(p, "POST", body);
      expect(r.status).toBe(400);
      expect(r.data.error).toContain("agent browser is off");
    }
    // Nothing was left behind by the refused agent run, and a run by hand still starts.
    expect((await call("plans/cart")).data.runs).toEqual([]);
    expect((await call("plans/cart/runs", "POST", {})).status).toBe(201);
    // An exploration refused at creation leaves no plan.
    expect((await call("plans", "POST", { title: "Coupons", explore: true, note: "Try coupons" })).status).toBe(400);
    expect((await call("plans")).data.plans.map((p: { slug: string }) => p.slug)).toEqual(["cart"]);
  });

  test("the feature map lists coverage; drafting a plan for a feature links it", async () => {
    expect((await call("features")).data).toMatchObject({ features: [], exists: false, problem: null, session: null, batch: null });
    fs.mkdirSync(path.join(dir, "lab"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lab/features.md"), MAP);
    const prompts: string[] = [];
    setTurnRunner(async (o: RunTurnOptions) => {
      prompts.push(o.prompt);
      return ok("done");
    });
    const made = await call("features/checkout/plan", "POST", {});
    expect(made.status).toBe(201);
    expect(made.data.plan).toMatchObject({ slug: "checkout", title: "Checkout" });
    await settled(made.data.session.sessionId);
    expect(prompts[0]).toContain('Test the feature "Checkout" end to end');
    expect(prompts[0]).toContain("It lives on: /cart.");
    expect(fs.readFileSync(path.join(dir, "lab/features.md"), "utf-8")).toContain("where: /cart\nplans: checkout\nA buyer pays.");
    const view = (await call("features")).data;
    expect(view.features.map((f: { id: string; coverage: string }) => [f.id, f.coverage])).toEqual([
      ["checkout", "no-plan"],
      ["invite-a-teammate", "no-plan"],
    ]);
    expect(view.features[0].planInfo).toEqual([{ slug: "checkout", title: "Checkout", exists: true, steps: 0, lastRun: null }]);
    expect((await call("features/nope/plan", "POST", {})).status).toBe(404);
  });

  test("an end-to-end run checks the features and plans it names", async () => {
    setSetting("agent_browser", "on");
    fs.mkdirSync(path.join(dir, "lab"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lab/features.md"), MAP);
    const missing = await call("e2e", "POST", { features: ["nope"] });
    // Without Chrome on the machine the browser check refuses first; with it, the feature is not found.
    expect([400, 404]).toContain(missing.status);
    if (missing.status === 404) {
      expect(missing.data.error).toContain('No feature "nope"');
      expect((await call("e2e", "POST", { features: ["checkout"] })).data.error).toContain("no plans yet");
      expect((await call("e2e", "POST", { plans: ["ghost"] })).data.error).toContain('No plan "ghost"');
    }
    expect((await call("batches/qab_nope/cancel", "POST", {})).status).toBe(404);
  });
});
