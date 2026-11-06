/**
 * A scripted stand-in for `claude -p --output-format stream-json`: speaks the same protocol so the
 * daemon, parser, resume, worktrees and the real `trb mcp-serve` shim can be exercised without a
 * model. It does what the prompt's directive lines tell it to:
 *
 *   SAY <text>                     assistant text (the last one becomes the final answer)
 *   WRITE <path> <content…>        write a file under cwd (relative path)
 *   SLEEP <ms>
 *   FAIL <message>                 end with an error result
 *   CALL_TOOL <name> <json>        call an MCP tool on the `trb` server from --mcp-config, like a lead would
 *   REJECT_RESUME                  when resumed, behave like a CLI that lost the session
 *   ECHO_RESUME                    say whether this turn was a resume, and its session id
 *   SAYMD <n>                      a markdown answer (headings, a list, a table, a code block) repeated n times
 *   THINK                          a thinking block
 *   TOOL <Name> <arg> [ms]         a tool call and its result, with no side effects (optionally taking ms)
 *   BASH <command>                 a Bash tool call that really runs the command in cwd
 *   READ <path>                    a Read tool call
 *   SKILLS                         say which skill directories are visible to the engine in cwd (.claude/skills)
 *   MCPS                           say which MCP servers the engine was given (--mcp-config)
 *   ECHO_PROMPT <needle>           say whether the prompt it received contains <needle> (yes/no)
 *   USAGE <n>                      an assistant message whose usage totals n tokens of context (input + cache read)
 *   COMPACT <from> <to>            a compaction: the compact_boundary event, then a message at <to> tokens of context
 *   WINDOW <n>                     report an n-token context window in the result's modelUsage
 *   (a prompt starting with /compact compacts 150000 -> 12000, as a manual /compact would)
 *   ECHO_ARGS                      say the argv it was launched with (to see which mode flags an engine got)
 *   GIT_COMMIT <message>           `git add -A && git commit` in cwd, the way real agents often do for themselves
 */
import fs from "fs";
import path from "path";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
};
const resumeId = flag("--resume");
const mcpConfig = flag("--mcp-config");
// Claude is held read-only by `--permission-mode plan`, or by an `--allowedTools` allowlist when the plan
// questionnaire is wired (its plan mode refuses MCP tools): the stand-in refuses writes and shell for both.
const planMode = flag("--permission-mode") === "plan" || argv.includes("--allowedTools");
const sessionId = resumeId ?? `fake-${Math.random().toString(16).slice(2, 10)}`;

const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prompt = await new Response(Bun.stdin.stream()).text();
const lines = prompt.split("\n");
const directives = lines.filter((l) => /^(SAY|SAYMD|THINK|TOOL|BASH|READ|WRITE|SLEEP|FAIL|CALL_TOOL|REJECT_RESUME|ECHO_RESUME|GIT_COMMIT|SKILLS|MCPS|ECHO_PROMPT|USAGE|COMPACT|WINDOW|ECHO_ARGS)\b/.test(l));

if (resumeId && directives.some((d) => d.startsWith("REJECT_RESUME"))) {
  console.error(`No conversation found with session ID: ${resumeId}`);
  process.exit(1);
}

emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model: flag("--model") ?? "fake-1", tools: [] });

let lastText = "";
let failed: string | null = null;
let toolSeq = 0;
let messageSeq = 0;
let windowTokens: number | null = null;

const compact = (from: number, to: number, trigger: string) => {
  emit({ type: "system", subtype: "compact_boundary", session_id: sessionId, compact_metadata: { trigger, pre_tokens: from } });
  emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [], usage: { input_tokens: 5, cache_read_input_tokens: Math.max(0, to - 5), output_tokens: 0 } } });
};
if (lines.some((l) => l.trim().startsWith("/compact"))) {
  compact(150_000, 12_000, "manual");
  lastText = "Compacted.";
}

// Minimal MCP stdio client, so CALL_TOOL goes through the real `trb mcp-serve` shim.
type McpClient = { call: (name: string, args: any) => Promise<string>; close: () => void };
const state: { mcp: McpClient | null } = { mcp: null };
async function mcpClient(): Promise<McpClient> {
  if (state.mcp) return state.mcp;
  const cfg = JSON.parse(fs.readFileSync(mcpConfig!, "utf-8"));
  const srv = cfg.mcpServers?.trb;
  if (!srv) throw new Error("no `trb` server in --mcp-config");
  const child = Bun.spawn([srv.command, ...srv.args], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, ...srv.env } });
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pending = new Map<number, (m: any) => void>();
  (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      buf += dec.decode(r.value);
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          pending.get(m.id)?.(m);
        } catch {}
      }
    }
  })();
  let id = 0;
  const rpc = (method: string, params?: any) =>
    new Promise<any>((resolve) => {
      const my = ++id;
      pending.set(my, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  state.mcp = {
    call: async (name, args) => {
      const m = await rpc("tools/call", { name, arguments: args });
      return m.result?.content?.[0]?.text ?? JSON.stringify(m.error ?? m);
    },
    close: () => child.kill(),
  };
  return state.mcp;
}

for (const d of directives) {
  const [verb, ...restParts] = d.split(" ");
  const rest = restParts.join(" ");
  if (verb === "SAY") {
    lastText = rest;
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "text", text: rest }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } });
  } else if (verb === "SAYMD") {
    const n = Math.max(1, Number(rest) || 1);
    const block = "## Summary\n\nI made the change in `src/greet.ts` and **verified it** with the tests.\n\n- trimmed the name before greeting\n- kept the default for empty input\n- no API change\n\n| file | change |\n|---|---|\n| `src/greet.ts` | +3 −1 |\n\n```ts\nexport function greet(name: string): string {\n  return `Hello, ${name.trim() || \"world\"}!`;\n}\n```\n";
    lastText = Array.from({ length: n }, () => block).join("\n");
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "text", text: lastText }], usage: { input_tokens: 10, output_tokens: 5 } } });
  } else if (verb === "USAGE") {
    const n = Math.max(0, Number(rest) || 0);
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [], usage: { input_tokens: 10, cache_read_input_tokens: Math.max(0, n - 10), output_tokens: 0 } } });
  } else if (verb === "COMPACT") {
    const [from, to] = rest.split(/\s+/).map(Number);
    compact(from || 150_000, to || 12_000, "auto");
  } else if (verb === "WINDOW") {
    windowTokens = Number(rest) || null;
  } else if (verb === "SKILLS") {
    const dir = path.resolve(".claude/skills");
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    lastText = `skills=${names.join(",")}`;
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "text", text: lastText }], usage: { input_tokens: 1, output_tokens: 1 } } });
  } else if (verb === "MCPS") {
    const cfg = mcpConfig && fs.existsSync(mcpConfig) ? JSON.parse(fs.readFileSync(mcpConfig, "utf-8")) : { mcpServers: {} };
    lastText = `mcps=${Object.keys(cfg.mcpServers ?? {}).filter((n) => n !== "trb").sort().join(",")}`;
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "text", text: lastText }], usage: { input_tokens: 1, output_tokens: 1 } } });
  } else if (verb === "ECHO_PROMPT") {
    // The directive line itself contains the needle, so look only at the rest of the prompt.
    const others = lines.filter((l) => !l.startsWith("ECHO_PROMPT")).join("\n");
    lastText = `prompt-has[${rest}]=${others.includes(rest) ? "yes" : "no"}`;
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "text", text: lastText }], usage: { input_tokens: 1, output_tokens: 1 } } });
  } else if (verb === "THINK") {
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "thinking", thinking: "…" }], usage: { input_tokens: 10, output_tokens: 5 } } });
  } else if (verb === "TOOL" || verb === "READ" || verb === "BASH") {
    const parts = rest.split(" ");
    const name = verb === "TOOL" ? parts.shift()! : verb === "READ" ? "Read" : "Bash";
    let ms = 0;
    if (verb === "TOOL" && /^\d+$/.test(parts[parts.length - 1] ?? "")) ms = Number(parts.pop());
    const arg = parts.join(" ");
    const id = `tu${++toolSeq}`;
    const input = verb === "BASH" ? { command: arg } : verb === "READ" ? { file_path: arg } : { pattern: arg, path: arg };
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 10, output_tokens: 5 } } });
    let out = "ok";
    if (verb === "BASH" && planMode) {
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "denied: plan mode is read-only" }] } });
      continue;
    }
    if (verb === "BASH") {
      const r = Bun.spawnSync(["bash", "-c", arg], { cwd: process.cwd() });
      out = r.stdout.toString() + r.stderr.toString();
    }
    if (ms) await sleep(ms);
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: out || "ok" }] } });
  } else if (verb === "SLEEP") {
    await sleep(Number(rest) || 0);
  } else if (verb === "WRITE") {
    const sp = rest.indexOf(" ");
    const rel = sp === -1 ? rest : rest.slice(0, sp);
    const content = sp === -1 ? "" : rest.slice(sp + 1);
    const id = `tu${++toolSeq}`;
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "tool_use", id, name: "Write", input: { file_path: rel } }], usage: { input_tokens: 10, output_tokens: 5 } } });
    if (planMode) {
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "denied: plan mode is read-only" }] } });
      continue;
    }
    fs.mkdirSync(path.dirname(path.resolve(rel)), { recursive: true });
    fs.writeFileSync(path.resolve(rel), content + "\n");
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  } else if (verb === "GIT_COMMIT") {
    const run = (args: string[]) => Bun.spawnSync(["git", "-c", "user.email=agent@x", "-c", "user.name=agent", "-c", "commit.gpgsign=false", ...args], { cwd: process.cwd() });
    run(["add", "-A"]);
    run(["commit", "-qm", rest || "agent commit"]);
  } else if (verb === "FAIL") {
    failed = rest || "failed";
  } else if (verb === "ECHO_ARGS") {
    lastText = `args=${argv.join(" ")}`;
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "text", text: lastText }], usage: { input_tokens: 1, output_tokens: 1 } } });
  } else if (verb === "ECHO_RESUME") {
    lastText = `resume=${resumeId ? "yes" : "no"} session=${sessionId}`;
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "text", text: lastText }], usage: { input_tokens: 1, output_tokens: 1 } } });
  } else if (verb === "CALL_TOOL") {
    const sp = rest.indexOf(" ");
    const name = sp === -1 ? rest : rest.slice(0, sp);
    const args = sp === -1 ? {} : JSON.parse(rest.slice(sp + 1));
    const id = `tu${++toolSeq}`;
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "tool_use", id, name: `mcp__trb__${name}`, input: args }], usage: { input_tokens: 10, output_tokens: 5 } } });
    const text = await (await mcpClient()).call(name, args);
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
    // Surface the tool's answer so tests can assert on what the lead saw.
    lastText = `TOOL ${name} -> ${text}`;
    emit({ type: "assistant", message: { id: `m${++messageSeq}`, model: "fake-1", content: [{ type: "text", text: lastText }], usage: { input_tokens: 1, output_tokens: 1 } } });
  }
}
state.mcp?.close();

emit({
  type: "result",
  subtype: failed ? "error_during_execution" : "success",
  is_error: failed !== null,
  result: failed ?? (lastText || "ok"),
  session_id: sessionId,
  num_turns: 1,
  total_cost_usd: 0.001,
  duration_ms: 5,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
  ...(windowTokens ? { modelUsage: { "fake-1": { contextWindow: windowTokens } } } : {}),
});
process.exit(0);
