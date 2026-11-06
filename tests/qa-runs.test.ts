import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { createBugFinding } from "../src/lab/findings";
import { createPlan, editPlan, listPlans, readPlan, removePlan } from "../src/qa/plan";
import { currentStep, getRun, lastOutcomes, listRuns, parseOutcome, setOutcome, startRun } from "../src/qa/runs";
import type { StepId } from "../src/qa/types";
import { makeDir } from "./helpers";

let root: string;
beforeEach(() => {
  db().exec("DELETE FROM qa_runs");
  root = makeDir();
});

function plan() {
  const p = createPlan(root, "Cart", { kind: "manual" });
  editPlan(root, p.slug, { op: "add", step: { action: "Open the cart", expected: "Two items", path: "/cart" as any }, after: "start" });
  return editPlan(root, p.slug, { op: "add", step: { action: "Pay", expected: "Confirmation", path: null }, after: readPlan(root, p.slug).steps[0]!.id });
}

describe("runs", () => {
  test("startRun copies the steps as pending and computes progress", () => {
    const p = plan();
    const r = startRun(root, p);
    expect<unknown>(r.steps.map((s) => s.action)).toEqual(["Open the cart", "Pay"]);
    expect<unknown>(r.steps.every((s) => s.outcome.state === "pending")).toBe(true);
    expect<unknown>(currentStep(r)!.id).toBe(p.steps[0]!.id);
    expect<unknown>(getRun(r.id)).toEqual(r);
    expect<unknown>(listRuns(root, p.slug)[0]).toMatchObject({ id: r.id, finished: false, counts: { pending: 2, pass: 0, fail: 0, skip: 0, blocked: 0 } });
  });

  test("an empty plan and a broken plan cannot be run", () => {
    expect<unknown>(() => startRun(root, createPlan(root, "Empty", { kind: "manual" }))).toThrow("no steps");
    fs.writeFileSync(path.join(root, "lab/qa/empty.md"), "junk");
    expect<unknown>(() => startRun(root, readPlan(root, "empty" as any))).toThrow("cannot be read");
  });

  test("a failed step can only link a bug that exists in the project", () => {
    const r = startRun(root, plan());
    const id = r.steps[0]!.id;
    expect<unknown>(() => setOutcome(r.id, id, { state: "fail", at: 1, actual: "x", bug: "bug-does-not-exist" })).toThrow("no finding");
    expect(getRun(r.id)!.steps[0]!.outcome.state).toBe("pending");
    const f = createBugFinding(root, { title: "Cart breaks", body: "x", bug: { url: "http://localhost:3000/cart", capture: null, shot: "none", kind: "functional" }, impact: "medium", effort: "s" });
    setOutcome(r.id, id, { state: "fail", at: 1, actual: "x", bug: f.id });
    expect(getRun(r.id)!.steps[0]!.outcome).toMatchObject({ state: "fail", bug: f.id });
  });

  test("setOutcome refuses a step that is not in the run", () => {
    const r = startRun(root, plan());
    expect<unknown>(() => setOutcome(r.id, "s-zzzz" as StepId, { state: "pass", at: 1, note: "" })).toThrow("not in run");
    expect<unknown>(() => setOutcome("qa_nope" as any, r.steps[0]!.id, { state: "pass", at: 1, note: "" })).toThrow("No run");
  });

  test("blocked needs a note", () => {
    const r = startRun(root, plan());
    const id = r.steps[0]!.id;
    expect<unknown>(() => setOutcome(r.id, id, parseOutcome({ state: "blocked", note: "  " }))).toThrow("needs a note");
    expect<unknown>(getRun(r.id)!.steps[0]!.outcome.state).toBe("pending");
    setOutcome(r.id, id, parseOutcome({ state: "blocked", note: "No test card" }));
    expect<unknown>(getRun(r.id)!.steps[0]!.outcome).toMatchObject({ state: "blocked", note: "No test card" });
  });

  test("outcomes are parsed at the boundary", () => {
    expect<unknown>(() => parseOutcome({ state: "great" })).toThrow("Unknown outcome");
    expect<unknown>(parseOutcome({ state: "fail", actual: " 500 page " }, 5)).toEqual({ state: "fail", at: 5, actual: "500 page", bug: null });
    expect<unknown>(parseOutcome({ state: "pass" }, 5)).toEqual({ state: "pass", at: 5, note: "" });
    expect<unknown>(parseOutcome({ state: "pending" })).toEqual({ state: "pending" });
  });

  test("a run finishes when no step is pending", () => {
    const r = startRun(root, plan());
    setOutcome(r.id, r.steps[0]!.id, parseOutcome({ state: "pass" }));
    setOutcome(r.id, r.steps[1]!.id, parseOutcome({ state: "fail", actual: "500" }));
    expect<unknown>(listRuns(root, r.plan)[0]).toMatchObject({ finished: true, counts: { pass: 1, fail: 1 } });
    expect<unknown>(currentStep(getRun(r.id)!)).toBeNull();
    expect<unknown>(listPlans(root)[0]!.lastRun).toMatchObject({ id: r.id, finished: true });
  });

  test("a re-run after an edit copies the new steps and the old run keeps its text", () => {
    const p = plan();
    const first = startRun(root, p);
    editPlan(root, p.slug, { op: "update", id: p.steps[1]!.id, fields: { action: "Pay with a saved card" } });
    editPlan(root, p.slug, { op: "remove", id: p.steps[0]!.id });
    const second = startRun(root, readPlan(root, p.slug));
    expect<unknown>(getRun(first.id)!.steps.map((s) => s.action)).toEqual(["Open the cart", "Pay"]);
    expect<unknown>(second.steps.map((s) => s.action)).toEqual(["Pay with a saved card"]);
    expect<unknown>(listRuns(root, p.slug).map((r) => r.id)).toEqual([second.id, first.id]);
  });

  test("lastOutcomes gives each step its newest recorded outcome", () => {
    const p = plan();
    const a = startRun(root, p);
    setOutcome(a.id, a.steps[0]!.id, parseOutcome({ state: "fail", actual: "x" }));
    const b = startRun(root, p);
    setOutcome(b.id, b.steps[0]!.id, parseOutcome({ state: "pass" }));
    const last = lastOutcomes(root, p.slug);
    expect<unknown>(last[p.steps[0]!.id]).toMatchObject({ run: b.id, outcome: { state: "pass" } });
    expect<unknown>(last[p.steps[1]!.id]).toBeUndefined();
  });

  test("removing a plan removes its runs", () => {
    const p = plan();
    const r = startRun(root, p);
    removePlan(root, p.slug);
    expect<unknown>(getRun(r.id)).toBeNull();
  });
});
