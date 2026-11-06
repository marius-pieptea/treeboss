import { describe, expect, test } from "bun:test";
import { applyMention, findMentionToken, formatElapsed, headsSummary, leadProblem, pairDefaults, parseDbTime, parseSlash, slashSuggestions, turnDurationSec } from "../../web/src/features/agent/composer-logic";
import { BOTTOM_THRESHOLD, isNearBottom, nextStick, showJumpPill } from "../../web/src/features/agent/scroll-logic";
import { segment } from "../../web/src/features/agent/Transcript";
import { groupTools, type TranscriptItem } from "../../web/src/lib/transcript";
import type { EngineInfo, Pair } from "../../web/src/lib/types";

describe("slash commands", () => {
  test("known commands parse, with their argument", () => {
    expect(parseSlash("/new")).toEqual({ name: "new", arg: "" });
    expect(parseSlash("  /pair Opus leads Sonnet ")).toEqual({ name: "pair", arg: "Opus leads Sonnet" });
    expect(parseSlash("/MODEL claude-haiku-5-5")).toEqual({ name: "model", arg: "claude-haiku-5-5" });
    expect(parseSlash("/interrupt")).toEqual({ name: "interrupt", arg: "" });
  });

  test("anything that is not exactly a known command is an ordinary prompt", () => {
    expect(parseSlash("/etc/hosts is wrong, fix it")).toBeNull();
    expect(parseSlash("/unknown thing")).toBeNull();
    expect(parseSlash("/new\nand more")).toBeNull();
    expect(parseSlash("explain /new")).toBeNull();
    expect(parseSlash("/pair")).toBeNull(); // needs an argument
  });

  test("suggestions appear only while typing the command word", () => {
    expect(slashSuggestions("/").map((c) => c.name)).toContain("pair");
    expect(slashSuggestions("/mo").map((c) => c.name)).toEqual(["model"]);
    expect(slashSuggestions("/model x")).toEqual([]);
    expect(slashSuggestions("hello /")).toEqual([]);
  });
});

describe("@-mentions", () => {
  test("a token is found at the start, after whitespace and after a newline", () => {
    expect(findMentionToken("@src/ut", 7)).toEqual({ start: 0, query: "src/ut" });
    expect(findMentionToken("look at @gre", 12)).toEqual({ start: 8, query: "gre" });
    expect(findMentionToken("line one\n@ab", 12)).toEqual({ start: 9, query: "ab" });
    expect(findMentionToken("@", 1)).toEqual({ start: 0, query: "" });
  });

  test("emails and finished mentions are not tokens", () => {
    expect(findMentionToken("mail me@example.com", 19)).toBeNull();
    expect(findMentionToken("@a.ts and", 9)).toBeNull();
    expect(findMentionToken("no mention", 10)).toBeNull();
  });

  test("the caret decides which mention is live", () => {
    expect(findMentionToken("@one @two", 4)).toEqual({ start: 0, query: "one" });
    expect(findMentionToken("@one @two", 9)).toEqual({ start: 5, query: "two" });
  });

  test("applying a mention replaces the token, keeps the rest, and puts the caret after it", () => {
    const text = "check @gre and then more";
    const token = findMentionToken(text, 10)!;
    const r = applyMention(text, token, "src/greet.ts", 10);
    expect(r.text).toBe("check src/greet.ts and then more");
    expect(r.text.slice(r.caret)).toBe(" and then more");
    // At the end of the input a trailing space is added so typing can continue.
    const end = findMentionToken("see @gr", 7)!;
    expect(applyMention("see @gr", end, "a.ts", 7)).toEqual({ text: "see a.ts ", caret: 9 });
  });

  test("paths with spaces are quoted", () => {
    const token = findMentionToken("@my", 3)!;
    expect(applyMention("@my", token, "my docs/a b.md", 3).text).toBe("`my docs/a b.md` ");
  });
});

describe("pairs and pickers", () => {
  const pair = (over: Partial<Pair> = {}): Pair => ({ id: "p1", title: "T", mode: "heads", lead_engine: "claude", lead_model: "claude-opus-5-5", lead_effort: "high", heads_engine: "codex", heads_model: null, heads_effort: "medium", roles: null, max_heads: 4, ...over });

  test("a pair's lead decides engine, model and effort", () => {
    expect(pairDefaults(pair())).toEqual({ engine: "claude", model: "claude-opus-5-5", effort: "high" });
    expect(pairDefaults(pair({ lead_model: null, lead_effort: null }))).toEqual({ engine: "claude", model: "", effort: "" });
    expect(pairDefaults(null)).toBeNull();
  });

  test("the heads summary reads for both modes", () => {
    expect(headsSummary(pair())).toBe("codex @medium");
    expect(headsSummary(pair({ mode: "roles", heads_engine: null, roles: { scout: { engine: "claude", model: "claude-haiku-5-5" }, worker: { engine: "codex", model: "default" } } }))).toBe("scout: claude claude-haiku-5-5 · worker: codex");
  });

  const engines: EngineInfo[] = [
    { id: "claude", label: "Claude Code", installed: true, bin: "/x", mcp: "config-file", skills_dir: null, resume: true },
    { id: "opencode", label: "OpenCode", installed: true, bin: "/x", mcp: "none", skills_dir: null, resume: true },
    { id: "grok", label: "Grok", installed: false, bin: null, mcp: "none", skills_dir: null, resume: true },
  ];
  test("an engine that cannot lead a pair, or is not installed, is refused up front", () => {
    expect(leadProblem(engines, "claude", true)).toBeNull();
    expect(leadProblem(engines, "opencode", false)).toBeNull();
    expect(leadProblem(engines, "opencode", true)).toMatch(/cannot lead a Hydra pair/);
    expect(leadProblem(engines, "grok", false)).toMatch(/not installed/);
    expect(leadProblem(engines, "nope", false)).toMatch(/Unknown engine/);
    expect(leadProblem(undefined, "claude", true)).toBeNull(); // engines still loading: do not block
  });
});

describe("live strip formatting", () => {
  test("elapsed time", () => {
    expect(formatElapsed(4.9)).toBe("4s");
    expect(formatElapsed(65)).toBe("1m 05s");
    expect(formatElapsed(3600 + 125)).toBe("1h 02m");
    expect(formatElapsed(-3)).toBe("0s");
  });
  test("database timestamps are UTC", () => {
    expect(parseDbTime("2026-10-08 07:54:29")).toBe(Date.UTC(2026, 9, 8, 7, 54, 29));
    expect(parseDbTime("2026-10-08T07:54:29.000Z")).toBe(Date.UTC(2026, 9, 8, 7, 54, 29));
    expect(parseDbTime(null)).toBeNull();
    expect(turnDurationSec("2026-10-08 07:54:29", "2026-10-08 07:54:41")).toBe(12);
    expect(turnDurationSec("2026-10-08 07:54:29", null)).toBeNull();
  });
});

describe("stick to bottom", () => {
  test("near-bottom within the threshold", () => {
    expect(isNearBottom(900, 100, 1000)).toBe(true);
    expect(isNearBottom(900 - BOTTOM_THRESHOLD, 100, 1000)).toBe(true);
    expect(isNearBottom(500, 100, 1000)).toBe(false);
  });
  test("a user scroll away releases the follow; scrolling back re-engages it; our own scrolls never change it", () => {
    expect(nextStick(true, { scrollTop: 200, clientHeight: 100, scrollHeight: 1000, programmatic: false })).toBe(false);
    expect(nextStick(false, { scrollTop: 900, clientHeight: 100, scrollHeight: 1000, programmatic: false })).toBe(true);
    expect(nextStick(true, { scrollTop: 200, clientHeight: 100, scrollHeight: 1000, programmatic: true })).toBe(true);
    expect(nextStick(false, { scrollTop: 900, clientHeight: 100, scrollHeight: 1000, programmatic: true })).toBe(false);
  });
  test("the jump pill needs both: scrolled away and something new", () => {
    expect(showJumpPill(false, 3)).toBe(true);
    expect(showJumpPill(false, 0)).toBe(false);
    expect(showJumpPill(true, 3)).toBe(false);
  });
});

describe("subagent rails", () => {
  const t = (session: string, id: string): TranscriptItem => ({ type: "text", id, session, turnId: null, text: id });
  test("a head's burst becomes one rail; the lead's own lines stay main; head prompts and turn dividers are dropped", () => {
    const items: TranscriptItem[] = [
      t("lead", "a"),
      t("head1", "b"),
      { type: "turn", id: "x", session: "head1", turnId: "t", n: 1 },
      t("head1", "c"),
      t("head2", "d"),
      t("lead", "e"),
    ];
    const segs = segment(groupTools(items), "lead");
    expect(segs.map((s) => (s.kind === "main" ? `main:${s.item.id}` : `sub:${s.session}:${s.items.map((i) => i.id).join("")}`))).toEqual(["main:a", "sub:head1:bc", "sub:head2:d", "main:e"]);
  });
  test("with no focus session everything is main", () => {
    expect(segment(groupTools([t("a", "1"), t("b", "2")]), undefined).every((s) => s.kind === "main")).toBe(true);
  });
});

import { groupSessions, headCounts, matchesQuery } from "../../web/src/features/sessions/sessions-logic";
import type { SessionView } from "../../web/src/lib/types";

const sv = (over: Partial<SessionView>): SessionView => ({ id: "s_x", title: "t", status: "idle", parent: null, depth: 0, role: null, engine: "claude", model: null, effort: null, pair: null, turns: 1, isolation: "none", cwd: "/", branch: null, changes: null, merged: false, cost_usd: null, tokens: { input: 0, output: 0, cache_read: 0 }, ...over });

describe("sessions list", () => {
  const all = [
    sv({ id: "s_run", title: "Refactor billing", status: "running" }),
    sv({ id: "s_idle", title: "Add pagination", status: "idle", pair: "p1" }),
    sv({ id: "s_fail", title: "Fix flaky test", status: "failed" }),
    sv({ id: "s_closed", title: "Old thing", status: "closed" }),
    sv({ id: "s_h1", title: "head one", status: "running", depth: 1, parent: "s_run", role: "worker" }),
    sv({ id: "s_h2", title: "head two", status: "idle", depth: 1, parent: "s_run", role: "scout" }),
    sv({ id: "s_gh", title: "grandhead", status: "running", depth: 2, parent: "s_h1" }),
    sv({ id: "s_hc", title: "closed head", status: "closed", depth: 1, parent: "s_run" }),
  ];
  test("running, recent and closed groups of leads only; empty groups are dropped", () => {
    const g = groupSessions(all, "");
    expect(g.map((x) => `${x.key}:${x.items.map((i) => i.id).join(",")}`)).toEqual(["running:s_run", "recent:s_idle,s_fail", "closed:s_closed"]);
    expect(groupSessions(all.filter((s) => s.status === "idle"), "").map((x) => x.key)).toEqual(["recent"]);
  });
  test("the filter looks at title, engine, model, pair, id and branch", () => {
    expect(groupSessions(all, "billing").flatMap((g) => g.items.map((i) => i.id))).toEqual(["s_run"]);
    expect(matchesQuery(sv({ pair: "p1" }), "P1")).toBe(true);
    expect(matchesQuery(sv({ branch: "trb/worker/ab" }), "worker")).toBe(true);
    expect(matchesQuery(sv({}), "zzz")).toBe(false);
  });
  test("pinned leads lead the list, once each, whichever group they would sit in", () => {
    const pins = [sv({ id: "s_fail", title: "Fix flaky test", status: "failed", pinned: true }), sv({ id: "s_closed", title: "Old thing", status: "closed", pinned: true })];
    const g = groupSessions(all, "", pins);
    expect(g.map((x) => `${x.key}:${x.items.map((i) => i.id).join(",")}`)).toEqual(["pinned:s_fail,s_closed", "running:s_run", "recent:s_idle"]);
  });
  test("a pinned lead from another workspace is listed even though the workspace list does not hold it", () => {
    const g = groupSessions([], "billing", [sv({ id: "s_elsewhere", title: "Billing elsewhere", pinned: true })]);
    expect(g.map((x) => `${x.key}:${x.items.map((i) => i.id).join(",")}`)).toEqual(["pinned:s_elsewhere"]);
  });
  test("head counts include nested heads, skip closed ones, and say how many are working", () => {
    expect(headCounts(all)).toEqual({ s_run: { total: 3, running: 2 } });
  });
});
