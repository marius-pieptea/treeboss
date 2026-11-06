/**
 * The CLI as a user runs it: a real `trb` process against a real daemon it starts itself, with the
 * scripted engine standing in for a model. Slow on purpose (it spawns processes); it is the test
 * that proves the pieces are wired together.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { makeDir, makeRepo, sh } from "./helpers";

const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
let home: string;

async function trb(args: string[], opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
    cwd: opts.cwd ?? os.tmpdir(),
    env: { ...process.env, TRB_HOME: home, TRB_NO_AUTOSTART: "", NO_COLOR: "1", ...opts.env },
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-home-"));
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("offline commands (no daemon needed)", () => {
  test("help and version", async () => {
    expect((await trb(["--version"])).stdout.trim()).toBe("0.5.0");
    const h = await trb(["help"]);
    expect(h.stdout).toContain("trb run");
    expect(h.stdout).toContain("Hydra");
  });

  test("unknown command is a clean error with a non-zero exit", async () => {
    const r = await trb(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown command");
  });

  test("a daemon-requiring command with autostart refused says how to start it", async () => {
    const r = await trb(["ls"], { env: { TRB_NO_AUTOSTART: "1" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("trb daemon start");
  });

  test("config set/get/reset", async () => {
    expect((await trb(["config", "set", "max_depth", "3"])).stdout).toContain("max_depth = 3");
    expect((await trb(["config", "get", "max_depth"])).stdout.trim()).toBe("3");
    expect((await trb(["config", "set", "max_depth", "lots"])).code).toBe(1);
    await trb(["config", "reset", "max_depth"]);
    expect((await trb(["config", "get", "max_depth"])).stdout.trim()).toBe("2");
    expect((await trb(["config", "list"])).stdout).toContain("wait_default_sec");
  });

  test("pairs: recipe, explicit, roles with library instructions, edit, rm", async () => {
    expect((await trb(["pair", "add", "--recipe", "sonnet-haiku"])).stdout).toContain("Sonnet leads Haiku");
    const added = await trb(["pair", "add", "--title", "Mine", "--lead", "claude/claude-opus-5-5@high", "--role", "worker=fake/m1@low", "--role", "reviewer=fake", "--max-heads", "3"]);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("[roles, max 3 heads]");
    expect(added.stdout).toContain("worker");
    const shown = await trb(["pair", "show", "Mine"]);
    expect(shown.stdout).toContain("Implement exactly the slice"); // library instructions came along for the role id
    expect((await trb(["pair", "edit", "Mine", "--lead", "claude/claude-sonnet-5-5"])).stdout).toContain("claude/claude-sonnet-5-5");
    expect((await trb(["pair", "list"])).stdout).toContain("Sonnet leads Haiku");
    expect((await trb(["pair", "rm", "Mine"])).stdout).toContain("removed");
    expect((await trb(["pair", "show", "Mine"])).code).toBe(1);
    expect((await trb(["pair", "add", "--title", "x", "--lead", "not-an-engine"])).stderr).toContain("unknown engine");
  });

  test("mcp: add stdio and http, disable, import, test, rm", async () => {
    expect((await trb(["mcp", "add", "ctx", "--", "npx", "-y", "ctx-mcp"])).stdout).toContain("added ctx");
    expect((await trb(["mcp", "add", "remote", "--url", "https://h/mcp", "-H", "Authorization=Bearer x"])).stdout).toContain("(http)");
    expect((await trb(["mcp", "add", "trb", "--", "x"])).code).toBe(1);
    await trb(["mcp", "disable", "ctx"]);
    const list = (await trb(["mcp", "list"])).stdout;
    expect(list).toContain("ctx");
    expect(list).toContain("off");
    const file = path.join(home, "imp.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { fromfile: { command: "node", args: ["s.js"] } } }));
    expect((await trb(["mcp", "import", "--from", file])).stdout).toContain("added:   fromfile");
    // `mcp test` against a real stdio MCP server: trb's own shim.
    const self = ["bun", "run", MAIN, "mcp-serve"];
    await trb(["mcp", "add", "selftest", "--", ...self]);
    const t = await trb(["mcp", "test", "selftest"]);
    expect(t.stdout).toContain("7 tools");
    expect((await trb(["mcp", "rm", "selftest"])).code).toBe(0);
  });

  test("skills: new, add, import, show, disable, rm", async () => {
    expect((await trb(["skill", "new", "my-skill", "-d", "when testing"])).stdout).toContain("created my-skill");
    const dir = path.join(makeDir(), "ext");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: ext\ndescription: external one\n---\nbody\n");
    expect((await trb(["skill", "add", dir])).stdout).toContain("added ext");
    expect((await trb(["skill", "add", dir])).code).toBe(1); // already exists
    expect((await trb(["skill", "add", dir, "--force"])).code).toBe(0);
    expect((await trb(["skill", "show", "ext"])).stdout).toContain("external one");
    await trb(["skill", "disable", "ext"]);
    expect((await trb(["skill", "list"])).stdout).toMatch(/ext\s+off/);
    expect((await trb(["skill", "rm", "ext"])).code).toBe(0);
    expect((await trb(["skill", "show", "ext"])).code).toBe(1);
  });

  test("agents: add with instructions and assignments, edit, show, use in a pair role, remove", async () => {
    await trb(["skill", "new", "deploy-skill", "-d", "deploys"]);
    await trb(["mcp", "add", "db", "--", "x"]);
    const added = await trb(["agent", "add", "auditor", "-t", "Security auditor", "-d", "finds vulns", "-i", "Audit only. Never edit files.", "-s", "deploy-skill", "--mcp", "db", "-e", "fake", "--effort", "high"]);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("auditor");
    expect(added.stdout).toContain("deploy-skill");
    expect((await trb(["agent", "add", "auditor"])).stderr).toContain("already exists");
    expect((await trb(["agent", "add", "bad", "-s", "ghost"])).stderr).toContain("Unknown skill: ghost");
    const file = path.join(home, "instr.md");
    fs.writeFileSync(path.join(home, "instr.md"), "Long instructions from a file.\n");
    await trb(["agent", "edit", "auditor", "-f", file, "--no-mcp", "--all-skills"]);
    const shown = (await trb(["agent", "show", "auditor"])).stdout;
    expect(shown).toContain("Long instructions from a file.");
    expect(shown).toMatch(/skills\s+default set/);
    expect(shown).toMatch(/mcp\s+none/);
    expect((await trb(["agent", "add", "--from-role", "reviewer"])).stdout).toContain("reviewer");
    expect((await trb(["agent", "rm", "auditor"])).stdout).toContain("removed auditor");
    expect((await trb(["agent", "show", "auditor"])).code).toBe(1);
  });

  test("engines and doctor", async () => {
    expect((await trb(["engines"])).stdout).toContain("fake");
    const d = await trb(["doctor"]);
    expect(d.stdout).toContain("trb MCP shim answers (7 tools)");
  });
});

describe("running work (starts its own daemon)", () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });

  test("daemon lifecycle: starts on demand, reports status, stops", async () => {
    expect((await trb(["daemon", "status"])).code).toBe(1); // not running yet
    const r = await trb(["run", "-e", "fake", "SAY hello from the cli"], { cwd: repo });
    expect(r.stderr).toContain("starting daemon");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello from the cli");
    expect(r.stdout).toContain("✓ done");
    const status = await trb(["daemon", "status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("running");
  }, 60_000);

  test("run → ls → show → send (resumes) → logs", async () => {
    const run = await trb(["run", "-e", "fake", "-t", "my task", "SAY first answer"], { cwd: repo });
    expect(run.code).toBe(0);
    const id = /(s_[0-9a-f]{10})/.exec(run.stdout)![1];
    expect((await trb(["ls"])).stdout).toContain("my task");
    const show = await trb(["show", id]);
    expect(show.stdout).toContain("first answer");
    expect(show.stdout).toContain(id);
    const send = await trb(["send", id, "ECHO_RESUME"]);
    expect(send.code).toBe(0);
    expect(send.stdout).toContain("resume=yes");
    expect(send.stdout).not.toContain("first answer"); // only the new turn is shown
    expect((await trb(["logs", id])).stdout).toContain("first answer");
    // unique prefix and `last`
    expect((await trb(["show", id.slice(0, 6)])).stdout).toContain(id);
    expect((await trb(["show", "last"])).code).toBe(0);
  }, 60_000);

  test("--json prints one parseable document; a failed turn exits 1", async () => {
    const ok = await trb(["run", "-e", "fake", "--json", "SAY json answer"], { cwd: repo });
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).session).toMatchObject({ status: "idle", output: "json answer" });
    const bad = await trb(["run", "-e", "fake", "FAIL nope"], { cwd: repo });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("✗ failed");
  }, 60_000);

  test("the prompt can come from stdin", async () => {
    const r = await trb(["run", "-e", "fake", "-"], { cwd: repo, stdin: "SAY from stdin\n" });
    expect(r.stdout).toContain("from stdin");
  }, 60_000);

  test("--detach prints just the id, and attach/interrupt work on a running session", async () => {
    const det = await trb(["run", "-e", "fake", "-d", "SAY started\nSLEEP 30000"], { cwd: repo });
    const id = det.stdout.trim();
    expect(id).toMatch(/^s_[0-9a-f]{10}$/);
    await Bun.sleep(800);
    const i = await trb(["interrupt", id]);
    expect(i.stdout).toContain("idle");
    expect((await trb(["show", id])).stdout).toContain("idle");
    expect((await trb(["close", id])).stdout).toContain("closed");
  }, 60_000);

  test("Hydra from the CLI: a lead opens a head in a worktree; the operator diffs and merges it", async () => {
    await trb(["pair", "add", "--title", "CLI Hydra", "--lead", "fake", "--heads", "fake", "--max-heads", "2"]);
    const prompt = [
      `CALL_TOOL subagent_create {"brief":"WRITE shipped.txt by the head\\nSAY head ok","title":"ship it"}`,
      `CALL_TOOL subagent_wait {"timeout_sec":25}`,
    ].join("\n");
    const r = await trb(["run", "-p", "CLI Hydra", "-e", "fake", "-"], { cwd: repo, stdin: prompt });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 subagent");
    expect(r.stdout).toMatch(/fake │ .*Write\(shipped.txt\)/); // the head's work is shown under the lead's, attributed
    const tree = (await trb(["ls", "-a"])).stdout;
    const headId = tree.split("\n").find((l) => l.includes("↳"))!.split(/\s+/)[0];
    expect(headId).toMatch(/^s_[0-9a-f]{10}$/);
    expect((await trb(["diff", headId])).stdout).toContain("+by the head");
    expect(fs.existsSync(path.join(repo, "shipped.txt"))).toBe(false);
    const m = await trb(["merge", headId]);
    expect(m.code).toBe(0);
    expect(fs.readFileSync(path.join(repo, "shipped.txt"), "utf-8")).toBe("by the head\n");
    expect(sh("git status --short", repo)).toContain("shipped.txt");
  }, 90_000);

  test("spawn: the operator opens a subagent under a session", async () => {
    const lead = (await trb(["run", "-e", "fake", "-d", "SAY lead"], { cwd: repo })).stdout.trim();
    await Bun.sleep(600);
    const r = await trb(["spawn", lead, "SAY spawned ok", "-e", "fake"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("spawned ok");
    expect((await trb(["show", lead])).stdout).toContain("└─");
  }, 60_000);

  test("trb ui registers the folder and prints a single-use sign-in link that the browser can use", async () => {
    const r = await trb(["ui", "--no-open"], { cwd: repo });
    expect(r.code).toBe(0);
    const link = /(http:\/\/127\.0\.0\.1:\d+\/_auth\?ticket=[0-9a-f]+&to=[^\s]+)/.exec(r.stdout)?.[1];
    expect(link).toBeTruthy();
    expect(r.stdout).toMatch(/\/w\/w_[A-Za-z0-9]+/);
    const res = await fetch(link!, { redirect: "manual" });
    expect(res.status).toBe(302);
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    const origin = new URL(link!).origin;
    const ws = await (await fetch(`${origin}/api/workspaces`, { headers: { cookie } })).json();
    expect(ws.workspaces.some((w: any) => w.path === fs.realpathSync(repo))).toBe(true);
    expect((await fetch(link!, { redirect: "manual" })).status).toBe(401); // the link works once
    // Running it again for the same folder reuses the workspace.
    await trb(["ui", "--no-open"], { cwd: repo });
    const again = await (await fetch(`${origin}/api/workspaces`, { headers: { cookie } })).json();
    expect(again.workspaces.filter((w: any) => w.path === fs.realpathSync(repo))).toHaveLength(1);
  }, 60_000);

  test("daemon stop", async () => {
    expect((await trb(["daemon", "stop"])).stdout).toContain("stopped");
    expect((await trb(["daemon", "status"])).code).toBe(1);
  });
});
