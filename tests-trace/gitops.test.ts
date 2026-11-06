import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START gitops\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END gitops\n"); });
import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import * as G from "../src/git/ops";
import { makeDir, makeRepo, sh } from "./helpers";

const ID = `-c user.email=t@t -c user.name=t -c commit.gpgsign=false`;
const w = (repo: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};
const commitAll = (repo: string, msg: string) => sh(`git add -A && git ${ID} commit -qm ${JSON.stringify(msg)}`, repo);

/** A repo with a local bare "origin" it tracks. */
function repoWithRemote() {
  const repo = makeRepo();
  const bare = makeDir();
  sh("git init -q --bare -b main .", bare);
  sh(`git remote add origin ${bare} && git push -q -u origin main`, repo);
  return { repo, bare };
}

describe("repo info", () => {
  test("not a repo / repo / subdirectory prefix", async () => {
    expect((await G.repoInfo(makeDir())).isRepo).toBe(false);
    const r = makeRepo({ "pkg/app/x.txt": "x" });
    const top = await G.repoInfo(r);
    expect(top).toMatchObject({ isRepo: true, prefix: "" });
    expect((await G.repoInfo(path.join(r, "pkg/app"))).prefix).toBe("pkg/app/");
  });
  test("init creates a repo on main", async () => {
    const d = makeDir();
    await G.init(d);
    expect((await G.repoInfo(d)).isRepo).toBe(true);
    expect((await G.status(d)).branch).toBe("main");
  });
});

describe("status excluding scaffolding", () => {
  test("leaves out the given folders but keeps every other change, from a subfolder too", async () => {
    const r = makeRepo({ "a.txt": "a", "pkg/b.txt": "b" });
    w(r, ".claude/skills/x/SKILL.md", "x");
    w(r, ".claude/skills/x/ref.md", "x");
    w(r, ".claude/skills/own/SKILL.md", "own");
    w(r, "pkg/b.txt", "changed");
    const skill = path.join(r, ".claude/skills/x");
    expect((await G.status(r)).files).toHaveLength(4);
    const files = (await G.status(r, [skill])).files.map((f) => f.path).sort();
    expect(files).toEqual([".claude/skills/own/SKILL.md", "pkg/b.txt"]);
    // Run from a subfolder, the whole repo is still in scope and an exclude inside that folder applies.
    w(r, "pkg/.claude/skills/y/SKILL.md", "y");
    const inPkg = (await G.status(path.join(r, "pkg"), [path.join(r, "pkg/.claude/skills/y")])).files.map((f) => f.path).sort();
    expect(inPkg).toEqual([".claude/skills/own/SKILL.md", ".claude/skills/x/ref.md", ".claude/skills/x/SKILL.md", "pkg/b.txt"].sort());
    // A path outside the folder is ignored rather than an error.
    expect((await G.status(r, ["/nowhere/else"])).files).toHaveLength(5);
  });
});

describe("status", () => {
  test("parser: every record shape, with spaces in paths and a rename", () => {
    const out = [
      "# branch.oid 3f1d2c0000000000000000000000000000000000",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/has space.ts",
      "1 A. N... 000000 100644 100644 000 ccc new.ts",
      "2 R. N... 100644 100644 100644 ddd eee R100 renamed.ts",
      "old name.ts",
      "u UU N... 100644 100644 100644 100644 f1 f2 f3 conflicted.ts",
      "? untracked file.txt",
      "",
    ].join("\0");
    const s = G.parseStatusV2(out);
    expect(s).toMatchObject({ branch: "feature/x", upstream: "origin/feature/x", ahead: 2, behind: 1, detached: false });
    expect(s.files).toEqual([
      { path: "src/has space.ts", index: ".", worktree: "M" },
      { path: "new.ts", index: "A", worktree: "." },
      { path: "renamed.ts", origPath: "old name.ts", index: "R", worktree: "." },
      { path: "conflicted.ts", index: "U", worktree: "U", conflict: "UU" },
      { path: "untracked file.txt", index: ".", worktree: "?" },
    ]);
  });

  test("detached HEAD and an unborn branch", () => {
    expect(G.parseStatusV2("# branch.oid abc\0# branch.head (detached)\0")).toMatchObject({ detached: true, branch: null, head: "abc" });
    expect(G.parseStatusV2("# branch.oid (initial)\0# branch.head main\0")).toMatchObject({ head: null, branch: "main" });
  });

  test("against a real repo: staged, unstaged, untracked, renamed", async () => {
    const r = makeRepo({ "a.txt": "one\n", "b.txt": "bee\n" });
    w(r, "a.txt", "one\ntwo\n");
    w(r, "new.txt", "n\n");
    sh("git mv b.txt c.txt", r);
    sh("git add a.txt", r);
    w(r, "a.txt", "one\ntwo\nthree\n");
    const s = await G.status(r);
    const f = Object.fromEntries(s.files.map((x) => [x.path, x]));
    expect(f["a.txt"]).toMatchObject({ index: "M", worktree: "M" });
    expect(f["new.txt"]).toMatchObject({ worktree: "?" });
    expect(f["c.txt"]).toMatchObject({ index: "R", origPath: "b.txt" });
    expect(s).toMatchObject({ branch: "main", operation: null, stashCount: 0 });
  });
});

describe("diff", () => {
  test("unstaged vs staged vs untracked vs a commit", async () => {
    const r = makeRepo({ "a.txt": "one\n" });
    w(r, "a.txt", "one\ntwo\n");
    expect((await G.diff(r, { path: "a.txt" })).diff).toContain("+two");
    expect((await G.diff(r, { path: "a.txt", staged: true })).diff).toBe("");
    sh("git add a.txt", r);
    expect((await G.diff(r, { path: "a.txt", staged: true })).diff).toContain("+two");
    w(r, "n.txt", "fresh\n");
    const u = await G.diff(r, { path: "n.txt", untracked: true });
    expect(u.diff).toContain("new file mode");
    expect(u.diff).toContain("+fresh");
    commitAll(r, "add two");
    const sha = sh("git rev-parse HEAD", r);
    expect((await G.diff(r, { commit: sha })).diff).toContain("+two");
  });

  test("a range, context size, and refusing option-looking refs", async () => {
    const r = makeRepo({ "a.txt": "1\n2\n3\n4\n5\n6\n7\n" });
    const base = sh("git rev-parse HEAD", r);
    w(r, "a.txt", "1\n2\n3\nFOUR\n5\n6\n7\n");
    commitAll(r, "edit");
    expect((await G.diff(r, { base, head: "HEAD", context: 0 })).diff).not.toContain(" 3\n");
    expect((await G.diff(r, { base, head: "HEAD", context: 3 })).diff).toContain(" 3\n");
    await expect(G.diff(r, { commit: "--output=/tmp/x" })).rejects.toThrow(/Bad commit/);
    await expect(G.diff(r, { base: "-x", head: "HEAD" })).rejects.toThrow(/Bad base/);
  });

  test("showFile reads HEAD, the index, and reports a missing file as null", async () => {
    const r = makeRepo({ "a.txt": "head\n" });
    w(r, "a.txt", "work\n");
    sh("git add a.txt", r);
    w(r, "a.txt", "work2\n");
    expect(await G.showFile(r, "HEAD", "a.txt")).toBe("head\n");
    expect(await G.showFile(r, ":", "a.txt")).toBe("work\n");
    expect(await G.showFile(r, "HEAD", "ghost.txt")).toBeNull();
  });
});

describe("staging", () => {
  test("stage, unstage, and stage a deletion", async () => {
    const r = makeRepo({ "a.txt": "1\n", "gone.txt": "g\n" });
    w(r, "a.txt", "2\n");
    w(r, "n.txt", "n\n");
    fs.rmSync(path.join(r, "gone.txt"));
    await G.stage(r, ["a.txt", "n.txt", "gone.txt"]);
    let s = Object.fromEntries((await G.status(r)).files.map((f) => [f.path, f]));
    expect(s["a.txt"]).toMatchObject({ index: "M", worktree: "." });
    expect(s["n.txt"]).toMatchObject({ index: "A" });
    expect(s["gone.txt"]).toMatchObject({ index: "D" });
    await G.unstage(r, ["a.txt", "gone.txt"]);
    s = Object.fromEntries((await G.status(r)).files.map((f) => [f.path, f]));
    expect(s["a.txt"]).toMatchObject({ index: ".", worktree: "M" });
    expect(s["gone.txt"]).toMatchObject({ index: ".", worktree: "D" });
  });

  test("unstage works before the first commit", async () => {
    const d = makeDir();
    sh("git init -q -b main .", d);
    w(d, "a.txt", "a\n");
    await G.stage(d, ["a.txt"]);
    expect((await G.status(d)).files[0]).toMatchObject({ index: "A" });
    await G.unstage(d, ["a.txt"]);
    expect((await G.status(d)).files[0]).toMatchObject({ index: ".", worktree: "?" });
  });

  test("discard: tracked edits revert, untracked files are deleted, other files are untouched", async () => {
    const r = makeRepo({ "a.txt": "orig\n", "keep.txt": "k\n" });
    w(r, "a.txt", "changed\n");
    w(r, "keep.txt", "kept edit\n");
    w(r, "junk.txt", "junk\n");
    await G.discard(r, ["a.txt", "junk.txt"]);
    expect(fs.readFileSync(path.join(r, "a.txt"), "utf-8")).toBe("orig\n");
    expect(fs.existsSync(path.join(r, "junk.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(r, "keep.txt"), "utf-8")).toBe("kept edit\n");
  });

  test("discard `all` also drops what was staged", async () => {
    const r = makeRepo({ "a.txt": "orig\n" });
    w(r, "a.txt", "staged edit\n");
    sh("git add a.txt", r);
    await G.discard(r, ["a.txt"], { all: true });
    expect(fs.readFileSync(path.join(r, "a.txt"), "utf-8")).toBe("orig\n");
    expect((await G.status(r)).files).toEqual([]);
  });

  test("hunk staging: stage one hunk of two, then unstage it again", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const r = makeRepo({ "f.txt": lines.join("\n") + "\n" });
    const edited = [...lines];
    edited[2] = "CHANGED 3";
    edited[35] = "CHANGED 36";
    w(r, "f.txt", edited.join("\n") + "\n");
    const full = (await G.diff(r, { path: "f.txt", context: 1 })).diff;
    // Keep the header and only the first hunk.
    const parts = full.split(/^(?=@@ )/m);
    expect(parts.length).toBe(3);
    const firstHunkPatch = parts[0] + parts[1];
    await G.applyPatch(r, firstHunkPatch, { cached: true });
    const staged = (await G.diff(r, { path: "f.txt", staged: true })).diff;
    expect(staged).toContain("+CHANGED 3");
    expect(staged).not.toContain("CHANGED 36");
    const unstaged = (await G.diff(r, { path: "f.txt" })).diff;
    expect(unstaged).toContain("+CHANGED 36");
    expect(unstaged).not.toContain("+CHANGED 3\n");
    await G.applyPatch(r, firstHunkPatch, { cached: true, reverse: true });
    expect((await G.diff(r, { path: "f.txt", staged: true })).diff).toBe("");
  });

  test("discarding one hunk from the working tree leaves the other", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const r = makeRepo({ "f.txt": lines.join("\n") + "\n" });
    const edited = [...lines];
    edited[2] = "CHANGED 3";
    edited[35] = "CHANGED 36";
    w(r, "f.txt", edited.join("\n") + "\n");
    const parts = (await G.diff(r, { path: "f.txt", context: 1 })).diff.split(/^(?=@@ )/m);
    await G.applyPatch(r, parts[0] + parts[1], { reverse: true });
    const now = fs.readFileSync(path.join(r, "f.txt"), "utf-8");
    expect(now).toContain("line 3\n");
    expect(now).toContain("CHANGED 36");
  });

  test("a bad patch is a clear error and changes nothing", async () => {
    const r = makeRepo();
    await expect(G.applyPatch(r, "not a patch", { cached: true })).rejects.toThrow();
    await expect(G.applyPatch(r, "  ", {})).rejects.toThrow(/Empty/);
    expect((await G.status(r)).files).toEqual([]);
  });
});

describe("commit", () => {
  test("commits what is staged, returns the sha and subject", async () => {
    const r = makeRepo();
    w(r, "a.txt", "changed\n");
    w(r, "other.txt", "o\n");
    await G.stage(r, ["a.txt"]);
    const c = await G.commit(r, "feat: change a\n\nbody line");
    expect(c.summary).toBe("feat: change a");
    expect(c.sha).toBe(sh("git rev-parse HEAD", r));
    expect(sh("git log -1 --format=%b", r)).toBe("body line");
    expect((await G.status(r)).files.map((f) => f.path)).toEqual(["other.txt"]); // the unstaged file stayed out
  });

  test("an empty message is refused; nothing staged says so; amend rewrites the last commit", async () => {
    const r = makeRepo();
    await expect(G.commit(r, "  ")).rejects.toThrow(/message is required/);
    await expect(G.commit(r, "nothing")).rejects.toThrow(/nothing|no changes/i);
    w(r, "a.txt", "x\n");
    await G.stage(r, ["a.txt"]);
    await G.commit(r, "first");
    const before = sh("git rev-list --count HEAD", r);
    await G.commit(r, "reworded", { amend: true });
    expect(sh("git rev-list --count HEAD", r)).toBe(before);
    expect(sh("git log -1 --format=%s", r)).toBe("reworded");
  });

  test("a failing pre-commit hook blocks the commit and its output reaches the caller; noVerify bypasses it", async () => {
    const r = makeRepo();
    fs.writeFileSync(path.join(r, ".git/hooks/pre-commit"), "#!/bin/sh\necho 'lint failed: no semicolons' >&2\nexit 1\n", { mode: 0o755 });
    w(r, "a.txt", "x\n");
    await G.stage(r, ["a.txt"]);
    await expect(G.commit(r, "blocked")).rejects.toThrow(/lint failed/);
    expect((await G.commit(r, "skipped", { noVerify: true })).summary).toBe("skipped");
  });
});

describe("branches", () => {
  test("list, create, switch, delete", async () => {
    const r = makeRepo();
    await G.createBranch(r, "feature/x");
    expect((await G.status(r)).branch).toBe("feature/x");
    await G.createBranch(r, "other", { checkout: false });
    const list = await G.branches(r);
    expect(list.filter((b) => !b.remote).map((b) => b.name).sort()).toEqual(["feature/x", "main", "other"]);
    expect(list.find((b) => b.current)!.name).toBe("feature/x");
    await G.checkout(r, "main");
    await G.deleteBranch(r, "other");
    expect((await G.branches(r)).some((b) => b.name === "other")).toBe(false);
  });

  test("an unmerged branch needs force to delete; bad names are refused", async () => {
    const r = makeRepo();
    await G.createBranch(r, "wip");
    w(r, "w.txt", "w\n");
    commitAll(r, "wip commit");
    await G.checkout(r, "main");
    await expect(G.deleteBranch(r, "wip")).rejects.toThrow(/not fully merged/);
    await G.deleteBranch(r, "wip", true);
    for (const bad of ["-x", "a b", "a..b", "x.lock", "a~1", "", "--force"]) await expect(G.createBranch(r, bad)).rejects.toThrow(/valid branch name/);
  });

  test("switching with conflicting local changes is refused with git's own message", async () => {
    const r = makeRepo({ "a.txt": "base\n" });
    await G.createBranch(r, "other");
    w(r, "a.txt", "other\n");
    commitAll(r, "other edit");
    await G.checkout(r, "main");
    w(r, "a.txt", "dirty\n");
    await expect(G.checkout(r, "other")).rejects.toThrow(/overwritten|local changes/i);
  });

  test("ahead/behind and upstream appear for a tracking branch; remote branches can be checked out", async () => {
    const { repo, bare } = repoWithRemote();
    w(repo, "x.txt", "x\n");
    commitAll(repo, "ahead by one");
    const main = (await G.branches(repo)).find((b) => b.name === "main")!;
    expect(main).toMatchObject({ upstream: "origin/main", ahead: 1, behind: 0 });
    await G.push(repo);
    sh("git switch -c feat && echo f > f.txt && git add -A && git " + ID + " commit -qm f && git push -q origin feat && git switch main && git branch -D feat", repo);
    await G.fetchRemote(repo);
    const remotes = (await G.branches(repo)).filter((b) => b.remote).map((b) => b.name);
    expect(remotes).toContain("origin/feat");
    await G.checkoutRemote(repo, "origin/feat");
    expect((await G.status(repo))).toMatchObject({ branch: "feat", upstream: "origin/feat" });
    void bare;
  });
});

describe("merge and conflicts", () => {
  function conflicted() {
    const r = makeRepo({ "a.txt": "base\n" });
    sh("git switch -q -c topic", r);
    w(r, "a.txt", "topic\n");
    commitAll(r, "topic edit");
    sh("git switch -q main", r);
    w(r, "a.txt", "main\n");
    commitAll(r, "main edit");
    return r;
  }

  test("a clean merge", async () => {
    const r = makeRepo({ "a.txt": "base\n" });
    sh("git switch -q -c topic", r);
    w(r, "b.txt", "b\n");
    commitAll(r, "add b");
    sh("git switch -q main", r);
    const res = await G.merge(r, "topic");
    expect(res.conflicts).toBe(false);
    expect(fs.existsSync(path.join(r, "b.txt"))).toBe(true);
  });

  test("a conflicting merge is a state, not an error: status shows it, abort restores", async () => {
    const r = conflicted();
    const res = await G.merge(r, "topic");
    expect(res.conflicts).toBe(true);
    const s = await G.status(r);
    expect(s.operation).toBe("merge");
    expect(s.files.find((f) => f.path === "a.txt")).toMatchObject({ conflict: "UU" });
    expect(fs.readFileSync(path.join(r, "a.txt"), "utf-8")).toContain("<<<<<<<");
    await G.abortOperation(r, "merge");
    expect((await G.status(r)).operation).toBeNull();
    expect(fs.readFileSync(path.join(r, "a.txt"), "utf-8")).toBe("main\n");
  });

  test("resolve by taking a side stages the file", async () => {
    const r = conflicted();
    await G.merge(r, "topic");
    await G.resolveConflict(r, "a.txt", "theirs");
    expect(fs.readFileSync(path.join(r, "a.txt"), "utf-8")).toBe("topic\n");
    const resolved = (await G.status(r)).files.find((f) => f.path === "a.txt")!;
    expect(resolved).toMatchObject({ index: "M", worktree: "." });
    expect(resolved).not.toHaveProperty("conflict");
    const c = await G.commit(r, "merge topic");
    expect(c.summary).toBe("merge topic");
    expect((await G.status(r)).operation).toBeNull();
  });
});

describe("history", () => {
  test("log with parents, refs and pagination; a commit's changed files including a rename", async () => {
    const r = makeRepo({ "a.txt": "a\n" });
    for (const n of [1, 2, 3]) {
      w(r, `f${n}.txt`, `${n}\n`);
      commitAll(r, `commit ${n}`);
    }
    sh("git mv f1.txt renamed.txt", r);
    commitAll(r, "rename");
    const all = await G.log(r);
    expect(all.map((c) => c.subject)).toEqual(["rename", "commit 3", "commit 2", "commit 1", "init"]);
    expect(all[0].refs.join(" ")).toContain("main");
    expect(all[0].parents).toEqual([all[1].sha]);
    expect(all.at(-1)!.parents).toEqual([]);
    expect((await G.log(r, { limit: 2, skip: 1 })).map((c) => c.subject)).toEqual(["commit 3", "commit 2"]);
    expect((await G.log(r, { path: "f2.txt" })).map((c) => c.subject)).toEqual(["commit 2"]);
    const d = await G.commitDetail(r, all[0].sha);
    expect(d.files).toEqual([{ status: "R", origPath: "f1.txt", path: "renamed.txt" }]);
    expect(d.subject).toBe("rename");
  });

  test("an empty repo has an empty log, not an error", async () => {
    // A bare `git init`, not G.init: G.init makes an "Initial commit" so worktrees have a base.
    const d = makeDir();
    sh("git init -q -b main .", d);
    expect(await G.log(d)).toEqual([]);
  });

  test("init gives the repo one parentless Initial commit", async () => {
    const d = makeDir();
    await G.init(d);
    const all = await G.log(d);
    expect(all.map((c) => c.subject)).toEqual(["Initial commit"]);
    expect(all[0].parents).toEqual([]);
  });
});

describe("stash", () => {
  test("push, list, apply, pop, drop", async () => {
    const r = makeRepo({ "a.txt": "base\n" });
    w(r, "a.txt", "work in progress\n");
    w(r, "u.txt", "untracked\n");
    await G.stashPush(r, { message: "wip", includeUntracked: true });
    expect(fs.readFileSync(path.join(r, "a.txt"), "utf-8")).toBe("base\n");
    expect(fs.existsSync(path.join(r, "u.txt"))).toBe(false);
    const list = await G.stashList(r);
    expect(list).toHaveLength(1);
    expect(list[0].message).toContain("wip");
    expect((await G.status(r)).stashCount).toBe(1);
    await G.stashOp(r, "apply", 0);
    expect(fs.readFileSync(path.join(r, "a.txt"), "utf-8")).toBe("work in progress\n");
    expect(await G.stashList(r)).toHaveLength(1); // apply keeps it
    sh("git checkout -- . && git clean -fdq", r);
    await G.stashOp(r, "pop", 0);
    expect(await G.stashList(r)).toHaveLength(0);
    await expect(G.stashOp(r, "drop", -1)).rejects.toThrow(/Bad stash index/);
  });
});

describe("remotes", () => {
  test("push sets upstream on a new branch; pull fast-forwards; a diverged pull is refused", async () => {
    const { repo, bare } = repoWithRemote();
    await G.createBranch(repo, "feature");
    w(repo, "f.txt", "f\n");
    commitAll(repo, "feature work");
    await G.push(repo, { setUpstream: true, branch: "feature" });
    expect((await G.status(repo)).upstream).toBe("origin/feature");

    // Someone else pushes to main; we pull it.
    const other = makeDir();
    sh(`git clone -q ${bare} .`, other);
    w(other, "theirs.txt", "t\n");
    sh(`git add -A && git ${ID} commit -qm theirs && git push -q origin main`, other);
    await G.checkout(repo, "main");
    await G.fetchRemote(repo);
    expect((await G.status(repo)).behind).toBe(1);
    await G.pull(repo);
    expect(fs.existsSync(path.join(repo, "theirs.txt"))).toBe(true);

    // Now diverge: local commit + remote commit.
    w(repo, "mine.txt", "m\n");
    commitAll(repo, "mine");
    w(other, "theirs2.txt", "t2\n");
    sh(`git add -A && git ${ID} commit -qm theirs2 && git push -q origin main`, other);
    await G.fetchRemote(repo);
    await expect(G.pull(repo)).rejects.toThrow(/fast-forward|diverg/i);
  });

  test("push to an unreachable remote fails fast with a message, never a prompt", async () => {
    const r = makeRepo();
    sh("git remote add origin /definitely/not/a/repo", r);
    const t0 = Date.now();
    await expect(G.push(r, { setUpstream: true, branch: "main" })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe("worktrees", () => {
  test("lists the main checkout and linked worktrees", async () => {
    const r = makeRepo();
    const wt = path.join(makeDir(), "wt");
    sh(`git worktree add -q -b side ${wt}`, r);
    const list = await G.worktrees(r);
    expect(list).toHaveLength(2);
    expect(list.map((x) => x.branch).sort()).toEqual(["main", "side"]);
  });
});

void os;

describe("publish to GitHub", () => {
  test("rejects bad names, non-repos, existing origin and empty repos before touching gh", async () => {
    const r = makeRepo({ "a.txt": "a" });
    await expect(G.publishRepo(r, { name: "bad name!", visibility: "private" })).rejects.toThrow(/not a valid repository name/);
    await expect(G.publishRepo(r, { name: "ok", visibility: "secret" as any })).rejects.toThrow(/private or public/);
    await expect(G.publishRepo(makeDir(), { name: "ok", visibility: "private" })).rejects.toThrow(/not a git repository/);
    const { repo } = repoWithRemote();
    await expect(G.publishRepo(repo, { name: "ok", visibility: "public" })).rejects.toThrow(/already has an "origin"/);
    const empty = makeDir();
    sh("git init -q -b main", empty);
    await expect(G.publishRepo(empty, { name: "ok", visibility: "private" })).rejects.toThrow(/no commit/);
  });
});
