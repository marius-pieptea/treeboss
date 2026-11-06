import { describe, expect, test } from "bun:test";
import { appendLine, buildTranscript, emptyTranscript, groupTools, summarizeTools } from "../../web/src/lib/transcript";
import type { LogLine, TurnRow } from "../../web/src/lib/types";
import { classifyLine } from "../../src/engines/classify";

let n = 0;
const line = (text: string, session = "s_a", turn = "t_1"): LogLine => {
  const data = classifyLine(text);
  return { id: ++n, session, turn_id: turn, text, kind: data.kind, data };
};
const feed = (texts: string[], session = "s_a") => texts.reduce((s, t) => appendLine(s, line(t, session)), emptyTranscript());

describe("transcript", () => {
  test("a tool call and its result become one item", () => {
    const s = feed(["[claude] → Read(src/a.ts)", "[claude]   ✓ Read (2.0 KB)"]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ type: "tool", name: "Read", arg: "src/a.ts", status: "ok", size: "2.0 KB" });
  });

  test("a running tool stays running until its result arrives", () => {
    const s = feed(["[claude] → Bash(bun test)"]);
    expect(s.items[0]).toMatchObject({ status: "running" });
  });

  test("results attach to the oldest running call of that name", () => {
    const s = feed(["[claude] → Read(a)", "[claude] → Bash(ls)", "[claude] → Read(b)", "[claude]   ✓ Read (1 B)", "[claude]   ✓ Bash (3 B)"]);
    const tools = s.items.filter((i) => i.type === "tool") as any[];
    expect(tools.map((t) => `${t.name}:${t.arg}:${t.status}`)).toEqual(["Read:a:ok", "Bash:ls:ok", "Read:b:running"]);
  });

  test("a failed tool keeps its error text", () => {
    const s = feed(["[claude] → Bash(false)", "[claude]   ✗ Bash: Exit code 1"]);
    expect(s.items[0]).toMatchObject({ status: "err", detail: "Exit code 1" });
  });

  test("a result with no call we saw is still shown", () => {
    const s = feed(["[claude]   ✓ Read (1 B)"]);
    expect(s.items[0]).toMatchObject({ type: "tool", name: "Read", status: "ok" });
  });

  test("results stay within their own session", () => {
    let s = emptyTranscript();
    s = appendLine(s, line("[claude] → Read(x)", "s_lead"));
    s = appendLine(s, line("[claude] → Read(y)", "s_head"));
    s = appendLine(s, line("[claude]   ✓ Read (1 B)", "s_head"));
    const tools = s.items.filter((i) => i.type === "tool") as any[];
    expect(tools.map((t) => `${t.session}:${t.status}`)).toEqual(["s_lead:running", "s_head:ok"]);
  });

  test("consecutive thinking collapses, and text ends it", () => {
    let s = feed(["[claude] (thinking…)", "[claude] (thinking…)"]);
    expect(s.items.filter((i) => i.type === "thinking")).toHaveLength(1);
    s = appendLine(s, line("here is the answer"));
    expect((s.items[0] as any).active).toBe(false);
    expect(s.items[1]).toMatchObject({ type: "text", text: "here is the answer" });
  });

  test("a tool call ends thinking, so a run of think-then-tool steps leaves no live thinking behind", () => {
    const s = feed(["[claude] (thinking…)", "[claude] → Read(a)", "[claude]   ✓ Read (1 B)", "[claude] (thinking…)", "[claude] → Bash(ls)", "[claude]   ✓ Bash (1 B)"]);
    const thinking = s.items.filter((i) => i.type === "thinking") as Array<{ active: boolean }>;
    expect(thinking).toHaveLength(2);
    expect(thinking.every((t) => !t.active)).toBe(true);
  });

  test("a stop closes the live thinking: an interrupted turn leaves no 'Thinking…' behind", () => {
    const s = feed(["[claude] (thinking…)", "[claude] stopped by user"]);
    expect(s.items.filter((i) => i.type === "thinking")).toEqual([expect.objectContaining({ active: false })]);
  });

  test("turn headers become dividers, protocol noise is dropped, done lines end the turn", () => {
    const s = feed(["[trb] s_a1b2c3d4e5 (claude, m) — turn 1", "[trb] Claude Code in /tmp/x", "[claude] session started in /tmp/x (33 tools)", "[claude] rate limit: allowed (five_hour)", "ok", "[claude] done after 1 turn(s), 2s of model time"]);
    expect(s.items.map((i) => i.type)).toEqual(["turn", "text", "end"]);
    expect(s.items[2]).toMatchObject({ ok: true });
  });

  test("a failure is an end item with ok=false; stderr is a warning note", () => {
    const s = feed(["[stderr] boom", "[claude] failed after 1 turn(s)"]);
    expect(s.items[0]).toMatchObject({ type: "note", tone: "warn", text: "boom" });
    expect(s.items[1]).toMatchObject({ type: "end", ok: false });
  });

  test("replays are idempotent: applying a line twice changes nothing", () => {
    const l = line("hello");
    const once = appendLine(emptyTranscript(), l);
    expect(appendLine(once, l)).toBe(once);
  });

  test("incremental feeding equals building from the whole log", () => {
    const texts = ["[trb] s_a1b2c3d4e5 (claude, m) — turn 1", "[claude] (thinking…)", "[claude] → Read(a)", "[claude]   ✓ Read (1 B)", "done", "[claude] done after 1 turn(s)"];
    const lines = texts.map((t) => line(t));
    const inc = lines.reduce((s, l) => appendLine(s, l), emptyTranscript());
    expect(buildTranscript(lines).items).toEqual(inc.items);
  });

  test("user prompts come from the turns table, before each turn's first line", () => {
    const turns: TurnRow[] = [{ id: "t_9", seq: 1, status: "completed", started_at: "", finished_at: null, cost_usd: null, prompt: "fix the bug", output: null }];
    const ls = [line("[trb] s_a1b2c3d4e5 (claude, m) — turn 1", "s_a", "t_9"), line("done", "s_a", "t_9")];
    const t = buildTranscript(ls, turns, "s_a");
    expect(t.items.map((i) => i.type)).toEqual(["user", "turn", "text"]);
    expect((t.items[0] as any).text).toBe("fix the bug");
  });

  test("a child's own prompt is not shown as the lead's", () => {
    const turns: TurnRow[] = [{ id: "t_c", seq: 1, status: "completed", started_at: "", finished_at: null, cost_usd: null, prompt: "child brief", output: null }];
    const t = buildTranscript([line("hi", "s_child", "t_c")], turns, "s_lead");
    expect(t.items.some((i) => i.type === "user")).toBe(false);
  });
});

describe("grouping", () => {
  test("consecutive tools group; text breaks the group; groups do not cross sessions", () => {
    const s = feed(["[claude] → Read(a)", "[claude]   ✓ Read (1 B)", "[claude] → Bash(ls)", "[claude]   ✓ Bash (1 B)", "thinking out loud", "[claude] → Bash(pwd)", "[claude]   ✓ Bash (1 B)"]);
    const g = groupTools(s.items);
    expect(g.map((x) => x.type)).toEqual(["tools", "text", "tools"]);
    expect((g[0] as any).tools).toHaveLength(2);
  });

  test("summaries read like a sentence", () => {
    expect(summarizeTools([{ name: "Bash" }, { name: "Bash" }, { name: "Bash" }, { name: "Read" }, { name: "Read" }, { name: "Edit" }])).toBe("Ran 3 commands, read 2 files, edited a file");
    expect(summarizeTools([{ name: "mcp__trb__subagent_create" }])).toBe("Called subagent create");
  });
});
