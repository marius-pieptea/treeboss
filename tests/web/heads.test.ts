import { describe, expect, test } from "bun:test";
import { activityBySession, buildTree, countHeads, durationSec, engineLabel, flatten, formatElapsed, hasUnmergedWork, isMergeReady, pairRoles, shortToolName, totals } from "../../web/src/features/heads/model";
import { hashString, roleTone, toneClasses } from "../../web/src/features/heads/roles";
import { appendLine, emptyTranscript } from "../../web/src/lib/transcript";
import { classifyLine } from "../../src/engines/classify";
import type { LogLine, SessionView } from "../../web/src/lib/types";

const head = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  title: id,
  status: "idle",
  parent: "s_root",
  depth: 1,
  role: null,
  engine: "claude",
  model: null,
  effort: null,
  pair: null,
  turns: 1,
  isolation: "worktree",
  cwd: "/x",
  branch: `trb/x/${id}`,
  changes: null,
  merged: false,
  cost_usd: null,
  tokens: { input: 0, output: 0, cache_read: 0 },
  ...over,
});

describe("role colours", () => {
  test("pinned roles keep their colour; the same role always gets the same one", () => {
    expect(roleTone("scout")).toBe("blue");
    expect(roleTone("Reviewer")).toBe("amber");
    expect(roleTone("  worker ")).toBe("accent");
    expect(roleTone("my-custom-role")).toBe(roleTone("my-custom-role"));
  });
  test("no role is neutral; custom roles land in the palette, never neutral", () => {
    expect(roleTone(null)).toBe("neutral");
    expect(roleTone(undefined)).toBe("neutral");
    for (const r of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"]) {
      expect(roleTone(r)).not.toBe("neutral");
      expect(toneClasses[roleTone(r)].text).toMatch(/^text-/);
    }
  });
  test("the hash is stable (a fixed value) and spreads custom names over more than one colour", () => {
    expect(hashString("worker")).toBe(hashString("worker"));
    expect(hashString("a")).not.toBe(hashString("b"));
    const tones = new Set(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].map(roleTone));
    expect(tones.size).toBeGreaterThan(2);
  });
});

describe("tree", () => {
  test("flat children become a tree by parent, keeping sibling order", () => {
    const flat = [head("a"), head("b"), head("a1", { parent: "a", depth: 2 }), head("a2", { parent: "a", depth: 2 }), head("a1x", { parent: "a1", depth: 3 })];
    const t = buildTree("s_root", flat);
    expect(t.map((n) => n.head.id)).toEqual(["a", "b"]);
    expect(t[0].children.map((n) => n.head.id)).toEqual(["a1", "a2"]);
    expect(t[0].children[0].children[0]).toMatchObject({ level: 2 });
    expect(flatten(t).map((h) => h.id)).toEqual(["a", "a1", "a1x", "a2", "b"]);
  });
  test("closed heads are hidden unless asked for, and their orphans move up to the root", () => {
    const flat = [head("a", { status: "closed" }), head("a1", { parent: "a", depth: 2 })];
    expect(buildTree("s_root", flat).map((n) => n.head.id)).toEqual(["a1"]);
    expect(buildTree("s_root", flat, { includeClosed: true }).map((n) => n.head.id)).toEqual(["a"]);
  });
  test("a cycle in bad data cannot loop forever", () => {
    const flat = [head("a", { parent: "b" }), head("b", { parent: "a" })];
    expect(() => buildTree("s_root", flat)).not.toThrow();
  });
});

describe("merge readiness", () => {
  const changed = { files: 2, insertions: 5, deletions: 1 };
  test("idle + worktree + changes + not merged", () => {
    expect(isMergeReady(head("a", { changes: changed }))).toBe(true);
    expect(isMergeReady(head("a", { changes: changed, status: "running" }))).toBe(false);
    expect(isMergeReady(head("a", { changes: changed, status: "failed" }))).toBe(false);
    expect(isMergeReady(head("a", { changes: changed, merged: true }))).toBe(false);
    expect(isMergeReady(head("a", { changes: null }))).toBe(false);
    expect(isMergeReady(head("a", { changes: { files: 0, insertions: 0, deletions: 0 } }))).toBe(false);
    expect(isMergeReady(head("a", { changes: changed, isolation: "none" }))).toBe(false); // shared workspace: nothing to merge
  });
  test("unmerged work is what closing must warn about, regardless of status", () => {
    expect(hasUnmergedWork(head("a", { changes: changed, status: "failed" }))).toBe(true);
    expect(hasUnmergedWork(head("a", { changes: changed, merged: true }))).toBe(false);
    expect(hasUnmergedWork(head("a"))).toBe(false);
  });
  test("counts", () => {
    const heads = [head("a", { status: "running" }), head("b", { changes: changed }), head("c", { status: "failed" }), head("d", { merged: true, changes: changed })];
    expect(countHeads(heads)).toEqual({ total: 4, working: 1, idle: 2, failed: 1, ready: 1, merged: 1 });
  });
  test("totals sum cost and both token sides, treating null cost as zero", () => {
    expect(totals([head("a", { cost_usd: 0.5, tokens: { input: 10, output: 5, cache_read: 100 } }), head("b", { tokens: { input: 1, output: 2, cache_read: 0 } })])).toEqual({ cost: 0.5, input: 111, output: 7 });
  });
});

describe("formatting", () => {
  test("elapsed", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59.9)).toBe("59s");
    expect(formatElapsed(65)).toBe("1m 05s");
    expect(formatElapsed(3725)).toBe("1h 02m");
    expect(formatElapsed(-5)).toBe("0s");
  });
  test("duration between sqlite and iso timestamps", () => {
    expect(durationSec("2026-10-08 10:00:00", "2026-10-08 10:00:42")).toBe(42);
    expect(durationSec("2026-10-08T10:00:00Z", "2026-10-08 10:01:00")).toBe(60);
    expect(durationSec("2026-10-08 10:00:00", null)).toBeNull();
    expect(durationSec(null, null)).toBeNull();
  });
  test("engine label trims noise and shows effort", () => {
    expect(engineLabel({ engine: "claude", model: "claude-haiku-5-5", effort: "low" })).toBe("claude · haiku-5-5 @low");
    expect(engineLabel({ engine: "codex", model: null, effort: null })).toBe("codex");
  });
  test("tool names lose MCP prefixes", () => {
    expect(shortToolName("mcp__trb__subagent_create")).toBe("subagent create");
    expect(shortToolName("trb/subagent_list")).toBe("subagent list");
    expect(shortToolName("Bash")).toBe("Bash");
  });
});

describe("activity line", () => {
  let n = 0;
  const feed = (rows: Array<[string, string]>) =>
    rows.reduce((s, [session, text]) => {
      const data = classifyLine(text);
      const l: LogLine = { id: ++n, session, turn_id: "t", text, kind: data.kind, data };
      return appendLine(s, l);
    }, emptyTranscript());

  test("a running tool call is the activity, per session, and finishes into the next thing", () => {
    const s = feed([
      ["s_a", "[claude] → Bash(bun test)"],
      ["s_b", "[claude] → Read(src/x.ts)"],
      ["s_b", "[claude]   ✓ Read (1 B)"],
    ]);
    const a = activityBySession(s.items);
    expect(a.get("s_a")).toEqual({ kind: "tool", label: "Bash: bun test", running: true });
    expect(a.get("s_b")).toEqual({ kind: "tool", label: "Read: src/x.ts", running: false });
  });
  test("thinking, then text takes over; the end of a turn clears the line", () => {
    let s = feed([["s_a", "[claude] (thinking…)"]]);
    expect(activityBySession(s.items).get("s_a")).toMatchObject({ kind: "thinking", running: true });
    s = feed([["s_a", "[claude] (thinking…)"], ["s_a", "I am updating the greeting\nsecond line"]]);
    expect(activityBySession(s.items).get("s_a")).toEqual({ kind: "text", label: "I am updating the greeting", running: false });
    s = feed([["s_a", "all done"], ["s_a", "[claude] done after 1 turn(s)"]]);
    expect(activityBySession(s.items).has("s_a")).toBe(false);
  });
  test("long arguments are cut to one line", () => {
    const s = feed([["s_a", `[claude] → Bash(${"x".repeat(300)})`]]);
    const label = activityBySession(s.items).get("s_a")!.label;
    expect(label.length).toBeLessThanOrEqual(90);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("pair roles", () => {
  test("only a roles pair offers roles, with labels defaulting to the id", () => {
    expect(pairRoles(null)).toEqual([]);
    expect(pairRoles({ mode: "heads", roles: null })).toEqual([]);
    expect(pairRoles({ mode: "roles", roles: { scout: { engine: "claude", model: "m", label: "Scout" }, worker: { engine: "codex" } } })).toEqual([
      { id: "scout", label: "Scout", engine: "claude", model: "m", effort: null, agent: null },
      { id: "worker", label: "worker", engine: "codex", model: null, effort: null, agent: null },
    ]);
  });

  test("a role that names an agent carries it, so the spawn dialog can say so", () => {
    expect(pairRoles({ mode: "roles", roles: { reviewer: { engine: "claude", agent: "auditor" } } })[0].agent).toBe("auditor");
  });
});

describe("finished heads", () => {
  const changed = { files: 1, insertions: 1, deletions: 0 };
  test("only settled heads with nothing unmerged are safe to close in bulk", async () => {
    const { isFinished } = await import("../../web/src/features/heads/model");
    expect(isFinished(head("a"))).toBe(true);
    expect(isFinished(head("a", { status: "failed" }))).toBe(true);
    expect(isFinished(head("a", { status: "running" }))).toBe(false);
    expect(isFinished(head("a", { changes: changed }))).toBe(false); // unmerged work: keep it
    expect(isFinished(head("a", { changes: changed, merged: true }))).toBe(true);
  });
});

describe("diff file splitting", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " keep",
    "-old",
    "+new",
    "+extra",
    "diff --git a/src/new file.ts b/src/new file.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new file.ts",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/old.ts b/moved.ts",
    "similarity index 100%",
    "rename from old.ts",
    "rename to moved.ts",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "",
  ].join("\n");

  test("per-file status, counts and text; header lines like `--- a/x` are not counted as changes", async () => {
    const { splitDiff, summarize } = await import("../../web/src/features/session/diff-files");
    const files = splitDiff(diff);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["src/a.ts", "modified", 2, 1],
      ["src/new file.ts", "added", 1, 0],
      ["gone.ts", "deleted", 0, 1],
      ["moved.ts", "renamed", 0, 0],
      ["img.png", "binary", 0, 0],
    ]);
    expect(files[3].oldPath).toBe("old.ts");
    expect(files[0].text.startsWith("diff --git a/src/a.ts")).toBe(true);
    expect(files[0].text).not.toContain("new file.ts");
    expect(summarize(files)).toEqual({ files: 5, additions: 3, deletions: 2 });
  });
  test("an empty diff has no files", async () => {
    const { splitDiff } = await import("../../web/src/features/session/diff-files");
    expect(splitDiff("")).toEqual([]);
    expect(splitDiff("  \n")).toEqual([]);
  });
});

describe("conversation display", () => {
  const user = (id: string, text: string) => ({ type: "user" as const, id, session: "s_h", turnId: id, text });
  test("a head's first prompt is replaced by its brief; follow-ups lose their header", async () => {
    const { conversationItems, cleanPrompt } = await import("../../web/src/features/session/display");
    const items = [user("t1", "# Subagent brief\nlots of rules\n---\n\nadd tests"), { type: "text" as const, id: "x", session: "s_h", turnId: "t1", text: "done" }, user("t2", "# Follow-up from the parent session (s_a)\n\nalso lint it")];
    const out = conversationItems(items, { session: "s_h", brief: "add tests", depth: 1 });
    expect(out.filter((i) => i.type === "user").map((i: any) => i.text)).toEqual(["add tests", "also lint it"]);
    expect(cleanPrompt("# Subagent brief\nx\n\n# Your previous answer\nold\n\n# Follow-up from the operator\nfix it")).toBe("fix it");
    expect(cleanPrompt("plain message")).toBe("plain message");
  });
  test("the brief still leads when the turns list has not arrived yet; a lead's own prompts are untouched", async () => {
    const { conversationItems } = await import("../../web/src/features/session/display");
    const out = conversationItems([{ type: "text", id: "x", session: "s_h", turnId: null, text: "hi" }], { session: "s_h", brief: "the brief", depth: 1 });
    expect(out[0]).toMatchObject({ type: "user", text: "the brief" });
    const lead = conversationItems([user("t1", "do the thing")], { session: "s_h", brief: "do the thing", depth: 0 });
    expect(lead).toHaveLength(1);
  });
  test("only the session's own items are shown", async () => {
    const { conversationItems } = await import("../../web/src/features/session/display");
    const out = conversationItems([{ type: "text", id: "a", session: "other", turnId: null, text: "x" }], { session: "s_h", brief: null, depth: 1 });
    expect(out).toEqual([]);
  });
});
