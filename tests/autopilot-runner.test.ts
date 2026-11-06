import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { advanceAll, approveRun, getRun, listRuns, pauseRun, rejectRun, resumeRun, setPrFlow, startAutopilot, startRun, stopAutopilot, stopRun } from "../src/autopilot/runner";
import { git } from "../src/git/worktree";
import { getSession, interrupt, interruptAll, recoverOnStartup, setTurnRunner } from "../src/sessions/manager";
import { setGlobalConfig } from "../src/verify/store";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState } from "./helpers";

const SPEC = "specs/001-demo";

const turn = (cost: number): TurnResult =>
  ({
    success: true,
    output: "done",
    sessionId: null,
    resumeRejected: false,
    aborted: false,
    timedOut: false,
    maxTurnsHit: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: cost },
    exitCode: 0,
    stderr: "",
  }) as unknown as TurnResult;

let calls = 0;
let cost = 0;

/** A workspace with one feature whose tasks.md holds the given task lines. */
function workspaceWith(tasks: string[], files: Record<string, string> = {}) {
  const dir = makeRepo({
    ...files,
    [`${SPEC}/spec.md`]: "# Feature Specification: Demo\n",
    [`${SPEC}/tasks.md`]: `# Tasks\n\n## Phase 1\n\n${tasks.join("\n")}\n`,
  });
  return Workspaces.open(dir);
}

const tasksText = (ws: { path: string }) => fs.readFileSync(path.join(ws.path, SPEC, "tasks.md"), "utf-8");

async function until(cond: () => boolean, label: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(50);
  }
}

const ticked = (ws: { path: string }, id: string) => new RegExp(`\\[x\\] ${id}\\b`).test(tasksText(ws));

const setVerify = (commands: Array<{ name: string; cmd: string }>, maxRetries = 0) => setGlobalConfig({ enabled: true, commands, max_retries: maxRetries, timeout_sec: 60 });

beforeEach(() => {
  resetState();
  listRuns(); // creates the table
  db().exec("DELETE FROM autopilot_runs");
  calls = 0;
  cost = 0;
  setTurnRunner(async () => {
    calls++;
    return turn(cost);
  });
  setVerify([{ name: "ok", cmd: "true" }]);
  startAutopilot();
});

afterEach(async () => {
  stopAutopilot();
  await interruptAll();
  setTurnRunner(null);
  setPrFlow(null);
  setGlobalConfig({ enabled: null, commands: null, max_retries: null, timeout_sec: null });
});

describe("autopilot: a sequential run", () => {
  test("works through the open tasks in order, ticks each one, and finishes", async () => {
    const ws = workspaceWith(["- [x] T000 Already done", "- [ ] T001 First thing", "- [ ] T002 Second thing"]);
    const run = startRun(ws.id, "001-demo");
    expect(run.status).toBe("running");
    await until(() => getRun(run.id)!.status === "done", "the run to finish");
    expect(ticked(ws, "T001")).toBe(true);
    expect(ticked(ws, "T002")).toBe(true);
    expect(calls).toBe(2); // T000 was done and is not started again
    const done = getRun(run.id)!;
    expect(done.done).toBe(2);
    expect(done.reason).toMatch(/All 3 tasks are done/);
    expect(done.log.some((l) => l.kind === "task" && /T001: done/.test(l.text))).toBe(true);
  });

  test("refuses a second run on the same spec while one is open", async () => {
    const ws = workspaceWith(["- [ ] T001 Only thing"]);
    const first = startRun(ws.id, "001-demo", { approval_policy: { every: 1 } });
    expect(() => startRun(ws.id, "001-demo")).toThrow(/already working/);
    stopRun(first.id);
  });

  test("a task whose checks fail stops the run and leaves its box open", async () => {
    setVerify([{ name: "bad", cmd: "false" }], 0);
    const ws = workspaceWith(["- [ ] T001 Breaks checks", "- [ ] T002 Never reached"]);
    const run = startRun(ws.id, "001-demo");
    await until(() => getRun(run.id)!.status === "failed", "the run to fail");
    const failed = getRun(run.id)!;
    expect(failed.reason).toMatch(/T001: the checks still fail/);
    expect(ticked(ws, "T001")).toBe(false);
    expect(calls).toBe(1);
  });

  test("stops at the budget and does not start the next task", async () => {
    cost = 1;
    const ws = workspaceWith(["- [ ] T001 Costs a dollar", "- [ ] T002 Not started"]);
    const run = startRun(ws.id, "001-demo", { budget_usd: 0.5 });
    await until(() => getRun(run.id)!.status === "stopped", "the budget stop");
    const stopped = getRun(run.id)!;
    expect(stopped.reason).toMatch(/Budget reached: \$1\.00 of \$0\.50/);
    expect(stopped.spent_usd).toBe(1);
    expect(ticked(ws, "T001")).toBe(true); // the task in flight was settled, not thrown away
    expect(ticked(ws, "T002")).toBe(false);
    expect(calls).toBe(1);
  });

  test("the task limit stops the run once that many are done", async () => {
    const ws = workspaceWith(["- [ ] T001 One", "- [ ] T002 Two", "- [ ] T003 Three"]);
    const run = startRun(ws.id, "001-demo", { max_tasks: 2 });
    await until(() => getRun(run.id)!.status === "stopped", "the task limit");
    expect(getRun(run.id)!.reason).toMatch(/limit of 2 task/);
    expect(ticked(ws, "T003")).toBe(false);
  });

  test("pausing lets the task in flight finish, then starts nothing until resumed", async () => {
    const ws = workspaceWith(["- [ ] T001 One", "- [ ] T002 Two"]);
    const run = startRun(ws.id, "001-demo");
    pauseRun(run.id);
    await until(() => ticked(ws, "T001"), "T001 to finish");
    expect(getRun(run.id)!.status).toBe("paused");
    expect(ticked(ws, "T002")).toBe(false);
    expect(calls).toBe(1);
    resumeRun(run.id);
    await until(() => getRun(run.id)!.status === "done", "the resumed run to finish");
    expect(ticked(ws, "T002")).toBe(true);
  });
});

describe("autopilot: approval gates", () => {
  test("every N tasks: pauses for approval, and approve carries on", async () => {
    const ws = workspaceWith(["- [ ] T001 One", "- [ ] T002 Two"]);
    const run = startRun(ws.id, "001-demo", { approval_policy: { every: 1 } });
    await until(() => getRun(run.id)!.status === "awaiting_approval", "the gate");
    const waiting = getRun(run.id)!;
    expect(waiting.gate?.kind).toBe("every");
    expect(waiting.reason).toMatch(/1 task\(s\) done/);
    expect(calls).toBe(1);
    approveRun(run.id);
    // After the second task there is nothing left, so the run finishes without a second gate.
    await until(() => getRun(run.id)!.status === "done", "the run to finish");
    expect(ticked(ws, "T002")).toBe(true);
    expect(getRun(run.id)!.log.some((l) => l.kind === "gate" && /Approved/.test(l.text))).toBe(true);
  });

  test("reject stops the run before the gated work", async () => {
    const ws = workspaceWith(["- [ ] T001 One", "- [ ] T002 Two"]);
    const run = startRun(ws.id, "001-demo", { approval_policy: { every: 1 } });
    await until(() => getRun(run.id)!.status === "awaiting_approval", "the gate");
    rejectRun(run.id);
    const stopped = getRun(run.id)!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.reason).toMatch(/^Rejected: 1 task/);
    expect(ticked(ws, "T002")).toBe(false);
    expect(calls).toBe(1);
  });

  test("a task tagged [APPROVE] waits for approval before it starts", async () => {
    const ws = workspaceWith(["- [ ] T001 Plain", "- [ ] T002 Delete the old table [APPROVE]"]);
    const run = startRun(ws.id, "001-demo", { approval_policy: { tagged: true } });
    await until(() => getRun(run.id)!.status === "awaiting_approval", "the tagged gate");
    expect(getRun(run.id)!.gate?.kind).toBe("tagged");
    expect(getRun(run.id)!.gate?.text).toMatch(/T002 is tagged \[APPROVE\]/);
    expect(calls).toBe(1);
    approveRun(run.id);
    await until(() => getRun(run.id)!.status === "done", "the run to finish");
    expect(ticked(ws, "T002")).toBe(true);
  });

  test("approve and reject only apply to a run that is waiting", () => {
    const ws = workspaceWith(["- [ ] T001 One"]);
    const run = startRun(ws.id, "001-demo");
    expect(() => approveRun(run.id)).toThrow(/not waiting for approval/);
    stopRun(run.id);
  });
});

describe("autopilot: parallel batches", () => {
  test("[P] tasks run together in their own worktrees, up to the concurrency, and are ticked once they pass", async () => {
    const ws = workspaceWith(["- [ ] T001 [P] First in a.txt", "- [ ] T002 [P] Second in b.txt"]);
    const run = startRun(ws.id, "001-demo", { concurrency: 2 });
    expect(run.active.map((m) => m.id)).toEqual(["T001", "T002"]);
    expect(run.active.every((m) => m.isolated)).toBe(true);
    await until(() => getRun(run.id)!.status === "done", "the batch to finish");
    expect(ticked(ws, "T001")).toBe(true);
    expect(ticked(ws, "T002")).toBe(true);
    expect(calls).toBe(2);
  });

  test("a batch behind an approval gate waits for the merge approval", async () => {
    const ws = workspaceWith(["- [ ] T001 [P] First", "- [ ] T002 [P] Second"]);
    const run = startRun(ws.id, "001-demo", { concurrency: 2, approval_policy: { merge: true } });
    await until(() => getRun(run.id)!.status === "awaiting_approval", "the merge gate");
    expect(getRun(run.id)!.gate?.kind).toBe("merge");
    expect(ticked(ws, "T001")).toBe(false);
    approveRun(run.id);
    await until(() => getRun(run.id)!.status === "done", "the run to finish");
  });
});

describe("autopilot: a merge conflict in a batch", () => {
  test("stops the run, keeps the branches, and ticks no box of the batch", async () => {
    // Each [P] task rewrites the same line of shared.txt in its own worktree, so the second patch cannot apply.
    setTurnRunner(async (o) => {
      calls++;
      fs.writeFileSync(path.join(o.cwd, "shared.txt"), `${/T001/.test(o.prompt) ? "from T001" : "from T002"}\n`);
      return turn(0);
    });
    const ws = workspaceWith(["- [ ] T001 [P] First edits shared.txt", "- [ ] T002 [P] Second edits shared.txt"], { "shared.txt": "base\n" });
    const run = startRun(ws.id, "001-demo", { concurrency: 2 });
    await until(() => getRun(run.id)!.status === "failed", "the conflict stop");
    const failed = getRun(run.id)!;
    expect(failed.reason).toMatch(/do not apply cleanly/);
    expect(failed.reason).toMatch(/Nothing from it was applied; its branch \S+ is kept/);
    expect(ticked(ws, "T001")).toBe(false);
    expect(ticked(ws, "T002")).toBe(false);
    expect(failed.done).toBe(0);
    // The first patch went in, the second did not: the workspace holds exactly one of the two edits.
    expect(fs.readFileSync(path.join(ws.path, "shared.txt"), "utf-8")).toMatch(/^from T00[12]\r?\n$/);
    const branch = failed.reason!.match(/its branch (\S+) is kept/)![1];
    expect(git(["rev-parse", "--verify", branch], ws.path).ok).toBe(true);
  });
});

describe("autopilot: a restart", () => {
  test("a task whose turn the restart interrupted is sent a follow-up and then finishes", async () => {
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      calls++;
      prompts.push(o.prompt);
      if (calls === 1) {
        await new Promise<void>((resolve) => o.signal?.addEventListener("abort", () => resolve()));
        return { ...turn(0), success: false, aborted: true } as TurnResult;
      }
      return turn(0);
    });
    const ws = workspaceWith(["- [ ] T001 First thing", "- [ ] T002 Second thing"]);
    const run = startRun(ws.id, "001-demo");
    await until(() => calls === 1, "the first turn to start");
    const session = getRun(run.id)!.active[0].session;

    stopAutopilot(); // the daemon goes down mid-turn: the row still says running, and nothing is left of the turn
    await interrupt({ operator: true }, session);
    db().prepare("UPDATE sessions SET status = 'running', last_error = NULL WHERE id = ?").run(session);
    db().prepare("UPDATE turns SET status = 'running' WHERE session_id = ?").run(session);
    expect(recoverOnStartup().interrupted).toBe(1);
    expect(getSession(session)!.status).toBe("failed");
    expect(getRun(run.id)!.status).toBe("running");
    expect(ticked(ws, "T001")).toBe(false);

    startAutopilot();
    await until(() => getRun(run.id)!.status === "done", "the run to finish after the restart");
    expect(prompts.length).toBe(3); // T001, its follow-up, T002: T001 was not started over
    expect(prompts[1]).toMatch(/daemon restarted while you were working on this task/);
    expect(ticked(ws, "T001")).toBe(true);
    expect(ticked(ws, "T002")).toBe(true);
    expect(getRun(run.id)!.log.some((l) => /the daemon restarted during its turn; continuing it/.test(l.text))).toBe(true);
  }, 30_000);
});

describe("autopilot: pull requests and their checks", () => {
  let checks: "pending" | "passing" | "failing";
  let opened: string[];
  let polls: number;
  beforeEach(() => {
    checks = "passing";
    opened = [];
    polls = 0;
    setPrFlow({
      open: async (sessionId) => {
        opened.push(sessionId);
        return { pr: { number: 7 } };
      },
      checks: async () => {
        polls++;
        return { state: checks };
      },
    });
  }, 30_000);

  test("passing checks: the task gets a PR, the run continues, and the box is ticked", async () => {
    const ws = workspaceWith(["- [ ] T001 First thing", "- [ ] T002 Second thing"]);
    const run = startRun(ws.id, "001-demo", { open_pr: true });
    await until(() => getRun(run.id)!.status === "done", "the run to finish");
    expect(opened.length).toBe(2); // one PR per task
    expect(ticked(ws, "T001")).toBe(true);
    expect(ticked(ws, "T002")).toBe(true);
    expect(getRun(run.id)!.log.some((l) => /T001: opened pull request #7/.test(l.text))).toBe(true);
  }, 30_000);

  test("failing checks: the run fails, and the box stays open", async () => {
    checks = "failing";
    const ws = workspaceWith(["- [ ] T001 First thing", "- [ ] T002 Never reached"]);
    const run = startRun(ws.id, "001-demo", { open_pr: true });
    await until(() => getRun(run.id)!.status === "failed", "the run to fail");
    expect(getRun(run.id)!.reason).toMatch(/T001: the checks of pull request #7 are failing/);
    expect(ticked(ws, "T001")).toBe(false);
    expect(calls).toBe(1);
    expect(opened.length).toBe(1);
  }, 30_000);

  test("pending checks: nothing advances across passes until they settle", async () => {
    checks = "pending";
    const ws = workspaceWith(["- [ ] T001 First thing", "- [ ] T002 Second thing"]);
    const run = startRun(ws.id, "001-demo", { open_pr: true });
    await until(() => polls >= 1, "the first poll");
    for (let i = 0; i < 3; i++) {
      advanceAll();
      await until(() => polls >= i + 2, "another poll");
    }
    const waiting = getRun(run.id)!;
    expect(waiting.status).toBe("running");
    expect(waiting.active.map((m) => m.id)).toEqual(["T001"]);
    expect(ticked(ws, "T001")).toBe(false);
    expect(calls).toBe(1);
    expect(opened.length).toBe(1); // the PR is opened once, then only polled
    checks = "passing";
    advanceAll();
    await until(() => getRun(run.id)!.status === "done", "the run to finish once checks pass");
    expect(ticked(ws, "T001")).toBe(true);
    expect(ticked(ws, "T002")).toBe(true);
  }, 30_000);
});

describe("autopilot: starting", () => {
  test("refuses a spec with no open task, and a budget that is not positive", () => {
    const ws = workspaceWith(["- [x] T001 Done already"]);
    expect(() => startRun(ws.id, "001-demo")).toThrow(/already done/);
    const ws2 = workspaceWith(["- [ ] T001 Open"]);
    expect(() => startRun(ws2.id, "001-demo", { budget_usd: 0 })).toThrow(/budget/);
  });

  test("the run is found by its workspace in the list", () => {
    const ws = workspaceWith(["- [ ] T001 Open"]);
    const run = startRun(ws.id, "001-demo", { approval_policy: { every: 1 } });
    expect(listRuns(ws.id).map((r) => r.id)).toContain(run.id);
    expect(listRuns("w_none")).toEqual([]);
    stopRun(run.id);
    advanceAll(); // a stopped run is not advanced any more
    expect(getRun(run.id)!.status).toBe("stopped");
  });
});
