import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START goal\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END goal\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import { fingerprint, getGoal, normalizeGoal, parseGoalStatus, recoverGoals, runCheck, setGoal, stopGoal, type Goal } from "../src/sessions/goal";
import { setDaemonContext } from "../src/sessions/context";
import { close, createLead, getSession, interrupt, interruptAll, readLog, send, setTurnRunner, viewSession } from "../src/sessions/manager";
import type { TurnResult } from "../src/engines/runner";
import { makeDir, makeRepo, resetState, settled } from "./helpers";

beforeEach(() => {
  resetState();
  getGoal("-"); // makes sure the table exists
  db().exec("DELETE FROM session_goals");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
  delete process.env.TRB_GOAL_CHECK_TIMEOUT_MS;
});

/** Wait until the goal loop is over (the loop sends its own turns, so a single turn's end is not the end). */
async function over(id: string, timeoutMs = 20_000): Promise<Goal> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = getGoal(id);
    const s = getSession(id);
    if (g && g.status !== "active" && s?.status !== "running") return g;
    if (Date.now() > until) throw new Error(`goal still ${g?.status} (session ${s?.status}) after ${timeoutMs}ms`);
    await Bun.sleep(40);
  }
}

const result = (output: string, over: Partial<TurnResult> = {}): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...over });
const lead = (prompt: string, over: Record<string, unknown> = {}) => createLead({ prompt, engine: "fake", cwd: makeDir(), ...over } as any);
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).length : 0);

describe("goal with a check command", () => {
  test("keeps sending turns until the command exits 0, then stops as met", async () => {
    const cwd = makeDir();
    const s0 = createLead({ prompt: "SAY starting", engine: "fake", cwd, goal: { text: "BASH echo x >> count.txt", check: "test $(wc -l < count.txt) -ge 3" } });
    const g = await over(s0.id);
    expect(g.status).toBe("met");
    expect(g.turns_used).toBe(3);
    expect(lines(path.join(cwd, "count.txt"))).toBe(3);
    expect(getSession(s0.id)!.turns).toBe(3);
    expect(g.last_note).toContain("passed after 3 turns");
    expect(g.last_check_exit).toBe(0);
  });

  test("the next prompt carries the goal, the failing output, and the budget left", async () => {
    const prompts: string[] = [];
    let n = 0;
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return result(`turn ${++n}`);
    });
    const s0 = createLead({ prompt: "begin", engine: "fake", cwd: makeDir(), goal: { text: "ship the thing", check: "echo MISSING-semicolon-xyz; exit 3", maxTurns: 2 } });
    const g = await over(s0.id);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("## Goal");
    expect(prompts[0]).toContain("ship the thing");
    expect(prompts[1]).toContain("turn 2 of 2");
    expect(prompts[1]).toContain("ship the thing");
    expect(prompts[1]).toContain("exited 3");
    expect(prompts[1]).toContain("MISSING-semicolon-xyz");
    expect(g.status).toBe("exhausted");
  });

  test("the check is the truth: the agent saying DONE does not end it", async () => {
    setTurnRunner(async () => result("all finished\nGOAL_STATUS: DONE"));
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: makeDir(), goal: { text: "g", check: "false", maxTurns: 2 } });
    expect((await over(s0.id)).status).toBe("exhausted");
    expect(getSession(s0.id)!.turns).toBe(2);
  });

  test("runs in the session's directory, and a long check is killed", async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "marker"), "");
    expect((await runCheck("test -f marker", dir)).exit).toBe(0);
    process.env.TRB_GOAL_CHECK_TIMEOUT_MS = "300";
    const slow = await runCheck("sleep 5", dir);
    expect(slow.timedOut).toBe(true);
    expect(slow.exit).toBe(124);
    expect(slow.output).toContain("timed out");
  });

  test("a check's output is truncated to its tail", async () => {
    const r = await runCheck("yes line | head -c 20000", makeDir());
    expect(r.output.length).toBeLessThan(3100);
    expect(r.output.startsWith("…")).toBe(true);
  });
});

describe("goal without a check command", () => {
  test("the agent decides: CONTINUE keeps going, DONE ends it", async () => {
    const prompts: string[] = [];
    const answers = ["part one\nGOAL_STATUS: CONTINUE parser still missing", "part two\nGOAL_STATUS: CONTINUE tests", "done\n**GOAL_STATUS: DONE**"];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return result(answers[prompts.length - 1]);
    });
    const s0 = createLead({ prompt: "go", engine: "fake", cwd: makeDir(), goal: { text: "build the parser" } });
    const g = await over(s0.id);
    expect(g.status).toBe("met");
    expect(g.turns_used).toBe(3);
    expect(prompts[0]).toContain("GOAL_STATUS: DONE");
    expect(prompts[1]).toContain("Continue with what remains");
    expect(g.last_note).toContain("reported DONE");
  });

  test("a reply with no GOAL_STATUS line is nudged, not trusted", async () => {
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return result(prompts.length === 1 ? "I think that is it." : "ok\nGOAL_STATUS: DONE");
    });
    const s0 = createLead({ prompt: "go", engine: "fake", cwd: makeDir(), goal: { text: "g" } });
    expect((await over(s0.id)).status).toBe("met");
    expect(prompts[1]).toContain("did not end with a GOAL_STATUS line");
  });

  test("the last status line wins", () => {
    expect(parseGoalStatus("GOAL_STATUS: CONTINUE\n...\nGOAL_STATUS: DONE")).toBe("DONE");
    expect(parseGoalStatus("goal_status: done")).toBe("DONE");
    expect(parseGoalStatus("no marker")).toBeNull();
    expect(parseGoalStatus("say GOAL_STATUS: DONE inside a sentence")).toBeNull();
    expect(parseGoalStatus(null)).toBeNull();
  });
});

describe("limits and stalls", () => {
  test("stops as exhausted when the turn budget is spent", async () => {
    const cwd = makeDir();
    const s0 = createLead({ prompt: "x", engine: "fake", cwd, goal: { text: "BASH echo $RANDOM >> f.txt", check: "false", maxTurns: 3 } });
    const g = await over(s0.id);
    expect(g.status).toBe("exhausted");
    expect(g.turns_used).toBe(3);
    expect(g.last_note).toContain("used all 3 turns");
  });

  test("stops as exhausted when the time budget is spent", async () => {
    setTurnRunner(async () => result("working"));
    // A goal whose clock ran out before its first evaluation.
    const id = (await settled(lead("SAY idle").id)).id;
    setGoal(id, { text: "g", check: "false", maxMinutes: 1 });
    db().prepare("UPDATE session_goals SET started_at = ? WHERE session_id = ?").run(new Date(Date.now() - 5 * 60_000).toISOString(), id);
    const done = await over(id);
    expect(done.status).toBe("exhausted");
    expect(done.last_note).toContain("minute budget");
  });

  test("stops as stalled after two more turns that change nothing and report the same", async () => {
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: makeDir(), goal: { text: "SAY thinking about it", check: "echo still-broken; false" } });
    const g = await over(s0.id);
    expect(g.status).toBe("stalled");
    expect(g.turns_used).toBe(3);
    expect(g.last_note).toContain("changed no files");
  });

  test("progress resets the stall counter: a file that changes every turn never stalls", async () => {
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: makeDir(), goal: { text: "BASH echo $RANDOM >> f.txt", check: "echo same; false", maxTurns: 5 } });
    const g = await over(s0.id);
    expect(g.status).toBe("exhausted");
    expect(g.turns_used).toBe(5);
  });

  test("the fingerprint moves with file content, in a git repo and outside one", () => {
    for (const dir of [makeRepo(), makeDir()]) {
      const a = fingerprint(dir);
      expect(fingerprint(dir)).toBe(a);
      fs.writeFileSync(path.join(dir, "new.txt"), "1");
      const b = fingerprint(dir);
      expect(b).not.toBe(a);
      fs.writeFileSync(path.join(dir, "new.txt"), "22");
      expect(fingerprint(dir)).not.toBe(b);
    }
  });
});

describe("it never loops past the operator", () => {
  test("interrupting a turn stops the goal, and no further turn is sent", async () => {
    const s0 = createLead({ prompt: "SLEEP 5000", engine: "fake", cwd: makeDir(), goal: { text: "g", check: "false" } });
    await Bun.sleep(300);
    await interrupt({ operator: true }, s0.id);
    const g = await over(s0.id);
    expect(g.status).toBe("stopped");
    expect(g.last_note).toBe("interrupted");
    await Bun.sleep(300);
    expect(getSession(s0.id)!.turns).toBe(1);
    expect(getSession(s0.id)!.status).toBe("idle");
  });

  test("closing the session stops the goal", async () => {
    const s0 = createLead({ prompt: "SLEEP 5000", engine: "fake", cwd: makeDir(), goal: { text: "g", check: "false" } });
    await Bun.sleep(300);
    await close({ operator: true }, s0.id);
    expect(getGoal(s0.id)!.status).toBe("stopped");
    expect(getGoal(s0.id)!.last_note).toBe("the session was closed");
  });

  test("stopping during the check ends it before another turn", async () => {
    let turns = 0;
    setTurnRunner(async () => result(`t${++turns}`));
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: makeDir(), goal: { text: "g", check: "sleep 0.6; false" } });
    await Bun.sleep(300); // the turn is over, the check is running
    stopGoal(s0.id, "stopped by you");
    await Bun.sleep(900);
    expect(turns).toBe(1);
    expect(getGoal(s0.id)!.status).toBe("stopped");
  });

  test("a failed turn stops the goal and says why", async () => {
    setTurnRunner(async () => result("Provider rate limit hit", { success: false }));
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: makeDir(), goal: { text: "g", check: "false" } });
    const g = await over(s0.id);
    expect(g.status).toBe("stopped");
    expect(g.last_note).toContain("the turn failed");
    expect(g.last_note).toContain("rate limit");
  });

  test("a daemon restart leaves no goal marked active", async () => {
    const id = (await settled(lead("SAY hi").id)).id;
    db().prepare("DELETE FROM session_goals WHERE session_id = ?").run(id);
    setGoal(id, { text: "g", check: "false" }, { kickoff: false });
    expect(recoverGoals()).toBe(1);
    expect(getGoal(id)).toMatchObject({ status: "stopped" });
    expect(getGoal(id)!.last_note).toContain("daemon restarted");
  });
});

describe("setting a goal mid-session", () => {
  test("on an idle session it starts a turn straight away", async () => {
    const cwd = makeDir();
    const s0 = await settled(createLead({ prompt: "SAY hi", engine: "fake", cwd }).id);
    expect(getGoal(s0.id)).toBeNull();
    setGoal(s0.id, { text: "BASH echo x >> n.txt", check: "test $(wc -l < n.txt) -ge 2" });
    const g = await over(s0.id);
    expect(g.status).toBe("met");
    expect(getSession(s0.id)!.turns).toBe(3); // the first turn, then two under the goal
  });

  test("on a running session it waits for the turn to end, which counts as the first", async () => {
    const cwd = makeDir();
    const s0 = createLead({ prompt: "SLEEP 400\nBASH echo x >> n.txt", engine: "fake", cwd });
    setGoal(s0.id, { text: "BASH echo x >> n.txt", check: "test $(wc -l < n.txt) -ge 2" });
    const g = await over(s0.id);
    expect(g.status).toBe("met");
    expect(g.turns_used).toBe(2);
  });

  test("setting again replaces the earlier goal", async () => {
    const s0 = await settled(lead("SAY hi").id);
    setGoal(s0.id, { text: "first", check: "false" }, { kickoff: false });
    setGoal(s0.id, { text: "second", maxTurns: 5 }, { kickoff: false });
    expect(getGoal(s0.id)).toMatchObject({ text: "second", check_cmd: null, max_turns: 5, turns_used: 0, status: "active" });
  });

  test("a closed or missing session cannot take a goal", async () => {
    expect(() => setGoal("s_ghost", { text: "g" })).toThrow(/No session/);
    const s0 = await settled(lead("SAY hi").id);
    await close({ operator: true }, s0.id);
    expect(() => setGoal(s0.id, { text: "g" })).toThrow(/closed/);
  });

  test("a message the operator sends mid-goal is judged like any turn", async () => {
    const cwd = makeDir();
    const s0 = createLead({ prompt: "SAY hi", engine: "fake", cwd, goal: { text: "SLEEP 600", check: "test -f done.txt" } });
    await Bun.sleep(200);
    // The first turn finishes, a check fails and the loop's own second turn is running: the operator's send is refused, not queued behind it.
    expect(() => send({ operator: true }, s0.id, "WRITE done.txt ok")).toThrow(/still working/);
    stopGoal(s0.id, "stopped by you");
    await settled(s0.id);
    send({ operator: true }, s0.id, "WRITE done.txt ok");
    await settled(s0.id);
    expect(getGoal(s0.id)!.status).toBe("stopped");
  });
});

describe("visibility", () => {
  test("progress is written to the log as info lines, and the session view carries the goal", async () => {
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: makeDir(), goal: { text: "BASH echo x >> c.txt", check: "test $(wc -l < c.txt) -ge 2" } });
    await over(s0.id);
    const info = readLog(s0.id).filter((l) => l.kind === "info" && l.text.startsWith("[goal]")).map((l) => l.text);
    expect(info[0]).toContain("[goal] set:");
    expect(info.some((t) => t.includes("turn 1/12") && t.includes("continuing"))).toBe(true);
    expect(info[info.length - 1]).toContain("[goal] met:");
    const view = viewSession(getSession(s0.id)!);
    expect(view.goal).toMatchObject({ status: "met", turns_used: 2, check_cmd: "test $(wc -l < c.txt) -ge 2" });
    expect(viewSession(getSession((await settled(lead("SAY a").id)).id)!).goal).toBeNull();
  });

  test("validation: text, limits and a bad goal creates no session", () => {
    expect(() => normalizeGoal({ text: "  " })).toThrow(/needs text/);
    expect(() => normalizeGoal({ text: "g", maxTurns: 0 })).toThrow(/max turns/);
    expect(() => normalizeGoal({ text: "g", maxTurns: 101 })).toThrow(/max turns/);
    expect(() => normalizeGoal({ text: "g", maxMinutes: 1.5 })).toThrow(/max minutes/);
    expect(normalizeGoal({ text: " g " })).toEqual({ text: "g", check: null, maxTurns: 12, maxMinutes: 60 });
    const before = (db().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    expect(() => createLead({ prompt: "x", engine: "fake", cwd: makeDir(), goal: { text: "" } })).toThrow(/needs text/);
    expect((db().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(before);
  });
});

describe("goal over HTTP", () => {
  const TOKEN = "goal-api-token";
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
    setDaemonContext({ url: srv.url, token: TOKEN });
  });
  afterAll(() => {
    setDaemonContext(null);
    srv.stop();
  });
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  test("create with a goal, read it, and watch it finish", async () => {
    const made = await call("POST", "/api/sessions", { prompt: "SAY go", engine: "fake", cwd: makeDir(), goal: { text: "BASH echo x >> c.txt", check: "test $(wc -l < c.txt) -ge 2", max_turns: 5 } });
    expect(made.status).toBe(201);
    const id = made.body.session.id as string;
    expect(made.body.session.goal).toMatchObject({ max_turns: 5, status: "active" });
    await over(id);
    expect((await call("GET", `/api/sessions/${id}/goal`)).body.goal.status).toBe("met");
    expect((await call("GET", `/api/sessions/${id}`)).body.session.goal.status).toBe("met");
  });

  test("set one on a running session, then stop it", async () => {
    const id = (await call("POST", "/api/sessions", { prompt: "SLEEP 4000", engine: "fake", cwd: makeDir() })).body.session.id as string;
    const put = await call("PUT", `/api/sessions/${id}/goal`, { text: "g", check: "false", max_turns: 9, max_minutes: 30 });
    expect(put.status).toBe(200);
    expect(put.body.goal).toMatchObject({ text: "g", check_cmd: "false", max_turns: 9, max_minutes: 30, status: "active" });
    const stop = await call("POST", `/api/sessions/${id}/goal/stop`);
    expect(stop.body.goal).toMatchObject({ status: "stopped", last_note: "stopped by you" });
    await interrupt({ operator: true }, id);
  });

  test("errors are 400s and 404s, not 500s", async () => {
    const id = (await call("POST", "/api/sessions", { prompt: "SAY x", engine: "fake", cwd: makeDir() })).body.session.id as string;
    await settled(id);
    expect((await call("PUT", `/api/sessions/${id}/goal`, { text: "" })).status).toBe(400);
    expect((await call("PUT", `/api/sessions/${id}/goal`, { text: "g", max_turns: 500 })).status).toBe(400);
    expect((await call("GET", "/api/sessions/s_ghost/goal")).status).toBe(404);
    expect((await call("POST", "/api/sessions", { prompt: "x", engine: "fake", cwd: makeDir(), goal: { text: "" } })).status).toBe(400);
  });
});
