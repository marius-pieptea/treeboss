import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START ask\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END ask\n"); });
/** Ask mode: read-only, lean, cheap. Engine flags, what a turn is (not) given, model rules, cost, HTTP. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { Agents } from "../src/agents/store";
import { startServer } from "../src/daemon/server";
import { CLAUDE_ASK_CODEGRAPH_TOOLS, ENGINES, type LaunchInput } from "../src/engines/registry";
import { McpStore } from "../src/mcp/store";
import { SkillStore } from "../src/skills/store";
import { setSetting } from "../src/settings";
import { setDaemonContext } from "../src/sessions/context";
import { ASK_EFFORT, askModelFor, askOverrideModel, askPreamble, parseAskModels, questionOf } from "../src/sessions/ask";
import { createLead, getSession, interruptAll, readLog, send, setTurnRunner, viewSession } from "../src/sessions/manager";
import { parseMode, setMode } from "../src/sessions/plan";
import { clearCodegraphCache } from "../src/codegraph/detect";
import { db } from "../src/db";
import { makeDir, makeRepo, resetState, settled } from "./helpers";

// Stand-in for the codegraph CLI on PATH (keep the bundled copy out of the way).
process.env.TRB_CODEGRAPH_BUNDLED = "0";
const oldPath = process.env.PATH;
function stubCodegraph(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-ask-cg-"));
  const status = JSON.stringify({ initialized: true, version: "1.6.2", fileCount: 3, nodeCount: 10, edgeCount: 9, lastIndexed: "2026-10-08T00:00:00Z", pendingChanges: { added: 0, modified: 0, removed: 0 }, index: { state: "complete", reindexRecommended: false } });
  fs.writeFileSync(path.join(dir, "codegraph"), `#!/bin/sh\ncase "$1" in\n  --version) echo 1.6.2;;\n  status) echo '${status}';;\n  *) exit 1;;\nesac\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
}

beforeEach(() => {
  process.env.PATH = oldPath;
  resetState();
  clearCodegraphCache();
  db().exec("DELETE FROM agents");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});
afterAll(() => {
  process.env.PATH = oldPath;
});

const said = (id: string) => readLog(id).map((l) => l.text).join("\n");
const lead = (prompt: string, over: Record<string, unknown> = {}) => createLead({ prompt, engine: "fake", cwd: makeDir(), ...over } as any);
function skill(name: string) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trb-ask-sk-")), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: skill ${name}\n---\nbody\n`);
  return SkillStore.add(dir);
}

describe("each engine's read-only switch for ask", () => {
  const input = (over: Partial<LaunchInput> = {}): LaunchInput => ({ key: "k-ask", prompt: "q", cwd: "/tmp/x", mcp: {}, timeoutSec: 60, mode: "ask", ...over });
  const cg = { codegraph: { type: "stdio" as const, command: "codegraph", args: ["serve", "--mcp", "--path", "/tmp/x"], env: {} } };
  const after = (args: string[], flag: string) => args.slice(args.indexOf(flag) + 1);

  test("claude without an index: only Read, Glob and Grep are offered and allowed, no permission skip, no shell", () => {
    const args = ENGINES.claude.build(input(), "claude").args;
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
    expect(after(args, "--tools")[0]).toBe("Read,Glob,Grep");
    const allowed = after(args, "--allowedTools").slice(0, 3);
    expect(allowed).toEqual(["Read", "Glob", "Grep"]);
    expect(args.join(" ")).not.toMatch(/Bash|Edit|Write|WebFetch|WebSearch|plan_/);
  });

  test("claude with an index: Read plus ONLY the two codegraph tools", () => {
    const args = ENGINES.claude.build(input({ mcp: cg }), "claude").args;
    expect(after(args, "--tools")[0]).toBe("Read");
    const allowed = after(args, "--allowedTools").filter((a) => !a.startsWith("--"));
    expect(allowed.slice(0, 3)).toEqual(["Read", ...CLAUDE_ASK_CODEGRAPH_TOOLS]);
    expect(args.join(" ")).not.toMatch(/Glob|Grep|Bash|mcp__trb__/);
  });

  test("claude build and plan are unchanged", () => {
    expect(ENGINES.claude.build(input({ mode: "build" }), "claude").args).toContain("--dangerously-skip-permissions");
    expect(ENGINES.claude.build(input({ mode: "plan" }), "claude").args).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
    expect(ENGINES.claude.build(input({ mode: "build" }), "claude").args).not.toContain("--tools");
  });

  test("codex: a read-only sandbox as config, fresh and resumed", () => {
    for (const resumeId of [null, "abc"]) {
      const args = ENGINES.codex.build(input({ resumeId }), "codex").args;
      expect(args).toContain('sandbox_mode="read-only"');
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    }
  });

  test("cursor: --mode ask; opencode: the plan agent; agy: --mode plan; grok: no auto-approve", () => {
    const cursor = ENGINES.cursor.build(input(), "cursor-agent").args;
    expect(cursor).toEqual(expect.arrayContaining(["--mode", "ask"]));
    expect(cursor).not.toContain("--yolo");
    const oc = ENGINES.opencode.build(input(), "opencode").args;
    expect(oc).toEqual(expect.arrayContaining(["--agent", "plan"]));
    expect(oc).not.toContain("--auto");
    const agy = ENGINES.agy.build(input(), "agy").args;
    expect(agy).toEqual(expect.arrayContaining(["--mode", "plan"]));
    expect(agy).not.toContain("--dangerously-skip-permissions");
    expect(ENGINES.grok.build(input(), "grok").args).not.toContain("--always-approve");
  });
});

describe("ask on a session", () => {
  test("starts in ask mode with the ask contract on every turn, resumed too; build turns have none", async () => {
    const s = await settled(lead("ECHO_PROMPT # Ask mode", { mode: "ask" }).id);
    expect(s.mode).toBe("ask");
    expect(s.last_output).toBe("prompt-has[# Ask mode]=yes");
    send({ operator: true }, s.id, "ECHO_PROMPT # Ask mode");
    expect((await settled(s.id)).last_output).toBe("prompt-has[# Ask mode]=yes");
    setMode(s.id, "build");
    send({ operator: true }, s.id, "ECHO_PROMPT # Ask mode");
    expect((await settled(s.id)).last_output).toBe("prompt-has[# Ask mode]=no");
  });

  test("a write and a shell command are refused, and nothing lands on disk", async () => {
    const cwd = makeDir();
    const s = await settled(createLead({ prompt: "WRITE out.txt hi\nBASH touch shell.txt\nSAY the answer", engine: "fake", cwd, mode: "ask" }).id);
    expect(fs.existsSync(path.join(cwd, "out.txt"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "shell.txt"))).toBe(false);
    expect(s.last_output).toBe("the answer");
  });

  test("lean: no skills materialized, no agent instructions, none of the operator's MCP servers", async () => {
    skill("alpha");
    McpStore.put({ name: "db", command: "x" });
    Agents.create({ name: "pirate", instructions: "Always answer like a pirate: ARRR-MARKER." });
    const build = await settled(lead("SKILLS\nMCPS", { agent: "pirate" }).id);
    expect(said(build.id)).toContain("skills=alpha");
    expect(said(build.id)).toContain("mcps=db");
    const ask = await settled(lead("SKILLS\nMCPS\nECHO_PROMPT ARRR-MARKER", { agent: "pirate", mode: "ask" }).id);
    expect(said(ask.id)).toContain("skills=");
    expect(said(ask.id)).not.toContain("alpha");
    expect(said(ask.id)).not.toContain("mcps=db");
    expect(said(ask.id)).toContain("prompt-has[ARRR-MARKER]=no");
  });

  test("CodeGraph is wired only when the project has an index", async () => {
    stubCodegraph();
    const none = await settled(lead("MCPS\nECHO_ARGS", { mode: "ask" }).id);
    expect(said(none.id)).not.toContain("codegraph");
    expect(said(none.id)).toContain("--tools Read,Glob,Grep");

    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".codegraph"));
    const s = await settled(createLead({ prompt: "MCPS\nECHO_ARGS\nECHO_PROMPT codegraph_explore", engine: "fake", cwd: repo, mode: "ask" }).id);
    expect(said(s.id)).toContain("mcps=codegraph");
    expect(said(s.id)).toContain("--tools Read ");
    expect(said(s.id)).toContain("prompt-has[codegraph_explore]=yes");
  });

  test("an ask session never gets a worktree, even when isolation is asked for", () => {
    const s = createLead({ prompt: "SAY x", engine: "fake", cwd: makeRepo(), mode: "ask", isolate: true });
    expect(s.isolation).toBe("none");
  });

  test("attachments ride along only when attached since the last turn, not the whole set again", async () => {
    const cwd = makeDir();
    fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "docs", "a.md"), "# A\n");
    const s = await settled(createLead({ prompt: "ECHO_PROMPT docs/a.md", engine: "fake", cwd, mode: "ask", attachments: [{ path: "docs/a.md" }] }).id);
    expect(s.last_output).toBe("prompt-has[docs/a.md]=yes");
    send({ operator: true }, s.id, "ECHO_PROMPT docs/a.md");
    expect((await settled(s.id)).last_output).toBe("prompt-has[docs/a.md]=no");
  });

  test("the mode flips between turns and the transcript says so", async () => {
    const s = await settled(lead("SAY one").id);
    setMode(s.id, "ask");
    expect(getSession(s.id)!.mode).toBe("ask");
    setMode(s.id, "plan");
    setMode(s.id, "build");
    const log = readLog(s.id).map((l) => l.text).join("\n");
    expect(log).toContain("[ask] ask mode on");
    expect(log).toContain("[plan] plan mode on");
    expect(log).toContain("[plan] plan mode off");
  });

  test("cost: ask turns are summed apart from the rest", async () => {
    const s = await settled(lead("SAY q", { mode: "ask" }).id);
    expect(viewSession(s).ask_cost_usd).toBeCloseTo(0.001, 6);
    setMode(s.id, "build");
    send({ operator: true }, s.id, "SAY build");
    await settled(s.id);
    const v = viewSession(getSession(s.id)!);
    expect(v.ask_cost_usd).toBeCloseTo(0.001, 6);
    expect(v.cost_usd).toBeCloseTo(0.002, 6);
    const modes = (db().prepare("SELECT mode FROM turns WHERE session_id = ? ORDER BY seq").all(s.id) as Array<{ mode: string }>).map((r) => r.mode);
    expect(modes).toEqual(["ask", "build"]);
  });
});

describe("the ask model", () => {
  test("parseAskModels reads engine=model pairs and ignores junk", () => {
    expect(parseAskModels("claude=claude-haiku-5-5, codex = gpt-5-mini ,junk,=x,y=")).toEqual({ claude: "claude-haiku-5-5", codex: "gpt-5-mini" });
  });

  test("a new ask session: operator map first, then the built-in default, then a small model from the catalog", () => {
    expect(askModelFor("claude")).toBe("claude-haiku-5-5");
    setSetting("ask_models", "claude=claude-haiku-4-5,codex=gpt-5-nano");
    expect(askModelFor("claude")).toBe("claude-haiku-4-5");
    expect(askModelFor("codex")).toBe("gpt-5-nano");
    setSetting("ask_models", "");
    expect(askModelFor("codex", ["gpt-5", "gpt-5-codex", "gpt-5-mini"])).toBe("gpt-5-mini");
    expect(askModelFor("codex", ["gpt-5", "gpt-5-codex"])).toBeNull();
    expect(askModelFor("cursor")).toBeNull();
  });

  test("ask_models rejects a malformed value", () => {
    expect(() => setSetting("ask_models", "claude")).toThrow(/engine=model/);
    expect(() => setSetting("ask_model_override", "maybe")).toThrow(/"on" or "off"/);
  });

  test("an existing session keeps its model unless the override is on, and only claude and codex take it", () => {
    expect(askOverrideModel("claude", "claude-opus-5-5")).toBeNull();
    setSetting("ask_model_override", "on");
    expect(askOverrideModel("claude", "claude-opus-5-5")).toBe("claude-haiku-5-5");
    expect(askOverrideModel("claude", "claude-haiku-5-5")).toBeNull();
    expect(askOverrideModel("cursor", "x")).toBeNull();
    expect(askOverrideModel("codex", "gpt-5", ["gpt-5-mini"])).toBe("gpt-5-mini");
  });

  test("with the override on, the turn runs on the cheap model but the session keeps its own", async () => {
    setSetting("ask_models", "claude=cheap-1");
    setSetting("ask_model_override", "on");
    const seen: Array<string | null | undefined> = [];
    setTurnRunner(async (input: any) => {
      seen.push(input.model);
      return { success: true, output: "ok", sessionId: "x", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" } as any;
    });
    const s = await settled(createLead({ prompt: "q", engine: "claude", model: "claude-opus-5-5", cwd: makeDir(), mode: "ask" }).id);
    expect(seen).toEqual(["cheap-1"]);
    expect(getSession(s.id)!.model).toBe("claude-opus-5-5");
  });

  test("the preamble is tiny and names the right tool", () => {
    expect(askPreamble({ codegraph: true })).toContain("codegraph_explore");
    expect(askPreamble({ codegraph: false })).not.toContain("codegraph_explore");
    expect(askPreamble({ codegraph: true }).length).toBeLessThan(700);
    expect(questionOf(askPreamble({ codegraph: true }) + "where is auth?")).toBe("where is auth?");
  });
});

describe("ask over HTTP", () => {
  const TOKEN = "ask-api-token";
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

  test("a new ask session starts on the engine's cheap model at low effort; an explicit model or pair wins", async () => {
    setSetting("ask_models", "fake=cheap-1");
    const cheap = await call("POST", "/api/sessions", { prompt: "SAY a", engine: "fake", cwd: makeDir(), mode: "ask" });
    expect(cheap.status).toBe(201);
    expect(cheap.body.session).toMatchObject({ mode: "ask", model: "cheap-1", effort: ASK_EFFORT });
    await settled(cheap.body.session.id);
    const blank = await call("POST", "/api/sessions", { prompt: "SAY a", engine: "fake", cwd: makeDir(), mode: "ask", model: "", effort: "" }); // what the composer sends
    expect(blank.body.session).toMatchObject({ model: "cheap-1", effort: ASK_EFFORT });
    await settled(blank.body.session.id);
    const chosen = await call("POST", "/api/sessions", { prompt: "SAY a", engine: "fake", cwd: makeDir(), mode: "ask", model: "big-1", effort: "high" });
    expect(chosen.body.session).toMatchObject({ model: "big-1", effort: "high" });
    const build = await call("POST", "/api/sessions", { prompt: "SAY a", engine: "fake", cwd: makeDir() });
    expect(build.body.session.model).not.toBe("cheap-1");
    await interruptAll();
  });

  test("send with a mode, flip it, and a bad mode is a readable error", async () => {
    const made = await call("POST", "/api/sessions", { prompt: "SAY a", engine: "fake", cwd: makeDir() });
    const id = made.body.session.id as string;
    await settled(id);
    const sent = await call("POST", `/api/sessions/${id}/send`, { message: "ECHO_ARGS", mode: "ask" });
    expect(sent.body.session.mode).toBe("ask");
    expect((await settled(id)).last_output).toContain("--tools Read,Glob,Grep");
    expect((await call("PUT", `/api/sessions/${id}/mode`, { mode: "build" })).body.session.mode).toBe("build");
    const bad = await call("PUT", `/api/sessions/${id}/mode`, { mode: "yolo" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Unknown mode.*build.*plan.*ask/);
    expect(() => parseMode("yolo")).toThrow(/"ask"/);
  });

  test("the turns list carries each turn's mode and cost", async () => {
    const made = await call("POST", "/api/sessions", { prompt: "SAY q", engine: "fake", cwd: makeDir(), mode: "ask" });
    const id = made.body.session.id as string;
    await settled(id);
    const turns = (await call("GET", `/api/sessions/${id}/turns`)).body.turns;
    expect(turns[0]).toMatchObject({ mode: "ask" });
    expect(turns[0].cost_usd).toBeGreaterThan(0);
    expect(typeof turns[0].usage_json).toBe("string");
  });
});

describe("the follow-ups under an answer", () => {
  const TOKEN = "ask-doc-token";
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
  async function answered() {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "auth.ts"), "export const a = 1;\n");
    const made = await call("POST", "/api/sessions", { prompt: "Where is auth handled?\nSAY Auth lives in src/auth.ts:1 and nowhere else (see src/ghost.ts:9).", engine: "fake", cwd: repo, mode: "ask" });
    await settled(made.body.session.id);
    return { id: made.body.session.id as string, repo };
  }

  test("Save as doc: a preview writes nothing; the click writes a managed page with covers and HEAD", async () => {
    const { id, repo } = await answered();
    const pre = await call("GET", `/api/sessions/${id}/ask/doc`);
    expect(pre.status).toBe(200);
    expect(pre.body.preview.title).toBe("Where is auth handled");
    expect(pre.body.preview.covers).toEqual(["src/auth.ts"]); // ghost.ts does not exist
    expect(pre.body.preview.path).toBe("docs/where-is-auth-handled.md");
    expect(fs.existsSync(path.join(repo, "docs"))).toBe(false);

    const saved = await call("POST", `/api/sessions/${id}/ask/doc`, { path: "notes/auth.md" });
    expect(saved.status).toBe(201);
    expect(saved.body.page.path).toBe("docs/notes/auth.md");
    const text = fs.readFileSync(path.join(repo, "docs", "notes", "auth.md"), "utf-8");
    expect(text).toMatch(/^---\n/);
    expect(text).toContain("covers:\n  - src/auth.ts");
    expect(text).toMatch(/generated:\n {2}commit: [0-9a-f]{7,40}/);
    expect(text).toContain("(ask)");
    expect(text).toContain("> Where is auth handled?");
    expect(text).toContain("Auth lives in src/auth.ts:1");

    const again = await call("POST", `/api/sessions/${id}/ask/doc`, { path: "notes/auth.md" });
    expect(again.status).toBe(409);
  });

  test("Save as doc refuses a path that leaves the docs folder, and needs a finished ask answer", async () => {
    const { id } = await answered();
    expect((await call("POST", `/api/sessions/${id}/ask/doc`, { path: "../../outside.md" })).status).toBeGreaterThanOrEqual(400);
    const build = await call("POST", "/api/sessions", { prompt: "SAY hi", engine: "fake", cwd: makeDir() });
    await settled(build.body.session.id);
    const none = await call("GET", `/api/sessions/${build.body.session.id}/ask/doc`);
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/no finished ask answer/);
    expect((await call("GET", "/api/sessions/s_ghost/ask/doc")).status).toBe(404);
  });

  test("Turn into a plan: flip to plan mode and send the message, then plan turns are read-only", async () => {
    const { id, repo } = await answered();
    expect((await call("POST", `/api/sessions/${id}/send`, { message: "Turn the answer above into a plan.\nWRITE out.txt hi", mode: "plan" })).body.session.mode).toBe("plan");
    await settled(id);
    expect(fs.existsSync(path.join(repo, "out.txt"))).toBe(false);
  });
});

describe("ask defaults for the composer", () => {
  test("GET /api/ask/model reports what a new ask session would start on", async () => {
    const srv = startServer({ port: 0, token: "t" });
    try {
      setSetting("ask_models", "fake=cheap-2");
      const r = (await (await fetch(`${srv.url}/api/ask/model?engine=fake`, { headers: { authorization: "Bearer t" } })).json()) as any;
      expect(r).toEqual({ model: "cheap-2", effort: ASK_EFFORT });
      const claude = (await (await fetch(`${srv.url}/api/ask/model?engine=claude`, { headers: { authorization: "Bearer t" } })).json()) as any;
      expect(claude.model).toBe("claude-haiku-5-5");
    } finally {
      srv.stop();
    }
  });
});
