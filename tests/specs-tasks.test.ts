import { describe, expect, test } from "bun:test";
import { nextTasks, parallelGroups, parseTasks, reportedDone, setTaskDone, taskLine, tickIds } from "../src/specs/tasks";

const SAMPLE = `# Tasks: Add CSV export

**Feature**: \`001-add-csv-export\`

## Phase 1: Setup

- [ ] T001 Create the export module in src/export/index.ts
- [x] T002 Add the csv dependency to package.json

## Phase 2: Foundational

- [ ] T003 [P] Add the row serializer in src/export/rows.ts
- [ ] T004 [P] Add the header builder in src/export/header.ts

## Phase 3: User Story 1 (P1)

### Export button

- [ ] T005 [P] [US1] Add the button in web/src/orders/ExportButton.tsx
- [ ] T006 [US1] Wire it to the endpoint in src/api/orders.ts
`;

describe("parseTasks", () => {
  const p = parseTasks(SAMPLE);

  test("reads ids, markers, files, phases and groups", () => {
    expect(p.total).toBe(6);
    expect(p.done).toBe(1);
    const t5 = p.tasks.find((t) => t.id === "T005")!;
    expect(t5).toMatchObject({ parallel: true, story: "US1", done: false, phase: "Phase 3: User Story 1 (P1)", group: "Export button", file: "web/src/orders/ExportButton.tsx" });
    expect(t5.text).toBe("Add the button in web/src/orders/ExportButton.tsx");
    expect(p.tasks.find((t) => t.id === "T006")!.parallel).toBe(false);
    expect(p.tasks.find((t) => t.id === "T002")!.done).toBe(true);
    expect(p.phases.map((x) => [x.title, x.tasks.length])).toEqual([
      ["Phase 1: Setup", 2],
      ["Phase 2: Foundational", 2],
      ["Phase 3: User Story 1 (P1)", 2],
    ]);
    expect(p.malformed).toEqual([]);
  });

  test("records the zero-based line of each task", () => {
    const lines = SAMPLE.split("\n");
    for (const t of p.tasks) expect(lines[t.line]).toContain(t.id!);
  });

  test("is tolerant: other bullets, upper-case X, odd spacing, markers in any order, no id", () => {
    const q = parseTasks(["## Phase 1", "*  [X]  T010  [US2]  [P]  Do a thing in a/b.ts", "+ [ ]T011 do another", "    - [ ] [P] T012 nested and indented", "- [ ] a task with no id at all", "- [ ]   ", "-[ ] t013 lower case id"].join("\n"));
    expect(q.total).toBe(5);
    expect(q.tasks[0]).toMatchObject({ id: "T010", done: true, parallel: true, story: "US2", text: "Do a thing in a/b.ts", file: "a/b.ts" });
    expect(q.tasks[1]).toMatchObject({ id: "T011", done: false });
    expect(q.tasks[2]).toMatchObject({ id: "T012", parallel: true, indent: 4 });
    expect(q.tasks[3].id).toBeNull();
    expect(q.tasks[3].text).toBe("a task with no id at all");
    expect(q.tasks[4].id).toBe("T013");
    expect(q.malformed).toEqual([{ line: 5, text: "- [ ]" }]);
  });

  test("ignores checkboxes inside code fences and non-task lines", () => {
    const q = parseTasks(["## Phase 1", "- [ ] T001 real", "```", "- [ ] T999 not a task", "```", "- a plain bullet", "[ ] no bullet"].join("\n"));
    expect(q.tasks.map((t) => t.id)).toEqual(["T001"]);
  });

  test("empty and heading-only files parse to nothing", () => {
    expect(parseTasks("").total).toBe(0);
    expect(parseTasks("# Tasks\n\n## Phase 1\n").total).toBe(0);
  });

  test("tasks before any phase heading belong to no phase", () => {
    const q = parseTasks("- [ ] T001 first\n");
    expect(q.tasks[0].phase).toBeNull();
    expect(q.phases[0].title).toBe("Tasks");
  });
});

describe("setTaskDone", () => {
  test("changes exactly one character", () => {
    const next = setTaskDone(SAMPLE, parseTasks(SAMPLE).tasks.find((t) => t.id === "T001")!.line, true);
    const a = SAMPLE.split("\n");
    const b = next.split("\n");
    const diff = a.map((l, i) => (l === b[i] ? null : [l, b[i]])).filter(Boolean) as string[][];
    expect(diff).toHaveLength(1);
    expect(diff[0][1]).toBe(diff[0][0].replace("[ ]", "[x]"));
    expect(next.length).toBe(SAMPLE.length);
  });

  test("toggles when no value is given, and is a no-op when already in that state", () => {
    const line = parseTasks(SAMPLE).tasks.find((t) => t.id === "T002")!.line;
    expect(parseTasks(setTaskDone(SAMPLE, line)).tasks.find((t) => t.id === "T002")!.done).toBe(false);
    expect(setTaskDone(SAMPLE, line, true)).toBe(SAMPLE);
  });

  test("keeps CRLF files byte for byte except the box", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const line = parseTasks(crlf).tasks.find((t) => t.id === "T003")!.line;
    const next = setTaskDone(crlf, line, true);
    expect(next.replace("[x] T003", "[ ] T003")).toBe(crlf);
    expect(next.includes("\r\n")).toBe(true);
    expect(next.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(parseTasks(next).done).toBe(2);
  });

  test("keeps a missing final newline, mixed endings and trailing spaces", () => {
    const odd = "## P\r\n- [ ] T001 a  \n- [ ] T002 b\r- [ ] T003 c";
    const t = parseTasks(odd).tasks;
    expect(t.map((x) => x.id)).toEqual(["T001", "T002", "T003"]);
    let out = odd;
    for (const x of t) out = setTaskDone(out, x.line, true);
    expect(out).toBe("## P\r\n- [x] T001 a  \n- [x] T002 b\r- [x] T003 c");
  });

  test("preserves upper-case X on an unchanged task and the bullet style", () => {
    const src = "* [X] T001 done\n+ [ ] T002 open\n";
    expect(setTaskDone(src, 1, true)).toBe("* [X] T001 done\n+ [x] T002 open\n");
  });

  test("refuses a line that is not a task", () => {
    expect(() => setTaskDone(SAMPLE, 0, true)).toThrow(/not a task/);
    expect(() => setTaskDone(SAMPLE, 9999, true)).toThrow(/not a task/);
  });
});

describe("tickIds and reportedDone", () => {
  test("ticks only known, open ids", () => {
    const { text, ticked } = tickIds(SAMPLE, ["t001", "T002", "T404", "T003"]);
    expect(ticked).toEqual(["T001", "T003"]);
    const p = parseTasks(text);
    expect(p.done).toBe(3);
  });

  test("reads TASKS_DONE lines out of a reply", () => {
    const out = "Did the work.\nTASKS_DONE: T001, t003 and T010\nmore text\n  TASK_DONE: T003";
    expect(reportedDone(out)).toEqual(["T001", "T003", "T010"]);
    expect(reportedDone(null)).toEqual([]);
    expect(reportedDone("nothing here T001")).toEqual([]);
  });
});

describe("planning helpers", () => {
  test("nextTasks returns open tasks in order", () => {
    expect(nextTasks(parseTasks(SAMPLE), 3).map((t) => t.id)).toEqual(["T001", "T003", "T004"]);
  });

  test("parallelGroups takes the first run of [P] tasks in one phase", () => {
    const g = parallelGroups(parseTasks(SAMPLE));
    expect(g.map((x) => x.map((t) => t.id))).toEqual([["T003"], ["T004"]]);
  });

  test("a run of one [P] task is not parallel, and a done task is not a candidate", () => {
    expect(parallelGroups(parseTasks("## P\n- [ ] T1 [P] a\n- [ ] T2 b\n"))).toEqual([]);
    expect(parallelGroups(parseTasks("## P\n- [x] T1 [P] a\n- [ ] T2 [P] b\n- [ ] T3 c\n"))).toEqual([]);
  });

  test("tasks of one user story stay together, and the head count is capped", () => {
    const src = ["## Phase 3", "- [ ] T1 [P] [US1] a", "- [ ] T2 [P] [US1] b", "- [ ] T3 [P] [US2] c", "- [ ] T4 [P] [US3] d", "- [ ] T5 [P] [US4] e", "- [ ] T6 [P] [US5] f"].join("\n");
    const g = parallelGroups(parseTasks(src), 3);
    expect(g).toHaveLength(3);
    expect(g.flat().map((t) => t.id).sort()).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
    const us1 = g.find((x) => x.some((t) => t.id === "T1"))!;
    expect(us1.map((t) => t.id)).toContain("T2");
  });

  test("a non-[P] task or a new phase ends the run", () => {
    const src = ["## A", "- [ ] T1 [P] a", "- [ ] T2 b", "- [ ] T3 [P] c", "## B", "- [ ] T4 [P] d"].join("\n");
    expect(parallelGroups(parseTasks(src))).toEqual([]);
  });

  test("taskLine is a one-liner for prompts", () => {
    const t = parseTasks("## P\n- [ ] T007 [P] [US2] do x in a/b.ts").tasks[0];
    expect(taskLine(t)).toBe("T007 [P] [US2] do x in a/b.ts");
  });
});
