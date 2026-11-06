import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { createPlan, decide, editPlan, listPlans, parsePlanEdit, readPlan, removePlan, stepPath } from "../src/qa/plan";
import type { PlanSlug, ProposalId, StepId } from "../src/qa/types";
import { makeDir } from "./helpers";

let root: string;
beforeEach(() => {
  root = makeDir();
});

const planPath = (slug: string) => path.join(root, "lab/qa", `${slug}.md`);
const propPath = (slug: string) => path.join(root, "lab/qa", `${slug}.proposals.md`);
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const ids = (xs: Array<{ id: string }>): string[] => xs.map((x) => x.id);
const slug = "checkout" as PlanSlug;

const CANON = `---
title: Checkout with saved card
source: spec:specs/121-checkout
---
Intro text.
## Steps
1. [s-7k2p] Open the cart with two items
   path: /cart
   expect: Both items listed, total 42.00
2. [s-9m3q] Pay with the saved card
   expect: Order confirmation shows
`;

describe("plan files", () => {
  test("a canonical plan reads and writes back byte-identical", () => {
    put(planPath("checkout"), CANON);
    const p = readPlan(root, slug);
    expect<unknown>(p.problem).toBeNull();
    expect<unknown>(p.source).toEqual({ kind: "spec", dir: "specs/121-checkout" });
    expect<unknown>(ids(p.steps)).toEqual(["s-7k2p", "s-9m3q"]);
    expect<unknown>(p.steps[0]).toMatchObject({ action: "Open the cart with two items", path: "/cart", expected: "Both items listed, total 42.00" });
    expect<unknown>(fs.readFileSync(planPath("checkout"), "utf-8")).toBe(CANON);
    editPlan(root, slug, { op: "update", id: "s-7k2p" as StepId, fields: { action: "Open the cart with two items" } });
    expect<unknown>(fs.readFileSync(planPath("checkout"), "utf-8")).toBe(CANON);
  });

  test("CRLF files keep their line endings", () => {
    const crlf = CANON.replace(/\n/g, "\r\n");
    put(planPath("checkout"), crlf);
    readPlan(root, slug);
    expect<unknown>(fs.readFileSync(planPath("checkout"), "utf-8")).toBe(crlf);
    editPlan(root, slug, { op: "update", id: "s-7k2p" as StepId, fields: { expected: "x" } });
    expect<unknown>(fs.readFileSync(planPath("checkout"), "utf-8").replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("steps without an id get one once, and the file is not touched again", () => {
    put(planPath("checkout"), "---\ntitle: T\nsource: manual\n---\n## Steps\n1. First\n2. [s-aaaa] Second\n3. Third\n   path: http://localhost:3000/pay?x=1\n");
    const a = readPlan(root, slug);
    expect<unknown>(ids(a.steps)).toHaveLength(3);
    expect<unknown>(new Set(ids(a.steps)).size).toBe(3);
    expect<unknown>(a.steps[1]!.id).toBe("s-aaaa");
    expect<unknown>(a.steps[2]!.path).toBe("/pay?x=1");
    const after = fs.readFileSync(planPath("checkout"), "utf-8");
    const before = fs.statSync(planPath("checkout")).mtimeMs;
    const b = readPlan(root, slug);
    expect<unknown>(b.steps).toEqual(a.steps);
    expect<unknown>(fs.readFileSync(planPath("checkout"), "utf-8")).toBe(after);
    expect<unknown>(fs.statSync(planPath("checkout")).mtimeMs).toBe(before);
  });

  test("a malformed file is listed with a problem, never dropped", () => {
    put(planPath("checkout"), CANON);
    put(planPath("broken"), "no front matter here\n");
    put(planPath("badstep"), "---\ntitle: B\nsource: manual\n---\n## Steps\n1. [s-aaaa] ok\n   color: red\n");
    put(planPath("Bad_Name"), CANON);
    const list = listPlans(root);
    expect<unknown>(list.map((p) => p.slug).sort()).toEqual(["Bad_Name", "badstep", "broken", "checkout"]);
    expect<unknown>(list.find((p) => p.slug === "checkout")).toMatchObject({ title: "Checkout with saved card", steps: 2, proposals: 0, problem: null });
    expect<unknown>(list.find((p) => p.slug === "broken")!.problem).toContain("front matter");
    expect<unknown>(list.find((p) => p.slug === "badstep")!.problem).toContain("line 7");
    expect<unknown>(list.find((p) => p.slug === "Bad_Name")!.problem).toContain("not a plan name");
    expect<unknown>(() => editPlan(root, "broken" as PlanSlug, { op: "remove", id: "s-aaaa" as StepId })).toThrow("cannot be read");
    expect<unknown>(fs.readFileSync(planPath("broken"), "utf-8")).toBe("no front matter here\n");
  });

  test("createPlan picks a free slug and an empty title is refused", () => {
    const a = createPlan(root, "Checkout flow!", { kind: "manual" });
    const b = createPlan(root, "Checkout flow!", { kind: "text" });
    expect<unknown>([a.slug, b.slug]).toEqual(["checkout-flow", "checkout-flow-2"]);
    expect<unknown>(() => createPlan(root, "  ", { kind: "manual" })).toThrow("title");
  });

  test("removePlan deletes both files and 404s on a missing plan", () => {
    put(planPath("checkout"), CANON);
    put(propPath("checkout"), "## Steps\n1. [p-aaaa] X\n   after: start\n");
    removePlan(root, slug);
    expect<unknown>(fs.existsSync(planPath("checkout"))).toBe(false);
    expect<unknown>(fs.existsSync(propPath("checkout"))).toBe(false);
    expect<unknown>(() => readPlan(root, slug)).toThrow("No QA plan");
  });
});

describe("editPlan", () => {
  const sid = (n: string) => n as StepId;
  beforeEach(() => put(planPath("checkout"), CANON));

  test("add after a step and at the start", () => {
    editPlan(root, slug, { op: "add", step: { action: "Apply a coupon", expected: "Total drops", path: null }, after: sid("s-7k2p") });
    const p = editPlan(root, slug, { op: "add", step: { action: "Sign in", expected: "", path: "/login" as any }, after: "start" });
    expect<unknown>(p.steps.map((s) => s.action)).toEqual(["Sign in", "Open the cart with two items", "Apply a coupon", "Pay with the saved card"]);
    expect<unknown>(p.steps[0]!.id).toMatch(/^s-[a-z0-9]{4}$/);
  });

  test("update changes only the given fields, and a null path clears it", () => {
    const p = editPlan(root, slug, { op: "update", id: sid("s-7k2p"), fields: { expected: "Three items", path: null } });
    expect<unknown>(p.steps[0]).toMatchObject({ action: "Open the cart with two items", expected: "Three items", path: null });
  });

  test("move and remove", () => {
    let p = editPlan(root, slug, { op: "move", id: sid("s-9m3q"), after: "start" });
    expect<unknown>(ids(p.steps)).toEqual(["s-9m3q", "s-7k2p"]);
    p = editPlan(root, slug, { op: "remove", id: sid("s-9m3q") });
    expect<unknown>(ids(p.steps)).toEqual(["s-7k2p"]);
  });

  test("an unknown step or anchor is refused and the file is unchanged", () => {
    expect<unknown>(() => editPlan(root, slug, { op: "remove", id: sid("s-zzzz") })).toThrow("No step s-zzzz");
    expect<unknown>(() => editPlan(root, slug, { op: "add", step: { action: "x", expected: "", path: null }, after: sid("s-zzzz") })).toThrow("No step");
    expect<unknown>(() => editPlan(root, slug, { op: "move", id: sid("s-7k2p"), after: sid("s-7k2p") })).toThrow("itself");
    expect<unknown>(fs.readFileSync(planPath("checkout"), "utf-8")).toBe(CANON);
  });

  test("the API edit parser refuses bad input", () => {
    expect<unknown>(() => parsePlanEdit({ op: "nope" })).toThrow("Unknown edit");
    expect<unknown>(() => parsePlanEdit({ op: "add", step: { action: "" }, after: "start" })).toThrow("action");
    expect<unknown>(() => parsePlanEdit({ op: "add", step: { action: "x", path: "https://example.com/a" }, after: "start" })).toThrow("not a path");
    expect<unknown>(() => parsePlanEdit({ op: "remove", id: "../x" })).toThrow("step id");
    expect<unknown>(stepPath("http://localhost:5173")).toBe("/");
  });
});

describe("proposals", () => {
  const PROPS = `## Steps
1. [p-aaaa] Try an expired card
   expect: A clear error, cart kept
   after: s-7k2p
   why: Payment failures are common
2. [p-bbbb] Try an empty cart
   expect: Checkout is disabled
   after: s-7k2p
   why: Empty state
3. Open it on a phone
   after: start
   why: Mobile
`;
  beforeEach(() => {
    put(planPath("checkout"), CANON);
    put(propPath("checkout"), PROPS);
  });

  test("proposals are read and given ids when missing", () => {
    const p = readPlan(root, slug);
    expect<unknown>(ids(p.proposals).slice(0, 2)).toEqual(["p-aaaa", "p-bbbb"]);
    expect<unknown>(p.proposals[2]!.id).toMatch(/^p-[a-z0-9]{4}$/);
    expect<unknown>(p.proposals[0]).toMatchObject({ after: "s-7k2p", why: "Payment failures are common", orphan: false });
    expect<unknown>(fs.readFileSync(propPath("checkout"), "utf-8")).toContain(`[${p.proposals[2]!.id}] Open it on a phone`);
    expect<unknown>(p.steps).toHaveLength(2);
  });

  test("accept one: the step joins the plan with a fresh s- id and leaves the file", () => {
    const p = decide(root, slug, "p-bbbb" as ProposalId, "accept");
    expect<unknown>(p.steps.map((s) => s.action)).toEqual(["Open the cart with two items", "Try an empty cart", "Pay with the saved card"]);
    expect<unknown>(p.steps[1]!.id).toMatch(/^s-/);
    expect<unknown>(String(p.steps[1]!.id)).not.toBe("p-bbbb");
    expect<unknown>(ids(p.proposals)).not.toContain("p-bbbb");
    expect<unknown>(p.proposals).toHaveLength(2);
  });

  test("accept all keeps file order for a shared anchor and removes the file", () => {
    const p = decide(root, slug, "all", "accept");
    expect<unknown>(p.steps.map((s) => s.action)).toEqual(["Open it on a phone", "Open the cart with two items", "Try an expired card", "Try an empty cart", "Pay with the saved card"]);
    expect<unknown>(p.proposals).toEqual([]);
    expect<unknown>(fs.existsSync(propPath("checkout"))).toBe(false);
  });

  test("reject one and reject all leave the plan alone", () => {
    let p = decide(root, slug, "p-aaaa" as ProposalId, "reject");
    expect<unknown>(p.proposals).toHaveLength(2);
    expect<unknown>(p.steps).toHaveLength(2);
    p = decide(root, slug, "all", "reject");
    expect<unknown>(p.proposals).toEqual([]);
    expect<unknown>(fs.readFileSync(planPath("checkout"), "utf-8")).toBe(CANON);
  });

  test("an unknown proposal is a not-found", () => {
    expect<unknown>(() => decide(root, slug, "p-zzzz" as ProposalId, "accept")).toThrow("No proposal");
  });

  test("a proposal anchored to a deleted step lands at the end and is flagged", () => {
    editPlan(root, slug, { op: "remove", id: "s-7k2p" as StepId });
    let p = readPlan(root, slug);
    expect<unknown>(ids(p.proposals.filter((x) => x.orphan))).toEqual(["p-aaaa", "p-bbbb"]);
    expect<unknown>(String(p.proposals[0]!.after)).toBe("s-9m3q");
    expect<unknown>(p.proposals[2]!.orphan).toBe(false);
    p = decide(root, slug, "all", "accept");
    expect<unknown>(p.steps.map((s) => s.action)).toEqual(["Open it on a phone", "Pay with the saved card", "Try an expired card", "Try an empty cart"]);
  });

  test("a draft is proposals against an empty plan", () => {
    const d = createPlan(root, "Draft me", { kind: "text" });
    put(propPath(d.slug), "## Steps\n1. First\n   expect: a\n   after: start\n2. Second\n   expect: b\n   after: start\n3. Third\n   expect: c\n");
    const p = decide(root, d.slug, "all", "accept");
    expect<unknown>(p.steps.map((s) => s.action)).toEqual(["First", "Second", "Third"]);
  });

  test("a malformed proposals file is a problem on the plan, and the plan stays usable", () => {
    put(propPath("checkout"), "I could not do it\n");
    const p = readPlan(root, slug);
    expect<unknown>(p.proposalsProblem).toContain("## Steps");
    expect<unknown>(p.proposals).toEqual([]);
    expect<unknown>(p.steps).toHaveLength(2);
    put(propPath("checkout"), "## Steps\n1. [p-aaaa] X\n   after: p-bbbb\n");
    expect<unknown>(readPlan(root, slug).proposalsProblem).toContain("after must be");
  });
});
