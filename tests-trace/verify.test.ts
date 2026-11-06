import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START verify\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END verify\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import { detectVerifyCommands, parseCommands } from "../src/verify/detect";
import { fixPrompt, runVerifyNow, verifyGate } from "../src/verify/loop";
import { getSessionRow, patchSession, setConfig, setGlobalConfig, listRuns, resolveConfig } from "../src/verify/store";
import { getGoal } from "../src/sessions/goal";
import { createLead, getSession, interruptAll, readLog, send, setTurnRunner, viewSession } from "../src/sessions/manager";
import type { TurnResult } from "../src/engines/runner";
import { Workspaces } from "../src/workspaces";
import { makeDir, resetState } from "./helpers";

const result = (output = "ok"): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" });
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).length : 0);

beforeEach(() => {
  resetState();
  getSessionRow("-"); // makes sure the tables exist
  getGoal("-");
  db().exec("DELETE FROM verify_config; DELETE FROM session_verify; DELETE FROM verify_runs; DELETE FROM session_goals");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

/** Wait until the loop is over: the session idle, and verification reported for its latest turn (or never going to). */
async function over(id: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  let stable = 0;
  for (;;) {
    const s = getSession(id)!;
    const v = viewSession(s, { withOutput: false }).verify;
    const reported = v && v.last?.turn_id === s.last_turn_id && (v.state === "passed" || v.state === "failed");
    if (s.status !== "running" && reported) {
      if (++stable >= 3) return { s, v: v! };
    } else stable = 0;
    if (Date.now() > until) throw new Error(`still ${s.status}, verify ${v?.state} after ${timeoutMs}ms`);
    await Bun.sleep(50);
  }
}

/** The check: passes once ok.txt exists. Counts how often it ran in a sibling file, outside the tree being fingerprinted. */
const CHECK = [{ name: "check", cmd: "echo run >> \"$PWD.runs\"; test -f ok.txt || { echo 'ok.txt is missing'; exit 3; }" }];

function project(opts: { commands?: Array<{ name: string; cmd: string }>; maxRetries?: number } = {}) {
  const dir = makeDir();
  setConfig(dir, { enabled: true, commands: opts.commands ?? CHECK, max_retries: opts.maxRetries ?? 2 });
  return dir;
}

describe("detecting the project's commands", () => {
  test("package.json scripts, in typecheck, lint, test order, with the runner the lockfile implies", () => {
    const dir = makeDir();
    write(dir, "package.json", JSON.stringify({ scripts: { test: "bun test", lint: "eslint .", typecheck: "tsc --noEmit", build: "x" } }));
    write(dir, "bun.lock", "");
    expect(detectVerifyCommands(dir)).toEqual([
      { name: "typecheck", cmd: "bun run typecheck" },
      { name: "lint", cmd: "bun run lint" },
      { name: "test", cmd: "bun run test" },
    ]);
    const pnpm = makeDir();
    write(pnpm, "package.json", JSON.stringify({ scripts: { "type-check": "tsc", test: "vitest" } }));
    write(pnpm, "pnpm-lock.yaml", "");
    expect(detectVerifyCommands(pnpm).map((c) => c.cmd)).toEqual(["pnpm run type-check", "pnpm run test"]);
  });

  test("npm's placeholder test script, and projects with nothing recognisable, give no commands", () => {
    const dir = makeDir();
    write(dir, "package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectVerifyCommands(dir)).toEqual([]);
    expect(detectVerifyCommands(makeDir())).toEqual([]);
  });

  test("other ecosystems", () => {
    const rust = makeDir();
    write(rust, "Cargo.toml", "[package]");
    expect(detectVerifyCommands(rust).map((c) => c.name)).toEqual(["typecheck", "test"]);
    const go = makeDir();
    write(go, "go.mod", "module x");
    expect(detectVerifyCommands(go).map((c) => c.cmd)).toEqual(["go vet ./...", "go test ./..."]);
  });

  test("overrides are validated", () => {
    expect(parseCommands([{ name: "t", cmd: " make test " }])).toEqual([{ name: "t", cmd: "make test" }]);
    expect(() => parseCommands([{ name: "t", cmd: "" }])).toThrow(/empty/);
    expect(() => parseCommands("nope")).toThrow();
  });

  test("settings resolve session over workspace over global", () => {
    const dir = makeDir();
    setGlobalConfig({ enabled: false, max_retries: 5 });
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    expect(resolveConfig(s.id, dir)).toMatchObject({ enabled: false, enabled_from: "global", max_retries: 5 });
    setConfig(dir, { enabled: true, max_retries: 1 });
    expect(resolveConfig(s.id, dir)).toMatchObject({ enabled: true, enabled_from: "workspace", max_retries: 1 });
    patchSession(s.id, { enabled: 0 });
    expect(resolveConfig(s.id, dir)).toMatchObject({ enabled: false, enabled_from: "session" });
    expect(() => setConfig(dir, { max_retries: 99 })).toThrow(/max retries/);
  });
});

describe("the post-turn loop", () => {
  test("a failure is fed back as the next turn, with the output; a fixed tree passes and the session is done", async () => {
    const dir = project();
    const prompts: string[] = [];
    let n = 0;
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      n++;
      if (n === 2) write(o.cwd, "ok.txt", "fixed");
      return result(`turn ${n}`);
    });
    const s0 = createLead({ prompt: "build it", engine: "fake", cwd: dir });
    const { s, v } = await over(s0.id);
    expect(n).toBe(2);
    expect(prompts[1]).toContain("Verification failed after your last turn (automatic fix 1 of 2)");
    expect(prompts[1]).toContain("ok.txt is missing");
    expect(prompts[1]).toContain("exited 3");
    expect(v.state).toBe("passed");
    expect(v.done).toBe(true);
    expect(viewSession(s).done).toBe(true);
    expect(s.turns).toBe(2);
    const runs = listRuns(s0.id);
    expect(runs.map((r) => r.state)).toEqual(["passed", "failed"]);
    expect(runs[1].results[0]).toMatchObject({ name: "check", exit: 3, ok: false });
    const log = readLog(s0.id).map((l) => l.text).join("\n");
    expect(log).toContain("[verify] running");
    expect(log).toContain("sending the failures back");
  });

  test("retries are bounded: N fix turns, then it stops as failed and is never done", async () => {
    const dir = project({ maxRetries: 2 });
    let n = 0;
    setTurnRunner(async (o) => {
      n++;
      write(o.cwd, "touched.txt", `edit ${n}`); // changes something every turn, so it is not mistaken for a stall
      return result();
    });
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: dir });
    const { s, v } = await over(s0.id);
    await Bun.sleep(200);
    expect(n).toBe(3); // the turn, and two automatic fixes
    expect(v.state).toBe("failed");
    expect(v.done).toBe(false);
    expect(v.note).toContain("used all 2 automatic fixes");
    expect(getSession(s0.id)!.status).toBe("idle");
    expect(s.turns).toBe(3);
    expect(lines(`${dir}.runs`)).toBe(3);
  });

  test("a fix turn that changes nothing stops the loop early", async () => {
    const dir = project({ maxRetries: 5 });
    let n = 0;
    setTurnRunner(async () => {
      n++;
      return result("I could not fix it");
    });
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: dir });
    const { v } = await over(s0.id);
    await Bun.sleep(200);
    expect(n).toBe(2);
    expect(v.state).toBe("failed");
    expect(v.note).toContain("changed no files");
  });

  test("an operator turn starts the retry count over", async () => {
    const dir = project({ maxRetries: 1 });
    let n = 0;
    setTurnRunner(async (o) => {
      write(o.cwd, "e.txt", String(++n));
      return result();
    });
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: dir });
    await over(s0.id);
    expect(n).toBe(2);
    send({ operator: true }, s0.id, "try again");
    await Bun.sleep(100);
    await over(s0.id);
    await Bun.sleep(200);
    expect(n).toBe(4);
  });

  test("off switches: global, workspace, and the session's own, in that order of weakness; nothing runs", async () => {
    const dir = project();
    setGlobalConfig({ enabled: false });
    setConfig(dir, { enabled: null });
    setTurnRunner(async () => result());
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: dir });
    for (let i = 0; i < 40 && getSessionRow(s0.id)?.state !== "off"; i++) await Bun.sleep(50);
    expect(getSessionRow(s0.id)?.state).toBe("off");
    expect(fs.existsSync(`${dir}.runs`)).toBe(false);
    expect(viewSession(getSession(s0.id)!).done).toBe(false);

    // The session's switch beats the global one.
    patchSession(s0.id, { enabled: 1 });
    send({ operator: true }, s0.id, "again");
    const { v } = await over(s0.id).catch(() => ({ v: viewSession(getSession(s0.id)!).verify! }));
    expect(["failed", "fixing", "passed"]).toContain(v.state);
    expect(fs.existsSync(`${dir}.runs`)).toBe(true);
  });

  test("off by default: nothing runs and the state is off", async () => {
    const dir = makeDir();
    write(dir, "package.json", JSON.stringify({ scripts: { test: "exit 1" } }));
    setTurnRunner(async () => result());
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: dir });
    for (let i = 0; i < 40 && getSessionRow(s0.id)?.state !== "off"; i++) await Bun.sleep(50);
    expect(viewSession(getSession(s0.id)!).verify?.state).toBe("off");
    expect(resolveConfig(s0.id, dir).enabled).toBe(false);
  });

  test("nothing detected: state none, never done", async () => {
    setGlobalConfig({ enabled: true });
    setTurnRunner(async () => result());
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: makeDir() });
    for (let i = 0; i < 40 && getSessionRow(s0.id)?.state !== "none"; i++) await Bun.sleep(50);
    const view = viewSession(getSession(s0.id)!);
    expect(view.verify?.state).toBe("none");
    expect(view.done).toBe(false);
  });

  test("a failed or interrupted turn is not verified", async () => {
    const dir = project();
    setTurnRunner(async () => ({ ...result("boom"), success: false }));
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: dir });
    await Bun.sleep(400);
    expect(fs.existsSync(`${dir}.runs`)).toBe(false);
    expect(getSession(s0.id)!.status).toBe("failed");
  });

  test("a hung command is killed at the timeout and reported as a failure", async () => {
    const dir = project({ commands: [{ name: "slow", cmd: "sleep 30" }], maxRetries: 0 });
    setConfig(dir, { timeout_sec: 5 });
    // 5 s is the floor the setting allows; use the run helper's own timeout for a quick test instead.
    const { runOne } = await import("../src/verify/run");
    const r = await runOne({ name: "slow", cmd: "sleep 30 & sleep 31" }, dir, { timeoutMs: 300 });
    expect(r.timed_out).toBe(true);
    expect(r.exit).toBe(124);
    expect(r.output).toContain("timed out");
  });

  test("unchanged files since the last green run are not verified again", async () => {
    const dir = project();
    write(dir, "ok.txt", "here");
    setTurnRunner(async () => result("did nothing"));
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: dir });
    await over(s0.id);
    send({ operator: true }, s0.id, "anything else?");
    await over(s0.id);
    await Bun.sleep(200);
    expect(lines(`${dir}.runs`)).toBe(1);
    expect(getSessionRow(s0.id)!.state).toBe("passed");
    expect(viewSession(getSession(s0.id)!).done).toBe(true);
  });

  test("a manual run records a result and never starts a fix turn by itself", async () => {
    const dir = project();
    setTurnRunner(async () => result());
    setConfig(dir, { enabled: false });
    const s0 = createLead({ prompt: "x", engine: "fake", cwd: dir });
    for (let i = 0; i < 40 && getSessionRow(s0.id)?.state !== "off"; i++) await Bun.sleep(50);
    setConfig(dir, { enabled: true });
    const out = await runVerifyNow(s0.id);
    expect(out.state).toBe("failed");
    expect(out.continued).toBe(false);
    expect(getSession(s0.id)!.turns).toBe(1);
    await expect(runVerifyNow("s_missing")).rejects.toThrow();
  });
});

describe("goal mode", () => {
  test("a goal the agent calls DONE is not met while verification fails, and the next goal turn carries the failure", async () => {
    const dir = project({ maxRetries: 0 });
    const prompts: string[] = [];
    let n = 0;
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      n++;
      if (n === 3) write(o.cwd, "ok.txt", "now");
      return result(`work ${n}\nGOAL_STATUS: DONE`);
    });
    const s0 = createLead({ prompt: "go", engine: "fake", cwd: dir, goal: { text: "make it work", maxTurns: 6 } });
    const until = Date.now() + 20_000;
    while (Date.now() < until && !(getGoal(s0.id)?.status !== "active" && getSession(s0.id)!.status !== "running")) await Bun.sleep(50);
    const g = getGoal(s0.id)!;
    expect(g.status).toBe("met");
    expect(g.turns_used).toBe(3);
    expect(prompts[1]).toContain("verification is also failing");
    expect(prompts[1]).toContain("ok.txt is missing");
    expect(viewSession(getSession(s0.id)!).done).toBe(true);
  });

  test("a verification failure with fixes available is handled before the goal is judged", async () => {
    const dir = project({ maxRetries: 1 });
    let n = 0;
    setTurnRunner(async (o) => {
      n++;
      if (n === 2) write(o.cwd, "ok.txt", "fixed");
      return result("GOAL_STATUS: DONE");
    });
    const s0 = createLead({ prompt: "go", engine: "fake", cwd: dir, goal: { text: "g" } });
    const until = Date.now() + 20_000;
    while (Date.now() < until && !(getGoal(s0.id)?.status !== "active" && getSession(s0.id)!.status !== "running")) await Bun.sleep(50);
    expect(n).toBe(2);
    expect(getGoal(s0.id)!.status).toBe("met");
    expect(getGoal(s0.id)!.turns_used).toBe(1); // the fix turn was the one the goal was judged on
  });

  test("verifyGate reads the latest turn only", () => {
    const s = createLead({ prompt: "x", engine: "fake", cwd: makeDir() });
    expect(verifyGate(s.id).blocked).toBe(false);
  });
});

describe("the prompt and the HTTP surface", () => {
  test("the fix prompt names each failing command and keeps its output", () => {
    const p = fixPrompt(
      [
        { name: "typecheck", cmd: "bun run typecheck", exit: 2, ok: false, duration_ms: 1, timed_out: false, output: "src/a.ts(1,1): error TS2322" },
        { name: "test", cmd: "bun run test", exit: 0, ok: true, duration_ms: 1, timed_out: false, output: "" },
      ],
      1,
      2,
    );
    expect(p).toContain("typecheck: `bun run typecheck` exited 2");
    expect(p).toContain("error TS2322");
    expect(p).toContain("Passed: test.");
  });

  describe("routes", () => {
    let server: ReturnType<typeof startServer>;
    const token = "t0ken";
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(`${server.url}${p}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    beforeAll(() => {
      server = startServer({ port: 0, token });
    });
    afterAll(() => server.stop());

    test("workspace settings round trip with what would be detected", async () => {
      const dir = makeDir();
      write(dir, "package.json", JSON.stringify({ scripts: { lint: "x" } }));
      const ws = Workspaces.open(dir);
      const got = await call("GET", `/api/workspaces/${ws.id}/verify`);
      expect(got.status).toBe(200);
      expect(got.body.detected.map((c: any) => c.name)).toEqual(["lint"]);
      const put = await call("PUT", `/api/workspaces/${ws.id}/verify`, { enabled: false, max_retries: 3, commands: [{ name: "mine", cmd: "make check" }] });
      expect(put.body.config).toMatchObject({ enabled: false, max_retries: 3, commands: [{ name: "mine", cmd: "make check" }] });
      expect((await call("PUT", `/api/workspaces/${ws.id}/verify`, { max_retries: 99 })).status).toBe(400);
      const cleared = await call("PUT", `/api/workspaces/${ws.id}/verify`, { enabled: null, commands: null, max_retries: null });
      expect(cleared.body.config).toMatchObject({ enabled: null, commands: null, max_retries: null });
    });

    test("a session's verify view, its switch, and a manual run", async () => {
      const dir = project({ maxRetries: 0 });
      setTurnRunner(async () => result());
      const s0 = createLead({ prompt: "x", engine: "fake", cwd: dir });
      await over(s0.id);
      const v = await call("GET", `/api/sessions/${s0.id}/verify`);
      expect(v.body.view.state).toBe("failed");
      expect(v.body.commands).toEqual(CHECK);
      expect(v.body.commands_from).toBe("settings");
      expect(v.body.runs).toHaveLength(1);
      write(dir, "ok.txt", "now");
      const run = await call("POST", `/api/sessions/${s0.id}/verify/run`, {});
      expect(run.body.state).toBe("passed");
      expect(run.body.session.done).toBe(true);
      const off = await call("PUT", `/api/sessions/${s0.id}/verify`, { enabled: false });
      expect(off.body.enabled).toBe(false);
      expect(off.body.enabled_from).toBe("session");
      expect((await call("POST", `/api/sessions/s_nope/verify/run`, {})).status).toBe(404);
    });

    test("checkpoints listing for a session", async () => {
      setTurnRunner(async () => result());
      const s0 = createLead({ prompt: "x", engine: "fake", cwd: makeDir() });
      await Bun.sleep(300);
      const r = await call("GET", `/api/sessions/${s0.id}/checkpoints`);
      expect(r.status).toBe(200);
      expect(r.body.checkpoints).toEqual([]); // not a git repository: nothing recorded, nothing failed
      expect(r.body.turns).toHaveLength(1);
      expect(r.body.can_rewind).toBe(true);
      const t = r.body.turns[0].id;
      expect((await call("POST", `/api/sessions/${s0.id}/turns/${t}/rewind`, {})).status).toBe(400);
    });
  });
});
