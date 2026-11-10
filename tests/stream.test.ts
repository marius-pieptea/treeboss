import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { createStreamAccumulator, looksLikeResumeRejection } from "../src/engines/stream";

const feed = (events: unknown[], label = "claude") => {
  const lines: string[] = [];
  let sid: string | null = null;
  const acc = createStreamAccumulator((l) => lines.push(l), (id) => (sid = id), label);
  acc.push(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  acc.end();
  return { acc, lines, sid: () => sid };
};

describe("claude stream-json (real capture)", () => {
  const raw = fs.readFileSync(path.join(import.meta.dir, "fixtures", "claude-pong.ndjson"), "utf-8");

  test("recovers the answer, session id and usage from a real run", () => {
    const lines: string[] = [];
    const ids: string[] = [];
    const acc = createStreamAccumulator((l) => lines.push(l), (id) => ids.push(id));
    acc.push(raw);
    acc.end();
    expect(acc.finalText()).toBe("pong");
    expect(acc.completed()).toBe(true);
    expect(acc.isError()).toBe(false);
    expect(acc.sessionId()).toBe("63eaddd5-8eef-49ca-875c-38e6fd72fcd3");
    expect(ids).toEqual(["63eaddd5-8eef-49ca-875c-38e6fd72fcd3"]); // fired once, not per event
    const u = acc.cliUsage()!;
    expect(u.outputTokens).toBeGreaterThan(0);
    expect(u.cacheCreationInputTokens).toBeGreaterThan(20000);
    expect(u.totalCostUsd).toBeCloseTo(0.00535, 4);
    expect(u.model).toBe("claude-haiku-5-5");
  });

  test("the raw NDJSON never becomes the answer", () => {
    const acc = createStreamAccumulator(() => {});
    acc.push(raw);
    expect(acc.finalText()).not.toContain("{");
  });

  test("handles a chunk boundary in the middle of a line", () => {
    const acc = createStreamAccumulator(() => {});
    const mid = Math.floor(raw.length / 2);
    acc.push(raw.slice(0, mid));
    acc.push(raw.slice(mid));
    acc.end();
    expect(acc.finalText()).toBe("pong");
    expect(acc.completed()).toBe(true);
  });
});

describe("usage accounting", () => {
  test("one API message split across several assistant events is counted once", () => {
    // Verified live: 4 events, one message id, cache_creation 23125 on every one.
    const usage = { input_tokens: 4, output_tokens: 10, cache_creation_input_tokens: 23125, cache_read_input_tokens: 0 };
    const events = [1, 2, 3, 4].map(() => ({ type: "assistant", message: { id: "msg_1", model: "m", content: [{ type: "text", text: "x" }], usage } }));
    const { acc } = feed(events);
    expect(acc.cliUsage()!.cacheCreationInputTokens).toBe(23125); // not 92500
  });

  test("the terminal result's usage wins over the per-message snapshot", () => {
    const { acc } = feed([
      { type: "assistant", message: { id: "a", content: [], usage: { input_tokens: 1, output_tokens: 54 } } },
      { type: "result", is_error: false, result: "ok", num_turns: 2, total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 305 } },
    ]);
    expect(acc.cliUsage()!.outputTokens).toBe(305);
    expect(acc.cliUsage()!.totalCostUsd).toBe(0.5);
  });

  test("an interrupted run (no result event) still reports its tokens", () => {
    const { acc } = feed([{ type: "assistant", message: { id: "a", content: [], usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 100 } } }]);
    expect(acc.completed()).toBe(false);
    expect(acc.cliUsage()).toMatchObject({ inputTokens: 7, outputTokens: 9, cacheReadInputTokens: 100, totalCostUsd: null });
  });
});

describe("claude events", () => {
  test("tool calls and results become progress lines, tool output is sized not echoed", () => {
    const { lines, acc } = feed([
      { type: "assistant", message: { id: "a", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(2048) }] } },
    ]);
    expect(lines).toContain("[claude] → Read(src/a.ts)");
    expect(lines).toContain("[claude]   ✓ Read (2.0 KB)");
    expect(acc.toolCount()).toBe(1);
  });

  test("a failed tool result is marked", () => {
    const { lines } = feed([
      { type: "assistant", message: { id: "a", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Exit code 1" }] } },
    ]);
    expect(lines.some((l) => l.includes("✗ Bash: Exit code 1"))).toBe(true);
  });

  test("max-turns is detected from the two fields that state it, not from stop_reason", () => {
    const capped = feed([{ type: "result", is_error: true, subtype: "error_max_turns", terminal_reason: "max_turns", num_turns: 2 }]);
    expect(capped.acc.maxTurnsHit()).toBe(true);
    const healthy = feed([{ type: "result", is_error: false, stop_reason: "tool_use", result: "ok" }]);
    expect(healthy.acc.maxTurnsHit()).toBe(false);
  });

  test("an error result is reported as an error", () => {
    const { acc } = feed([{ type: "result", is_error: true, result: "boom" }]);
    expect(acc.completed()).toBe(true);
    expect(acc.isError()).toBe(true);
  });
});

describe("resume rejection", () => {
  test("recognises the refusals that need a fresh session", () => {
    expect(looksLikeResumeRejection("No conversation found with session ID: abc")).toBe(true);
    expect(looksLikeResumeRejection("Error: thread/resume: no rollout found for thread id 123")).toBe(true);
  });
  test("does not mistake ordinary errors for one", () => {
    expect(looksLikeResumeRejection("TypeError: cannot read properties of undefined")).toBe(false);
    expect(looksLikeResumeRejection("")).toBe(false);
  });
  test("a non-JSON line announcing it flips the flag", () => {
    const acc = createStreamAccumulator(() => {});
    acc.push("No conversation found with session ID: zzz\n");
    expect(acc.resumeRejected()).toBe(true);
  });
});

describe("codex exec --json", () => {
  const events = [
    { type: "thread.started", thread_id: "th_1" },
    { type: "turn.started" },
    { type: "item.started", item: { type: "command_execution", command: "ls -la" } },
    { type: "item.completed", item: { type: "command_execution", command: "ls -la", exit_code: 0 } },
    { type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts" }, { path: "b.ts" }] } },
    { type: "item.completed", item: { type: "agent_message", text: "All done." } },
    { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } },
  ];
  test("session id, answer, tool count and completion", () => {
    const { acc, lines } = feed(events, "codex");
    expect(acc.sessionId()).toBe("th_1");
    expect(acc.finalText()).toBe("All done.");
    expect(acc.completed()).toBe(true);
    expect(acc.toolCount()).toBe(1); // started counts; completed does not double-count
    expect(lines).toContain("[codex] → $ ls -la");
    expect(lines.some((l) => l.includes("edit a.ts, b.ts"))).toBe(true);
  });
  test("OpenAI-shaped usage is normalised: cached tokens are not billed as fresh input", () => {
    const u = feed(events, "codex").acc.cliUsage()!;
    expect(u.inputTokens).toBe(200); // 1000 total - 800 cached
    expect(u.cacheReadInputTokens).toBe(800);
    expect(u.outputTokens).toBe(50);
  });
  test("turn.failed is an error and can be a refused resume", () => {
    const { acc } = feed([{ type: "turn.failed", error: { message: "thread/resume failed: no rollout found for thread id x" } }], "codex");
    expect(acc.isError()).toBe(true);
    expect(acc.resumeRejected()).toBe(true);
  });
});

describe("other engines", () => {
  test("cursor: tool_call started/completed", () => {
    const { lines, acc } = feed([
      { type: "system", subtype: "init", session_id: "c1", model: "m", cwd: "/x" },
      { type: "tool_call", subtype: "started", call_id: "k", tool_call: { shellToolCall: { args: { command: "pwd" } } } },
      { type: "tool_call", subtype: "completed", call_id: "k", tool_call: { shellToolCall: { result: { success: { stdout: "/x\n" } } } } },
      { type: "result", is_error: false, result: "fine", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(acc.sessionId()).toBe("c1");
    expect(lines).toContain("[claude] → Bash(pwd)");
    expect(acc.finalText()).toBe("fine");
  });

  test("agy: step_update events and result", () => {
    const { acc, lines } = feed(
      [
        { event: "init", conversation_id: "conv-9", init: { cwd: "/w", tools: [1, 2] } },
        { event: "step_update", conversation_id: "conv-9", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "view_file", tool_info: { parameters: { AbsolutePath: "/w/a" } } } },
        { event: "step_update", step_update: { step_type: "agent_response", text_delta: "hi there" } },
        { event: "result", result: { status: "SUCCESS", response: "final answer" } },
      ],
      "agy",
    );
    expect(acc.sessionId()).toBe("conv-9");
    expect(lines).toContain("[agy] → view_file(/w/a)");
    expect(acc.finalText()).toBe("final answer");
    expect(acc.isError()).toBe(false);
  });

  test("agy: token deltas are buffered and emitted as a single block on DONE", () => {
    const { acc, lines } = feed(
      [
        { event: "init", conversation_id: "conv-10", init: { cwd: "/w" } },
        { event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "Hello" } },
        { event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: " " } },
        { event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "world" } },
        { event: "step_update", step_update: { step_type: "agent_response", state: "DONE", text_delta: "!" } },
        { event: "result", result: { status: "SUCCESS", response: "Hello world!" } },
      ],
      "agy",
    );
    expect(lines.filter((l) => l.includes("Hello world!"))).toHaveLength(1);
    expect(lines).not.toContain("Hello");
    expect(lines).not.toContain("world");
    expect(acc.finalText()).toBe("Hello world!");
  });

  test("agy: buffered text is shown before the tool call that follows it", () => {
    const { lines } = feed(
      [
        { event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "Let me " } },
        { event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "look." } },
        { event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "view_file", tool_info: { parameters: { path: "/w/a" } } } },
        { event: "result", result: { status: "SUCCESS" } },
      ],
      "agy",
    );
    const text = lines.indexOf("Let me look.");
    expect(text).toBeGreaterThanOrEqual(0);
    expect(text).toBeLessThan(lines.findIndex((l) => l.startsWith("[agy] → view_file")));
  });

  test("agy: text still buffered when the stream ends without a result is not lost", () => {
    const { acc, lines } = feed(
      [
        { event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "Partial " } },
        { event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "answer" } },
      ],
      "agy",
    );
    expect(lines).toContain("Partial answer");
    expect(acc.finalText()).toBe("Partial answer");
    expect(acc.completed()).toBe(false);
  });

  test("agy: a result with a response but no deltas still shows the answer once", () => {
    const { acc, lines } = feed([{ event: "result", result: { status: "SUCCESS", response: "Only here" } }], "agy");
    expect(lines.filter((l) => l === "Only here")).toHaveLength(1);
    expect(acc.finalText()).toBe("Only here");
  });

  test("opencode: real step_finish carries tokens (input excludes the cache portions)", () => {
    const { acc } = feed(
      [
        { type: "step_start", sessionID: "ses_x", part: { id: "prt_1", type: "step-start" } },
        { type: "text", sessionID: "ses_x", part: { type: "text", text: "pong" } },
        { type: "step_finish", sessionID: "ses_x", part: { id: "prt_2", reason: "stop", type: "step-finish", tokens: { total: 116327, input: 56740, output: 3, reasoning: 0, cache: { write: 0, read: 59584 } }, cost: 0 } },
      ],
      "opencode",
    );
    expect(acc.cliUsage()).toMatchObject({ inputTokens: 56740, outputTokens: 3, cacheReadInputTokens: 59584 });
    expect(acc.cliUsage()!.totalCostUsd).toBeNull(); // opencode reported cost 0: no figure, not "free"
  });

  test("opencode: text parts and step_finish", () => {
    const { acc } = feed(
      [
        { type: "step_start", sessionID: "oc1", part: {} },
        { type: "text", sessionID: "oc1", part: { text: "answer" } },
        { type: "step_finish", part: { reason: "stop" } },
      ],
      "opencode",
    );
    expect(acc.sessionId()).toBe("oc1");
    expect(acc.finalText()).toBe("answer");
    expect(acc.completed()).toBe(true);
    expect(acc.isError()).toBe(false);
  });

  test("opencode: tool_use is self-contained — emits start and completion so the UI spinner stops", () => {
    const { lines, acc } = feed(
      [
        { type: "step_start", sessionID: "oc2", part: { type: "step-start" } },
        {
          type: "tool_use",
          sessionID: "oc2",
          part: {
            type: "tool",
            callID: "c1",
            tool: "bash",
            state: { status: "completed", input: { command: "echo hi" }, output: "hi\n" },
          },
        },
        { type: "step_finish", sessionID: "oc2", part: { reason: "tool-calls", tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } } } },
        { type: "text", sessionID: "oc2", part: { text: "done" } },
        { type: "step_finish", sessionID: "oc2", part: { reason: "stop" } },
      ],
      "opencode",
    );
    expect(lines).toContain("[opencode] → bash(echo hi)");
    expect(lines).toContain("[opencode]   ✓ bash (3 B)");
    expect(lines.filter((l) => l.startsWith("[opencode] done")).length).toBe(1); // only the terminal step_finish, not tool-calls
    expect(acc.toolCount()).toBe(1);
    expect(acc.completed()).toBe(true);
    expect(acc.finalText()).toBe("done");
  });

  test("opencode: a failed tool_use is marked", () => {
    const { lines } = feed(
      [
        {
          type: "tool_use",
          sessionID: "oc3",
          part: { type: "tool", tool: "bash", state: { status: "error", input: { command: "false" }, output: "Exit 1" } },
        },
      ],
      "opencode",
    );
    expect(lines.some((l) => l.includes("✗ bash: Exit 1"))).toBe(true);
  });
});
