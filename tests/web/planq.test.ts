import { describe, expect, test } from "bun:test";
import {
  answerPayload,
  answeredQuestions,
  answerSummary,
  canAnswer,
  defaultSelection,
  dockFor,
  optionForKey,
  planDecisionReady,
  reviewBack,
  reviewForward,
  approveLabel,
  chipLabel,
  parsePlanReadyLine,
  planBar,
  planBody,
  planForTab,
  planTab,
  planTabTitle,
  shouldAutoOpen,
  statusLabel,
  stepLabel,
  toggleChoice,
} from "../../web/src/features/agent/plan-logic";
import { toolVerb } from "../../web/src/features/agent/chat-logic";
import type { PlanQuestion, PlanRecord, PlanState } from "../../web/src/lib/types";

const q = (over: Partial<PlanQuestion> = {}): PlanQuestion => ({
  id: "pq_1",
  session_id: "s_1",
  seq: 1,
  question: "Which store?",
  options: [{ label: "SQLite", recommended: true, reason: "in repo" }, { label: "Postgres" }, { label: "Redis" }],
  allow_custom: true,
  multi: false,
  status: "pending",
  answer: null,
  asked_at: "2026-10-08T10:00:00Z",
  answered_at: null,
  ...over,
});

const plan = (over: Partial<PlanRecord> = {}): PlanRecord => ({
  id: "pl_1",
  session_id: "s_1",
  version: 1,
  title: "Add a cache",
  summary: "Use SQLite.",
  steps: [{ title: "Add table", detail: "migrate", files: ["src/db.ts"] }, { title: "Wire it", detail: "" }],
  risks: [],
  open_questions: [],
  status: "draft",
  note: null,
  created_at: "2026-10-08T10:00:00Z",
  decided_at: null,
  path: "plans/2026-10-08-add-a-cache.md",
  depth: "quick",
  feature: null,
  promoted: null,
  ...over,
});

const state = (over: Partial<PlanState> = {}): PlanState => ({ mode: "plan", questions: [], pending: null, plan: null, plans: [], expected_total: 4, depth: "quick", ...over });

describe("answering", () => {
  test("a bare Enter takes the recommendation, and nothing is preselected without one", () => {
    expect(defaultSelection(q())).toEqual(["SQLite"]);
    expect(defaultSelection(q({ options: [{ label: "a" }, { label: "b" }] }))).toEqual([]);
  });

  test("single choice replaces, multi toggles", () => {
    expect(toggleChoice({ multi: false }, ["SQLite"], "Redis")).toEqual(["Redis"]);
    expect(toggleChoice({ multi: true }, ["SQLite"], "Redis")).toEqual(["SQLite", "Redis"]);
    expect(toggleChoice({ multi: true }, ["SQLite", "Redis"], "SQLite")).toEqual(["Redis"]);
  });

  test("digit keys map to options, nothing else does", () => {
    const o = q().options;
    expect(optionForKey("2", o)?.label).toBe("Postgres");
    expect(optionForKey("4", o)).toBeNull();
    expect(optionForKey("0", o)).toBeNull();
    expect(optionForKey("a", o)).toBeNull();
    expect(optionForKey("12", o)).toBeNull();
  });

  test("an answer needs a choice or, where allowed, written text", () => {
    expect(canAnswer({ allow_custom: true }, { choices: [], custom: "  " })).toBe(false);
    expect(canAnswer({ allow_custom: true }, { choices: [], custom: "mine" })).toBe(true);
    expect(canAnswer({ allow_custom: false }, { choices: [], custom: "mine" })).toBe(false);
    expect(canAnswer({ allow_custom: false }, { choices: ["a"], custom: "" })).toBe(true);
  });

  test("the payload matches what the daemon takes", () => {
    expect(answerPayload(q(), { choices: ["Postgres"], custom: "" })).toEqual({ question_id: "pq_1", choice: "Postgres" });
    expect(answerPayload(q({ multi: true }), { choices: ["a", "b"], custom: "" })).toEqual({ question_id: "pq_1", choices: ["a", "b"] });
    expect(answerPayload(q(), { choices: [], custom: " use KV " })).toEqual({ question_id: "pq_1", custom: "use KV" });
    expect(answerPayload(q({ multi: true }), { choices: ["a"], custom: "plus this" })).toEqual({ question_id: "pq_1", choices: ["a"], custom: "plus this" });
  });

  test("history lines read naturally", () => {
    expect(answerSummary({ choices: ["SQLite"], custom: null, skipped: false })).toBe("SQLite");
    expect(answerSummary({ choices: ["a", "b"], custom: "and c", skipped: false })).toBe("a; b; and c");
    expect(answerSummary({ choices: [], custom: null, skipped: true })).toBe("skipped");
    expect(answerSummary(null)).toBe("");
  });

  test("the step indicator never says fewer questions than have been asked", () => {
    expect(stepLabel({ seq: 2 }, 4)).toBe("Question 2 of ~4");
    expect(stepLabel({ seq: 5 }, 4)).toBe("Question 5 of ~5");
  });

  test("reviewing earlier answers walks back and forward to the live question", () => {
    expect(reviewBack(null, 0)).toBeNull();
    expect(reviewBack(null, 3)).toBe(2);
    expect(reviewBack(2, 3)).toBe(1);
    expect(reviewBack(0, 3)).toBe(0);
    expect(reviewForward(0, 3)).toBe(1);
    expect(reviewForward(2, 3)).toBeNull();
    expect(reviewForward(null, 3)).toBeNull();
  });

  test("only answered questions count as history", () => {
    const st = state({ questions: [q({ status: "answered" }), q({ id: "pq_2", status: "cancelled" }), q({ id: "pq_3" })] });
    expect(answeredQuestions(st).map((x) => x.id)).toEqual(["pq_1"]);
  });
});

describe("the plan as a file", () => {
  test("the viewer tab follows the file, so a revision reuses it, and a legacy plan follows its id", () => {
    const t1 = planTab(plan(), "w_1", "s_1") as any;
    const t2 = planTab(plan({ id: "pl_2", version: 2 }), "w_1", "s_1") as any;
    expect(t1).toMatchObject({ kind: "plan", root: "w_1", sessionId: "s_1", path: "plans/2026-10-08-add-a-cache.md", title: "Plan: Add a cache" });
    expect(planTabTitle("A very long plan title that keeps going and going")).toBe("Plan: A very long plan title th…");
    // The store keys the tab by session and path; both versions share it.
    expect(`plan:s_1:${t1.path}`).toBe(`plan:s_1:${t2.path}`);
  });

  test("a plan opens its tab once, and only while it is a draft", () => {
    const opened = new Set<string>();
    expect(shouldAutoOpen(plan(), opened)).toBe(true);
    opened.add("pl_1");
    expect(shouldAutoOpen(plan(), opened)).toBe(false);
    expect(shouldAutoOpen(plan({ id: "pl_2", status: "approved" }), opened)).toBe(false);
    expect(shouldAutoOpen(plan({ id: "pl_3", status: "superseded" }), opened)).toBe(false);
  });

  test("the tab shows the newest plan on its file", () => {
    const st = state({ plans: [plan({ status: "superseded", note: "split it" }), plan({ id: "pl_2", version: 2 })] });
    expect(planForTab(st, { planId: "pl_1", path: "plans/2026-10-08-add-a-cache.md" })?.id).toBe("pl_2");
    expect(planForTab(st, { planId: "pl_1", path: "plans/other.md" })?.id).toBe("pl_1");
    const legacy = state({ plans: [plan({ id: "pl_9", path: null })] });
    expect(planForTab(legacy, { planId: "pl_9", path: null })?.id).toBe("pl_9");
    expect(planForTab(undefined, { planId: "x", path: null })).toBeNull();
  });

  test("the bar offers the decision only for a draft, and only once the agent has finished its turn", () => {
    expect(planBar(plan(), state(), "idle")).toEqual({ kind: "decide", canDecide: true, reason: null });
    const busy = planBar(plan(), state(), "running");
    expect(busy).toMatchObject({ kind: "decide", canDecide: false });
    expect(planBar(plan({ status: "approved" }), state(), "idle")).toEqual({ kind: "approved" });
    expect(planBar(null, state(), "idle")).toEqual({ kind: "gone" });
  });

  test("superseded reads as skipped, being revised, or replaced", () => {
    const sent = plan({ status: "superseded", note: "split it" });
    expect(planBar(sent, state({ plans: [sent] }), "idle")).toEqual({ kind: "superseded", skipped: false, revising: true });
    expect(planBar(sent, state({ plans: [sent, plan({ id: "pl_2", version: 2 })] }), "idle")).toEqual({ kind: "superseded", skipped: false, revising: false });
    const skipped = plan({ status: "superseded", note: "skipped" });
    expect(planBar(skipped, state({ plans: [skipped] }), "idle")).toEqual({ kind: "superseded", skipped: true, revising: false });
    expect(statusLabel(sent, planBar(sent, state({ plans: [sent] }), "idle"))).toContain("being revised");
    expect(statusLabel(skipped, planBar(skipped, state({ plans: [skipped] }), "idle"))).toContain("skipped");
    expect(statusLabel(plan(), planBar(plan(), state(), "idle"))).toBe("v1 · waiting for you");
  });

  test("labels: a spec plan is approved as a spec, chips say what state the plan is in", () => {
    expect(approveLabel({ depth: "quick" })).toBe("Approve and build");
    expect(approveLabel({ depth: "spec" })).toBe("Approve spec");
    expect(chipLabel(plan())).toBe("Plan ready: Add a cache");
    expect(chipLabel(plan({ version: 2 }))).toBe("Plan v2 ready: Add a cache");
    expect(chipLabel(plan({ status: "approved" }))).toBe("Approved plan: Add a cache");
  });

  test("the daemon's log line becomes a chip, and nothing else does", () => {
    expect(parsePlanReadyLine("[plan] plan v2 ready: Add a cache (3 steps) → plans/2026-10-08-add-a-cache.md")).toEqual({ version: 2, title: "Add a cache", steps: 3, path: "plans/2026-10-08-add-a-cache.md" });
    expect(parsePlanReadyLine("[plan] plan v1 ready: Old (1 step)")).toEqual({ version: 1, title: "Old", steps: 1, path: null });
    expect(parsePlanReadyLine("plan v3 ready: Add a cache (2 steps) → plans/x.md")).toMatchObject({ version: 3, path: "plans/x.md" });
    expect(parsePlanReadyLine("[plan] plan v1 approved: building")).toBeNull();
    expect(parsePlanReadyLine("plan v1 ready")).toBeNull();
  });

  test("the viewer renders the body, not the front matter", () => {
    const text = '---\ntitle: "Add a cache"\nstatus: draft\n---\n# Add a cache\n\nUse SQLite.\n';
    expect(planBody(text)).toBe("# Add a cache\n\nUse SQLite.\n");
    expect(planBody("# No front matter\n")).toBe("# No front matter\n");
    expect(planBody("---\r\ntitle: x\r\n---\r\nBody")).toBe("Body");
  });
});

describe("what the dock shows", () => {
  test("an open question beats a plan, a draft beats nothing, an approved plan is a quiet record", () => {
    expect(dockFor(undefined).kind).toBe("none");
    expect(dockFor(state()).kind).toBe("none");
    expect(dockFor(state({ pending: q(), plan: plan() })).kind).toBe("question");
    expect(dockFor(state({ plan: plan() })).kind).toBe("plan");
    expect(dockFor(state({ plan: plan({ status: "approved" }) })).kind).toBe("approved");
    expect(dockFor(state({ plan: plan({ status: "superseded" }) })).kind).toBe("none");
  });

  test("a plan can only be decided once the agent has finished its turn", () => {
    expect(planDecisionReady("running")).toBe(false);
    expect(planDecisionReady("idle")).toBe(true);
  });

  test("the plan tools read as what they are while running", () => {
    expect(toolVerb({ name: "mcp__trb__plan_ask", arg: "" })).toBe("Waiting for your answer…");
    expect(toolVerb({ name: "plan_submit", arg: "" })).toBe("Writing up the plan…");
  });
});
