import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { listPlans, planSignature, planText, QaNotFound, readPlan, removePlan, stepId } from "../src/qa/plan";
import { getRun, startRun } from "../src/qa/runs";
import type { FeatureId } from "../src/qa/types";
import { makeDir } from "./helpers";

let root: string;
beforeEach(() => {
  db().exec("DELETE FROM qa_runs");
  root = makeDir();
});

const planPath = (slug: string) => path.join(root, "lab/qa", `${slug}.md`);
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const FEATURES = "# Features\n## Checkout\nid: checkout\nwhere: /cart\nPays.\n## Invite a teammate\nid: invite\nwhere: /team\nInvites.\n";
const id = (s: string) => s as FeatureId;

const CANON = `---
title: Checkout with saved card
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
  test("a canonical plan reads and is left byte-identical", () => {
    put(planPath("checkout"), CANON);
    const p = readPlan(root, id("checkout"));
    expect<unknown>(p.problem).toBeNull();
    expect<unknown>(p).toMatchObject({ feature: "checkout", title: "Checkout with saved card", intro: "Intro text." });
    expect<unknown>(p.steps).toEqual([
      { id: "s-7k2p", action: "Open the cart with two items", expected: "Both items listed, total 42.00", path: "/cart" },
      { id: "s-9m3q", action: "Pay with the saved card", expected: "Order confirmation shows", path: null },
    ]);
    expect(fs.readFileSync(planPath("checkout"), "utf-8")).toBe(CANON);
  });

  test("steps written without an id get one once, and the ids they keep never change", () => {
    put(planPath("checkout"), "---\ntitle: Checkout\n---\n## Steps\n1. [s-keep] Keep me\n2. Add me\n   expect: It appears\n");
    const first = readPlan(root, id("checkout"));
    expect(first.steps[0]!.id).toBe("s-keep");
    expect(first.steps[1]!.id).toMatch(/^s-[a-z0-9]{4}$/);
    const written = fs.readFileSync(planPath("checkout"), "utf-8");
    expect(written).toContain(`2. [${first.steps[1]!.id}] Add me`);
    expect(readPlan(root, id("checkout")).steps.map((s) => s.id)).toEqual(first.steps.map((s) => s.id));
    expect(fs.readFileSync(planPath("checkout"), "utf-8")).toBe(written);
  });

  test("the eol of a CRLF plan is kept when ids are added", () => {
    put(planPath("checkout"), "---\r\ntitle: Checkout\r\n---\r\n## Steps\r\n1. A step\r\n");
    readPlan(root, id("checkout"));
    expect(fs.readFileSync(planPath("checkout"), "utf-8")).toMatch(/\r\n/);
    expect(fs.readFileSync(planPath("checkout"), "utf-8").replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("a source: line from an older plan is ignored", () => {
    put(planPath("checkout"), CANON.replace("title: Checkout with saved card\n", "title: Checkout with saved card\nsource: spec:specs/121-checkout\n"));
    const p = readPlan(root, id("checkout"));
    expect<unknown>(p.problem).toBeNull();
    expect(p.steps).toHaveLength(2);
  });

  test("a plan that cannot be read is reported, with no steps, and never dropped", () => {
    for (const [text, why] of [
      ["junk", "front matter"],
      ["---\ntitle: X\n", "never closed"],
      ["---\n---\n## Steps\n", "no title"],
      ["---\ntitle: X\n---\nno heading\n", "## Steps"],
      ["---\ntitle: X\n---\n## Steps\n1. A\n   path: cart\n", "not a path"],
      ["---\ntitle: X\n---\n## Steps\n1. [s-a] A\n2. [s-a] B\n", "used twice"],
      ["---\ntitle: X\n---\n## Steps\n1. A\n   expect: a\n   expect: b\n", "twice"],
      ["---\ntitle: X\n---\n## Steps\nloose text\n", "not a step"],
    ] as const) {
      put(planPath("broken"), text);
      const p = readPlan(root, id("broken"));
      expect(p.problem).toContain(why);
      expect<unknown>(p.steps).toEqual([]);
    }
  });

  test("a localhost url in path: is reduced to its path", () => {
    put(planPath("checkout"), "---\ntitle: X\n---\n## Steps\n1. A\n   path: http://localhost:3000/cart?x=1\n");
    expect<unknown>(readPlan(root, id("checkout")).steps[0]!.path).toBe("/cart?x=1");
  });

  test("a plan that does not exist is a QaNotFound, an oversized one a problem", () => {
    expect(() => readPlan(root, id("none"))).toThrow(QaNotFound);
    put(planPath("big"), "x".repeat(600 * 1024));
    expect(readPlan(root, id("big")).problem).toContain("KB");
  });

  test("signature and text change when the file does, and are null or absent without one", () => {
    expect(planSignature(root, id("checkout"))).toBeNull();
    expect(planText(root, id("checkout"))).toBeNull();
    put(planPath("checkout"), CANON);
    const a = planSignature(root, id("checkout"));
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    put(planPath("checkout"), CANON + "3. [s-zzzz] More\n");
    expect(planSignature(root, id("checkout"))).not.toBe(a);
    expect(planText(root, id("checkout"))).toContain("[s-zzzz]");
  });

  test("step ids are validated at the boundary", () => {
    expect(stepId("s-7k2p")).toBe("s-7k2p");
    expect(() => stepId("p-1")).toThrow("not a step id");
  });
});

describe("listPlans", () => {
  test("a plan is a feature's when its file name is a feature id; any other plan file is loose", () => {
    put(path.join(root, "lab/features.md"), FEATURES);
    put(planPath("checkout"), CANON);
    put(planPath("old-flow"), "---\ntitle: An old flow\n---\n## Steps\n1. [s-a1] One\n");
    put(planPath("Bad Name"), "---\ntitle: X\n---\n## Steps\n");
    put(planPath("old-flow.proposals"), "## Steps\n1. nope\n");
    put(planPath("checkout.proposals"), "garbage");
    const { byFeature, loose } = listPlans(root);
    expect([...byFeature.keys()]).toEqual(["checkout"]);
    expect(byFeature.get(id("checkout"))).toMatchObject({ title: "Checkout with saved card", updatedAt: expect.any(Number) });
    expect(byFeature.get(id("checkout"))!.steps).toHaveLength(2);
    expect(loose).toEqual([
      { slug: "Bad Name", title: "Bad Name", steps: 0, problem: expect.stringContaining("not a plan name"), path: "lab/qa/Bad Name.md" },
      { slug: "old-flow", title: "An old flow", steps: 1, problem: null, path: "lab/qa/old-flow.md" },
    ]);
  });

  test("with no folder and no features there is nothing", () => {
    const { byFeature, loose } = listPlans(root);
    expect(byFeature.size).toBe(0);
    expect(loose).toEqual([]);
  });

  test("a broken feature plan is listed with its problem", () => {
    put(path.join(root, "lab/features.md"), FEATURES);
    put(planPath("invite"), "junk");
    expect(listPlans(root).byFeature.get(id("invite"))!.problem).toContain("front matter");
  });
});

describe("removePlan", () => {
  test("deletes the file and its runs, and refuses a plan that is not there", () => {
    put(planPath("checkout"), CANON);
    const run = startRun(root, readPlan(root, id("checkout")), null);
    removePlan(root, "checkout");
    expect(fs.existsSync(planPath("checkout"))).toBe(false);
    expect(getRun(run.id as never)).toBeNull();
    expect(() => removePlan(root, "checkout")).toThrow('No plan "checkout".');
  });
});
