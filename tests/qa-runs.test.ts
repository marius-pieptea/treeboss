import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { createBugFinding } from "../src/lab/findings";
import { realOf } from "../src/lab/tables";
import { readPlan, removePlan } from "../src/qa/plan";
import { qaContext, usesQaTools } from "../src/qa/registry";
import { currentStep, getRun, lastOutcomes, listRuns, parseOutcome, removeRun, runRoot, runsOfSession, setOutcome, setRunSession, startRun, summarize } from "../src/qa/runs";
import { executeQaTool } from "../src/qa/tools";
import type { FeatureId, RunId, StepId } from "../src/qa/types";
import { createLead, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { makeDir, resetState, settled } from "./helpers";

const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });

let root: string;
beforeEach(() => {
  resetState();
  db().exec("DELETE FROM qa_runs; DELETE FROM qa_jobs; DELETE FROM qa_pipelines");
  root = makeDir();
  setTurnRunner(async () => ok("done"));
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

const put = (slug: string, text: string) => {
  fs.mkdirSync(path.join(root, "lab/qa"), { recursive: true });
  fs.writeFileSync(path.join(root, "lab/qa", `${slug}.md`), text);
};
const CART = "---\ntitle: Cart\n---\n## Steps\n1. [s-open] Open the cart\n   path: /cart\n   expect: Two items\n2. [s-pay] Pay\n   expect: Confirmation\n";
const INVITE = "---\ntitle: Invite\n---\n## Steps\n1. [s-send] Send an invite\n   expect: Mail is sent\n";
const plan = (slug = "cart") => readPlan(root, slug as FeatureId);
const bug = () => createBugFinding(root, { title: "Cart breaks", body: "x", bug: { url: "http://localhost:3000/cart", capture: null, shot: "none", kind: "functional", feature: null }, impact: "medium", effort: "s" });

describe("runs", () => {
  test("startRun copies the steps as pending, names the feature and the walking session, and computes progress", () => {
    put("cart", CART);
    const r = startRun(root, plan(), "s_walker");
    expect<unknown>(r.steps.map((s) => s.action)).toEqual(["Open the cart", "Pay"]);
    expect<unknown>(r.steps.every((s) => s.outcome.state === "pending")).toBe(true);
    expect<unknown>(currentStep(r)!.id).toBe("s-open");
    expect<unknown>(getRun(r.id as RunId)).toEqual(r);
    expect<unknown>(r).toMatchObject({ feature: "cart", sessionId: "s_walker" });
    expect<unknown>(listRuns(root, "cart")[0]).toEqual({ id: r.id, feature: "cart", startedAt: r.startedAt, finished: false, sessionId: "s_walker", counts: { pending: 2, pass: 0, fail: 0, skip: 0, blocked: 0 } });
    expect(runRoot(r.id as RunId)).toBe(realOf(root));
  });

  test("an empty plan and a broken plan cannot be run", () => {
    put("empty", "---\ntitle: Empty\n---\n## Steps\n");
    expect<unknown>(() => startRun(root, plan("empty"), null)).toThrow("no steps");
    put("junk", "junk");
    expect<unknown>(() => startRun(root, plan("junk"), null)).toThrow("cannot be read");
  });

  test("a session is attached after the fact, and runsOfSession lists its runs oldest first", () => {
    put("cart", CART);
    put("invite", INVITE);
    const a = startRun(root, plan("cart"), null);
    const b = startRun(root, plan("invite"), null);
    startRun(root, plan("cart"), "s_other");
    expect(runsOfSession("s_walker")).toEqual([]);
    setRunSession(a.id as RunId, "s_walker");
    setRunSession(b.id as RunId, "s_walker");
    expect(runsOfSession("s_walker").map((r) => r.id)).toEqual([a.id, b.id]);
    expect(runsOfSession("s_walker")[0]!.sessionId).toBe("s_walker");
  });

  test("a failed step can only link a bug that exists in the project", () => {
    put("cart", CART);
    const r = startRun(root, plan(), null);
    expect<unknown>(() => setOutcome(r.id as RunId, "s-open" as StepId, { state: "fail", at: 1, actual: "x", bug: "bug-does-not-exist" })).toThrow("no finding");
    expect(getRun(r.id as RunId)!.steps[0]!.outcome.state).toBe("pending");
    const f = bug();
    setOutcome(r.id as RunId, "s-open" as StepId, { state: "fail", at: 1, actual: "x", bug: f.id });
    expect(getRun(r.id as RunId)!.steps[0]!.outcome).toMatchObject({ state: "fail", bug: f.id });
  });

  test("setOutcome refuses a step that is not in the run, and a run that does not exist", () => {
    put("cart", CART);
    const r = startRun(root, plan(), null);
    expect<unknown>(() => setOutcome(r.id as RunId, "s-zzzz" as StepId, { state: "pass", at: 1, note: "" })).toThrow("not in run");
    expect<unknown>(() => setOutcome("qa_nope" as RunId, "s-open" as StepId, { state: "pass", at: 1, note: "" })).toThrow("No run");
  });

  test("blocked needs a note", () => {
    put("cart", CART);
    const r = startRun(root, plan(), null);
    expect<unknown>(() => setOutcome(r.id as RunId, "s-open" as StepId, parseOutcome({ state: "blocked", note: "  " }))).toThrow("needs a note");
    expect<unknown>(getRun(r.id as RunId)!.steps[0]!.outcome.state).toBe("pending");
    setOutcome(r.id as RunId, "s-open" as StepId, parseOutcome({ state: "blocked", note: "No test card" }));
    expect<unknown>(getRun(r.id as RunId)!.steps[0]!.outcome).toMatchObject({ state: "blocked", note: "No test card" });
  });

  test("outcomes are parsed at the boundary", () => {
    expect<unknown>(() => parseOutcome({ state: "great" })).toThrow("Unknown outcome");
    expect<unknown>(parseOutcome({ state: "fail", actual: " 500 page " }, 5)).toEqual({ state: "fail", at: 5, actual: "500 page", bug: null });
    expect<unknown>(parseOutcome({ state: "pass" }, 5)).toEqual({ state: "pass", at: 5, note: "" });
    expect<unknown>(parseOutcome({ state: "pending" })).toEqual({ state: "pending" });
  });

  test("a run finishes when no step is pending", () => {
    put("cart", CART);
    const r = startRun(root, plan(), null);
    setOutcome(r.id as RunId, "s-open" as StepId, parseOutcome({ state: "pass" }));
    setOutcome(r.id as RunId, "s-pay" as StepId, parseOutcome({ state: "fail", actual: "500" }));
    const done = getRun(r.id as RunId)!;
    expect<unknown>(summarize(done)).toMatchObject({ finished: true, counts: { pass: 1, fail: 1 } });
    expect<unknown>(listRuns(root, "cart")[0]).toMatchObject({ finished: true });
    expect<unknown>(currentStep(done)).toBeNull();
  });

  test("a re-run after the plan changes copies the new steps and the old run keeps its text", () => {
    put("cart", CART);
    const first = startRun(root, plan(), null);
    put("cart", "---\ntitle: Cart\n---\n## Steps\n1. [s-pay] Pay with a saved card\n   expect: Confirmation\n");
    const second = startRun(root, plan(), null);
    expect<unknown>(getRun(first.id as RunId)!.steps.map((s) => s.action)).toEqual(["Open the cart", "Pay"]);
    expect<unknown>(second.steps.map((s) => s.action)).toEqual(["Pay with a saved card"]);
    expect<unknown>(listRuns(root, "cart").map((r) => r.id)).toEqual([second.id, first.id]);
  });

  test("lastOutcomes gives each step its newest recorded state, across runs", () => {
    put("cart", CART);
    const a = startRun(root, plan(), null);
    setOutcome(a.id as RunId, "s-open" as StepId, parseOutcome({ state: "fail", actual: "x" }));
    const b = startRun(root, plan(), null);
    setOutcome(b.id as RunId, "s-open" as StepId, parseOutcome({ state: "pass" }));
    expect<unknown>(lastOutcomes(root, "cart")).toEqual({ "s-open": "pass" });
  });

  test("a run is removed alone, and with its plan", () => {
    put("cart", CART);
    const a = startRun(root, plan(), null);
    const b = startRun(root, plan(), null);
    removeRun(a.id as RunId);
    expect(getRun(a.id as RunId)).toBeNull();
    removePlan(root, "cart");
    expect(getRun(b.id as RunId)).toBeNull();
  });
});

describe("qa_record routes a step to its flow", () => {
  async function testJob(units: string[]) {
    const dir = root;
    const lead = (await settled(createLead({ prompt: "go", cwd: dir }).id)).id;
    const now = Date.now();
    db().prepare("INSERT INTO qa_pipelines (id, root_dir, config, control, units, created_at) VALUES ('qap_t', ?, '{}', '{\"kind\":\"running\",\"stage\":\"test\"}', NULL, ?)").run(realOf(dir), now);
    db().prepare("INSERT INTO qa_jobs (id, pipeline_id, root_dir, stage, units, session_id, sigs, started_at) VALUES ('qaj_t', 'qap_t', ?, 'test', ?, ?, '{}', ?)").run(realOf(dir), JSON.stringify(units), lead, now);
    return lead;
  }

  test("one run needs no flow; several runs need one", async () => {
    put("cart", CART);
    put("invite", INVITE);
    const lead = await testJob(["cart"]);
    const only = startRun(root, plan("cart"), lead);
    const r1 = await executeQaTool("qa_record", { step: "s-open", state: "pass", note: "saw two items" }, lead);
    expect(r1.text).toContain("Recorded s-open: pass. 1 of 2 steps recorded.");
    expect(getRun(only.id as RunId)!.steps[0]!.outcome.state).toBe("pass");

    const second = startRun(root, plan("invite"), lead);
    const ambiguous = await executeQaTool("qa_record", { step: "s-send", state: "pass" }, lead);
    expect(ambiguous.text).toContain("walks 2 flows: pass flow");
    const wrong = await executeQaTool("qa_record", { flow: "ghost", step: "s-send", state: "pass" }, lead);
    expect(wrong.text).toContain('no flow "ghost"');
    const routed = await executeQaTool("qa_record", { flow: "invite", step: "s-send", state: "pass", note: "mail arrived" }, lead);
    expect(routed.text).toContain("Every step is recorded");
    expect(getRun(second.id as RunId)!.steps[0]!.outcome.state).toBe("pass");
    expect(getRun(only.id as RunId)!.steps[1]!.outcome.state).toBe("pending");
  });

  test("a step of another flow is refused, a failure needs a bug that exists, and the note is added to the bug", async () => {
    put("cart", CART);
    put("invite", INVITE);
    const lead = await testJob(["cart", "invite"]);
    const cart = startRun(root, plan("cart"), lead);
    startRun(root, plan("invite"), lead);
    expect((await executeQaTool("qa_record", { flow: "cart", step: "s-send", state: "pass" }, lead)).text).toContain("is not in run");
    expect((await executeQaTool("qa_record", { flow: "cart", step: "s-open", state: "fail", actual: "500" }, lead)).text).toContain("needs bug");
    expect((await executeQaTool("qa_record", { flow: "cart", step: "s-open", state: "fail", actual: "500", bug: "bug-nope" }, lead)).text).toContain('no bug "bug-nope"');
    const f = bug();
    const r = await executeQaTool("qa_record", { flow: "cart", step: "s-open", state: "fail", actual: "500", bug: f.id }, lead);
    expect(r.text).toContain("Recorded s-open: fail");
    expect(getRun(cart.id as RunId)!.steps[0]!.outcome).toMatchObject({ state: "fail", bug: f.id });
    expect(fs.readFileSync(path.join(root, f.path), "utf-8")).toContain(`Seen failing in QA run ${cart.id} of the flow "cart", step s-open.`);
    expect((await executeQaTool("qa_record", { flow: "cart", step: "s-pay", state: "blocked" }, lead)).text).toContain("needs a note");
  });

  test("only a test job's session can record, and a head resolves to its lead's job", async () => {
    put("cart", CART);
    const lead = await testJob(["cart"]);
    const run = startRun(root, plan("cart"), lead);
    expect((await executeQaTool("qa_record", { step: "s-open", state: "pass" }, "s_nobody")).text).toContain("is for a QA test job");

    db().prepare("INSERT INTO sessions (id, title, parent_id, root_id, depth, engine, status, cwd, base_cwd, isolation) SELECT 's_head', 'h', id, id, 1, engine, 'idle', cwd, base_cwd, 'none' FROM sessions WHERE id = ?").run(lead);
    expect(qaContext("s_head")).toMatchObject({ head: true, job: { id: "qaj_t" } });
    expect(qaContext(lead)).toMatchObject({ head: false });
    expect(usesQaTools("s_head")).toBe(true);
    expect((await executeQaTool("qa_record", { step: "s-open", state: "pass", note: "ok" }, "s_head")).text).toContain("Recorded s-open");
    expect(getRun(run.id as RunId)!.steps[0]!.outcome.state).toBe("pass");

    db().prepare("UPDATE qa_jobs SET stage = 'fix'").run();
    expect(usesQaTools(lead)).toBe(false);
    expect(usesQaTools("s_nobody")).toBe(false);
  });
});
