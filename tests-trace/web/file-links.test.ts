import { describe, expect, test } from "bun:test";
// The root package has no react; the web workspace does (its types live there too, hence the ignores).
// @ts-ignore
import { createElement } from "../../web/node_modules/react";
// @ts-ignore
import { renderToStaticMarkup } from "../../web/node_modules/react-dom/server";
import { createFileIndex, linkifyText, parseFileRef, relativize, resolveFileRef, toolFilePaths } from "../../web/src/features/agent/file-links";
import { FileLinksContext, fileRootFor } from "../../web/src/features/agent/FileLinks";
import { Markdown } from "../../web/src/features/agent/Markdown";

const FILES = ["src/a.ts", "src/lib/util.ts", "web/src/features/agent/Markdown.tsx", "web/src/other/index.ts", "src/index.ts", "Makefile", "package.json", "docs/My File.md"];
const index = createFileIndex(FILES);
const CWD = "/work/repo";

describe("file index", () => {
  test("exact paths win; a unique suffix or basename resolves; ambiguity does not", () => {
    expect(index.find("src/a.ts")).toBe("src/a.ts");
    expect(index.find("Markdown.tsx")).toBe("web/src/features/agent/Markdown.tsx");
    expect(index.find("agent/Markdown.tsx")).toBe("web/src/features/agent/Markdown.tsx");
    expect(index.find("index.ts")).toBeNull(); // two of them
    expect(index.find("rc/a.ts")).toBeNull(); // a suffix must start at a path segment
    expect(index.find("nope.ts")).toBeNull();
  });
});

describe("parseFileRef", () => {
  test("line and column forms", () => {
    expect(parseFileRef("src/a.ts")).toEqual({ path: "src/a.ts", line: undefined, col: undefined });
    expect(parseFileRef("./src/a.ts:42")).toMatchObject({ path: "src/a.ts", line: 42 });
    expect(parseFileRef("src/a.ts:42:7")).toMatchObject({ line: 42, col: 7 });
    expect(parseFileRef("src/a.ts#L42")).toMatchObject({ line: 42 });
    expect(parseFileRef("src/a.ts#L42-L50")).toMatchObject({ line: 42 });
    expect(parseFileRef("src/a.ts(42,7)")).toMatchObject({ line: 42, col: 7 });
  });
  test("absolute paths only inside the working directory; file:// too", () => {
    expect(parseFileRef(`${CWD}/src/a.ts:3`, CWD)).toMatchObject({ path: "src/a.ts", line: 3 });
    expect(parseFileRef(`file://${CWD}/src/a.ts`, CWD)?.path).toBe("src/a.ts");
    expect(parseFileRef("/etc/passwd", CWD)).toBeNull();
    expect(parseFileRef(`${CWD}/src/a.ts`)).toBeNull();
  });
  test("rejects URLs, escapes, prose and empties", () => {
    for (const bad of ["https://x.dev/a.ts", "../secret.ts", "src/../../x.ts", "two words.ts", "", "   ", ":42"]) expect(parseFileRef(bad, CWD)).toBeNull();
  });
  test("relativize", () => {
    expect(relativize("./a/b.ts")).toBe("a/b.ts");
    expect(relativize("a/../b.ts")).toBeNull();
  });
  test("resolveFileRef needs a real file; extensionless names count", () => {
    expect(resolveFileRef("Makefile:3", index)).toMatchObject({ path: "Makefile", line: 3 });
    expect(resolveFileRef("README", index)).toBeNull();
    expect(resolveFileRef("Markdown.tsx:12", index)).toMatchObject({ path: "web/src/features/agent/Markdown.tsx", line: 12 });
  });
});

describe("linkifyText", () => {
  test("links real files in prose, leaves the rest", () => {
    const parts = linkifyText("I changed src/a.ts:10 and util.ts, not nope.ts or v1.2.3.", index, CWD);
    expect(parts.filter((p) => "ref" in p).map((p: any) => [p.text, p.ref.path, p.ref.line])).toEqual([
      ["src/a.ts:10", "src/a.ts", 10],
      ["util.ts", "src/lib/util.ts", undefined],
    ]);
    expect(parts.map((p) => p.text).join("")).toBe("I changed src/a.ts:10 and util.ts, not nope.ts or v1.2.3.");
  });
  test("a URL's path is not a file mention", () => {
    expect(linkifyText("see https://x.dev/src/a.ts", index).every((p) => !("ref" in p))).toBe(true);
  });
  test("an empty index links nothing", () => {
    expect(linkifyText("src/a.ts", createFileIndex([]))).toEqual([{ text: "src/a.ts" }]);
  });
});

describe("toolFilePaths", () => {
  test("write-ish calls of the session, relative to cwd", () => {
    const items = [
      { type: "tool", name: "Write", arg: `${CWD}/new/file.ts`, session: "s_1" },
      { type: "tool", name: "Edit", arg: "src/a.ts", session: "s_1" },
      { type: "tool", name: "Edit", arg: "src/head.ts", session: "s_2" },
      { type: "tool", name: "Read", arg: "src/read.ts", session: "s_1" },
      { type: "text", session: "s_1" },
    ];
    expect(toolFilePaths(items, CWD, "s_1").sort()).toEqual(["new/file.ts", "src/a.ts"]);
  });
});

describe("fileRootFor", () => {
  const s = { id: "s_1", isolation: "none" as const, cwd: "/work/repo" };
  test("a plain session uses the workspace, a worktree session its own directory", () => {
    expect(fileRootFor(s, { root: "w_1", path: "/work/repo" })).toEqual({ root: "w_1", cwd: "/work/repo" });
    expect(fileRootFor({ ...s, isolation: "worktree", cwd: "/work/wt" }, { root: "w_1", path: "/work/repo" })).toEqual({ root: "s_1", cwd: "/work/wt" });
    expect(fileRootFor(s, null)).toEqual({ root: "s_1", cwd: "/work/repo" });
  });
});

describe("Markdown with file links", () => {
  const html = (text: string, scoped = true) =>
    renderToStaticMarkup(createElement(FileLinksContext.Provider, { value: scoped ? { index, cwd: CWD, open: () => {} } : null }, createElement(Markdown, { text })));

  test("inline code, prose and links to real files become buttons", () => {
    const out = html("Edited `src/a.ts:42`, then `Makefile` and [the util](src/lib/util.ts#L9) plus [abs](/work/repo/src/a.ts).");
    expect(out).toContain('data-file-link="src/a.ts"');
    expect(out).toContain('data-file-line="42"');
    expect(out).toContain('data-file-link="Makefile"');
    expect(out).toContain('data-file-link="src/lib/util.ts"');
    expect(out.match(/data-file-link="src\/a\.ts"/g)?.length).toBe(2);
    expect(out).toContain("<code>src/a.ts:42</code>"); // the original text is kept
  });
  test("leaves non-files, fenced code, external links alone", () => {
    const out = html("`nope.ts` and `index.ts`\n\n```\nsrc/a.ts\n```\n\n[web](https://example.com/a.ts)");
    expect(out).not.toContain("data-file-link");
    expect(out).toContain('href="https://example.com/a.ts"');
    expect(out).toContain('target="_blank"');
  });
  test("a link to a file that is not there is text, not a 404 anchor", () => {
    const out = html("[gone](src/gone.ts)");
    expect(out).not.toContain("<a ");
    expect(out).toContain("gone");
  });
  test("outside a scope nothing changes", () => {
    const out = html("`src/a.ts` [x](src/a.ts)", false);
    expect(out).not.toContain("data-file-link");
    expect(out).toContain('<a href="src/a.ts"');
  });
});
