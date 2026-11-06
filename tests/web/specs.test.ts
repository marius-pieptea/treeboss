import { describe, expect, test } from "bun:test";
import { ago, attachLabel, compact, CONSTITUTION_PATH, costTone, currentPhase, docTabs, emptyRun, featureOfPath, filterTasks, groupByPhase, nextNumber, percent, pipeline, previewSlug, runPayload, statusLabel, statusTone, stepInputLabel, STEPS, type FeatureInfo, type SpecsOverview, type SpecTask } from "../../web/src/features/specs/logic";

const feature = (over: Partial<FeatureInfo> = {}, files: Partial<FeatureInfo["files"]> = {}): FeatureInfo => ({
  id: "001-orders-export",
  number: "001",
  name: "orders-export",
  dir: "specs/001-orders-export",
  title: "Orders export",
  files: { spec: true, plan: false, tasks: false, research: false, dataModel: false, quickstart: false, contracts: [], other: [], ...files },
  tasks: { done: 0, total: 0 },
  status: "draft",
  updatedAt: 0,
  specDraft: false,
  clarifications: 0,
  ...over,
});

const overview = (over: Partial<SpecsOverview["constitution"]> = {}, features: FeatureInfo[] = []): SpecsOverview => ({
  constitution: { exists: true, path: CONSTITUTION_PATH, bytes: 900, placeholders: false, mtime: 1, ...over },
  features,
  specify: { path: null },
  numbering: "sequential",
  rev: "x",
});

const task = (over: Partial<SpecTask>): SpecTask => ({ line: 0, id: "T001", done: false, parallel: false, story: null, text: "do it", file: null, phase: "Phase 1", group: null, indent: 0, ...over });

const state = (steps: ReturnType<typeof pipeline>) => Object.fromEntries(steps.map((s) => [s.id, s.state]));

describe("pipeline", () => {
  test("nothing exists: the constitution is the first thing to do and the rest wait for a feature", () => {
    const s = state(pipeline(overview({ exists: false, bytes: 0, mtime: null }), null));
    expect(s).toEqual({ constitution: "active", specify: "blocked", clarify: "blocked", plan: "blocked", tasks: "blocked", analyze: "blocked", implement: "blocked" });
  });

  test("a constitution still holding placeholders is not done", () => {
    expect(state(pipeline(overview({ placeholders: true }), null)).constitution).toBe("active");
  });

  test("a fresh feature (skeleton spec) needs specifying; the plan can already run since spec.md exists", () => {
    const s = pipeline(overview(), feature({ specDraft: true }));
    expect(state(s).constitution).toBe("done");
    expect(state(s).specify).toBe("active");
    // A constitution that is still a template does not hold up the feature in front of you.
    expect(state(pipeline(overview({ placeholders: true }), feature({ specDraft: true }))).specify).toBe("active");
    expect(state(pipeline(overview({ placeholders: true }), feature({ specDraft: true }))).constitution).toBe("ready");
    expect(state(s).plan).toBe("ready");
    expect(state(s).tasks).toBe("blocked");
    expect(s.find((x) => x.id === "tasks")!.note).toBe("Plan first");
  });

  test("a written spec with open questions leaves clarify ready, and plan active", () => {
    const s = pipeline(overview(), feature({ clarifications: 2 }));
    expect(state(s).specify).toBe("done");
    expect(state(s).clarify).toBe("ready");
    expect(s.find((x) => x.id === "clarify")!.note).toBe("2 open questions");
    expect(state(s).plan).toBe("active");
  });

  test("no open questions marks clarify done", () => {
    expect(state(pipeline(overview(), feature())).clarify).toBe("done");
  });

  test("with a plan, tasks are next; with tasks, implement is", () => {
    const withPlan = pipeline(overview(), feature({ status: "planned" }, { plan: true }));
    expect(state(withPlan).plan).toBe("done");
    expect(state(withPlan).tasks).toBe("active");
    expect(state(withPlan).implement).toBe("blocked");
    const withTasks = pipeline(overview(), feature({ status: "tasked", tasks: { done: 0, total: 5 } }, { plan: true, tasks: true }));
    expect(state(withTasks).tasks).toBe("done");
    expect(state(withTasks).implement).toBe("active");
    expect(withTasks.find((x) => x.id === "implement")!.note).toBe("0/5 done");
  });

  test("analyze never blocks anything and is never marked done", () => {
    const s = pipeline(overview(), feature({ tasks: { done: 5, total: 5 }, status: "done" }, { plan: true, tasks: true }));
    expect(state(s).analyze).toBe("ready");
    expect(state(s).implement).toBe("done");
    expect(s.every((x) => x.state !== "active")).toBe(true);
  });

  test("an empty tasks.md does not count as tasks", () => {
    const s = pipeline(overview(), feature({ status: "tasked" }, { plan: true, tasks: true }));
    expect(state(s).tasks).toBe("active");
    expect(state(s).implement).toBe("blocked");
  });

  test("every step has a hint", () => {
    expect(STEPS.map((s) => s.id)).toEqual(["constitution", "specify", "clarify", "plan", "tasks", "analyze", "implement"]);
    for (const s of STEPS) expect(s.hint.length).toBeGreaterThan(10);
  });
});

describe("formatters", () => {
  test("status tones and labels", () => {
    expect(statusTone("done")).toBe("green");
    expect(statusTone("in-progress")).toBe("amber");
    expect(statusTone("draft")).toBe("neutral");
    expect(statusLabel("in-progress")).toBe("in progress");
  });
  test("percent, compact, costTone", () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(0, 0)).toBe(0);
    expect(compact(950)).toBe("950");
    expect(compact(1234)).toBe("1.2k");
    expect(compact(15_800)).toBe("16k");
    expect(costTone(300)).toBe("ok");
    expect(costTone(2500)).toBe("warn");
    expect(costTone(20_000)).toBe("high");
  });
  test("ago", () => {
    const now = 1_000_000_000;
    expect(ago(now - 5_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5m ago");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3d ago");
  });
  test("attachLabel and featureOfPath", () => {
    expect(attachLabel(CONSTITUTION_PATH)).toBe("Constitution");
    expect(attachLabel("specs/001-orders-export")).toBe("001 orders-export");
    expect(attachLabel("specs/001-orders-export/plan.md")).toBe("001 orders-export · plan.md");
    expect(attachLabel("specs/20261008-101500-login/spec.md")).toBe("20261008-101500 login · spec.md");
    expect(attachLabel("other/file.md")).toBe("file.md");
    expect(featureOfPath("specs/001-x/spec.md")).toBe("001-x");
    expect(featureOfPath(CONSTITUTION_PATH)).toBeNull();
  });
  test("previewSlug mirrors the daemon", () => {
    expect(previewSlug("Add CSV export to the orders page")).toBe("add-csv-export-orders-page");
    expect(previewSlug("  !!  ")).toBe("");
    expect(previewSlug("Ünïcode naïve café")).toBe("unicode-naive-cafe");
    expect(previewSlug("the a an")).toBe("the-a-an");
  });
  test("nextNumber", () => {
    expect(nextNumber(undefined)).toBe("001");
    expect(nextNumber(overview({}, [feature(), feature({ number: "007", id: "007-x" })]))).toBe("008");
    expect(nextNumber({ ...overview(), numbering: "timestamp" })).toBe("YYYYMMDD-HHMMSS");
  });
  test("stepInputLabel is optional-worded for every step", () => {
    for (const s of STEPS) expect(stepInputLabel(s.id)).toContain("optional");
  });
});

describe("docs and tasks", () => {
  test("docTabs lists every file in workflow order and marks the missing ones", () => {
    const d = docTabs(feature({}, { plan: true, contracts: ["contracts/api.yaml", "contracts/events.json"] }));
    expect(d.map((x) => x.id)).toEqual(["spec", "plan", "tasks", "research", "data-model", "contracts", "quickstart"]);
    expect(d.find((x) => x.id === "plan")).toMatchObject({ exists: true, path: "specs/001-orders-export/plan.md" });
    expect(d.find((x) => x.id === "tasks")!.exists).toBe(false);
    expect(d.find((x) => x.id === "contracts")).toMatchObject({ exists: true, path: "specs/001-orders-export/contracts/api.yaml" });
    expect(docTabs(feature()).find((x) => x.id === "contracts")).toMatchObject({ exists: false, path: null });
  });

  const tasks = [
    task({ line: 2, id: "T001", done: true, text: "Create src/a.ts", phase: "Phase 1: Setup" }),
    task({ line: 3, id: "T002", text: "Add dependency", phase: "Phase 1: Setup" }),
    task({ line: 6, id: "T003", parallel: true, story: "US1", text: "Button in web/Button.tsx", phase: "Phase 2: Story" }),
    task({ line: 7, id: "T004", parallel: true, story: "US2", text: "Endpoint", phase: "Phase 2: Story" }),
  ];

  test("filterTasks by text, id, story, done and [P]", () => {
    expect(filterTasks(tasks, { query: "", hideDone: false, onlyParallel: false })).toHaveLength(4);
    expect(filterTasks(tasks, { query: "", hideDone: true, onlyParallel: false }).map((t) => t.id)).toEqual(["T002", "T003", "T004"]);
    expect(filterTasks(tasks, { query: "", hideDone: false, onlyParallel: true }).map((t) => t.id)).toEqual(["T003", "T004"]);
    expect(filterTasks(tasks, { query: "us2", hideDone: false, onlyParallel: false }).map((t) => t.id)).toEqual(["T004"]);
    expect(filterTasks(tasks, { query: "BUTTON", hideDone: false, onlyParallel: false }).map((t) => t.id)).toEqual(["T003"]);
    expect(filterTasks(tasks, { query: "t002", hideDone: false, onlyParallel: false }).map((t) => t.id)).toEqual(["T002"]);
    expect(filterTasks(tasks, { query: "zzz", hideDone: false, onlyParallel: false })).toEqual([]);
  });

  test("groupByPhase keeps file order and counts over all tasks, not just the visible ones", () => {
    const visible = filterTasks(tasks, { query: "", hideDone: true, onlyParallel: false });
    const g = groupByPhase(visible, tasks);
    expect(g.map((p) => [p.title, p.tasks.length, p.done, p.total])).toEqual([
      ["Phase 1: Setup", 1, 1, 2],
      ["Phase 2: Story", 2, 0, 2],
    ]);
    expect(currentPhase(g)).toBe("Phase 1: Setup");
    expect(currentPhase(groupByPhase(tasks.slice(0, 1), tasks.slice(0, 1)))).toBe("Phase 1: Setup");
    expect(currentPhase([])).toBeNull();
    expect(groupByPhase([task({ phase: null })], [task({ phase: null })])[0].title).toBe("Tasks");
  });
});

describe("runPayload", () => {
  test("defaults send nothing", () => {
    expect(runPayload(emptyRun(), null)).toEqual({});
  });
  test("a new session carries the engine, model, agent and pair", () => {
    expect(runPayload({ ...emptyRun(), engine: "claude", model: "opus", agent: "reviewer", pairId: "p1", input: " note " }, "s_1")).toEqual({ engine: "claude", model: "opus", agent: "reviewer", pairId: "p1", input: "note" });
  });
  test("the current session wins and drops the engine choices", () => {
    expect(runPayload({ ...emptyRun(), where: "current", engine: "claude", model: "opus" }, "s_1")).toEqual({ sessionId: "s_1" });
    expect(runPayload({ ...emptyRun(), where: "current", engine: "claude" }, null)).toEqual({ engine: "claude" });
  });
  test("implement and task options", () => {
    expect(runPayload({ ...emptyRun(), test: " bun test ", parallel: true, asHead: true, where: "current" }, "s_2")).toEqual({ sessionId: "s_2", test: "bun test", parallel: true, asHead: true });
  });
});
