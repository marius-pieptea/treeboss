import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { alignSplit, buildHunkPatch, buildLinesPatch, changedLineIds, intraLineRanges, parseDiff, unquotePath, wordDiff } from "../../web/src/lib/diff";
import { computeGraph } from "../../web/src/features/git/graph";

const ID = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", [...ID, ...args], { cwd, encoding: "utf-8" });
  if (r.status !== 0 && !args.includes("--check")) throw new Error(`git ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}
function repo(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trb-diff-")));
  git(dir, "init", "-q", "-b", "main");
  for (const [rel, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), c);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
function apply(cwd: string, patch: string, ...flags: string[]) {
  const r = spawnSync("git", ["apply", "--recount", "--whitespace=nowarn", ...flags, "-"], { cwd, input: patch, encoding: "utf-8" });
  return { ok: r.status === 0, err: r.stderr };
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const join = (ls: string[]) => ls.join("\n") + "\n";

describe("parseDiff", () => {
  test("modified file: hunks, numbers, counts, section", () => {
    const d = repo({ "a.ts": join(lines(30)) });
    const edited = lines(30);
    edited[4] = "FIVE";
    edited.splice(20, 0, "inserted");
    fs.writeFileSync(path.join(d, "a.ts"), join(edited));
    const [f] = parseDiff(git(d, "diff", "-U2"));
    expect(f).toMatchObject({ path: "a.ts", status: "modified", additions: 2, deletions: 1, binary: false });
    expect(f.hunks).toHaveLength(2);
    const h0 = f.hunks[0];
    expect(h0.lines.map((l) => l.type)).toEqual(["ctx", "ctx", "del", "add", "ctx", "ctx"]);
    expect(h0.lines[2]).toMatchObject({ oldNo: 5, newNo: null, text: "line 5" });
    expect(h0.lines[3]).toMatchObject({ oldNo: null, newNo: 5, text: "FIVE" });
    expect(h0.lines[4]).toMatchObject({ oldNo: 6, newNo: 6 });
    expect(f.hunks[1].lines.find((l) => l.type === "add")).toMatchObject({ newNo: 21, text: "inserted" });
  });

  test("new, deleted, renamed and mode-changed files", () => {
    const d = repo({ "keep.txt": "k\n", "gone.txt": "g\n", "old name.txt": join(lines(10)), "run.sh": "echo\n" });
    fs.writeFileSync(path.join(d, "new.txt"), "n\n");
    fs.rmSync(path.join(d, "gone.txt"));
    git(d, "mv", "old name.txt", "new name.txt");
    fs.chmodSync(path.join(d, "run.sh"), 0o755);
    git(d, "add", "-A");
    const files = parseDiff(git(d, "diff", "--cached", "-M"));
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by["new.txt"]).toMatchObject({ status: "added", oldPath: null, additions: 1 });
    expect(by["gone.txt"]).toMatchObject({ status: "deleted", newPath: null, deletions: 1, path: "gone.txt" });
    expect(by["new name.txt"]).toMatchObject({ status: "renamed", oldPath: "old name.txt", newPath: "new name.txt", similarity: 100 });
    expect(by["new name.txt"].hunks).toHaveLength(0);
    expect(by["run.sh"]).toMatchObject({ oldMode: "100644", newMode: "100755", hunks: [] });
  });

  test("binary files and untracked (--no-index) files", () => {
    const d = repo({ "a.txt": "a\n" });
    fs.writeFileSync(path.join(d, "img.bin"), Buffer.from([0, 1, 2, 3, 0]));
    git(d, "add", "img.bin");
    const bin = parseDiff(git(d, "diff", "--cached"));
    expect(bin[0]).toMatchObject({ path: "img.bin", binary: true, hunks: [] });
    fs.writeFileSync(path.join(d, "fresh.txt"), "one\ntwo\n");
    const r = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", "fresh.txt"], { cwd: d, encoding: "utf-8" });
    const [f] = parseDiff(r.stdout);
    expect(f).toMatchObject({ path: "fresh.txt", status: "added", additions: 2 });
  });

  test("CRLF keeps the carriage return; no-newline marker sticks to its line", () => {
    const d = repo({ "w.txt": "one\r\ntwo\r\n" });
    fs.writeFileSync(path.join(d, "w.txt"), "one\r\nTWO\r\nlast-no-eol");
    const [f] = parseDiff(git(d, "diff"));
    const add = f.hunks[0].lines.filter((l) => l.type === "add");
    expect(add[0].text).toBe("TWO\r");
    expect(add[1]).toMatchObject({ text: "last-no-eol", noNewline: true });
  });

  test("quoted and spaced paths", () => {
    expect(unquotePath('"a\\tb"')).toBe("a\tb");
    expect(unquotePath('"caf\\303\\251"')).toBe("café");
    expect(unquotePath("plain")).toBe("plain");
    const d = repo({ "dir with space/f g.txt": "x\n" });
    fs.writeFileSync(path.join(d, "dir with space/f g.txt"), "y\n");
    expect(parseDiff(git(d, "diff"))[0].path).toBe("dir with space/f g.txt");
  });

  test("garbage and empty input are harmless", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("not a diff at all\n")).toEqual([]);
    // A diff cut off mid-hunk (the daemon caps output) still parses what is there.
    const d = repo({ "a.txt": join(lines(10)) });
    fs.writeFileSync(path.join(d, "a.txt"), join(lines(10).map((l) => l + "!")));
    const text = git(d, "diff");
    expect(() => parseDiff(text.slice(0, text.length - 7))).not.toThrow();
  });

  test("multiple files", () => {
    const d = repo({ "a.txt": "a\n", "b.txt": "b\n" });
    fs.writeFileSync(path.join(d, "a.txt"), "a2\n");
    fs.writeFileSync(path.join(d, "b.txt"), "b2\n");
    expect(parseDiff(git(d, "diff")).map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("patch builders against real git apply", () => {
  const twoHunks = () => {
    const d = repo({ "f.txt": join(lines(40)) });
    const e = lines(40);
    e[2] = "CHANGED 3";
    e[35] = "CHANGED 36";
    fs.writeFileSync(path.join(d, "f.txt"), join(e));
    return d;
  };

  test("stage one hunk; the other stays unstaged; unstage it again", () => {
    const d = twoHunks();
    const [f] = parseDiff(git(d, "diff", "-U1"));
    expect(f.hunks).toHaveLength(2);
    expect(apply(d, buildHunkPatch(f, 0), "--cached").ok).toBe(true);
    expect(git(d, "diff", "--cached")).toContain("+CHANGED 3\n");
    expect(git(d, "diff", "--cached")).not.toContain("CHANGED 36");
    expect(git(d, "diff")).toContain("+CHANGED 36");
    const [s] = parseDiff(git(d, "diff", "--cached", "-U1"));
    expect(apply(d, buildHunkPatch(s, 0), "--cached", "-R").ok).toBe(true);
    expect(git(d, "diff", "--cached")).toBe("");
  });

  test("discard one hunk from the working tree", () => {
    const d = twoHunks();
    const [f] = parseDiff(git(d, "diff", "-U1"));
    expect(apply(d, buildHunkPatch(f, 1), "-R").ok).toBe(true);
    const now = fs.readFileSync(path.join(d, "f.txt"), "utf-8");
    expect(now).toContain("CHANGED 3\n");
    expect(now).toContain("line 36\n");
  });

  test("stage a subset of lines: selected adds and dels go in, the rest stays out", () => {
    const d = repo({ "f.txt": "a\nb\nc\nd\ne\n" });
    // b->B (del b, add B), delete d, add X after e
    fs.writeFileSync(path.join(d, "f.txt"), "a\nB\nc\ne\nX\n");
    const [f] = parseDiff(git(d, "diff"));
    const h = f.hunks[0];
    const ids = h.lines.filter((l) => l.type !== "ctx");
    const pick = (pred: (l: (typeof ids)[number]) => boolean) => new Set(ids.filter(pred).map((l) => l.id));
    // Stage only: the replacement of b by B, nothing else.
    const sel = pick((l) => l.text === "b" || l.text === "B");
    const patch = buildLinesPatch(f, 0, sel, "forward")!;
    expect(apply(d, patch, "--cached").ok).toBe(true);
    const staged = git(d, "show", ":f.txt");
    expect(staged).toBe("a\nB\nc\nd\ne\n"); // d is still there, X never arrived
    // The working tree is untouched, and the remaining diff is exactly the unselected part.
    expect(fs.readFileSync(path.join(d, "f.txt"), "utf-8")).toBe("a\nB\nc\ne\nX\n");
    const rest = parseDiff(git(d, "diff"))[0];
    expect(rest.hunks.flatMap((x) => x.lines.filter((l) => l.type !== "ctx").map((l) => l.type + l.text))).toEqual(["deld", "addX"]);
  });

  test("unstage a subset of lines (reverse on the index)", () => {
    const d = repo({ "f.txt": "a\nb\nc\nd\ne\n" });
    fs.writeFileSync(path.join(d, "f.txt"), "a\nB\nc\ne\nX\n");
    git(d, "add", "f.txt");
    const [f] = parseDiff(git(d, "diff", "--cached"));
    const ids = f.hunks[0].lines.filter((l) => l.type !== "ctx");
    const sel = new Set(ids.filter((l) => l.text === "X").map((l) => l.id));
    const patch = buildLinesPatch(f, 0, sel, "reverse")!;
    expect(apply(d, patch, "--cached", "-R").ok).toBe(true);
    expect(git(d, "show", ":f.txt")).toBe("a\nB\nc\ne\n"); // X is out of the index, the rest still staged
    expect(fs.readFileSync(path.join(d, "f.txt"), "utf-8")).toBe("a\nB\nc\ne\nX\n");
  });

  test("discard a subset of lines from the working tree", () => {
    const d = repo({ "f.txt": "a\nb\nc\nd\ne\n" });
    fs.writeFileSync(path.join(d, "f.txt"), "a\nB\nc\ne\nX\n");
    const [f] = parseDiff(git(d, "diff"));
    const ids = f.hunks[0].lines.filter((l) => l.type !== "ctx");
    const sel = new Set(ids.filter((l) => l.text === "X" || l.text === "d").map((l) => l.id));
    expect(apply(d, buildLinesPatch(f, 0, sel, "reverse")!, "-R").ok).toBe(true);
    // X is gone and d is back; the b->B edit is untouched.
    expect(fs.readFileSync(path.join(d, "f.txt"), "utf-8")).toBe("a\nB\nc\nd\ne\n");
  });

  test("nothing selected means no patch", () => {
    const d = twoHunks();
    const [f] = parseDiff(git(d, "diff"));
    expect(buildLinesPatch(f, 0, new Set())).toBeNull();
  });

  test("selecting every changed line equals the whole hunk", () => {
    const d = twoHunks();
    const [f] = parseDiff(git(d, "diff", "-U1"));
    const patch = buildLinesPatch(f, 1, new Set(changedLineIds(f.hunks[1])))!;
    expect(apply(d, patch, "--cached").ok).toBe(true);
    expect(git(d, "diff", "--cached")).toContain("+CHANGED 36");
  });

  test("CRLF files: a line patch still applies", () => {
    const d = repo({ "w.txt": "one\r\ntwo\r\nthree\r\n" });
    fs.writeFileSync(path.join(d, "w.txt"), "ONE\r\ntwo\r\nTHREE\r\n");
    const [f] = parseDiff(git(d, "diff"));
    const ids = f.hunks[0].lines.filter((l) => l.type !== "ctx");
    const sel = new Set(ids.filter((l) => l.text.startsWith("ONE") || l.text.startsWith("one")).map((l) => l.id));
    expect(apply(d, buildLinesPatch(f, 0, sel)!, "--cached").ok).toBe(true);
    expect(git(d, "show", ":w.txt")).toBe("ONE\r\ntwo\r\nthree\r\n");
  });

  test("no newline at end of file survives a hunk patch", () => {
    const d = repo({ "n.txt": "a\nb" });
    fs.writeFileSync(path.join(d, "n.txt"), "a\nB");
    const [f] = parseDiff(git(d, "diff"));
    expect(apply(d, buildHunkPatch(f, 0), "--cached").ok).toBe(true);
    expect(git(d, "show", ":n.txt")).toBe("a\nB");
  });

  test("a deleted file: stage its hunk", () => {
    const d = repo({ "x.txt": "1\n2\n" });
    fs.rmSync(path.join(d, "x.txt"));
    const [f] = parseDiff(git(d, "diff"));
    expect(f.status).toBe("deleted");
    expect(apply(d, buildHunkPatch(f, 0), "--cached").ok).toBe(true);
    expect(git(d, "diff", "--cached", "--name-status").trim()).toBe("D\tx.txt");
  });

  test("applying from a subdirectory of the repo works for a top-relative patch", () => {
    const d = repo({ "pkg/a.txt": "1\n2\n3\n" });
    fs.writeFileSync(path.join(d, "pkg/a.txt"), "1\nTWO\n3\n");
    const [f] = parseDiff(git(d, "diff"));
    // Run git apply with cwd = repo top: the daemon's /patch route does exactly this for subdirectory workspaces.
    expect(apply(d, buildHunkPatch(f, 0), "--cached").ok).toBe(true);
  });
});

describe("side by side and word diff", () => {
  const hunk = (body: string[]) => parseDiff(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,9 +1,9 @@", ...body, ""].join("\n"))[0].hunks[0];

  test("deletion runs pair with addition runs; context is on both sides", () => {
    const rows = alignSplit(hunk([" c1", "-d1", "-d2", "-d3", "+a1", "+a2", " c2"]));
    expect(rows.map((r) => `${r.left?.text ?? "_"}|${r.right?.text ?? "_"}`)).toEqual(["c1|c1", "d1|a1", "d2|a2", "d3|_", "c2|c2"]);
  });

  test("a lone addition or deletion leaves the other side empty", () => {
    expect(alignSplit(hunk(["+only"])).map((r) => [r.left, r.right?.text])).toEqual([[null, "only"]]);
    expect(alignSplit(hunk(["-only"])).map((r) => [r.left?.text, r.right])).toEqual([["only", null]]);
  });

  test("wordDiff marks only what changed", () => {
    const w = wordDiff("const total = sum(items);", "const total = mean(items);");
    expect(w.a.map(([s, e]) => "const total = sum(items);".slice(s, e))).toEqual(["sum"]);
    expect(w.b.map(([s, e]) => "const total = mean(items);".slice(s, e))).toEqual(["mean"]);
    expect(wordDiff("same", "same")).toEqual({ a: [], b: [] });
  });

  test("intraLineRanges skips lines that are mostly different", () => {
    const h = hunk(["-const total = sum(items);", "+const total = mean(items);", "-completely", "+unrelated words here"]);
    const r = intraLineRanges(h);
    expect(r.size).toBe(2); // only the first pair gets word highlights
  });
});

describe("commit graph lanes", () => {
  const c = (sha: string, ...parents: string[]) => ({ sha, parents });

  test("a linear history stays in one lane", () => {
    const g = computeGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(g.rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(g.maxLanes).toBe(1);
  });

  test("a branch and merge opens a second lane and closes it", () => {
    // m merges main(b) and topic(t); both descend from a.
    const g = computeGraph([c("m", "b", "t"), c("t", "a"), c("b", "a"), c("a")]);
    expect(g.rows[0].col).toBe(0);
    expect(g.rows[0].edges.some((e) => e.to === 1)).toBe(true); // the merge reaches into lane 1
    expect(g.rows[1].col).toBe(1); // t sits in lane 1
    expect(g.rows[2].col).toBe(0);
    expect(g.rows[3].col).toBe(0);
    // b's row pulls lane 1 left into lane 0 so the trunk stays put, and nothing passes through the root.
    expect(g.rows[2].passing).toEqual([{ lane: 1, to: 0 }]);
    expect(g.rows[3].passing).toEqual([]);
    expect(g.maxLanes).toBe(2);
  });

  test("two branches tips and a shared base: the second tip gets its own lane", () => {
    const g = computeGraph([c("x", "base"), c("y", "base"), c("base")]);
    expect(g.rows[0].col).toBe(0);
    expect(g.rows[1].col).toBe(1);
    expect(g.rows[2].col).toBe(0);
    expect(g.rows[1].edges).toEqual([{ from: 1, to: 0 }]); // y's line bends into base's lane
  });

  test("an octopus merge fans out to every parent", () => {
    const g = computeGraph([c("o", "p1", "p2", "p3"), c("p1"), c("p2"), c("p3")]);
    expect(g.rows[0].edges.map((e) => e.to).sort()).toEqual([0, 1, 2]);
    expect(g.maxLanes).toBe(3);
  });

  test("parents outside the loaded page do not break the graph", () => {
    const g = computeGraph([c("b", "a"), c("c", "b")]);
    expect(g.rows).toHaveLength(2);
  });
});

describe("ref chips", () => {
  const { visibleRefs } = require("../../web/src/features/git/History");
  test("drops origin/HEAD and a remote branch that mirrors a local one", () => {
    expect(visibleRefs(["HEAD -> main", "origin/main", "origin/HEAD"])).toEqual(["HEAD -> main"]);
    expect(visibleRefs(["main", "origin/main", "origin/feature", "tag: v1"])).toEqual(["main", "origin/feature", "tag: v1"]);
  });
});
