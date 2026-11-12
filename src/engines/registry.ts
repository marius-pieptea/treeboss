/**
 * Engines: the coding CLIs trb can drive, and exactly how each one is launched.
 *
 * Each engine is one function from `LaunchInput` to a process: argv, what goes
 * on stdin, env, and a `cleanup` that undoes anything written into the workspace.
 * The flags are the ones Omni runs in production (`harness/cli_runner.ts`); the
 * per-engine comments record why a flag is, or deliberately is not, passed.
 *
 * Permissions: every engine is launched in its "no prompts" mode. A print-mode
 * turn cannot ask a human, so the alternative is a tool denied on first use. The
 * safety net is isolation, not prompting: subagents run in their own git
 * worktree and their work only reaches your checkout through `subagent_merge`.
 *
 * Not yet driven: ACP engines (devin, omp). Omni drives those over JSON-RPC.
 */
import fs from "fs";
import path from "path";
import { paths } from "../paths";
import { slug } from "../util";

export type McpServerSpec =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** Name → server. Built per run from the enabled MCP registry plus trb's own `trb` server. */
export type McpRunConfig = Record<string, McpServerSpec>;

export interface LaunchInput {
  /** Unique per turn; names generated config files. */
  key: string;
  prompt: string;
  cwd: string;
  model?: string | null;
  effort?: string | null;
  resumeId?: string | null;
  mcp: McpRunConfig;
  /** `claude --max-turns`. 0/undefined = uncapped. */
  maxTurns?: number;
  /** `claude` only: whether to pass --strict-mcp-config (trb's roster is the whole tool surface). */
  strictMcp?: boolean;
  /** plan, ask: hold the engine read-only (each engine's own switch). build/undefined: no prompts, free to edit. */
  mode?: "plan" | "build" | "ask";
  timeoutSec: number;
}

export interface LaunchSpec {
  cmd: string;
  args: string[];
  /** Written to stdin, then stdin is closed. null: the prompt travels in argv. */
  stdin: string | null;
  env: Record<string, string>;
  /** Removes whatever this launch wrote into the workspace. Idempotent. */
  cleanup: () => void;
  /** One-line notes for the run log ("MCP not wired for this engine"). */
  notes: string[];
}

export type McpWiring =
  /** Config file outside the workspace, passed by flag. Isolated from the user's own config. */
  | "config-file"
  /** `-c key=value` overrides on argv. Layers on top of the user's own config. */
  | "cli-override"
  /** A file written into the workspace (backed up and restored). Layers on the user's own config. */
  | "workspace-file"
  /** Not wired: the engine runs without trb's MCP servers (and so without subagent tools). */
  | "none";

export interface EngineDef {
  id: string;
  label: string;
  /** Executable names to look for on PATH, best first. */
  binaries: string[];
  mcp: McpWiring;
  /** Where the engine natively discovers skills, relative to the workspace. null: none. */
  skillsDir: string | null;
  /** Whether a follow-up turn can resume the engine's own session. */
  resume: boolean;
  /** Whether a resumed turn takes a different model than the one the session started on. Default true: every CLI here accepts its model flag next to its resume flag. */
  modelOnResume?: boolean;
  /** Whether the engine can roll its own conversation back to an earlier turn. Default false: none does, so reverting a turn restores files only (checkpoints/revert.ts). */
  conversationRollback?: boolean;
  build(input: LaunchInput, bin: string): LaunchSpec;
}

const isDefaultModel = (m?: string | null) => !m || m === "default" || m === "auto";

/* -------------------------------------------------------------------------- */
/* MCP config rendering                                                       */
/* -------------------------------------------------------------------------- */

function claudeMcpJson(cfg: McpRunConfig): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(cfg)) {
    mcpServers[name] =
      s.type === "stdio"
        ? { type: "stdio", command: s.command, args: s.args, ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) }
        : { type: "http", url: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) };
  }
  return { mcpServers };
}

function cursorMcpJson(cfg: McpRunConfig): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(cfg)) {
    mcpServers[name] =
      s.type === "stdio"
        ? { command: s.command, args: s.args, ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) }
        : { url: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) };
  }
  return { mcpServers };
}

/** TOML basic strings share JSON's escapes, so JSON.stringify is a valid TOML string. */
const toml = (v: string) => JSON.stringify(v);
const tomlInlineTable = (o: Record<string, string>) =>
  `{${Object.entries(o)
    .map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : toml(k)}=${toml(v)}`)
    .join(",")}}`;

/** `codex -c mcp_servers.<name>.…` overrides. A `-c` value parses as TOML first. */
export function codexMcpOverrides(cfg: McpRunConfig): string[] {
  const out: string[] = [];
  for (const [rawName, s] of Object.entries(cfg)) {
    const name = rawName.replace(/[^A-Za-z0-9_-]/g, "_");
    const base = `mcp_servers.${name}`;
    if (s.type === "stdio") {
      out.push("-c", `${base}.command=${toml(s.command)}`);
      out.push("-c", `${base}.args=[${s.args.map(toml).join(",")}]`);
      if (s.env && Object.keys(s.env).length) out.push("-c", `${base}.env=${tomlInlineTable(s.env)}`);
      // plan_ask blocks until the operator answers: codex cuts a tool call off after 60s by default.
      if (rawName === "trb") out.push("-c", `${base}.tool_timeout_sec=86400`);
    } else {
      out.push("-c", `${base}.url=${toml(s.url)}`);
      if (s.headers && Object.keys(s.headers).length) out.push("-c", `${base}.http_headers=${tomlInlineTable(s.headers)}`);
    }
  }
  return out;
}

/**
 * Write `content` to a workspace file, remembering what was there so cleanup can
 * put it back. The workspace is often the operator's real checkout, and the file
 * may be one they track (`.cursor/mcp.json`): overwriting it for good would be
 * the harness silently editing their repo.
 */
function writeWorkspaceFile(file: string, content: string): () => void {
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file) : null;
  const dirExisted = fs.existsSync(path.dirname(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      if (original !== null) fs.writeFileSync(file, original);
      else fs.rmSync(file, { force: true });
      if (!dirExisted) fs.rmdirSync(path.dirname(file));
    } catch {}
  };
}

/* -------------------------------------------------------------------------- */
/* Engines                                                                    */
/* -------------------------------------------------------------------------- */

function baseEnv(): Record<string, string> {
  return { CI: "true", FORCE_COLOR: "0", CLAUDE_NON_INTERACTIVE: "1", GEMINI_CLI_TRUST_WORKSPACE: "true" };
}

/** Plan mode on claude: reading and searching, the plan tools, and the read-only code index. No shell, no edits. */
export const CLAUDE_PLAN_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "mcp__trb__plan_ask", "mcp__trb__plan_submit", "mcp__trb__session_title", "mcp__codegraph__codegraph_explore", "mcp__codegraph__codegraph_node"];

/**
 * Ask mode on claude: the model is only OFFERED these built-in tools (`--tools`, so the schemas of Bash, Edit and
 * the rest are not even sent: fewer tokens), and these are the only ones allowed. With a CodeGraph index it is its
 * two read tools plus Read for confirming a cited line; without one it reads and searches.
 */
export const CLAUDE_ASK_TOOLS_INDEXED = ["Read"];
export const CLAUDE_ASK_TOOLS_PLAIN = ["Read", "Glob", "Grep"];
export const CLAUDE_ASK_CODEGRAPH_TOOLS = ["mcp__codegraph__codegraph_explore", "mcp__codegraph__codegraph_node"];

const claude: EngineDef = {
  id: "claude",
  label: "Claude Code",
  binaries: ["claude"],
  mcp: "config-file",
  skillsDir: ".claude/skills",
  resume: true,
  build(input, bin) {
    const notes: string[] = [];
    // Claude's own plan permission mode refuses every MCP tool, plan_ask included (verified on 2.1.x:
    // "Cannot call mcp__trb__plan_ask while in plan mode"). With the questionnaire wired, plan mode is an
    // allowlist instead: a headless run denies whatever is not listed, so it stays read-only, with no shell.
    const questionnaire = input.mode === "plan" && input.mcp.trb?.type === "stdio" && input.mcp.trb.env?.TRB_PLAN === "1";
    // Ask: an allowlist too (claude's plan permission mode refuses every MCP tool, CodeGraph's included).
    const askBuiltins = input.mcp.codegraph ? CLAUDE_ASK_TOOLS_INDEXED : CLAUDE_ASK_TOOLS_PLAIN;
    const ask = input.mode === "ask" ? ["--tools", askBuiltins.join(","), "--allowedTools", ...askBuiltins, ...(input.mcp.codegraph ? CLAUDE_ASK_CODEGRAPH_TOOLS : [])] : null;
    const args = [
      ...(ask ?? (questionnaire ? ["--allowedTools", ...CLAUDE_PLAN_TOOLS] : input.mode === "plan" ? ["--permission-mode", "plan"] : ["--dangerously-skip-permissions"])),
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    let cfgFile: string | null = null;
    if (Object.keys(input.mcp).length > 0 || input.strictMcp) {
      cfgFile = path.join(paths.mcpConfigs(), `${slug(input.key, 60)}.json`);
      fs.writeFileSync(cfgFile, JSON.stringify(claudeMcpJson(input.mcp), null, 2), { mode: 0o600 });
      args.push("--mcp-config", cfgFile);
      if (input.strictMcp !== false) args.push("--strict-mcp-config");
    }
    // `--max-turns` is undocumented in `claude --help` but accepted (verified on 2.1.247) and
    // reported in the terminal event. Only claude gets it: a cap on an engine that cannot be
    // continued would truncate work, and a flag an engine does not read is worse than none.
    if (input.maxTurns && input.maxTurns > 0) args.push("--max-turns", String(Math.floor(input.maxTurns)));
    if (input.resumeId) args.push("--resume", input.resumeId);
    if (!isDefaultModel(input.model)) args.push("--model", input.model!);
    if (input.effort) args.push("--effort", input.effort);
    args.push("-p");
    return {
      cmd: bin,
      args,
      stdin: input.prompt + "\n",
      env: baseEnv(),
      cleanup: () => {
        if (cfgFile) fs.rmSync(cfgFile, { force: true });
      },
      notes,
    };
  },
};

const codex: EngineDef = {
  id: "codex",
  label: "Codex",
  binaries: ["codex"],
  mcp: "cli-override",
  skillsDir: ".agents/skills",
  resume: true,
  build(input, bin) {
    const args = ["exec"];
    // `codex exec resume <id>`: the subcommand sits right after `exec`.
    if (input.resumeId) args.push("resume", input.resumeId);
    args.push("--json", "--skip-git-repo-check");
    // Plan mode: a read-only sandbox, set as config so it also applies to `exec resume`, which takes fewer flags.
    if (input.mode === "plan" || input.mode === "ask") args.push("-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"');
    else args.push("--dangerously-bypass-approvals-and-sandbox");
    if (!isDefaultModel(input.model)) args.push("-m", input.model!);
    // Reasoning effort is config, not a flag. A bare word parses as a TOML string.
    if (input.effort) args.push("-c", `model_reasoning_effort=${input.effort}`);
    args.push(...codexMcpOverrides(input.mcp));
    // `-` reads the prompt from stdin for both exec and resume, avoiding command-line length limits.
    args.push("-");
    return { cmd: bin, args, stdin: input.prompt, env: baseEnv(), cleanup: () => {}, notes: [] };
  },
};

const cursor: EngineDef = {
  id: "cursor",
  label: "Cursor Agent",
  binaries: ["cursor-agent", "cursor"],
  mcp: "workspace-file",
  skillsDir: ".cursor/skills",
  resume: true,
  build(input, bin) {
    const args: string[] = [];
    if (path.basename(bin) === "cursor") args.push("agent");
    args.push("-p", "--output-format", "stream-json", ...(input.mode === "plan" ? ["--mode", "plan"] : input.mode === "ask" ? ["--mode", "ask"] : ["--yolo"]), "--approve-mcps", "--trust", "--workspace", input.cwd);
    if (input.resumeId) args.push("--resume", input.resumeId);
    if (!isDefaultModel(input.model)) args.push("--model", input.model!);
    let restore: () => void = () => {};
    if (Object.keys(input.mcp).length > 0) {
      restore = writeWorkspaceFile(path.join(input.cwd, ".cursor", "mcp.json"), JSON.stringify(cursorMcpJson(input.mcp), null, 2));
    }
    return { cmd: bin, args, stdin: input.prompt + "\n", env: baseEnv(), cleanup: restore, notes: [] };
  },
};

/**
 * opencode reads inline config from `OPENCODE_CONFIG_CONTENT`, merged after the operator's own files, so the
 * servers are added without touching their config. The whole roster goes in, `trb` and CodeGraph included.
 */
export function opencodeMcpConfig(cfg: McpRunConfig): string | null {
  const mcp: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(cfg)) {
    mcp[name] =
      s.type === "stdio"
        ? { type: "local", command: [s.command, ...s.args], enabled: true, ...(s.env && Object.keys(s.env).length ? { environment: s.env } : {}) }
        : { type: "remote", url: s.url, enabled: true, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) };
  }
  return Object.keys(mcp).length ? JSON.stringify({ mcp }) : null;
}

const opencode: EngineDef = {
  id: "opencode",
  label: "OpenCode",
  binaries: ["opencode"],
  mcp: "cli-override",
  skillsDir: null,
  resume: true,
  build(input, bin) {
    const args = ["run", "--format", "json", ...(input.mode === "plan" || input.mode === "ask" ? ["--agent", "plan"] : ["--auto"]), "--thinking"];
    if (input.resumeId) args.push("--session", input.resumeId);
    // v2 dropped --dir (the runner spawns in input.cwd) and --variant: the variant rides on the model as `provider/model#variant`.
    // A variant needs a model to hang on, so with the default model an effort has nowhere to go.
    if (!isDefaultModel(input.model)) args.push("--model", input.effort ? `${input.model!.replace(/#.*$/, "")}#${input.effort}` : input.model!);
    const inline = opencodeMcpConfig(input.mcp);
    return {
      cmd: bin,
      args,
      stdin: input.prompt + "\n",
      env: { ...baseEnv(), ...(inline ? { OPENCODE_CONFIG_CONTENT: inline } : {}) },
      cleanup: () => {},
      notes: [],
    };
  },
};

const agy: EngineDef = {
  id: "agy",
  label: "Antigravity",
  binaries: ["agy"],
  mcp: "none",
  skillsDir: ".agents/skills",
  resume: true,
  build(input, bin) {
    const args = [...(input.mode === "plan" || input.mode === "ask" ? ["--mode", "plan"] : ["--dangerously-skip-permissions"]), "--output-format", "stream-json", "--print-timeout", `${Math.ceil(input.timeoutSec)}s`, "--add-dir", input.cwd];
    if (input.resumeId) args.push("--conversation", input.resumeId);
    if (!isDefaultModel(input.model)) args.push("--model", input.model!);
    // agy model ids bake effort in (`gemini-3.8-flash-high`); the CLI rejects --effort alongside one.
    if (input.effort && (isDefaultModel(input.model) || !/-(low|medium|high)$/.test(input.model!))) args.push("--effort", input.effort);
    args.push("-p", input.prompt);
    return {
      cmd: bin,
      args,
      stdin: null,
      env: baseEnv(),
      cleanup: () => {},
      notes: Object.keys(input.mcp).length ? ["agy: trb's MCP servers are not wired; running without them."] : [],
    };
  },
};

const grok: EngineDef = {
  id: "grok",
  label: "Grok",
  binaries: ["grok"],
  mcp: "none",
  skillsDir: ".grok/skills",
  resume: true,
  build(input, bin) {
    // No plan switch: without --always-approve a headless run is refused every tool that needs approval.
    const args = ["-p", input.prompt, "--output-format", "streaming-messages-json", ...(input.mode === "plan" || input.mode === "ask" ? [] : ["--always-approve"]), "--cwd", input.cwd];
    if (input.resumeId) args.push("--resume", input.resumeId);
    if (!isDefaultModel(input.model)) args.push("--model", input.model!);
    if (input.effort) args.push("--effort", input.effort);
    return {
      cmd: bin,
      args,
      stdin: null,
      env: baseEnv(),
      cleanup: () => {},
      notes: Object.keys(input.mcp).length ? ["grok: trb's MCP servers are not wired; running without them."] : [],
    };
  },
};

/**
 * A scripted stand-in used by tests and `trb doctor --self-test`: speaks claude's
 * stream-json so the whole pipeline (spawn, parse, resume, worktrees, subagent
 * tools) can be exercised without spending a token. Enabled only when
 * TRB_FAKE_ENGINE points at an executable.
 */
const fake: EngineDef = {
  id: "fake",
  label: "Fake (test double)",
  binaries: [],
  mcp: "config-file",
  skillsDir: ".claude/skills",
  resume: true,
  build(input, bin) {
    const spec = claude.build(input, bin);
    return { ...spec, args: spec.args.filter((a) => a !== "--dangerously-skip-permissions") };
  },
};

export const ENGINES: Record<string, EngineDef> = { claude, codex, cursor, opencode, agy, grok, fake };

/** Engines a lead may be started on or a subagent opened on. */
export function engineIds(): string[] {
  return Object.keys(ENGINES).filter((id) => id !== "fake" || process.env.TRB_FAKE_ENGINE);
}

export function getEngine(id: string): EngineDef | null {
  if (id === "fake" && !process.env.TRB_FAKE_ENGINE) return null;
  return ENGINES[id] ?? null;
}

/** The executable for an engine on this machine, or null when it is not installed. */
export function resolveBinary(def: EngineDef): string | null {
  if (def.id === "fake") return process.env.TRB_FAKE_ENGINE ?? null;
  for (const name of def.binaries) {
    // Pass PATH explicitly: Bun.which keeps the PATH the process started with and ignores later changes.
    const found = Bun.which(name, { PATH: process.env.PATH });
    if (found) return found;
  }
  return null;
}

export function installedEngines(): Array<{ id: string; label: string; bin: string | null }> {
  return engineIds().map((id) => {
    const def = ENGINES[id];
    return { id, label: def.label, bin: resolveBinary(def) };
  });
}
