import { describe, expect, test } from "bun:test";
import { detectLanguage, mediaKind, previewKind } from "../../web/src/features/editor/language";
import { detectIndent } from "../../web/src/features/editor/indent";
import { hunksToMarkers, wholeFileAdded } from "../../web/src/features/editor/hunks";
import { changedLineRange } from "../../web/src/features/editor/diffRange";
import { resolveRelative } from "../../web/src/features/editor/mdPaths";
import { LISTING_LIMIT, ROW_HEIGHT, ancestors, buildDecorations, decorationFor, flattenTree, isNoopMove, moveBlocked, moveTarget, parentOf, scrollToReveal, uniqueCopyName, validateName, visibleWindow, type Listing } from "../../web/src/features/explorer/tree";
import { buildMatcher, excerpt, findSpans, flattenResults, folderToGlob, groupMatches, normalizeInclude, regexError } from "../../web/src/features/search/logic";
import type { GitFile, TreeEntry } from "../../web/src/lib/types";

const file = (path: string, over: Partial<TreeEntry> = {}): TreeEntry => ({ name: path.split("/").pop()!, path, type: "file", size: 1, mtime: 1, ...over });
const dir = (path: string): TreeEntry => ({ ...file(path), type: "dir", size: 0 });

describe("language detection", () => {
  test("by extension, with the variants that matter", () => {
    expect(detectLanguage("src/a.ts").id).toBe("ts");
    expect(detectLanguage("src/App.tsx")).toEqual({ id: "tsx", label: "TypeScript React" });
    expect(detectLanguage("x.mjs").id).toBe("js");
    expect(detectLanguage("a/b/c.PY").id).toBe("python");
    expect(detectLanguage("README.md").id).toBe("markdown");
    expect(detectLanguage("logo.svg").id).toBe("xml");
  });
  test("by whole name, and dotfiles that look like they have no extension", () => {
    expect(detectLanguage("Dockerfile").id).toBe("dockerfile");
    expect(detectLanguage("docker/Dockerfile.dev").id).toBe("dockerfile");
    expect(detectLanguage(".env.local").id).toBe("properties");
    expect(detectLanguage(".gitignore").label).toBe("Ignore");
    expect(detectLanguage("package.json").id).toBe("json");
  });
  test("unknown is plain text, never an error", () => {
    expect(detectLanguage("weird.zzz").id).toBe("text");
    expect(detectLanguage("noextension").id).toBe("text");
  });
  test("media and preview kinds", () => {
    expect(mediaKind("a/b.PNG")).toBe("image");
    expect(mediaKind("clip.mp4")).toBe("video");
    expect(mediaKind("a.pdf")).toBe("pdf");
    expect(mediaKind("a.svg")).toBeNull(); // svg is text first
    expect(previewKind("a.svg")).toBe("svg");
    expect(previewKind("notes.md")).toBe("markdown");
    expect(previewKind("a.ts")).toBeNull();
  });
});

describe("indent detection", () => {
  test("two and four spaces, tabs, and an empty file", () => {
    expect(detectIndent("function f() {\n  if (x) {\n    y();\n  }\n}\n").unit).toBe("  ");
    expect(detectIndent("def f():\n    if x:\n        y()\n    z()\n").unit).toBe("    ");
    expect(detectIndent("a {\n\tb: 1;\n\tc: 2;\n}\n")).toEqual({ unit: "\t", label: "Tabs" });
    expect(detectIndent("")).toEqual({ unit: "  ", label: "Spaces: 2" });
    expect(detectIndent("no indentation\nat all\n").unit).toBe("  ");
  });
});

describe("hunks to gutter markers", () => {
  test("added, modified and deleted hunks (zero-context diff)", () => {
    const diff = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -0,0 +1,3 @@", "+a", "+b", "+c", "@@ -10 +13 @@", "-old", "+new", "@@ -20,2 +22,0 @@", "-x", "-y"].join("\n");
    expect(hunksToMarkers(diff)).toEqual([
      { from: 1, to: 3, kind: "add" },
      { from: 13, to: 13, kind: "mod" },
      { from: 22, to: 22, kind: "del" },
    ]);
  });
  test("a hunk that replaces 2 lines with 4 is two modified and two added", () => {
    expect(hunksToMarkers("@@ -5,2 +5,4 @@")).toEqual([
      { from: 5, to: 6, kind: "mod" },
      { from: 7, to: 8, kind: "add" },
    ]);
  });
  test("a hunk that replaces 4 lines with 2 is two modified plus a deletion marker", () => {
    expect(hunksToMarkers("@@ -5,4 +5,2 @@")).toEqual([
      { from: 5, to: 6, kind: "mod" },
      { from: 6, to: 6, kind: "del" },
    ]);
  });
  test("no diff, no markers; an untracked file is all added", () => {
    expect(hunksToMarkers("")).toEqual([]);
    expect(wholeFileAdded(4)).toEqual([{ from: 1, to: 4, kind: "add" }]);
    expect(wholeFileAdded(0)).toEqual([]);
  });
});

describe("changedLineRange", () => {
  test("the lines that differ, found by trimming the common ends", () => {
    expect(changedLineRange("a\nb\nc\nd", "a\nB\nC\nd")).toEqual({ from: 2, to: 3 });
    expect(changedLineRange("a\nb", "a\nb\nc")).toEqual({ from: 3, to: 3 });
    expect(changedLineRange("a\nb\nc", "a\nc")).toEqual({ from: 2, to: 2 }); // lines removed: point at the seam
    expect(changedLineRange("same", "same")).toBeNull();
  });
});

describe("markdown path resolution", () => {
  test("relative to the document, never leaving the workspace", () => {
    expect(resolveRelative("docs", "img/a.png")).toBe("docs/img/a.png");
    expect(resolveRelative("docs/guide", "../logo.png")).toBe("docs/logo.png");
    expect(resolveRelative("", "./a.png")).toBe("a.png");
    expect(resolveRelative("docs", "/assets/a.png")).toBe("assets/a.png");
    expect(resolveRelative("docs", "../../../etc/passwd")).toBeNull();
    expect(resolveRelative("docs", "a%20b.png")).toBe("docs/a b.png");
  });
  test("absolute URLs, data URIs and anchors are not ours to resolve", () => {
    for (const r of ["https://x.test/a.png", "http://x/a", "data:image/png;base64,AAAA", "//cdn.test/a.png", "#section", "mailto:a@b.c"]) expect(resolveRelative("docs", r)).toBeNull();
  });
});

describe("explorer: flattening", () => {
  const listings = (m: Record<string, Listing>) => new Map(Object.entries(m));
  const root: TreeEntry[] = [dir("src"), dir("empty"), file("README.md")];

  test("collapsed folders hide their children; expanded ones show them nested", () => {
    const l = listings({ "": root, src: [file("src/a.ts"), dir("src/lib")], empty: [] });
    expect(flattenTree(l, new Set(), null).map((r) => (r.kind === "entry" ? r.entry.path : r.kind))).toEqual(["src", "empty", "README.md"]);
    const rows = flattenTree(l, new Set(["src"]), null);
    expect(rows.map((r) => (r.kind === "entry" ? `${r.depth}:${r.entry.path}` : r.kind))).toEqual(["0:src", "1:src/a.ts", "1:src/lib", "0:empty", "0:README.md"]);
  });

  test("loading, errored and empty folders say so in place", () => {
    const rows = flattenTree(listings({ "": root, src: "loading", empty: [] }), new Set(["src", "empty"]), null);
    expect(rows.filter((r) => r.kind === "status").map((r) => (r as any).text)).toEqual(["Loading…", "Empty folder"]);
    expect(flattenTree(listings({ "": root, src: "error" }), new Set(["src"]), null).some((r) => r.kind === "status" && r.tone === "error")).toBe(true);
    expect(flattenTree(listings({ "": "loading" }), new Set(), null)).toMatchObject([{ kind: "status", text: "Loading…" }]);
  });

  test("an inline new-file row appears first in its folder, and keeps an empty folder visible", () => {
    const l = listings({ "": root, src: [file("src/a.ts")], empty: [] });
    const rows = flattenTree(l, new Set(["src", "empty"]), { mode: "file", parent: "src" });
    expect(rows[1]).toMatchObject({ kind: "input", depth: 1 });
    const inEmpty = flattenTree(l, new Set(["empty"]), { mode: "dir", parent: "empty" });
    expect(inEmpty.some((r) => r.kind === "input")).toBe(true);
    expect(inEmpty.some((r) => r.kind === "status" && r.text === "Empty folder")).toBe(false);
  });

  test("a rename replaces the row in place", () => {
    const l = listings({ "": root, src: [] });
    const rows = flattenTree(l, new Set(), { mode: "rename", parent: "", target: "README.md" });
    expect(rows.map((r) => r.kind)).toEqual(["entry", "entry", "input"]);
    expect((rows[2] as any).initial).toBe("README.md");
  });

  test("a folder listed to the daemon's cap says it is cut off", () => {
    const big = Array.from({ length: LISTING_LIMIT }, (_, i) => file(`f${i}`));
    const rows = flattenTree(new Map([["", big]]), new Set(), null);
    expect(rows.at(-1)).toMatchObject({ kind: "status", text: "Showing the first 5,000 entries" });
    expect(flattenTree(new Map([["", big.slice(1)]]), new Set(), null).some((r) => r.kind === "status")).toBe(false);
  });

  test("ancestors and parents", () => {
    expect(ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestors("c.ts")).toEqual([]);
    expect(parentOf("a/b/c.ts")).toBe("a/b");
    expect(parentOf("c.ts")).toBe("");
  });
});

describe("explorer: names", () => {
  const sib = ["Readme.md", "src"];
  test("accepts ordinary names and nested paths for new entries", () => {
    expect(validateName("index.ts", { siblings: sib })).toBeNull();
    expect(validateName("a/b/c.ts", { siblings: sib, allowPath: true })).toBeNull();
    expect(validateName(".env", { siblings: sib })).toBeNull();
  });
  test("refuses empty, separators, dot segments, .git, control characters, overlong names", () => {
    expect(validateName("  ", { siblings: sib })).toBe("A name is required");
    expect(validateName("a/b", { siblings: sib })).toBe("A name cannot contain /");
    expect(validateName("a//b", { siblings: sib, allowPath: true })).toBe("Empty path segment");
    expect(validateName("a/", { siblings: sib, allowPath: true })).toBe("Remove the trailing /");
    expect(validateName("/abs", { siblings: sib, allowPath: true })).toMatch(/relative/);
    expect(validateName("..", { siblings: sib })).toMatch(/not a valid name/);
    expect(validateName("a/../b", { siblings: sib, allowPath: true })).toMatch(/not a valid name/);
    expect(validateName(".GIT", { siblings: sib })).toMatch(/reserved/);
    expect(validateName("a\\b", { siblings: sib })).toMatch(/Backslash/);
    expect(validateName("a\u0001b", { siblings: sib })).toMatch(/Control/);
    expect(validateName("x".repeat(256), { siblings: sib })).toMatch(/255/);
  });
  test("name clashes are case-insensitive, except the entry being renamed", () => {
    expect(validateName("README.md", { siblings: sib })).toMatch(/already exists/);
    expect(validateName("SRC", { siblings: sib, allowPath: true })).toMatch(/already exists/);
    expect(validateName("README.md", { siblings: sib, current: "Readme.md" })).toBeNull(); // a case-only rename is allowed
    expect(validateName("src/new.ts", { siblings: sib, allowPath: true })).toMatch(/already exists/); // the first segment collides
  });
  test("copy names count up and keep the extension", () => {
    expect(uniqueCopyName("a.txt", ["a.txt"])).toBe("a copy.txt");
    expect(uniqueCopyName("a.txt", ["a.txt", "a copy.txt"])).toBe("a copy 2.txt");
    expect(uniqueCopyName("a.txt", ["A COPY.txt"])).toBe("a copy 2.txt");
    expect(uniqueCopyName(".env", [".env"])).toBe(".env copy");
    expect(uniqueCopyName("src", ["src"])).toBe("src copy");
  });
});

describe("explorer: moves", () => {
  test("a folder cannot go into itself or a descendant; a move to the same parent is a no-op", () => {
    expect(moveBlocked("a", "a")).toMatch(/itself/);
    expect(moveBlocked("a", "a/b")).toMatch(/itself/);
    expect(moveBlocked("a", "ab")).toBeNull(); // a sibling whose name merely starts the same
    expect(moveBlocked("a/x.ts", "b")).toBeNull();
    expect(isNoopMove("a/x.ts", "a")).toBe(true);
    expect(isNoopMove("x.ts", "")).toBe(true);
    expect(isNoopMove("a/x.ts", "")).toBe(false);
    expect(moveTarget("a/x.ts", "b/c")).toBe("b/c/x.ts");
    expect(moveTarget("a/x.ts", "")).toBe("x.ts");
  });
});

describe("explorer: git decorations", () => {
  const f = (path: string, index: string, worktree: string, extra: Partial<GitFile> = {}): GitFile => ({ path, index, worktree, ...extra });
  test("a letter and tone per kind of change", () => {
    expect(decorationFor(f("a", ".", "M"))).toMatchObject({ letter: "M", tone: "amber" });
    expect(decorationFor(f("a", "A", "."))).toMatchObject({ letter: "A", tone: "green" });
    expect(decorationFor(f("a", ".", "?"))).toMatchObject({ letter: "U", tone: "green" });
    expect(decorationFor(f("a", ".", "D"))).toMatchObject({ letter: "D", tone: "red" });
    expect(decorationFor(f("a", "R", "."))).toMatchObject({ letter: "R", tone: "blue" });
    expect(decorationFor(f("a", "U", "U", { conflict: "UU" }))).toMatchObject({ letter: "!", tone: "red" });
  });
  test("folders roll up the count and the loudest tone", () => {
    const d = buildDecorations([f("src/a.ts", ".", "?"), f("src/lib/b.ts", ".", "M"), f("src/lib/c.ts", "U", "U", { conflict: "AA" }), f("README.md", ".", "M")], "");
    expect(d.dirs.get("src")).toEqual({ count: 3, tone: "red" });
    expect(d.dirs.get("src/lib")).toEqual({ count: 2, tone: "red" });
    expect(d.files.get("README.md")?.letter).toBe("M");
    expect(d.dirs.has("README.md")).toBe(false);
  });
  test("a workspace inside a repo maps repo-relative paths and drops what is outside it", () => {
    const d = buildDecorations([f("app/src/a.ts", ".", "M"), f("other/b.ts", ".", "M")], "app/");
    expect([...d.files.keys()]).toEqual(["src/a.ts"]);
    expect(d.dirs.get("src")?.count).toBe(1);
  });
});

describe("explorer: windowing", () => {
  test("renders the visible band plus overscan, clamped to the list", () => {
    expect(visibleWindow(10_000, 0, 480, 5)).toEqual({ start: 0, end: 25 });
    expect(visibleWindow(10_000, ROW_HEIGHT * 100, 480, 5)).toEqual({ start: 95, end: 125 });
    expect(visibleWindow(10, 0, 480, 5)).toEqual({ start: 0, end: 10 });
  });
  test("reveal scrolls only when the row is out of view", () => {
    expect(scrollToReveal(2, 0, 240)).toBeNull();
    expect(scrollToReveal(50, 0, 240)).toBe(51 * ROW_HEIGHT - 240);
    expect(scrollToReveal(1, 480, 240)).toBe(ROW_HEIGHT);
  });
});

describe("search: patterns", () => {
  test("literal queries are escaped; regex and flags are honoured", () => {
    const lit = buildMatcher("a.b(", { regex: false, caseSensitive: false, wholeWord: false })!;
    expect(findSpans("xa.b(y a-b(", lit)).toEqual([[1, 5]]);
    const re = buildMatcher("fo+", { regex: true, caseSensitive: true, wholeWord: false })!;
    expect(findSpans("foo FOO fo", re)).toEqual([[0, 3], [8, 10]]);
    const word = buildMatcher("foo", { regex: false, caseSensitive: false, wholeWord: true })!;
    expect(findSpans("foo foobar Foo", word)).toEqual([[0, 3], [11, 14]]);
  });
  test("an invalid regex is reported, not thrown", () => {
    expect(buildMatcher("(", { regex: true, caseSensitive: false, wholeWord: false })).toBeNull();
    expect(regexError("(", { regex: true, caseSensitive: false, wholeWord: false })).toBeTruthy();
    expect(regexError("(", { regex: false, caseSensitive: false, wholeWord: false })).toBeNull();
    expect(regexError("", { regex: true, caseSensitive: false, wholeWord: false })).toBeNull();
  });
  test("zero-width matches cannot loop", () => {
    const re = buildMatcher("x*", { regex: true, caseSensitive: false, wholeWord: false })!;
    expect(findSpans("abxxc", re)).toEqual([[2, 4]]);
  });
  test("include globs: trimmed, de-duplicated, folders become folder/**", () => {
    expect(normalizeInclude(" src/** , *.ts,, src/** ,!*.test.ts")).toBe("src/**,*.ts,!*.test.ts");
    expect(normalizeInclude("")).toBe("");
    expect(folderToGlob("src/lib")).toBe("src/lib/**");
    expect(folderToGlob("src/lib/")).toBe("src/lib/**");
    expect(folderToGlob("")).toBe("");
  });
});

describe("search: excerpts and results", () => {
  test("indentation is dropped and spans follow", () => {
    expect(excerpt("      const x = 1;", [[12, 13]])).toEqual({ text: "const x = 1;", spans: [[6, 7]] });
  });
  test("a long line is cut around its first match", () => {
    const line = `${"a".repeat(200)}NEEDLE${"b".repeat(50)}`;
    const e = excerpt(line, [[200, 206]]);
    expect(e.text.startsWith("…")).toBe(true);
    expect(e.text.slice(e.spans[0][0], e.spans[0][1])).toBe("NEEDLE");
    expect(e.text.length).toBeLessThan(150);
  });
  test("grouping sorts files and lines; collapsing hides a file's matches", () => {
    const m = (path: string, line: number) => ({ path, line, column: 1, text: "x" });
    const groups = groupMatches([m("b.ts", 9), m("a.ts", 5), m("b.ts", 2)]);
    expect(groups.map((g) => g.path)).toEqual(["a.ts", "b.ts"]);
    expect(groups[1].matches.map((x) => x.line)).toEqual([2, 9]);
    expect(flattenResults(groups, new Set()).map((r) => (r.kind === "file" ? `F:${r.path}:${r.count}` : `M:${r.match.line}`))).toEqual(["F:a.ts:1", "M:5", "F:b.ts:2", "M:2", "M:9"]);
    expect(flattenResults(groups, new Set(["b.ts"])).map((r) => r.kind)).toEqual(["file", "match", "file"]);
  });
});
