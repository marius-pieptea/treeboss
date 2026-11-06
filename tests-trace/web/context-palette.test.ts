import { describe, expect, test } from "bun:test";
import { addChip, MAX_CHIPS, matchKeywords, removeMention, toPayload, urlFromQuery, viewChip, type ContextChip } from "../../web/src/features/context/logic";
import { daysAgo, groupBySession, searchUrl, splitSnippet, type TranscriptHit } from "../../web/src/features/transcripts/logic";

let n = 0;
const id = () => `c${++n}`;

describe("context chips", () => {
  test("keywords match by prefix, and a typed URL is not a keyword", () => {
    expect(matchKeywords("").map((k) => k.name)).toEqual(["view", "url", "terminal", "browser"]);
    expect(matchKeywords("te").map((k) => k.name)).toEqual(["terminal"]);
    expect(matchKeywords("https://x.dev")).toEqual([]);
    expect(matchKeywords("zzz")).toEqual([]);
  });

  test("urlFromQuery wants a complete http(s) URL", () => {
    expect(urlFromQuery("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(urlFromQuery("https://")).toBeNull();
    expect(urlFromQuery("ftp://example.com")).toBeNull();
    expect(urlFromQuery("example.com")).toBeNull();
  });

  test("duplicates are ignored and the list is capped", () => {
    let list: ContextChip[] = [];
    const first = addChip(list, { kind: "file", value: "a.ts", label: "a.ts" }, id);
    list = first.list;
    expect(first.added).toBe(true);
    expect(addChip(list, { kind: "file", value: "a.ts", label: "a.ts" }, id)).toMatchObject({ added: false, reason: "duplicate" });
    expect(addChip(list, { kind: "commit", value: "a.ts", label: "x" }, id).added).toBe(true); // same value, other kind
    for (let i = 0; i < MAX_CHIPS; i++) list = addChip(list, { kind: "url", value: `https://e.com/${i}`, label: "e" }, id).list;
    expect(list.length).toBe(MAX_CHIPS);
    expect(addChip(list, { kind: "url", value: "https://e.com/new", label: "e" }, id)).toMatchObject({ added: false, reason: "full" });
  });

  test("choosing a row removes the @query and tidies the space", () => {
    expect(removeMention("fix @parse now", { start: 4, query: "parse" }, 10)).toEqual({ text: "fix now", caret: 4 });
    expect(removeMention("@parse", { start: 0, query: "parse" }, 6)).toEqual({ text: "", caret: 0 });
    expect(removeMention("look at @x", { start: 8, query: "x" }, 10)).toEqual({ text: "look at ", caret: 8 });
  });

  test("the payload carries kind, value and label only", () => {
    expect(toPayload([{ id: "c1", kind: "symbol", value: "a.ts:1-5", label: "go", detail: "ignored" }])).toEqual([{ kind: "symbol", value: "a.ts:1-5", label: "go" }]);
  });
});

describe("past sessions", () => {
  test("snippet markers become highlighted segments", () => {
    expect(splitSnippet("fix the \u0001login\u0002 bug")).toEqual([
      { text: "fix the ", hit: false },
      { text: "login", hit: true },
      { text: " bug", hit: false },
    ]);
    expect(splitSnippet("plain")).toEqual([{ text: "plain", hit: false }]);
  });

  test("the search URL carries only the filters that are set", () => {
    expect(searchUrl("a b", { workspace: "", engine: "codex", since: "2026-10-01", until: "" })).toBe("/api/search/sessions?q=a+b&engine=codex&since=2026-10-01");
  });

  test("daysAgo is a UTC date", () => {
    expect(daysAgo(7, new Date("2026-10-08T12:00:00Z"))).toBe("2026-10-01");
  });

  test("hits group by session in first-seen order", () => {
    const h = (session_id: string, seq: number) => ({ session_id, seq, title: session_id, engine: "claude", base_cwd: "/x", role: "user", snippet: "", started_at: "", root_id: session_id, depth: 0 }) as TranscriptHit;
    const g = groupBySession([h("b", 1), h("a", 2), h("b", 3)]);
    expect(g.map((x) => [x.session_id, x.hits.map((y) => y.seq)])).toEqual([["b", [1, 3]], ["a", [2]]]);
  });
});

describe("view chips", () => {
  const tab = (t: object) => ({ id: "x", title: "T", ...t }) as any;
  test("what is open becomes the chip the daemon resolves", () => {
    expect(viewChip(tab({ kind: "file", root: "w_1", path: "src/a.ts", title: "a.ts" }), "w_1")).toMatchObject({ kind: "file", value: "src/a.ts" });
    expect(viewChip(tab({ kind: "diff", root: "w_1", path: "a.ts", staged: true }), "w_1")).toMatchObject({ kind: "diff", value: "staged:a.ts" });
    expect(viewChip(tab({ kind: "diff", root: "w_1", path: "a.ts", commit: "abc123" }), "w_1")).toMatchObject({ value: "commit:abc123:a.ts" });
    expect(viewChip(tab({ kind: "browser", url: "http://localhost:3000/" }), "w_1")).toMatchObject({ kind: "browser", value: "http://localhost:3000/" });
    expect(viewChip(tab({ kind: "roadmap" }), "w_1")).toMatchObject({ kind: "roadmap" });
  });
  test("nothing to attach for settings or no tab, and a tab from another root is skipped", () => {
    expect(viewChip(undefined, "w_1")).toBeNull();
    expect(viewChip(tab({ kind: "settings", page: "agents" }), "w_1")).toBeNull();
    expect(viewChip(tab({ kind: "file", root: "w_2", path: "a.ts" }), "w_1")).toBeNull();
  });
});
