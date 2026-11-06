import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import type { RunTurnOptions, TurnResult } from "../src/engines/runner";
import { interruptAll, setTurnRunner } from "../src/sessions/manager";
import { qaSession, startQaDriver, stopQaDriver } from "../src/qa/sessions";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState, settled } from "./helpers";

const TOKEN = "qa-test-token";
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
  db().exec("DELETE FROM qa_runs; DELETE FROM qa_sessions");
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

const PROPOSALS = "## Steps\n1. Try an expired card\n   expect: A clear error shows\n   after: start\n   why: Failures\n2. Try an empty cart\n   expect: Checkout is disabled\n   after: start\n   why: Empty state\n";

/** A turn runner that records every prompt and writes `file` (relative to the turn's cwd) when given. */
function runner(write?: { file: string; text: string }) {
  const prompts: string[] = [];
  setTurnRunner(async (o: RunTurnOptions) => {
    prompts.push(o.prompt);
    if (write) {
      fs.mkdirSync(path.dirname(path.join(o.cwd, write.file)), { recursive: true });
      fs.writeFileSync(path.join(o.cwd, write.file), write.text);
    }
    return ok("done");
  });
  return prompts;
}

describe("plans over HTTP", () => {
  test("auth is required", async () => {
    expect((await fetch(`${srv.url}/api/qa/${root}/plans`)).status).toBe(401);
  });

  test("create, edit, read and delete a plan", async () => {
    expect((await call("plans")).data).toEqual({ plans: [] });
    const made = await call("plans", "POST", { title: "Cart flow" });
    expect(made.status).toBe(201);
    expect(made.data.session).toBeNull();
    expect(made.data.plan).toMatchObject({ slug: "cart-flow", title: "Cart flow", source: { kind: "manual" }, steps: [], proposals: [] });

    const added = await call("plans/cart-flow", "PATCH", { edit: { op: "add", step: { action: "Open the cart", expected: "Two items", path: "http://localhost:3000/cart" }, after: "start" } });
    expect(added.status).toBe(200);
    expect(added.data.plan.steps[0]).toMatchObject({ action: "Open the cart", path: "/cart" });
    const id = added.data.plan.steps[0].id;
    expect(fs.existsSync(path.join(dir, "lab/qa/cart-flow.md"))).toBe(true);

    const upd = await call("plans/cart-flow", "PATCH", { edit: { op: "update", id, fields: { expected: "Three items" } } });
    expect(upd.data.plan.steps[0].expected).toBe("Three items");

    const got = await call("plans/cart-flow");
    expect(got.data.plan.steps).toHaveLength(1);
    expect(got.data).toMatchObject({ runs: [], lastOutcomes: {}, session: null });
    expect((await call("plans")).data.plans[0]).toMatchObject({ slug: "cart-flow", steps: 1, proposals: 0, problem: null, lastRun: null });

    expect((await call("plans/cart-flow", "DELETE")).data).toEqual({ ok: true });
    expect((await call("plans/cart-flow")).status).toBe(404);
  });

  test("a blank plan, with or without a manual source, never starts a draft", async () => {
    const prompts = runner();
    const made = await call("plans", "POST", { title: "Blank one", from: { kind: "manual" } });
    expect(made.status).toBe(201);
    expect(made.data.session).toBeNull();
    expect(made.data.plan).toMatchObject({ slug: "blank-one", source: { kind: "manual" } });
    expect(prompts).toHaveLength(0);
  });

  test("a text draft without a note names text as the source", async () => {
    const r = await call("plans", "POST", { title: "X", from: { kind: "text" } });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("a draft from text needs a note");
  });

  test("bad requests are 400 and missing things are 404", async () => {
    await call("plans", "POST", { title: "Cart flow" });
    expect((await call("plans", "POST", { title: "" })).status).toBe(400);
    expect((await call("plans", "POST", { title: "X", from: { kind: "bogus" } })).status).toBe(400);
    expect((await call("plans", "POST", { title: "X", from: { kind: "text" } })).status).toBe(400);
    expect((await call("plans/Cart_Flow")).status).toBe(400);
    expect((await call("plans/nope")).status).toBe(404);
    expect((await call("plans/cart-flow", "PATCH", { edit: { op: "remove", id: "s-zzzz" } })).status).toBe(400);
    expect((await call("plans/cart-flow", "PATCH", { edit: { op: "nope" } })).status).toBe(400);
    expect((await call("plans/cart-flow/proposals/p-zzzz", "POST", { decision: "accept" })).status).toBe(404);
    expect((await call("plans/cart-flow/proposals/all", "POST", { decision: "maybe" })).status).toBe(400);
    expect((await call("plans/cart-flow/suggest", "POST", { focus: ["vibes"] })).status).toBe(400);
    expect((await call("plans/cart-flow/runs", "POST")).status).toBe(400);
    expect((await call("runs/qa_nope")).status).toBe(404);
    expect((await call("nothing")).status).toBe(404);
  });

  test("a draft from a spec starts a session whose prompt names the source, then accept-all fills the plan", async () => {
    const prompts = runner({ file: "lab/qa/checkout.proposals.md", text: PROPOSALS });
    const made = await call("plans", "POST", { title: "Checkout", from: { kind: "spec", dir: "specs/121-checkout" }, note: "Mind the coupons" });
    expect(made.status).toBe(201);
    expect(made.data.plan).toMatchObject({ slug: "checkout", source: { kind: "spec", dir: "specs/121-checkout" } });
    expect(made.data.session).toMatchObject({ kind: "draft" });
    await settled(made.data.session.sessionId);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("specs/121-checkout");
    expect(prompts[0]).toContain("lab/qa/checkout.proposals.md");
    expect(prompts[0]).toContain("Mind the coupons");

    const got = await call("plans/checkout");
    expect(got.data.session).toMatchObject({ kind: "draft", running: false, problem: null });
    expect(got.data.plan.proposals).toHaveLength(2);
    expect(got.data.plan.proposals[0]).toMatchObject({ after: "start", why: "Failures", orphan: false });

    const acc = await call("plans/checkout/proposals/all", "POST", { decision: "accept" });
    expect(acc.data.plan.steps.map((s: any) => s.action)).toEqual(["Try an expired card", "Try an empty cart"]);
    expect(acc.data.plan.proposals).toEqual([]);
  });

  test("a draft from a diff and from a page name their source", async () => {
    const prompts = runner();
    const a = await call("plans", "POST", { title: "Diff", from: { kind: "diff", base: "main", head: "feat/x" } });
    await settled(a.data.session.sessionId);
    const b = await call("plans", "POST", { title: "Page", from: { kind: "page", path: "/pricing" } });
    await settled(b.data.session.sessionId);
    expect(prompts[0]).toContain("git diff main..feat/x");
    expect(prompts[1]).toContain("browser_navigate");
    expect(prompts[1]).toContain("/pricing");
  });

  test("suggest puts the existing steps and the focus in the prompt and records a missing file as a problem", async () => {
    await call("plans", "POST", { title: "Cart flow" });
    await call("plans/cart-flow", "PATCH", { edit: { op: "add", step: { action: "Open the cart", expected: "Two items" }, after: "start" } });
    const prompts = runner();
    const r = await call("plans/cart-flow/suggest", "POST", { focus: ["errors", "mobile"], note: "Payment especially" });
    expect(r.status).toBe(201);
    await settled(r.data.session.sessionId);
    expect(prompts[0]).toContain("Open the cart");
    expect(prompts[0]).toContain("- errors:");
    expect(prompts[0]).toContain("- mobile:");
    expect(prompts[0]).not.toContain("- accessibility:");
    expect(prompts[0]).toContain("Payment especially");
    expect(prompts[0]).toContain("Do not repeat any of them");
    expect(qaSession(dir, "cart-flow" as any)).toMatchObject({ kind: "suggest", running: false });
    expect(qaSession(dir, "cart-flow" as any)!.problem).toContain("did not write");
  });

  test("a malformed proposals file is recorded as the session's problem", async () => {
    await call("plans", "POST", { title: "Cart flow" });
    runner({ file: "lab/qa/cart-flow.proposals.md", text: "Sorry, I could not.\n" });
    const r = await call("plans/cart-flow/suggest", "POST", {});
    await settled(r.data.session.sessionId);
    expect(qaSession(dir, "cart-flow" as any)!.problem).toContain("malformed");
    expect((await call("plans/cart-flow")).data.plan.proposalsProblem).toContain("## Steps");
  });

  test("a suggest turn that writes nothing is a problem even when an earlier turn left proposals, which stay", async () => {
    await call("plans", "POST", { title: "Cart flow" });
    runner({ file: "lab/qa/cart-flow.proposals.md", text: PROPOSALS });
    const first = await call("plans/cart-flow/suggest", "POST", {});
    await settled(first.data.session.sessionId);
    expect(qaSession(dir, "cart-flow" as any)!.problem).toBeNull();

    runner();
    const second = await call("plans/cart-flow/suggest", "POST", {});
    await settled(second.data.session.sessionId);
    expect(qaSession(dir, "cart-flow" as any)!.problem).toContain("did not add");
    expect((await call("plans/cart-flow")).data.plan.proposals).toHaveLength(2);

    runner({ file: "lab/qa/cart-flow.proposals.md", text: `${PROPOSALS}3. Try a coupon
   expect: The total drops
   after: start
   why: Coupons
` });
    const third = await call("plans/cart-flow/suggest", "POST", {});
    await settled(third.data.session.sessionId);
    expect(qaSession(dir, "cart-flow" as any)!.problem).toBeNull();
  });

  test("only one QA session runs per plan", async () => {
    await call("plans", "POST", { title: "Cart flow" });
    const release: Array<() => void> = [];
    setTurnRunner(async () => {
      await new Promise<void>((r) => release.push(r));
      return ok("done");
    });
    const first = await call("plans/cart-flow/suggest", "POST", {});
    expect(first.status).toBe(201);
    expect((await call("plans/cart-flow")).data.session.running).toBe(true);
    expect((await call("plans/cart-flow/suggest", "POST", {})).status).toBe(409);
    release.splice(0).forEach((r) => r());
    await settled(first.data.session.sessionId);
    runner();
    expect((await call("plans/cart-flow/suggest", "POST", {})).status).toBe(201);
  });
});

describe("runs over HTTP", () => {
  test("start a run, mark steps, read it back", async () => {
    await call("plans", "POST", { title: "Cart flow" });
    const a = (await call("plans/cart-flow", "PATCH", { edit: { op: "add", step: { action: "Open the cart", expected: "Two items" }, after: "start" } })).data.plan.steps[0];
    const b = (await call("plans/cart-flow", "PATCH", { edit: { op: "add", step: { action: "Pay", expected: "Confirmation" }, after: a.id } })).data.plan.steps[1];

    const started = await call("plans/cart-flow/runs", "POST");
    expect(started.status).toBe(201);
    const runId = started.data.run.id;
    expect(started.data.summary).toMatchObject({ finished: false, counts: { pending: 2 } });

    const pass = await call(`runs/${runId}/steps/${a.id}`, "PUT", { outcome: { state: "pass", note: "ok" } });
    expect(pass.status).toBe(200);
    expect(pass.data.run.steps[0].outcome).toMatchObject({ state: "pass", note: "ok" });
    expect(typeof pass.data.run.steps[0].outcome.at).toBe("number");

    expect((await call(`runs/${runId}/steps/${b.id}`, "PUT", { outcome: { state: "blocked" } })).status).toBe(400);
    expect((await call(`runs/${runId}/steps/${b.id}`, "PUT", { outcome: { state: "great" } })).status).toBe(400);
    expect((await call(`runs/${runId}/steps/s-zzzz`, "PUT", { outcome: { state: "skip" } })).status).toBe(404);

    const fail = await call(`runs/${runId}/steps/${b.id}`, "PUT", { outcome: { state: "fail", actual: "500 page" } });
    expect(fail.data.summary).toMatchObject({ finished: true, counts: { pass: 1, fail: 1, pending: 0 } });
    expect(fail.data.run.steps[1].outcome).toMatchObject({ state: "fail", actual: "500 page", bug: null });
    expect((await call(`runs/${runId}/steps/${b.id}`, "PUT", { outcome: { state: "fail", bug: "bug-does-not-exist" } })).status).toBe(400);

    expect((await call(`runs/${runId}`)).data.run.steps).toHaveLength(2);
    const plan = await call("plans/cart-flow");
    expect(plan.data.runs).toHaveLength(1);
    expect(plan.data.lastOutcomes[b.id]).toMatchObject({ run: runId, outcome: { state: "fail" } });
    expect((await call("plans")).data.plans[0].lastRun).toMatchObject({ id: runId, finished: true });
  });
});
