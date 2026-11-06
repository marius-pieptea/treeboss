import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { runTurn, turnLimit, type RunTurnOptions } from "../src/engines/runner";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
const engine = path.join(dir, "engine");
// Answers like a CLI, then leaves a background child holding its stdout open: the turn is over, the pipe is not.
fs.writeFileSync(
  engine,
  [
    "#!/bin/sh",
    `echo '{"type":"system","subtype":"init","model":"fake","tools":[]}'`,
    `echo '{"type":"result","subtype":"success","is_error":false,"result":"all done","num_turns":1}'`,
    "sleep 5 &",
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const prev = process.env.TRB_FAKE_ENGINE;
process.env.TRB_FAKE_ENGINE = engine;
afterAll(() => {
  process.env.TRB_FAKE_ENGINE = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runTurn", () => {
  test("settles when the CLI exits, not when a background child lets go of stdout", async () => {
    const started = Date.now();
    const r = await runTurn({ engine: "fake", key: "k-runner", prompt: "x", cwd: dir, mcp: {}, timeoutSec: 60, idleMs: 60_000, ceilingMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.success).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.output).toBe("all done");
  });
});

describe("turnLimit", () => {
  const min = 60_000;
  test("a turn that never waits stops at the ceiling", () => {
    expect(turnLimit(59 * min, 0, 60 * min, 240 * min)).toBeNull();
    expect(turnLimit(60 * min, 0, 60 * min, 240 * min)).toBe("the 60 min ceiling for one turn");
  });
  test("time spent waiting on working subagents does not count toward the ceiling", () => {
    expect(turnLimit(100 * min, 50 * min, 60 * min, 240 * min)).toBeNull();
    expect(turnLimit(110 * min, 50 * min, 60 * min, 240 * min)).toBe("the 60 min ceiling for one turn, not counting 50 min spent waiting on subagents");
  });
  test("the hard ceiling stops a turn however much of it was waiting", () => {
    expect(turnLimit(240 * min, 235 * min, 60 * min, 240 * min)).toBe("the 240 min limit for one turn, waiting on subagents included");
  });
});

describe("the ceiling while a turn waits", () => {
  // Silent for about two seconds, then answers: past a one-second ceiling unless the waiting is left out of it.
  const win = process.platform === "win32";
  const slow = path.join(dir, win ? "slow.cmd" : "slow");
  const answer = `{"type":"result","subtype":"success","is_error":false,"result":"waited","num_turns":1}`;
  beforeAll(() => {
    const lines = win ? ["@echo off", "ping -n 3 127.0.0.1 >nul", `echo ${answer}`, ""] : ["#!/bin/sh", "sleep 2", `echo '${answer}'`, ""];
    fs.writeFileSync(slow, lines.join(win ? "\r\n" : "\n"), { mode: 0o755 });
    process.env.TRB_FAKE_ENGINE = slow;
  });
  afterAll(() => {
    process.env.TRB_FAKE_ENGINE = engine;
  });
  // isBusy keeps the one-second idle check from ending the silent turn: only the ceilings are under test.
  const turn = (o: Partial<RunTurnOptions>) =>
    runTurn({ engine: "fake", key: "k-ceiling", prompt: "x", cwd: dir, mcp: {}, timeoutSec: 60, idleMs: 1000, ceilingMs: 1000, hardCeilingMs: 30_000, isBusy: () => true, ...o });

  test("a turn waiting on working subagents runs past the ceiling", async () => {
    const r = await turn({ isWaiting: () => true });
    expect(r.timedOut).toBe(false);
    expect(r.output).toBe("waited");
  }, 15_000);

  test("the same turn without the wait stops at the ceiling", async () => {
    const r = await turn({ isWaiting: () => false });
    expect(r.timedOut).toBe(true);
  }, 15_000);

  test("the hard ceiling stops a turn that waits", async () => {
    const r = await turn({ ceilingMs: 30_000, hardCeilingMs: 1000, isWaiting: () => true });
    expect(r.timedOut).toBe(true);
  }, 15_000);
});

describe("output held in memory", () => {
  // Each filler line is about 70 bytes, so 5000 of them clear both the 64 KB stdout cap and the 80 KB stderr cap.
  const win = process.platform === "win32";
  const toErr = (stream: "stdout" | "stderr") => (stream === "stderr" ? (win ? " 1>&2" : " >&2") : "");
  const fill = (stream: "stdout" | "stderr", lines: number) =>
    win
      ? `for /L %%i in (1,1,${lines}) do @echo filler line %%i ----------------------------------------------------${toErr(stream)}`
      : `i=0\nwhile [ $i -lt ${lines} ]; do echo "filler line $i ----------------------------------------------------"${toErr(stream)}; i=$((i+1)); done`;
  const say = (text: string, stream: "stdout" | "stderr" = "stdout") => (win ? `echo ${text}${toErr(stream)}` : `echo "${text}"${toErr(stream)}`);
  const exit1 = win ? "exit /b 1" : "exit 1";
  let n = 0;
  const script = (...body: string[]) => {
    const bin = path.join(dir, `bounded-${++n}${win ? ".cmd" : ""}`);
    fs.writeFileSync(bin, [win ? "@echo off" : "#!/bin/sh", ...body, ""].join(win ? "\r\n" : "\n"), { mode: 0o755 });
    return bin;
  };
  // spawn happens synchronously inside runTurn, so the engine path only has to be set for this call.
  const runWith = (bin: string) => {
    process.env.TRB_FAKE_ENGINE = bin;
    const turn = runTurn({ engine: "fake", key: "k-bounded", prompt: "x", cwd: dir, mcp: {}, timeoutSec: 60, idleMs: 60_000, ceilingMs: 60_000 });
    process.env.TRB_FAKE_ENGINE = engine;
    return turn;
  };

  test("stdout larger than the cap still yields the fallback answer from its end", async () => {
    const r = await runWith(script(fill("stdout", 5000), say("the answer is 42")));
    expect(r.success).toBe(true);
    expect(r.output.endsWith("the answer is 42")).toBe(true);
    expect(r.output).toContain("[… output dropped …]");
    expect(r.output.length).toBeLessThan(70 * 1024);
  }, 15_000);

  test("a failure named near the start of a huge stderr is still classified", async () => {
    const r = await runWith(script(say("Error: insufficient credit on this account", "stderr"), fill("stderr", 5000), exit1));
    expect(r.success).toBe(false);
    expect(r.output).toContain("Provider spend/quota limit reached");
    expect(r.stderr.length).toBeLessThan(100 * 1024);
  }, 15_000);

  test("a failure named at the end of a huge stderr is still classified", async () => {
    const r = await runWith(script(fill("stderr", 5000), say("Not logged in. Please run /login", "stderr"), exit1));
    expect(r.success).toBe(false);
    expect(r.output).toContain("Provider authentication failed");
  }, 15_000);
});
