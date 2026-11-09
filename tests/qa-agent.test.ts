import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { createBugFinding, patchFinding, readFinding, unconfirmedBug, writeFinding, type Finding } from "../src/lab/findings";
import { createPlan, editPlan, readPlan } from "../src/qa/plan";
import { getRun, listRuns, startRun } from "../src/qa/runs";
import { advanceBatch, cancelBatch, createBatch, getBatch } from "../src/qa/batches";
import { coverageOf, featureViews, FEATURES_FILE, linkPlan, parseFeatures, readFeatures } from "../src/qa/features";
import { finishQaTurn, parseBaseUrl, parseQaAsk, qaPrompt } from "../src/qa/sessions";
import { usesQaTools } from "../src/qa/registry";
import { executeQaTool, similarBug } from "../src/qa/tools";
import { qaToolDefs } from "../src/qa/defs";
import type { PlanSlug, PlanSummary, RunSummary } from "../src/qa/types";
import { realOf } from "../src/lab/tables";
import { makeDir } from "./helpers";

let root: string;
beforeEach(() => {
  db().exec("DELETE FROM qa_runs; DELETE FROM qa_sessions; DELETE FROM qa_batches");
  root = makeDir();
});

function plan(title = "Cart") {
  const p = createPlan(root, title, { kind: "manual" });
  editPlan(root, p.slug, { op: "add", step: { action: "Open the cart", expected: "Two items", path: "/cart" as any }, after: "start" });
  return editPlan(root, p.slug, { op: "add", step: { action: "Pay", expected: "Confirmation", path: null }, after: readPlan(root, p.slug).steps[0]!.id });
}

/** Registers `session` as a QA session of `slug`, the way startQaSession does before the first turn. */
function register(session: string, slug: string, kind: string, runId: string | null = null, batch: string | null = null) {
  db().prepare("INSERT OR REPLACE INTO qa_sessions (session_id, root_dir, plan, kind, problem, proposals_sig, run_id, batch_id) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)").run(session, realOf(root), slug, kind, runId, batch);
}

const bug = (title: string, url = "http://localhost:3000/cart") => createBugFinding(root, { title, body: "x", bug: { url, capture: null, shot: "none", kind: "functional" }, impact: "medium", effort: "s" });

describe("feature map", () => {
  const MAP = "# Features\n\nIntro text.\n\n## Checkout\nid: checkout\nwhere: /cart, /checkout\nplans: cart\nA buyer pays.\n\nSecond line.\n\n## Invite a teammate\nAn owner invites someone.\n\n## Checkout\nid: checkout\n";

  test("parses sections, keys, summaries and makes ids, flagging duplicates", () => {
    const { features, problem } = parseFeatures(MAP);
    expect(features.map((f) => f.id)).toEqual(["checkout", "invite-a-teammate", "checkout-2"]);
    expect(features[0]).toMatchObject({ title: "Checkout", where: ["/cart", "/checkout"], plans: ["cart"], summary: "A buyer pays.\n\nSecond line." });
    expect(features[1]).toMatchObject({ where: [], plans: [], summary: "An owner invites someone." });
    expect(problem).toContain('Two features have the id "checkout"');
  });

  test("a missing file is not a problem; a bad id is", () => {
    expect(readFeatures(root)).toEqual({ features: [], problem: null, exists: false });
    expect(parseFeatures("## X\nid: Not Valid\n").problem).toContain("lowercase");
  });

  test("linkPlan adds the slug to the plans line, or adds the line, touching nothing else", () => {
    fs.mkdirSync(path.join(root, "lab"), { recursive: true });
    fs.writeFileSync(path.join(root, FEATURES_FILE), MAP);
    linkPlan(root, "checkout", "checkout-errors");
    linkPlan(root, "invite-a-teammate", "invites");
    linkPlan(root, "checkout", "checkout-errors");
    const text = fs.readFileSync(path.join(root, FEATURES_FILE), "utf-8");
    expect(text).toContain("plans: cart, checkout-errors\nA buyer pays.");
    expect(text).toContain("## Invite a teammate\nplans: invites\nAn owner invites someone.");
    expect(text).toContain("Intro text.");
    expect(() => linkPlan(root, "nope", "x")).toThrow('No feature "nope"');
  });

  test("coverage reads the last run of each plan", () => {
    const run = (counts: Partial<RunSummary["counts"]>, finished = true): RunSummary => ({ id: "qa_1" as RunSummary["id"], plan: "p" as PlanSlug, startedAt: 1, finished, states: {}, counts: { pending: 0, pass: 0, fail: 0, skip: 0, blocked: 0, ...counts } });
    const p = (lastRun: RunSummary | null, exists = true) => ({ slug: "p", title: "P", exists, steps: 2, lastRun });
    expect(coverageOf([])).toBe("no-plan");
    expect(coverageOf([p(null, false)])).toBe("no-plan");
    expect(coverageOf([p(null)])).toBe("not-run");
    expect(coverageOf([p(run({ pass: 2 })), p(run({ fail: 1, pass: 1 }))])).toBe("failing");
    expect(coverageOf([p(run({ pass: 2 }))])).toBe("passing");
    expect(coverageOf([p(run({ pass: 1, blocked: 1 }))])).toBe("partial");
    expect(coverageOf([p(run({ pass: 2 })), p(null)])).toBe("partial");
    const plans = [{ slug: "cart", title: "Cart", steps: 2, proposals: 0, problem: null, updatedAt: 1, lastRun: null }] as unknown as PlanSummary[];
    const views = featureViews(parseFeatures(MAP).features, plans);
    expect(views[0]!.planInfo).toEqual([{ slug: "cart", title: "Cart", exists: true, steps: 2, lastRun: null }]);
    expect(views[0]!.coverage).toBe("not-run");
    expect(views[1]!.coverage).toBe("no-plan");
  });
});

describe("agent-found bugs", () => {
  test("an agent bug reads back unconfirmed, a person confirms it, and an operator bug cannot be confirmed", () => {
    const f = writeFinding(root, "bug-a", { title: "Total wrong", lens: "bug", scope: "http://localhost:3000/cart", impact: "medium", effort: "s", status: "new", evidence: [], bug: { url: "http://localhost:3000/cart", capture: null, shot: "agent", kind: "logic", by: "agent", confirmed: false } }, "x");
    expect(f.problem).toBeNull();
    expect(f.bug).toMatchObject({ shot: "agent", by: "agent", confirmed: false });
    expect(unconfirmedBug(f)).toBe(true);
    const c = patchFinding(root, "bug-a", { confirmed: true });
    expect(c.bug?.confirmed).toBe(true);
    expect(unconfirmedBug(c)).toBe(false);
    const op = bug("Operator bug");
    expect(op.bug?.by).toBeUndefined();
    expect(unconfirmedBug(op)).toBe(false);
    expect(() => patchFinding(root, op.id, { confirmed: true })).toThrow("Only a bug a QA agent logged");
  });

  test("similarBug matches the same title, or most of the words on the same page", () => {
    const open = [bug("Cart total ignores the discount code"), bug("Login button does nothing", "http://localhost:3000/login")];
    expect(similarBug("cart total ignores the discount code!", "http://localhost:3000/other", open)?.id).toBe(open[0]!.id);
    expect(similarBug("Discount code ignored by cart total", "http://localhost:3000/cart/", open)?.id).toBe(open[0]!.id);
    expect(similarBug("Discount code ignored by cart total", "http://localhost:3000/checkout", open)).toBeNull();
    expect(similarBug("Images missing on the cart", "http://localhost:3000/cart", open)).toBeNull();
  });
});

describe("qa_record", () => {
  test("records outcomes for the session's own run only, and a failure needs a real bug", async () => {
    const p = plan();
    const run = startRun(root, p);
    const [s1, s2] = run.steps.map((s) => s.id);
    register("s_run", p.slug, "run", run.id);
    expect(usesQaTools("s_run")).toBe(true);

    const ok = await executeQaTool("qa_record", { step: s1, state: "pass", note: "Two items listed" }, "s_run");
    expect(ok.text).toContain(`Recorded ${s1}: pass. 1 of 2 steps recorded. Next pending: ${s2}`);

    expect((await executeQaTool("qa_record", { step: s2, state: "fail", actual: "Blank page" }, "s_run")).text).toContain("needs bug");
    expect((await executeQaTool("qa_record", { step: s2, state: "fail", actual: "Blank page", bug: "bug-nope" }, "s_run")).text).toContain('no bug "bug-nope"');
    expect((await executeQaTool("qa_record", { step: s2, state: "blocked" }, "s_run")).text).toContain("needs a note");
    expect((await executeQaTool("qa_record", { step: "s-zzzz", state: "pass" }, "s_run")).text).toContain("not in run");
    expect((await executeQaTool("qa_record", { step: s2, state: "pending" }, "s_run")).text).toContain("state must be");

    const b = bug("Pay shows a blank page");
    const done = await executeQaTool("qa_record", { step: s2, state: "fail", actual: "Blank page", bug: b.id }, "s_run");
    expect(done.text).toContain("Every step is recorded");
    expect(getRun(run.id)!.steps[1]!.outcome).toMatchObject({ state: "fail", actual: "Blank page", bug: b.id });
    expect(readFinding(root, b.id).body).toContain(`Seen failing in QA run ${run.id}`);
    expect(listRuns(root, p.slug)[0]!.agentSession).toBe("s_run");
  });

  test("refused outside a run session", async () => {
    register("s_explore", plan().slug, "explore");
    expect((await executeQaTool("qa_record", { step: "s-1", state: "pass" }, "s_explore")).text).toContain("is for a QA agent run");
    expect((await executeQaTool("qa_record", { step: "s-1", state: "pass" }, "s_nobody")).text).toContain("is for a QA agent run");
    register("s_draft", "x", "draft");
    expect(usesQaTools("s_draft")).toBe(false);
    expect(usesQaTools("s_nobody")).toBe(false);
  });

  test("the tools are described with their required fields", () => {
    const defs = qaToolDefs();
    expect(defs.map((d) => d.name)).toEqual(["qa_record", "bug_log"]);
    expect(defs[1]!.inputSchema.required).toEqual(["title", "steps", "actual"]);
  });
});

describe("agent sessions", () => {
  test("a run turn that leaves steps unrecorded is a problem; a finished one is not", async () => {
    const p = plan();
    const run = startRun(root, p);
    register("s_run", p.slug, "run", run.id);
    expect(finishQaTurn("s_run")!.problem).toBe("The agent stopped with 2 of 2 steps not recorded.");
    for (const s of run.steps) await executeQaTool("qa_record", { step: s.id, state: "skip", note: "n/a" }, "s_run");
    expect(finishQaTurn("s_run")!.problem).toBeNull();
  });

  test("a map turn must write a feature map with features", () => {
    register("s_map", "@features", "map");
    expect(finishQaTurn("s_map")!.problem).toContain("did not write lab/features.md");
    fs.mkdirSync(path.join(root, "lab"), { recursive: true });
    fs.writeFileSync(path.join(root, FEATURES_FILE), "# Features\n");
    expect(finishQaTurn("s_map")!.problem).toContain("lists no features");
    fs.writeFileSync(path.join(root, FEATURES_FILE), "# Features\n\n## Checkout\nPay.\n");
    expect(finishQaTurn("s_map")!.problem).toBeNull();
  });

  test("the run prompt lists every step with its id and the open bugs; explore asks for proposals and bug_log", () => {
    const p = plan();
    const run = startRun(root, p);
    const b = bug("Pay shows a blank page");
    const r = qaPrompt(p, { kind: "run", run: run.id, note: "", baseUrl: "http://localhost:3000", batch: null }, root);
    for (const s of run.steps) expect(r.instructions).toContain(`- ${s.id}: ${s.action}`);
    expect(r.instructions).toContain("qa_record");
    expect(r.instructions).toContain("The app is running at http://localhost:3000");
    expect(r.instructions).toContain(`- ${b.id}: Pay shows a blank page`);
    expect(r.label).toBe("QA · agent run");
    const e = qaPrompt(p, parseQaAsk("explore", { note: "Try coupons", from: { kind: "page", path: "/cart" } }), root);
    expect(e.instructions).toContain(`lab/qa/${p.slug}.proposals.md`);
    expect(e.instructions).toContain("bug_log");
    expect(e.instructions).toContain("Start at the page `/cart`");
    expect(e.instructions).toContain("Find the running app first");
    expect(e.visible).toBe("Try coupons");
  });

  test("parseBaseUrl takes http(s) addresses only", () => {
    expect(parseBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(parseBaseUrl("")).toBeNull();
    expect(() => parseBaseUrl("ftp://x")).toThrow("http or https");
    expect(() => parseBaseUrl("nope")).toThrow("not an address");
  });
});

describe("end-to-end batches", () => {
  test("starts plans one at a time, skips one that cannot start, and stops when cancelled", () => {
    const started: string[] = [];
    const start = (_root: string, slug: PlanSlug) => {
      if (slug === "bad") throw new Error("The plan has no steps to run.");
      started.push(slug);
    };
    const b = createBatch(root, ["a", "bad", "c", "d"] as PlanSlug[], null, { engine: "fake", sessionId: "s_x" });
    expect(b.opts).toEqual({ engine: "fake" });
    expect(advanceBatch(b.id, start)).toMatchObject({ next: 1, current: "a" });
    expect(advanceBatch(b.id, start)).toMatchObject({ next: 3, current: "c", errors: [{ plan: "bad", error: "The plan has no steps to run." }] });
    cancelBatch(b.id);
    expect(advanceBatch(b.id, start)).toMatchObject({ next: 3, current: null, cancelled: true });
    expect(started).toEqual(["a", "c"]);
    expect(getBatch(b.id)!.current).toBeNull();
  });
});
