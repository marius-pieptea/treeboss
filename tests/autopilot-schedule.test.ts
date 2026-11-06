import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { DEPS_PROMPT, createSchedule, deleteSchedule, getSchedule, listSchedules, runSchedule, tickSchedules, updateSchedule } from "../src/autopilot/schedule";
import { getSession, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { setGlobalConfig } from "../src/verify/store";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState } from "./helpers";

const turn = (): TurnResult => ({ success: true, output: "done", sessionId: null, resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" }) as unknown as TurnResult;

async function until(cond: () => boolean, label: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(50);
  }
}

function workspace() {
  return Workspaces.open(makeRepo({ "a.txt": "one\n" }));
}

beforeEach(() => {
  resetState();
  setTurnRunner(async () => turn());
  setGlobalConfig({ enabled: false, commands: null, max_retries: null, timeout_sec: 60 });
  listSchedules(); // creates the table
  db().exec("DELETE FROM schedules");
});

afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
  setGlobalConfig({ enabled: null, commands: null, max_retries: null, timeout_sec: null });
});

describe("schedules: definitions", () => {
  test("a new job is due at its next slot, and carries its kind and payload", () => {
    const ws = workspace();
    const s = createSchedule({ workspace_id: ws.id, name: "Weekly deps", cron: "0 9 * * 1", kind: "deps_update" });
    expect(s.enabled).toBe(true);
    expect(s.next_run_at).not.toBeNull();
    const next = new Date(s.next_run_at!);
    expect(next.getDay()).toBe(1); // a Monday
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(getSchedule(s.id)!.kind).toBe("deps_update");
  });

  test("validates the cron, the kind and the payload", () => {
    const ws = workspace();
    expect(() => createSchedule({ workspace_id: ws.id, name: "x", cron: "every day", kind: "prompt", payload: { prompt: "hi" } })).toThrow(/five fields/);
    expect(() => createSchedule({ workspace_id: ws.id, name: "x", cron: "0 9 * * *", kind: "backup" })).toThrow(/Unknown kind/);
    expect(() => createSchedule({ workspace_id: ws.id, name: "x", cron: "0 9 * * *", kind: "prompt", payload: {} })).toThrow(/needs a prompt/);
    expect(() => createSchedule({ workspace_id: ws.id, name: "x", cron: "0 9 * * *", kind: "lab_sweep" })).toThrow(/needs a lens/);
    expect(() => createSchedule({ workspace_id: "w_missing", name: "x", cron: "0 9 * * *", kind: "verify" })).toThrow(/No workspace/);
    expect(() => createSchedule({ workspace_id: ws.id, name: "  ", cron: "0 9 * * *", kind: "verify" })).toThrow(/needs a name/);
  });

  test("a disabled job has no next slot; switching it on gives one", () => {
    const ws = workspace();
    const s = createSchedule({ workspace_id: ws.id, name: "Later", cron: "0 9 * * *", kind: "verify", enabled: false });
    expect(s.next_run_at).toBeNull();
    const on = updateSchedule(s.id, { enabled: true });
    expect(on.next_run_at).not.toBeNull();
    const off = updateSchedule(s.id, { enabled: false });
    expect(off.next_run_at).toBeNull();
  });

  test("changing the cron moves the next slot", () => {
    const ws = workspace();
    const s = createSchedule({ workspace_id: ws.id, name: "Moves", cron: "0 9 * * *", kind: "verify" });
    const moved = updateSchedule(s.id, { cron: "30 17 * * *" });
    expect(new Date(moved.next_run_at!).getMinutes()).toBe(30);
    expect(new Date(moved.next_run_at!).getHours()).toBe(17);
  });

  test("delete removes the job", () => {
    const ws = workspace();
    const s = createSchedule({ workspace_id: ws.id, name: "Gone", cron: "0 9 * * *", kind: "verify" });
    expect(deleteSchedule(s.id)).toBe(true);
    expect(getSchedule(s.id)).toBeNull();
    expect(deleteSchedule(s.id)).toBe(false);
  });
});

describe("schedules: running", () => {
  test("the ticker starts a due prompt job with its prompt, once, and moves its slot on", () => {
    const ws = workspace();
    const s = createSchedule({ workspace_id: ws.id, name: "Nightly", cron: "0 2 * * *", kind: "prompt", payload: { prompt: "Summarise yesterday" } });
    const later = new Date(s.next_run_at!).getTime() + 1000;
    expect(tickSchedules(later - 2000)).toBe(0); // not yet
    expect(tickSchedules(later)).toBe(1);
    const after = getSchedule(s.id)!;
    expect(after.last_session_id).not.toBeNull();
    expect(getSession(after.last_session_id!)!.brief).toBe("Summarise yesterday");
    expect(new Date(after.next_run_at!).getTime()).toBeGreaterThan(later);
    expect(tickSchedules(later)).toBe(0); // the same slot does not run twice
  });

  test("a disabled job is never started by the ticker", () => {
    const ws = workspace();
    const s = createSchedule({ workspace_id: ws.id, name: "Off", cron: "* * * * *", kind: "prompt", payload: { prompt: "x" }, enabled: false });
    expect(tickSchedules(Date.now() + 10 * 60_000)).toBe(0);
    expect(getSchedule(s.id)!.last_session_id).toBeNull();
  });

  test("run-now starts the job without moving its slot", () => {
    const ws = workspace();
    const s = createSchedule({ workspace_id: ws.id, name: "Now", cron: "0 9 * * *", kind: "prompt", payload: { prompt: "go" } });
    const r = runSchedule(s.id);
    expect(r.session_id).not.toBeNull();
    expect(getSchedule(s.id)!.next_run_at).toBe(s.next_run_at);
    expect(getSchedule(s.id)!.last_run_at).not.toBeNull();
  });

  test("the dependency job runs the built-in update prompt in the workspace", () => {
    const ws = workspace();
    const s = createSchedule({ workspace_id: ws.id, name: "Deps", cron: "0 9 * * *", kind: "deps_update" });
    const r = runSchedule(s.id);
    expect(getSession(r.session_id!)!.brief).toBe(DEPS_PROMPT);
    expect(getSession(r.session_id!)!.cwd).toBe(ws.path);
  });

  test("the verify job runs the project's checks and keeps the result", async () => {
    setGlobalConfig({ enabled: false, commands: [{ name: "ok", cmd: "true" }], max_retries: null, timeout_sec: 60 });
    const ws = workspace();
    const s = createSchedule({ workspace_id: ws.id, name: "Checks", cron: "0 9 * * *", kind: "verify" });
    runSchedule(s.id);
    await until(() => getSchedule(s.id)!.last_result !== null, "the checks");
    const result = getSchedule(s.id)!.last_result!;
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([{ name: "ok", ok: true, exit: 0, duration_ms: expect.any(Number) }]);
  });

  test("a lab sweep with an unknown lens fails the job and keeps the reason", () => {
    const ws = workspace();
    const s = createSchedule({ workspace_id: ws.id, name: "Sweep", cron: "0 9 * * *", kind: "lab_sweep", payload: { lens: "nope" } });
    expect(() => runSchedule(s.id)).toThrow(/Unknown lens/);
    expect(getSchedule(s.id)!.last_result).toMatchObject({ ok: false });
  });
});
