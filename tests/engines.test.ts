import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { ENGINES, codexMcpOverrides, type LaunchInput, type McpRunConfig } from "../src/engines/registry";

const mcp: McpRunConfig = {
  trb: { type: "stdio", command: "/usr/bin/bun", args: ["main.ts", "mcp-serve"], env: { TRB_SESSION: "s_1" } },
  remote: { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer x" } },
};
const input = (over: Partial<LaunchInput> = {}): LaunchInput => ({ key: "k1", prompt: "do it", cwd: os.tmpdir(), mcp: {}, timeoutSec: 60, ...over });

describe("claude", () => {
  test("print mode, stream-json, prompt on stdin, bypass permissions", () => {
    const s = ENGINES.claude.build(input(), "claude");
    expect(s.args).toContain("--dangerously-skip-permissions");
    expect(s.args.slice(s.args.indexOf("--output-format"), s.args.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(s.args.at(-1)).toBe("-p");
    expect(s.stdin).toBe("do it\n");
  });

  test("model, effort, resume and max-turns only when asked; 'default' means no --model", () => {
    const plain = ENGINES.claude.build(input({ model: "default" }), "claude").args;
    expect(plain).not.toContain("--model");
    expect(plain).not.toContain("--resume");
    expect(plain).not.toContain("--max-turns");
    const full = ENGINES.claude.build(input({ model: "claude-haiku-5-5", effort: "low", resumeId: "abc", maxTurns: 5 }), "claude").args;
    expect(full).toEqual(expect.arrayContaining(["--model", "claude-haiku-5-5", "--effort", "low", "--resume", "abc", "--max-turns", "5"]));
  });

  test("MCP config goes to a 0600 file OUTSIDE the workspace, strict by default, and cleanup removes it", () => {
    const s = ENGINES.claude.build(input({ mcp }), "claude");
    const file = s.args[s.args.indexOf("--mcp-config") + 1];
    expect(s.args).toContain("--strict-mcp-config");
    expect(file.startsWith(os.tmpdir())).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(cfg.mcpServers.trb).toMatchObject({ type: "stdio", command: "/usr/bin/bun", env: { TRB_SESSION: "s_1" } });
    expect(cfg.mcpServers.remote).toMatchObject({ type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer x" } });
    s.cleanup();
    expect(fs.existsSync(file)).toBe(false);
  });

  test("merge isolation drops --strict-mcp-config", () => {
    const s = ENGINES.claude.build(input({ mcp, strictMcp: false }), "claude");
    expect(s.args).toContain("--mcp-config");
    expect(s.args).not.toContain("--strict-mcp-config");
    s.cleanup();
  });
});

describe("codex", () => {
  test("exec --json with the prompt in argv, nothing on stdin", () => {
    const s = ENGINES.codex.build(input(), "codex");
    expect(s.args.slice(0, 1)).toEqual(["exec"]);
    expect(s.args).toContain("--json");
    expect(s.args.at(-1)).toBe("do it");
    expect(s.stdin).toBeNull();
  });
  test("resume sits right after exec; effort is config, not a flag", () => {
    const a = ENGINES.codex.build(input({ resumeId: "th_9", effort: "high", model: "gpt-x" }), "codex").args;
    expect(a.slice(0, 3)).toEqual(["exec", "resume", "th_9"]);
    expect(a).toEqual(expect.arrayContaining(["-m", "gpt-x", "-c", "model_reasoning_effort=high"]));
  });
  test("MCP servers become -c overrides with valid TOML values", () => {
    const o = codexMcpOverrides(mcp);
    expect(o).toContain('mcp_servers.trb.command="/usr/bin/bun"');
    expect(o).toContain('mcp_servers.trb.args=["main.ts","mcp-serve"]');
    expect(o).toContain('mcp_servers.trb.env={TRB_SESSION="s_1"}');
    expect(o).toContain('mcp_servers.remote.url="https://h/mcp"');
    expect(o).toContain('mcp_servers.remote.http_headers={Authorization="Bearer x"}');
    // The trb server also gets a day-long tool timeout: plan_ask blocks until the operator answers.
    expect(o).toContain("mcp_servers.trb.tool_timeout_sec=86400");
    expect(o.filter((x) => x === "-c").length).toBe(6);
  });
  test("a server name that is not a TOML bare key is sanitised", () => {
    expect(codexMcpOverrides({ "my.server": { type: "stdio", command: "x", args: [] } })).toContain('mcp_servers.my_server.command="x"');
  });
});

describe("cursor", () => {
  test("writes .cursor/mcp.json into the workspace and restores what was there", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cur-"));
    const file = path.join(ws, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '{"mine":true}');
    const s = ENGINES.cursor.build(input({ cwd: ws, mcp }), "/x/cursor-agent");
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers.trb.command).toBe("/usr/bin/bun");
    s.cleanup();
    expect(fs.readFileSync(file, "utf-8")).toBe('{"mine":true}'); // the operator's own file, untouched in the end
  });
  test("removes the file and directory it created", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cur-"));
    const s = ENGINES.cursor.build(input({ cwd: ws, mcp }), "/x/cursor-agent");
    expect(fs.existsSync(path.join(ws, ".cursor", "mcp.json"))).toBe(true);
    s.cleanup();
    expect(fs.existsSync(path.join(ws, ".cursor"))).toBe(false);
  });
  test("`cursor` (not cursor-agent) is invoked through its `agent` subcommand", () => {
    expect(ENGINES.cursor.build(input(), "/usr/local/bin/cursor").args[0]).toBe("agent");
    expect(ENGINES.cursor.build(input(), "/usr/local/bin/cursor-agent").args[0]).toBe("-p");
  });
});

describe("engines without MCP wiring say so instead of silently dropping the servers", () => {
  for (const id of ["agy", "grok"]) {
    test(id, () => {
      const s = ENGINES[id].build(input({ mcp }), id);
      expect(s.notes.join(" ")).toContain("not wired");
      expect(ENGINES[id].mcp).toBe("none");
    });
  }
  test("no note when there is nothing to wire", () => {
    expect(ENGINES.opencode.build(input(), "opencode").notes).toEqual([]);
  });
});

describe("opencode v2 launcher", () => {
  test("no --dir or --variant: cwd is the spawn directory, the variant rides on --model", () => {
    const a = ENGINES.opencode.build(input({ model: "zai-coding-plan/glm-5.3-flash", effort: "high" }), "opencode").args;
    expect(a).not.toContain("--dir");
    expect(a).not.toContain("--variant");
    expect(a.slice(a.indexOf("--model"), a.indexOf("--model") + 2)).toEqual(["--model", "zai-coding-plan/glm-5.3-flash#high"]);
  });
  test("an existing #variant is replaced, and no effort leaves the model alone", () => {
    expect(ENGINES.opencode.build(input({ model: "p/m#low", effort: "max" }), "opencode").args).toContain("p/m#max");
    expect(ENGINES.opencode.build(input({ model: "p/m" }), "opencode").args).toContain("p/m");
    expect(ENGINES.opencode.build(input({ model: "default", effort: "max" }), "opencode").args).not.toContain("--model");
  });
});

describe("opencode gets CodeGraph through inline config", () => {
  const codegraph: McpRunConfig = { codegraph: { type: "stdio", command: "/bin/codegraph", args: ["serve", "--mcp", "--path", "/repo"], env: {} } };
  test("OPENCODE_CONFIG_CONTENT carries the codegraph server, in opencode's local shape", () => {
    const s = ENGINES.opencode.build(input({ mcp: codegraph }), "opencode");
    expect(JSON.parse(s.env.OPENCODE_CONFIG_CONTENT)).toEqual({ mcp: { codegraph: { type: "local", command: ["/bin/codegraph", "serve", "--mcp", "--path", "/repo"], enabled: true } } });
    expect(s.notes).toEqual([]);
  });
  test("the whole roster goes in, http servers in opencode's remote shape", () => {
    const all: McpRunConfig = { ...codegraph, trb: { type: "stdio", command: "trb", args: ["mcp-serve"], env: { TRB_URL: "u" } }, web: { type: "http", url: "https://x/mcp", headers: { A: "b" } } };
    const s = ENGINES.opencode.build(input({ mcp: all }), "opencode");
    const cfg = JSON.parse(s.env.OPENCODE_CONFIG_CONTENT).mcp;
    expect(Object.keys(cfg)).toEqual(["codegraph", "trb", "web"]);
    expect(cfg.trb).toEqual({ type: "local", command: ["trb", "mcp-serve"], enabled: true, environment: { TRB_URL: "u" } });
    expect(cfg.web).toEqual({ type: "remote", url: "https://x/mcp", enabled: true, headers: { A: "b" } });
    expect(s.notes).toEqual([]);
  });
  test("no env override without servers", () => {
    expect(ENGINES.opencode.build(input(), "opencode").env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
});
