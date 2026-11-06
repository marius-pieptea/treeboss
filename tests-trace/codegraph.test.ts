import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START codegraph\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END codegraph\n"); });
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { codegraphFor, codegraphStatus, clearCodegraphCache } from "../src/codegraph/detect";
import { buildRunMcpConfig } from "../src/mcp/store";
import { ENGINES } from "../src/engines/registry";
import { setSetting, resetSetting } from "../src/settings";
import { startServer } from "../src/daemon/server";
import { Workspaces } from "../src/workspaces";
import { createLead } from "../src/sessions/manager";
import { makeRepo, resetState, settled } from "./helpers";

// These tests stand in for the CLI through PATH: keep the real bundled copy out of the way.
process.env.TRB_CODEGRAPH_BUNDLED = "0";
const oldPath = process.env.PATH;
const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ initialized: true, version: "1.5.0", fileCount: 12, nodeCount: 4200, edgeCount: 9000, lastIndexed: "2026-10-08T00:00:00Z", pendingChanges: { added: 0, modified: 0, removed: 0 }, index: { reindexRecommended: false }, ...over });

/** A `codegraph` stand-in: `--version`, `status --json`, and `init`/`index` that create .codegraph/. */
function stub(statusJson: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cg-stub-"));
  const f = path.join(dir, "codegraph");
  fs.writeFileSync(f, `#!/bin/sh\ncase "$1" in\n  --version) echo 1.5.0;;\n  status) echo '${statusJson}';;\n  init|index) echo "indexing $2"; mkdir -p "$2/.codegraph"; echo "done 3 nodes";;\n  *) exit 1;;\nesac\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  return dir;
}

beforeEach(() => {
  process.env.PATH = oldPath;
  resetState();
  clearCodegraphCache();
});
afterAll(() => {
  process.env.PATH = oldPath;
});

describe("status", () => {
  test("no binary: unavailable", () => {
    process.env.PATH = "/nonexistent";
    expect(codegraphStatus(makeRepo(), { fresh: true }).state).toBe("unavailable");
  });
  test("binary but no .codegraph/: none", () => {
    stub(status());
    const st = codegraphStatus(makeRepo(), { fresh: true });
    expect(st).toMatchObject({ available: true, state: "none", root: null, version: "1.5.0" });
  });
  test("index present: counts; pending changes make it stale", () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".codegraph"));
    stub(status());
    expect(codegraphStatus(repo, { fresh: true })).toMatchObject({ state: "indexed", symbols: 4200, files: 12, root: repo });
    stub(status({ pendingChanges: { added: 1, modified: 2, removed: 0 } }));
    clearCodegraphCache();
    expect(codegraphStatus(repo, { fresh: true })).toMatchObject({ state: "stale", pendingChanges: 3 });
  });
  test("an index above the project counts; a subdirectory resolves to it", () => {
    const repo = makeRepo({ "pkg/a.txt": "x" });
    fs.mkdirSync(path.join(repo, ".codegraph"));
    stub(status());
    expect(codegraphStatus(path.join(repo, "pkg"), { fresh: true }).root).toBe(repo);
  });
});

describe("wiring", () => {
  const cfg = (dir: string, allowed?: string[] | null) => buildRunMcpConfig({ sessionId: "s_1", subagents: false, daemonUrl: "http://x", token: "t", allowed, codegraphDir: dir });

  test("indexed project: the codegraph server is added, pointing at the index root", () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".codegraph"));
    stub(status());
    const c = cfg(repo);
    expect(c.codegraph).toMatchObject({ type: "stdio", args: ["serve", "--mcp", "--path", repo] });
  });
  test("a worktree path resolves to the main checkout's index via the base dir", () => {
    const repo = makeRepo({ "sub/a.txt": "x" });
    fs.mkdirSync(path.join(repo, ".codegraph"));
    stub(status());
    expect((cfg(path.join(repo, "sub")).codegraph as any).args.at(-1)).toBe(repo);
  });
  test("omitted: no index, setting off, no binary, or agent allow-list without it", () => {
    const repo = makeRepo();
    stub(status());
    expect(cfg(repo).codegraph).toBeUndefined();
    fs.mkdirSync(path.join(repo, ".codegraph"));
    expect(cfg(repo).codegraph).toBeDefined();
    expect(cfg(repo, ["other"]).codegraph).toBeUndefined();
    expect(cfg(repo, ["codegraph"]).codegraph).toBeDefined();
    expect(cfg(repo, []).codegraph).toBeUndefined();
    setSetting("codegraph", "off");
    expect(cfg(repo).codegraph).toBeUndefined();
    resetSetting("codegraph");
    process.env.PATH = "/nonexistent";
    expect(codegraphFor(repo, null)).toBeNull();
  });
  test("it reaches claude's config file, codex's -c overrides and cursor's workspace file", () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".codegraph"));
    stub(status());
    const mcp = cfg(repo);
    const base = { key: "cg1", prompt: "go", cwd: repo, mcp, timeoutSec: 60 };

    const claude = ENGINES.claude.build(base, "claude");
    const file = claude.args[claude.args.indexOf("--mcp-config") + 1];
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers.codegraph).toMatchObject({ type: "stdio", args: ["serve", "--mcp", "--path", repo] });
    claude.cleanup();

    const codex = ENGINES.codex.build(base, "codex").args.join(" ");
    expect(codex).toContain("mcp_servers.codegraph.command");
    expect(codex).toContain("mcp_servers.codegraph.args");

    const cursor = ENGINES.cursor.build(base, "/x/cursor-agent");
    expect(JSON.parse(fs.readFileSync(path.join(repo, ".cursor", "mcp.json"), "utf-8")).mcpServers.codegraph.args).toContain("--mcp");
    cursor.cleanup();
  });
  test("the name is reserved: a user server cannot shadow it", () => {
    const { McpStore } = require("../src/mcp/store");
    expect(() => McpStore.put({ name: "codegraph", command: "x" })).toThrow(/reserved/);
  });
});

describe("sessions", () => {
  test("an indexed project's session gets the server and the one-line hint; an unindexed one gets neither", async () => {
    const repo = makeRepo();
    stub(status());
    const run = async (prompt: string) => (await settled(createLead({ prompt, engine: "fake", cwd: repo }).id)).last_output ?? "";
    expect(await run("MCPS")).not.toContain("codegraph");
    expect(await run("ECHO_PROMPT codegraph_explore")).toContain("=no");
    fs.mkdirSync(path.join(repo, ".codegraph"));
    clearCodegraphCache();
    expect(await run("MCPS")).toContain("codegraph");
    expect(await run("ECHO_PROMPT codegraph_explore")).toContain("=yes");
  });
});

describe("api", () => {
  test("status, explicit init job, toggle", async () => {
    const repo = makeRepo();
    stub(status());
    const w = Workspaces.open(repo);
    const server = startServer({ port: 0, token: "tok", onShutdown: () => {} });
    const call = (method: string, p: string, body?: unknown) =>
      fetch(`${server.url}${p}`, { method, headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json() as Promise<any>);
    try {
      expect((await call("GET", `/api/workspaces/${w.id}/codegraph?fresh=1`)).codegraph.state).toBe("none");
      expect((await call("POST", `/api/workspaces/${w.id}/codegraph/index`)).error).toMatch(/not initialized/i); // a rebuild needs an index; only init makes one
      const { job } = await call("POST", `/api/workspaces/${w.id}/codegraph/init`);
      expect(job.mode).toBe("init");
      let j = job;
      for (let i = 0; i < 50 && j.state === "running"; i++) {
        await Bun.sleep(100);
        j = (await call("GET", `/api/codegraph/jobs/${job.id}`)).job;
      }
      expect(j.state).toBe("done");
      expect(fs.existsSync(path.join(repo, ".codegraph"))).toBe(true);
      expect((await call("GET", `/api/workspaces/${w.id}/codegraph?fresh=1`)).codegraph.state).toBe("indexed");
      expect((await call("POST", "/api/codegraph/toggle", { enabled: false })).setting).toBe("off");
      expect((await call("GET", `/api/workspaces/${w.id}/codegraph?fresh=1`)).codegraph.setting).toBe("off");
    } finally {
      server.stop();
    }
  });
});
