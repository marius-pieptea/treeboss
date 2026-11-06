import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START files\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END files\n"); });
import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { RootError, Workspaces, resolveRoot, safeJoin } from "../src/workspaces";
import { ConflictError, createEntry, deleteEntry, grep, listAllFiles, listDir, readFileSafe, renameEntry, writeFileSafe } from "../src/fs/files";
import { makeDir, makeRepo, resetState, sh } from "./helpers";

describe("safeJoin: nothing leaves the root", () => {
  const root = makeDir();
  fs.mkdirSync(path.join(root, "sub"));

  test("normal paths resolve inside", () => {
    expect(safeJoin(root, "sub/a.txt")).toBe(path.join(root, "sub", "a.txt"));
    expect(safeJoin(root, "")).toBe(root);
    expect(safeJoin(root, "/sub/a.txt")).toBe(path.join(root, "sub", "a.txt")); // a leading slash is relative to the root, not the filesystem
  });
  test("parent traversal is refused, however it is spelled", () => {
    for (const bad of ["../x", "sub/../../x", "sub/../..", "a/../../etc/passwd", "..\\x"]) {
      expect(() => safeJoin(root, bad)).toThrow(RootError);
    }
  });
  test("a NUL byte is refused", () => {
    expect(() => safeJoin(root, "a\0b")).toThrow(/Bad path/);
  });
  test("a symlink out of the root is refused, for existing and not-yet-existing targets", () => {
    const outside = makeDir();
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    fs.symlinkSync(outside, path.join(root, "escape"));
    expect(() => safeJoin(root, "escape/secret.txt")).toThrow(/symlink/);
    expect(() => safeJoin(root, "escape/new.txt")).toThrow(/symlink/); // would be created outside
    expect(() => safeJoin(root, "escape")).toThrow(/symlink/);
  });
  test("a symlink that stays inside is fine", () => {
    fs.symlinkSync(path.join(root, "sub"), path.join(root, "alias"));
    expect(() => safeJoin(root, "alias/x.txt")).not.toThrow();
  });
});

describe("roots", () => {
  test("workspaces are idempotent by real path and resolve by ref", () => {
    resetState();
    const dir = makeDir();
    const a = Workspaces.open(dir);
    const b = Workspaces.open(path.join(dir, "."));
    expect(b.id).toBe(a.id);
    expect(resolveRoot(a.id)).toMatchObject({ kind: "workspace", dir: a.path });
    expect(() => resolveRoot("w_nope")).toThrow(/No workspace/);
    expect(() => resolveRoot("../etc")).toThrow(/Bad root/);
    expect(() => Workspaces.open("/definitely/not/here")).toThrow(/not found/);
  });
});

describe("listing and reading", () => {
  test("directories first, .git hidden, gitignored entries flagged", async () => {
    const repo = makeRepo({ "b.txt": "b", "a.txt": "a", "src/x.ts": "x", ".gitignore": "ignored.log\nbuild/\n" });
    fs.writeFileSync(path.join(repo, "ignored.log"), "i");
    fs.mkdirSync(path.join(repo, "build"));
    const top = await listDir(repo, "");
    expect(top.map((e) => e.name)).toEqual(["build", "src", ".gitignore", "a.txt", "b.txt", "ignored.log"]);
    expect(top.find((e) => e.name === "ignored.log")!.ignored).toBe(true);
    expect(top.find((e) => e.name === "build")!.ignored).toBe(true);
    expect(top.find((e) => e.name === "a.txt")!.ignored).toBeUndefined();
    expect((await listDir(repo, "src")).map((e) => e.path)).toEqual(["src/x.ts"]);
  });

  test("a directory that does not exist is a 404, a file is not a directory", async () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, "f"), "x");
    await expect(listDir(d, "nope")).rejects.toMatchObject({ status: 404 });
    await expect(listDir(d, "f")).rejects.toThrow(/not a directory/);
  });

  test("text, CRLF detection, binary, and too-large files", () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, "t.txt"), "one\r\ntwo\r\n");
    fs.writeFileSync(path.join(d, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    fs.writeFileSync(path.join(d, "big.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    expect(readFileSafe(d, "t.txt")).toMatchObject({ content: "one\r\ntwo\r\n", eol: "crlf" });
    expect(readFileSafe(d, "bin.dat")).toMatchObject({ binary: true, size: 4 });
    expect(readFileSafe(d, "big.txt")).toMatchObject({ tooLarge: true });
    expect(() => readFileSafe(d, "ghost")).toThrow(/No such file/);
    expect(() => readFileSafe(d, ".")).toThrow(/directory/);
  });
});

describe("writing", () => {
  test("atomic write keeps the file mode and leaves no temp file", () => {
    const d = makeDir();
    const f = path.join(d, "run.sh");
    fs.writeFileSync(f, "old", { mode: 0o755 });
    const r = writeFileSafe(d, "run.sh", "new");
    expect(fs.readFileSync(f, "utf-8")).toBe("new");
    expect(fs.statSync(f).mode & 0o777).toBe(0o755);
    expect(r.size).toBe(3);
    expect(fs.readdirSync(d)).toEqual(["run.sh"]);
  });

  test("optimistic lock: a file changed since it was opened is a conflict, not an overwrite", async () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, "a.txt"), "v1");
    const opened = (readFileSafe(d, "a.txt") as { mtime: number }).mtime;
    await Bun.sleep(20);
    fs.writeFileSync(path.join(d, "a.txt"), "edited by an agent");
    expect(() => writeFileSafe(d, "a.txt", "mine", { expectedMtime: opened })).toThrow(ConflictError);
    expect(fs.readFileSync(path.join(d, "a.txt"), "utf-8")).toBe("edited by an agent");
    const now = (readFileSafe(d, "a.txt") as { mtime: number }).mtime;
    expect(() => writeFileSafe(d, "a.txt", "mine", { expectedMtime: now })).not.toThrow();
  });

  test("writing a file that does not exist needs `create`, and creates parent directories", () => {
    const d = makeDir();
    expect(() => writeFileSafe(d, "new/deep/f.txt", "x")).toThrow(/No such file/);
    writeFileSafe(d, "new/deep/f.txt", "x", { create: true });
    expect(fs.readFileSync(path.join(d, "new/deep/f.txt"), "utf-8")).toBe("x");
  });

  test(".git is untouchable", () => {
    const r = makeRepo();
    expect(() => writeFileSafe(r, ".git/config", "x")).toThrow(/\.git/);
    expect(() => deleteEntry(r, ".git")).toThrow(/\.git/);
    expect(() => deleteEntry(r, ".git/HEAD")).toThrow(/\.git/);
    expect(() => createEntry(r, ".git/hooks/x", "file")).toThrow(/\.git/);
    expect(() => renameEntry(r, "a.txt", ".git/a.txt")).toThrow(/\.git/);
  });

  test("create / rename / delete, with their refusals", () => {
    const d = makeDir();
    createEntry(d, "dir/inner/file.txt", "file");
    createEntry(d, "emptydir", "dir");
    expect(() => createEntry(d, "emptydir", "dir")).toThrow(/already exists/);
    renameEntry(d, "dir/inner/file.txt", "moved/file.txt");
    expect(fs.existsSync(path.join(d, "moved/file.txt"))).toBe(true);
    expect(() => renameEntry(d, "moved/file.txt", "emptydir")).toThrow(/already exists/);
    expect(() => renameEntry(d, "ghost", "x")).toThrow(/No such file/);
    deleteEntry(d, "dir");
    expect(fs.existsSync(path.join(d, "dir"))).toBe(false);
    expect(() => deleteEntry(d, "")).toThrow(/root/);
    expect(() => deleteEntry(d, ".")).toThrow(/root/);
    expect(() => deleteEntry(d, "../x")).toThrow(RootError);
  });
});

describe("find and grep", () => {
  test("find uses git's file list: tracked and untracked, never ignored, never deleted", async () => {
    const r = makeRepo({ "a.txt": "1", "keep.txt": "2", ".gitignore": "secret.env\n" });
    fs.writeFileSync(path.join(r, "secret.env"), "x");
    fs.writeFileSync(path.join(r, "untracked.txt"), "x");
    fs.rmSync(path.join(r, "keep.txt"));
    const { files } = await listAllFiles(r);
    expect(files.sort()).toEqual([".gitignore", "a.txt", "untracked.txt"]);
  });

  test("find outside a repo skips dependency directories", async () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, "node_modules/pkg"), { recursive: true });
    fs.writeFileSync(path.join(d, "node_modules/pkg/i.js"), "x");
    fs.writeFileSync(path.join(d, "app.js"), "x");
    expect((await listAllFiles(d)).files).toEqual(["app.js"]);
  });

  test("grep: literal vs regex, case, whole word, include globs", async () => {
    const r = makeRepo({ "a.ts": "const Foo = 1;\nfoo(bar)\nfoobar\n", "b.md": "foo in docs\n" });
    const lit = await grep(r, { query: "foo(", caseSensitive: false });
    expect(lit.matches.map((m) => `${m.path}:${m.line}`)).toEqual(["a.ts:2"]); // "(" is literal, not a regex group
    expect((await grep(r, { query: "foo", caseSensitive: true })).matches.map((m) => `${m.path}:${m.line}`).sort()).toEqual(["a.ts:2", "a.ts:3", "b.md:1"]);
    expect((await grep(r, { query: "foo", wholeWord: true })).matches.map((m) => `${m.path}:${m.line}`).sort()).toEqual(["a.ts:1", "a.ts:2", "b.md:1"]); // "foobar" is not the word foo
    expect((await grep(r, { query: "fo+bar", regex: true })).matches.map((m) => m.text)).toEqual(["foobar"]);
    const onlyMd = await grep(r, { query: "foo", include: "*.md" });
    expect(onlyMd.matches.map((m) => m.path)).toEqual(["b.md"]);
    expect(onlyMd.matches[0]).toMatchObject({ line: 1, column: 1 });
  });

  test("grep in a plain directory (no git) still works", async () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, "x.txt"), "needle here\n");
    const r = await grep(d, { query: "needle" });
    expect(r.matches).toMatchObject([{ path: "x.txt", line: 1, column: 1 }]);
  });

  test("a bad regex is a clear error", async () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, "x.txt"), "x\n");
    await expect(grep(d, { query: "(", regex: true })).rejects.toThrow();
  });
});
