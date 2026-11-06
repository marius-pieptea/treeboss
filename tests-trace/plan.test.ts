import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START plan\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END plan\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { ENGINES, type LaunchInput } from "../src/engines/registry";
import { setDaemonContext } from "../src/sessions/context";
import { createLead, getSession, interruptAll, readLog, send, setTurnRunner, viewSession } from "../src/sessions/manager";
import { APPROVE_MESSAGE, approvePlan, parseMode, planPreamble, setMode } from "../src/sessions/plan";
import { db } from "../src/db";
import { makeDir, resetState, settled } from "./helpers";

beforeEach(() => {
  resetState();
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

const lead = (prompt: string, over: Record<string, unknown> = {}) => createLead({ prompt, engine: "fake", cwd: makeDir(), ...over } as any);

describe("plan mode on a session", () => {
  test("a session starts in plan mode, and the engine is launched with its read-only switch", async () => {
    const s = await settled(lead("ECHO_ARGS", { mode: "plan" }).id);
    expect(s.mode).toBe("plan");
    expect(s.last_output).toContain("--permission-mode plan");
    expect(s.last_output).not.toContain("--dangerously-skip-permissions");
    expect(viewSession(s).mode).toBe("plan");
  });

  test("build is the default: no read-only switch, and the agent may write", async () => {
    const cwd = makeDir();
    const s = await settled(createLead({ prompt: "WRITE out.txt hi\nECHO_ARGS", engine: "fake", cwd }).id);
    expect(s.mode).toBe("build");
    expect(s.last_output).not.toContain("--permission-mode");
    expect(fs.existsSync(path.join(cwd, "out.txt"))).toBe(true);
  });

  test("in plan mode a write and a shell command are refused, and nothing lands on disk", async () => {
    const cwd = makeDir();
    const s = await settled(createLead({ prompt: "WRITE out.txt hi\nBASH touch shell.txt\nSAY plan: do the thing", engine: "fake", cwd, mode: "plan" }).id);
    expect(s.status).toBe("idle");
    expect(fs.existsSync(path.join(cwd, "out.txt"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "shell.txt"))).toBe(false);
    const log = readLog(s.id).map((l) => l.text).join("\n");
    expect(log).toContain("plan mode is read-only");
    expect(s.last_output).toBe("plan: do the thing");
  });

  test("plan turns lead with the plan-mode contract, and build turns do not", async () => {
    const plan = await settled(lead("ECHO_PROMPT # Plan mode", { mode: "plan" }).id);
    expect(plan.last_output).toBe("prompt-has[# Plan mode]=yes");
    const build = await settled(lead("ECHO_PROMPT # Plan mode").id);
    expect(build.last_output).toBe("prompt-has[# Plan mode]=no");
  });

  test("the contract rides along on a resumed follow-up too", async () => {
    const s0 = await settled(lead("SAY first", { mode: "plan" }).id);
    send({ operator: true }, s0.id, "ECHO_PROMPT # Plan mode");
    expect((await settled(s0.id)).last_output).toBe("prompt-has[# Plan mode]=yes");
  });

  test("setMode flips it, logs the change, and refuses nonsense", async () => {
    const s = await settled(lead("SAY hi").id);
    expect(setMode(s.id, "plan").mode).toBe("plan");
    expect(readLog(s.id).some((l) => l.kind === "info" && l.text.includes("[plan] plan mode on"))).toBe(true);
    expect(setMode(s.id, "build").mode).toBe("build");
    expect(readLog(s.id).some((l) => l.text.includes("[plan] plan mode off"))).toBe(true);
    expect(() => setMode("s_nope", "plan")).toThrow(/No session/);
    expect(() => parseMode("sideways")).toThrow(/Unknown mode/);
    expect(parseMode("")).toBeNull();
    expect(() => lead("SAY x", { mode: "yolo" })).toThrow(/Unknown mode/);
  });

  test("approving the plan leaves plan mode and sends the build message as the next turn", async () => {
    const cwd = makeDir();
    const s0 = await settled(createLead({ prompt: "SAY the plan", engine: "fake", cwd, mode: "plan" }).id);
    const after = approvePlan(s0.id);
    expect(after.mode).toBe("build");
    const done = await settled(s0.id);
    const turns = db().prepare("SELECT prompt FROM turns WHERE session_id = ? ORDER BY seq").all(s0.id) as Array<{ prompt: string }>;
    expect(turns).toHaveLength(2);
    expect(turns[1].prompt).toBe(APPROVE_MESSAGE);
    expect(done.mode).toBe("build");
  });

  test("approve needs plan mode and an idle session", async () => {
    const s = await settled(lead("SAY hi").id);
    expect(() => approvePlan(s.id)).toThrow(/not in plan mode/);
    const running = lead("SLEEP 3000", { mode: "plan" });
    expect(() => approvePlan(running.id)).toThrow(/still working/);
  });

  test("the preamble is a read-only contract that ends in a written plan", () => {
    const p = planPreamble();
    expect(p).toMatch(/read-only/);
    expect(p).toMatch(/ask the user/);
    expect(p).toMatch(/final message/);
    expect(p).toMatch(/Do not start implementing/);
  });
});

describe("each engine's own read-only switch", () => {
  const input = (mode?: "plan" | "build"): LaunchInput => ({ key: "k-plan", prompt: "do it", cwd: "/tmp/x", mcp: {}, timeoutSec: 60, mode });

  test("claude: permission mode plan instead of skipping permissions", () => {
    const plan = ENGINES.claude.build(input("plan"), "claude").args;
    expect(plan).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
    expect(plan).not.toContain("--dangerously-skip-permissions");
    expect(ENGINES.claude.build(input("build"), "claude").args).toContain("--dangerously-skip-permissions");
    expect(ENGINES.claude.build(input(), "claude").args).not.toContain("--permission-mode");
  });

  test("codex: a read-only sandbox as config, so a resumed exec gets it too", () => {
    for (const resumeId of [null, "abc"]) {
      const args = ENGINES.codex.build({ ...input("plan"), resumeId }, "codex").args;
      expect(args).toContain('sandbox_mode="read-only"');
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    }
    expect(ENGINES.codex.build(input("build"), "codex").args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("cursor: --mode plan instead of --yolo", () => {
    const plan = ENGINES.cursor.build(input("plan"), "cursor-agent").args;
    expect(plan).toEqual(expect.arrayContaining(["--mode", "plan"]));
    expect(plan).not.toContain("--yolo");
    expect(ENGINES.cursor.build(input("build"), "cursor-agent").args).toContain("--yolo");
  });

  test("opencode: the plan agent and no auto-approve; agy: --mode plan", () => {
    const oc = ENGINES.opencode.build(input("plan"), "opencode").args;
    expect(oc).toEqual(expect.arrayContaining(["--agent", "plan"]));
    expect(oc).not.toContain("--auto");
    const agy = ENGINES.agy.build(input("plan"), "agy").args;
    expect(agy).toEqual(expect.arrayContaining(["--mode", "plan"]));
    expect(agy).not.toContain("--dangerously-skip-permissions");
  });

  test("grok has no plan switch: it stops auto-approving, and the prompt carries the contract", () => {
    expect(ENGINES.grok.build(input("plan"), "grok").args).not.toContain("--always-approve");
    expect(ENGINES.grok.build(input("build"), "grok").args).toContain("--always-approve");
  });
});

describe("plan mode over HTTP", () => {
  const TOKEN = "plan-api-token";
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

  test("create in plan mode, send with a mode, flip it, approve", async () => {
    const cwd = makeDir();
    const made = await call("POST", "/api/sessions", { prompt: "SAY the plan", engine: "fake", cwd, mode: "plan" });
    expect(made.status).toBe(201);
    expect(made.body.session.mode).toBe("plan");
    const id = made.body.session.id as string;
    await settled(id);

    const sent = await call("POST", `/api/sessions/${id}/send`, { message: "ECHO_ARGS", mode: "build" });
    expect(sent.body.session.mode).toBe("build");
    expect((await settled(id)).last_output).not.toContain("--permission-mode");

    expect((await call("PUT", `/api/sessions/${id}/mode`, { mode: "plan" })).body.session.mode).toBe("plan");
    const approved = await call("POST", `/api/sessions/${id}/plan/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.session.mode).toBe("build");
    await settled(id);
    expect(getSession(id)!.turns).toBe(3);
  });

  test("a bad mode or a missing session is a clear error", async () => {
    expect((await call("PUT", "/api/sessions/s_ghost/mode", { mode: "plan" })).status).toBe(404);
    const id = (await call("POST", "/api/sessions", { prompt: "SAY x", engine: "fake", cwd: makeDir() })).body.session.id;
    await settled(id);
    const bad = await call("PUT", `/api/sessions/${id}/mode`, { mode: "yolo" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Unknown mode/);
    expect((await call("POST", `/api/sessions/${id}/plan/approve`)).status).toBe(400);
  });
});
