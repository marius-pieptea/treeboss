import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import { db } from "../src/db";
import { createChild, createLead, getSession, interruptAll, recoverOnStartup, send, setTurnRunner, viewSession, wait } from "../src/sessions/manager";
import { waitStep } from "../src/sessions/waiting";
import { makeDir, makeRepo, resetState, settled, sh } from "./helpers";

const result = (output: string, success = true, aborted = false) =>
  ({ success, output, sessionId: "engine-x", resumeRejected: false, aborted, timedOut: false, maxTurnsHit: false, usage: null, exitCode: success ? 0 : 1, stderr: "" }) as any;

/** Every turn answers at once. */
const answer = (text: string) => setTurnRunner(async () => result(text));
/** Every turn runs until it is interrupted, so a head stays live. */
const hold = () => setTurnRunner((o: any) => new Promise((resolve) => o.signal?.addEventListener("abort", () => resolve(result("", false, true)))));

const commit = (cwd: string, file: string) => sh(`echo work > ${file} && git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm wip`, cwd);

beforeEach(() => {
  resetState();
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

describe("a head the daemon died before its engine started", () => {
  test("is interrupted and keeps its context; its empty worktree is swept, so it cannot be resumed", async () => {
    answer("LEAD");
    const lead = await settled(createLead({ prompt: "SAY lead", engine: "fake", cwd: makeRepo() }).id);
    answer("HEAD");
    const head = await settled(createChild({ caller: { sessionId: lead.id }, brief: "SAY head" }).id);
    // Launched (the intent is recorded) and then the daemon died before the first turn.
    expect(head.launch_state).toBeNull();
    const cwd = head.cwd;
    db().prepare("UPDATE sessions SET status = 'idle', launch_state = 'launching', cli_session_id = NULL, last_error = NULL WHERE id = ?").run(head.id);
    expect(fs.existsSync(cwd)).toBe(true);

    const r = recoverOnStartup();
    expect(r.launchInterrupted).toBe(1);
    expect(r.headsInterrupted).toBe(1);
    expect(r.worktreesKept).toBe(0);
    expect(r.swept).toBeGreaterThanOrEqual(1);

    const after = getSession(head.id)!;
    expect(after.status).toBe("failed");
    expect(after.launch_state).toBeNull();
    expect(after.last_error).toContain("before this subagent started");
    expect(fs.existsSync(cwd)).toBe(false);
    expect(() => send({ operator: true }, head.id, "go")).toThrow(/no workspace/);
  });

  test("a head with commits or uncommitted edits keeps its worktree", async () => {
    answer("LEAD");
    const lead = await settled(createLead({ prompt: "SAY lead", engine: "fake", cwd: makeRepo() }).id);
    answer("HEAD");
    const committed = await settled(createChild({ caller: { sessionId: lead.id }, brief: "SAY head", title: "committed" }).id);
    const dirty = await settled(createChild({ caller: { sessionId: lead.id }, brief: "SAY head", title: "dirty" }).id);
    commit(committed.cwd, "work.txt");
    fs.writeFileSync(`${dirty.cwd}/draft.txt`, "unsaved\n");
    db().prepare("UPDATE sessions SET status = 'running' WHERE id IN (?, ?)").run(committed.id, dirty.id);

    const r = recoverOnStartup();
    expect(r.headsInterrupted).toBe(2);
    expect(r.worktreesKept).toBe(2);
    expect(r.launchInterrupted).toBe(0);
    expect(fs.existsSync(`${committed.cwd}/work.txt`)).toBe(true);
    expect(fs.existsSync(`${dirty.cwd}/draft.txt`)).toBe(true);
    expect(getSession(committed.id)!.status).toBe("failed");
    expect(getSession(committed.id)!.last_error).toContain("daemon stopped mid-turn");
    expect(getSession(committed.id)!.cli_session_id).toBe("engine-x");
  });

  test("a head that starts clears its launch intent", async () => {
    answer("HEAD");
    const lead = await settled(createLead({ prompt: "SAY lead", engine: "fake", cwd: makeDir() }).id);
    const head = await settled(createChild({ caller: { sessionId: lead.id }, brief: "SAY head" }).id);
    expect(head.status).toBe("idle");
    expect(head.launch_state).toBeNull();
  });
});

describe("a lead blocked in subagent_wait when the daemon died", () => {
  test("is flagged, its heads' results stay retrievable, and the flag clears on its next turn", async () => {
    answer("LEAD");
    const lead = await settled(createLead({ prompt: "SAY lead", engine: "fake", cwd: makeDir() }).id);
    answer("HEAD RESULT");
    const head = await settled(createChild({ caller: { sessionId: lead.id }, brief: "SAY 42", title: "the head" }).id);
    // The wait was open (persisted) and the lead's turn was running when the daemon died.
    db().prepare("INSERT INTO session_waits (id, caller_id, ids_json, mode, since) VALUES (?, ?, ?, ?, ?)").run("w_crash", lead.id, JSON.stringify([head.id]), "all", new Date().toISOString());
    db().prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(lead.id);

    const r = recoverOnStartup();
    expect(r.waitsInterrupted).toBe(1);

    const after = getSession(lead.id)!;
    expect(after.status).toBe("failed");
    expect(after.last_error).toContain("wait interrupted");
    const view = viewSession(after);
    expect(view.wait_interrupted?.mode).toBe("all");
    expect(view.wait_interrupted?.ids).toEqual([{ id: head.id, name: "the head", status: "idle" }]);
    expect(view.waiting_on).toBeUndefined();

    const res = await wait({ sessionId: lead.id }, [head.id], { timeoutSec: 5 });
    expect(res.sessions[0].last_output).toBe("HEAD RESULT");

    await settled(send({ operator: true }, lead.id, "carry on").id);
    expect(viewSession(getSession(lead.id)!).wait_interrupted).toBeFalsy();
  });

  test("a wait is persisted while it is open and its row is dropped when it ends", async () => {
    answer("LEAD");
    const lead = await settled(createLead({ prompt: "SAY lead", engine: "fake", cwd: makeDir() }).id);
    hold();
    const head = createChild({ caller: { sessionId: lead.id }, brief: "SLEEP" });
    const rows = () => (db().prepare("SELECT COUNT(*) AS n FROM session_waits WHERE caller_id = ?").get(lead.id) as { n: number }).n;

    const pending = waitStep({ ids: [head.id], mode: "all", timeoutSec: 1, resume: null }, { sessionId: lead.id });
    expect(rows()).toBe(1);
    await pending;
    expect(rows()).toBe(0);
  });
});
