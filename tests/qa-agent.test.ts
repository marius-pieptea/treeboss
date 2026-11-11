import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { createBugFinding } from "../src/lab/findings";
import { featuresSignature, FEATURES_FILE, parseFeatures, readFeatures } from "../src/qa/features";
import { similarBug } from "../src/qa/tools";
import { QA_TOOL_SET, qaToolDefs } from "../src/qa/defs";
import { executeQaTool } from "../src/qa/tools";
import { makeDir } from "./helpers";

let root: string;
beforeEach(() => {
  root = makeDir();
});

const bug = (title: string, url = "http://localhost:3000/cart") => createBugFinding(root, { title, body: "x", bug: { url, capture: null, shot: "none", kind: "functional", feature: null }, impact: "medium", effort: "s" });

describe("feature map", () => {
  const MAP = "# Features\n\nIntro text.\n\n## Checkout\nid: checkout\nwhere: /cart, /checkout\nplans: cart\nA buyer pays.\n\nSecond line.\n\n## Apply a discount code\nid: apply-discount\nparent: checkout\nwhere: /cart\nA buyer enters a code.\n\n## Invite a teammate\nAn owner invites someone.\n\n## Checkout\nid: checkout\n";

  test("parses sections, keys and summaries, makes ids, and flags duplicates", () => {
    const { features, problem } = parseFeatures(MAP);
    expect(features.map((f) => f.id)).toEqual(["checkout", "apply-discount", "invite-a-teammate", "checkout-2"]);
    expect(features[0]).toEqual({ id: "checkout", title: "Checkout", where: ["/cart", "/checkout"], parent: null, summary: "A buyer pays.\n\nSecond line." });
    expect(features[1]).toMatchObject({ parent: "checkout", where: ["/cart"], summary: "A buyer enters a code." });
    expect(features[2]).toMatchObject({ where: [], parent: null, summary: "An owner invites someone." });
    expect(problem).toContain('Two features have the id "checkout"');
  });

  test("a plans: line is read and ignored, and does not leak into the summary", () => {
    const [f] = parseFeatures("## Checkout\nid: checkout\nplans: a, b\nPays.\n").features;
    expect(f).toEqual({ id: "checkout", title: "Checkout", where: [], parent: null, summary: "Pays." });
  });

  test("a parent must be a top-level feature of the map, else it is a problem and the parent is dropped", () => {
    const text = "## A\nid: a\n## B\nid: b\nparent: a\n## C\nid: c\nparent: b\n## D\nid: d\nparent: ghost\n## E\nid: e\nparent: e\n## F\nid: f\nparent: later\n## Later\nid: later\n";
    const { features, problem } = parseFeatures(text);
    expect(features.map((f) => [f.id, f.parent])).toEqual([["a", null], ["b", "a"], ["c", null], ["d", null], ["e", null], ["f", "later"], ["later", null]]);
    expect(problem).toContain('"C" has the parent "b", which has a parent itself');
    expect(problem).toContain('"D" has the parent "ghost", which is not a feature');
    expect(problem).toContain('"E" has the parent "e"');
  });

  test("a missing file is not a problem; a bad id is", () => {
    expect(readFeatures(root)).toEqual({ features: [], problem: null, exists: false, updatedAt: null });
    expect(parseFeatures("## X\nid: Not Valid\n").problem).toContain("lowercase");
  });

  test("readFeatures reports when the file was last written, and a file that is too big as a problem", () => {
    fs.mkdirSync(path.join(root, "lab"), { recursive: true });
    fs.writeFileSync(path.join(root, FEATURES_FILE), MAP);
    const r = readFeatures(root);
    expect(r.exists).toBe(true);
    expect(r.updatedAt).toBeGreaterThan(0);
    expect(r.features).toHaveLength(4);
    fs.writeFileSync(path.join(root, FEATURES_FILE), "x".repeat(300 * 1024));
    expect(readFeatures(root)).toMatchObject({ features: [], exists: true, problem: expect.stringContaining("KB") });
  });

  test("the signature tells whether the file changed", () => {
    expect(featuresSignature(root)).toBeNull();
    fs.mkdirSync(path.join(root, "lab"), { recursive: true });
    fs.writeFileSync(path.join(root, FEATURES_FILE), MAP);
    const a = featuresSignature(root);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(featuresSignature(root)).toBe(a);
    fs.appendFileSync(path.join(root, FEATURES_FILE), "\n## New\n");
    expect(featuresSignature(root)).not.toBe(a);
  });
});

describe("bug_log helpers", () => {
  test("similarBug matches the same title, or most of the words on the same page", () => {
    const open = [bug("Cart total ignores the discount code"), bug("Login button does nothing", "http://localhost:3000/login")];
    expect(similarBug("cart total ignores the discount code!", "http://localhost:3000/other", open)?.id).toBe(open[0]!.id);
    expect(similarBug("Discount code ignored by cart total", "http://localhost:3000/cart/", open)?.id).toBe(open[0]!.id);
    expect(similarBug("Discount code ignored by cart total", "http://localhost:3000/checkout", open)).toBeNull();
    expect(similarBug("Images missing on the cart", "http://localhost:3000/cart", open)).toBeNull();
  });
});

describe("the QA tools", () => {
  test("their names are stable and bug_log and qa_record take the flow and feature arguments", () => {
    expect([...QA_TOOL_SET].sort()).toEqual(["bug_log", "qa_record"]);
    const defs = Object.fromEntries(qaToolDefs().map((d) => [d.name, d.inputSchema.properties as Record<string, unknown>]));
    expect(Object.keys(defs.qa_record!)).toContain("flow");
    expect(Object.keys(defs.bug_log!)).toContain("feature");
    expect(JSON.stringify(qaToolDefs()).toLowerCase()).not.toContain("unconfirmed");
  });

  test("outside a QA job the tools refuse, and an unknown tool is named", async () => {
    expect((await executeQaTool("bug_log", { title: "x", steps: [], actual: "y" }, "s_nobody")).text).toContain("is for QA map, plan and test jobs");
    expect((await executeQaTool("qa_record", { step: "s-a", state: "pass" }, "s_nobody")).text).toContain("is for a QA test job");
    expect((await executeQaTool("nope", {}, "s_nobody")).text).toBe('Error: unknown tool "nope".');
  });
});
