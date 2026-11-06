import { describe, expect, test } from "bun:test";
import { classifyLine } from "../src/engines/classify";

describe("classifyLine", () => {
  test("tool calls: Name(arg), shell, mcp and web search forms", () => {
    expect(classifyLine("[claude] → Read(src/a.ts)")).toEqual({ kind: "tool", name: "Read", arg: "src/a.ts" });
    expect(classifyLine("[codex] → $ ls -la")).toEqual({ kind: "tool", name: "Bash", arg: "ls -la" });
    expect(classifyLine("[codex] → trb/subagent_list")).toEqual({ kind: "tool", name: "trb/subagent_list" });
    expect(classifyLine("[codex] → web search: bun sqlite")).toEqual({ kind: "tool", name: "WebSearch", arg: "bun sqlite" });
    expect(classifyLine('[claude] → mcp__trb__subagent_create({"brief":"x (y)"})')).toMatchObject({ kind: "tool", name: "mcp__trb__subagent_create", arg: '{"brief":"x (y)"}' });
  });

  test("tool results: sized, failed with a reason, and exit codes", () => {
    expect(classifyLine("[claude]   ✓ Read (2.0 KB)")).toEqual({ kind: "tool_ok", name: "Read", size: "2.0 KB" });
    expect(classifyLine("[claude]   ✗ Bash: Exit code 1")).toEqual({ kind: "tool_err", name: "Bash", detail: "Exit code 1" });
    expect(classifyLine("[codex]   ✓ $ ls (exit 0)")).toMatchObject({ kind: "tool_ok" });
    expect(classifyLine("[codex]   ✓ edit a.ts, b.ts")).toMatchObject({ kind: "tool_ok", name: "edit a.ts, b.ts" });
  });

  test("thinking, outcome and status lines", () => {
    expect(classifyLine("[claude] (thinking…)").kind).toBe("thinking");
    expect(classifyLine("[claude] done after 3 turn(s), 4s of model time").kind).toBe("done");
    expect(classifyLine("[claude] failed after 1 turn(s)").kind).toBe("fail");
    expect(classifyLine("[codex] turn failed: nope").kind).toBe("fail");
    expect(classifyLine("[claude] stopped by user").kind).toBe("done");
    expect(classifyLine("[claude] rate limit: allowed (five_hour)").kind).toBe("info");
    expect(classifyLine("[trb] s_1 (claude) — turn 1").kind).toBe("info");
    expect(classifyLine("[worktree] created branch x").kind).toBe("info");
    expect(classifyLine("[stderr] boom")).toEqual({ kind: "stderr", detail: "boom" });
  });

  test("anything else is the assistant talking", () => {
    expect(classifyLine("I changed the file.").kind).toBe("text");
    expect(classifyLine("multi\nline answer").kind).toBe("text");
    expect(classifyLine("[note] not an engine tag we know").kind).toBe("info");
  });
});
