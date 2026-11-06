import { describe, expect, test } from "bun:test";
import { deriveChat, diffStat, hasLiveTail, headLine, loadDefaultViewMode, loadViewMode, otherMode, saveViewMode, settingsSummary, shelfFor, splitContext, terminalResume, toolVerb } from "../../web/src/features/agent/chat-logic";
import type { TranscriptItem } from "../../web/src/lib/transcript";
import type { SessionView } from "../../web/src/lib/types";

const L = "s_lead";
const H1 = "s_head1";
const H2 = "s_head2";

let n = 0;
const id = () => `i${++n}`;
const user = (text: string, session = L): TranscriptItem => ({ type: "user", id: id(), session, turnId: "t1", text });
const turn = (session = L): TranscriptItem => ({ type: "turn", id: id(), session, turnId: "t1", n: 1 });
const text = (t: string, session = L): TranscriptItem => ({ type: "text", id: id(), session, turnId: "t1", text: t });
const tool = (name: string, arg = "", status: "running" | "ok" | "err" = "ok", session = L): TranscriptItem => ({ type: "tool", id: id(), session, turnId: "t1", name, arg, status });
const thinking = (active: boolean, session = L): TranscriptItem => ({ type: "thinking", id: id(), session, turnId: "t1", active });
const note = (t: string, session = L): TranscriptItem => ({ type: "note", id: id(), session, turnId: "t1", text: t, tone: "info" });
const end = (ok: boolean, t: string, session = L): TranscriptItem => ({ type: "end", id: id(), session, turnId: "t1", ok, text: t });

const sv = (sid: string, over: Partial<SessionView> = {}): SessionView => ({
  id: sid,
  title: sid,
  status: "idle",
  parent: L,
  depth: 1,
  role: null,
  engine: "fake",
  model: null,
  effort: null,
  pair: null,
  turns: 1,
  isolation: "worktree",
  cwd: "/x",
  branch: `trb/${sid}`,
  changes: null,
  merged: false,
  cost_usd: null,
  tokens: { input: 0, output: 0, cache_read: 0 },
  ...over,
});

describe("deriveChat: what the chat shows and hides", () => {
  test("user and assistant text stay; turn dividers, notes and successful end markers go", () => {
    const chat = deriveChat([user("hi"), turn(), note("session started"), text("hello"), end(true, "done")], L);
    expect(chat.map((c) => c.kind)).toEqual(["user", "text"]);
  });

  test("a run of tool calls collapses into ONE line with the summary, even across hidden items", () => {
    const chat = deriveChat([tool("Read", "a.ts"), note("x"), tool("Read", "b.ts"), tool("Bash", "ls"), text("done")], L);
    expect(chat.map((c) => c.kind)).toEqual(["tools", "text"]);
    const t = chat[0];
    if (t.kind !== "tools") throw new Error("expected tools");
    expect(t.tools).toHaveLength(3);
    expect(t.summary).toBe("Read 2 files, ran a command");
    expect(t.running).toBe(false);
    expect(t.verb).toBeNull();
  });

  test("text between tools starts a new run", () => {
    const chat = deriveChat([tool("Read", "a"), text("looking"), tool("Bash", "ls")], L);
    expect(chat.map((c) => c.kind)).toEqual(["tools", "text", "tools"]);
  });

  test("a running tool gives the run a verb, and tests are called out", () => {
    const chat = deriveChat([tool("Read", "a"), tool("Bash", "bun test tests/", "running")], L);
    const t = chat[0];
    if (t.kind !== "tools") throw new Error("expected tools");
    expect(t.running).toBe(true);
    expect(t.verb).toBe("Running tests…");
    expect(toolVerb({ name: "Bash", arg: "ls -la" })).toBe("Running a command…");
    expect(toolVerb({ name: "Edit", arg: "x" })).toBe("Editing files…");
    expect(toolVerb({ name: "mcp__trb__subagent_create", arg: "" })).toBe("Delegating…");
  });

  test("only active thinking shows", () => {
    expect(deriveChat([thinking(true)], L).map((c) => c.kind)).toEqual(["thinking"]);
    expect(deriveChat([thinking(false), text("a")], L).map((c) => c.kind)).toEqual(["text"]);
  });

  test("failures are kept, with the daemon's text", () => {
    const chat = deriveChat([user("go"), end(false, "engine exited 1")], L);
    expect(chat[1]).toMatchObject({ kind: "failure", text: "engine exited 1" });
  });

  test("nothing leaks cost or duration: no chat item carries a number of tokens or dollars", () => {
    const chat = deriveChat([user("a"), tool("Bash", "ls"), text("b"), end(true, "done")], L);
    expect(JSON.stringify(chat)).not.toMatch(/cost|tokens|\$\d/);
  });
});

describe("deriveChat: head cards", () => {
  const items = (): TranscriptItem[] => [
    user("do it"),
    text("Spawning heads."),
    tool("mcp__trb__subagent_create", "scout", "ok"),
    turn(H1),
    user("brief", H1),
    tool("Read", "src/auth.ts", "ok", H1),
    tool("Grep", "login", "running", H1),
    tool("Read", "x", "ok", H2),
    text("Mapped auth: one module.\nMore detail.", H2),
    end(true, "done", H2),
    text("Heads running.", L),
  ];

  test("each head becomes ONE card where it first appeared; its tools and text are folded away", () => {
    const chat = deriveChat(items(), L);
    expect(chat.map((c) => c.kind)).toEqual(["user", "text", "tools", "head", "head", "text"]);
    expect(chat.filter((c) => c.kind === "head").map((c) => (c.kind === "head" ? c.session : ""))).toEqual([H1, H2]);
  });

  test("a working head shows its live activity, a finished one its one-line result", () => {
    const [h1, h2] = deriveChat(items(), L).filter((c): c is Extract<ReturnType<typeof deriveChat>[number], { kind: "head" }> => c.kind === "head");
    expect(h1.activity).toMatchObject({ running: true });
    expect(h1.activity?.label).toContain("Grep");
    expect(h2.result).toBe("Mapped auth: one module.");
    expect(headLine(sv(H1, { status: "running" }), h1)).toContain("Grep");
    expect(headLine(sv(H2, { status: "idle" }), h2)).toBe("Mapped auth: one module.");
    expect(headLine(sv(H2, { status: "idle", title: "Scout auth" }), { activity: null, result: null })).toBe("Scout auth");
  });

  test("a head's failure line does not become a chat failure of the lead", () => {
    const chat = deriveChat([text("x"), end(false, "boom", H1)], L);
    expect(chat.map((c) => c.kind)).toEqual(["text", "head"]);
  });

  test("without a focus session everything is the main voice", () => {
    expect(deriveChat([text("a", H1), text("b", L)], undefined).map((c) => c.kind)).toEqual(["text", "text"]);
  });

  test("diff stat appears only when files changed", () => {
    expect(diffStat(sv("a"))).toBeNull();
    expect(diffStat(sv("a", { changes: { files: 0, insertions: 0, deletions: 0 } }))).toBeNull();
    expect(diffStat(sv("a", { changes: { files: 2, insertions: 10, deletions: 3 } }))).toEqual({ files: 2, plus: 10, minus: 3 });
  });
});

describe("hasLiveTail", () => {
  test("text, thinking and a running tool are live; a finished tool run or empty thread is not", () => {
    expect(hasLiveTail([])).toBe(false);
    expect(hasLiveTail(deriveChat([text("a")], L))).toBe(true);
    expect(hasLiveTail(deriveChat([thinking(true)], L))).toBe(true);
    expect(hasLiveTail(deriveChat([tool("Read", "a", "running")], L))).toBe(true);
    expect(hasLiveTail(deriveChat([tool("Read", "a", "ok")], L))).toBe(false);
    expect(hasLiveTail(deriveChat([user("hi")], L))).toBe(false);
  });
});

describe("shelfFor", () => {
  test("no pair and no heads: no shelf", () => {
    expect(shelfFor(sv(L), [])).toBeNull();
    expect(shelfFor(null, [sv(H1)])).toBeNull();
  });

  test("a pair alone shows the lead", () => {
    const s = shelfFor(sv(L, { pair: "p_1", engine: "claude", status: "running" }), []);
    expect(s?.lead).toEqual({ engine: "claude", status: "running" });
    expect(s?.heads).toEqual([]);
  });

  test("heads become chips: role or engine label, state from status, closed ones omitted", () => {
    const s = shelfFor(sv(L), [sv(H1, { role: "scout", status: "running" }), sv(H2, { engine: "codex", status: "failed" }), sv("s_h3", { status: "idle", role: "worker" }), sv("s_h4", { status: "closed" })]);
    expect(s?.heads.map((h) => [h.label, h.state])).toEqual([
      ["scout", "running"],
      ["codex", "failed"],
      ["worker", "done"],
    ]);
  });
});

describe("settingsSummary", () => {
  const base = { effort: "", pairTitle: null, agentTitle: null, skillsLabel: "all enabled", worktree: false };
  test("defaults carry no dot", () => {
    expect(settingsSummary(base)).toEqual({ count: 0, items: [] });
  });
  test("each non-default setting counts and is named for the tooltip", () => {
    const s = settingsSummary({ effort: "high", pairTitle: "Fake Hydra", agentTitle: "Reviewer", skillsLabel: "3 of 7", worktree: true });
    expect(s.count).toBe(5);
    expect(s.items).toEqual(["effort high", "pair Fake Hydra", "agent Reviewer", "skills 3 of 7", "isolated worktree"]);
  });
  test("one change is a count of one", () => {
    expect(settingsSummary({ ...base, worktree: true }).count).toBe(1);
  });
});

describe("Chat | Trace persistence", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  test("starts in chat", () => {
    expect(loadDefaultViewMode(mem())).toBe("chat");
    expect(loadViewMode("s_1", mem())).toBe("chat");
  });

  test("a choice sticks to its session and becomes the default for new ones", () => {
    const s = mem();
    saveViewMode("s_1", "trace", s);
    expect(loadViewMode("s_1", s)).toBe("trace");
    expect(loadViewMode("s_new", s)).toBe("trace");
    saveViewMode("s_2", "chat", s);
    expect(loadViewMode("s_1", s)).toBe("trace"); // s_1 keeps its own
    expect(loadViewMode("s_3", s)).toBe("chat"); // last choice is the default
  });

  test("no storage, a throwing storage or junk values fall back to chat", () => {
    expect(loadViewMode("s_1", null)).toBe("chat");
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadViewMode("s_1", bad)).toBe("chat");
    expect(() => saveViewMode("s_1", "trace", bad)).not.toThrow();
    const junk = { getItem: () => "sideways", setItem: () => {} };
    expect(loadViewMode("s_1", junk)).toBe("chat");
  });

  test("toggle flips", () => {
    expect(otherMode("chat")).toBe("trace");
    expect(otherMode("trace")).toBe("chat");
  });
});

describe("terminalResume: only when idle", () => {
  test("idle with turns is the one enabled case", () => {
    expect(terminalResume({ status: "idle", turns: 2 })).toEqual({ enabled: true, reason: null });
  });
  test("a running turn is refused with the two-writers reason", () => {
    const r = terminalResume({ status: "running", turns: 1 });
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/two writers/);
  });
  test("nothing to resume, failed and closed are refused too", () => {
    expect(terminalResume({ status: "idle", turns: 0 }).enabled).toBe(false);
    expect(terminalResume({ status: "failed", turns: 1 }).enabled).toBe(false);
    expect(terminalResume({ status: "closed", turns: 1 }).enabled).toBe(false);
  });
});

describe("attached context in a user message", () => {
  test("the thread shows only what was typed; the attached text folds away", () => {
    const block = "# Attached context\n\n## File `a.md`\n\n```\nx\n\n---\n\ny\n```";
    const sent = `<!-- trb:context -->\n${block}\n\n<!-- /trb:context -->\n\n---\n\nexplain this`;
    expect(splitContext(sent)).toEqual({ text: "explain this", context: block });
  });
  test("a plain prompt, or a prompt that only mentions the tag, comes back unchanged", () => {
    expect(splitContext("hello")).toEqual({ text: "hello", context: null });
    expect(splitContext("see <!-- trb:context --> docs")).toEqual({ text: "see <!-- trb:context --> docs", context: null });
  });
});
