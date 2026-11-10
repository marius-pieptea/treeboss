import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { WorktreeManager, git, mergePatch, repoRootOf } from "../src/git/worktree";

let repo: string;
const sh = (cmd: string, cwd: string) => {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};
const G = `git -c user.email=t@t -c user.name=t -c commit.gpgsign=false`;

function newRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-repo-"));
  sh(`git init -q -b main . && echo one > a.txt && mkdir sub && echo two > sub/b.txt && ${G} add -A && ${G} commit -qm init`, dir);
  return dir;
}

beforeAll(() => {
  repo = newRepo();
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("prepare", () => {
  test("returns null outside a git repo", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "trb-plain-"));
    expect(new WorktreeManager(plain).prepare({ sessionId: "s_aaaaaaaaaa", label: "x" })).toBeNull();
    expect(repoRootOf(plain)).toBeNull();
  });

  test("creates a worktree OUTSIDE the repo, on its own branch, and never touches the checkout", () => {
    const wt = new WorktreeManager(repo).prepare({ sessionId: "s_wt00000001", label: "worker" })!;
    expect(wt.root.startsWith(repo)).toBe(false);
    expect(wt.branch).toBe("trb/worker/wt00000001");
    expect(fs.readFileSync(path.join(wt.cwd, "a.txt"), "utf-8")).toBe("one\n");
    expect(sh("git status --short", repo)).toBe("");
    new WorktreeManager(repo).cleanup(wt);
    expect(fs.existsSync(wt.root)).toBe(false);
    expect(git(["rev-parse", "--verify", "--quiet", wt.branch], repo).ok).toBe(true); // the branch outlives the checkout
  });

  test("replays the operator's uncommitted work as a baseline, so it is not the agent's diff", () => {
    const dirty = newRepo();
    fs.writeFileSync(path.join(dirty, "a.txt"), "edited\n");
    fs.writeFileSync(path.join(dirty, "new.txt"), "untracked\n");
    const wt = new WorktreeManager(dirty).prepare({ sessionId: "s_wt00000002", label: "x" })!;
    expect(fs.readFileSync(path.join(wt.cwd, "a.txt"), "utf-8")).toBe("edited\n");
    expect(fs.readFileSync(path.join(wt.cwd, "new.txt"), "utf-8")).toBe("untracked\n");
    expect(wt.notes.join(" ")).toContain("baseline");
    // Nothing changed since the baseline, so finalize commits nothing: the replay is not "work".
    const d = new WorktreeManager(dirty).finalize(wt, { title: "t", label: "x", sessionId: "s_wt00000002" });
    expect(d.committed).toBe(false);
    new WorktreeManager(dirty).cleanup(wt);
  });

  test("a monorepo subdirectory maps to the same subdirectory inside the worktree", () => {
    const wt = new WorktreeManager(path.join(repo, "sub")).prepare({ sessionId: "s_wt00000003", label: "x" })!;
    expect(wt.cwd.endsWith(path.join("", "sub"))).toBe(true);
    expect(fs.existsSync(path.join(wt.cwd, "b.txt"))).toBe(true);
    new WorktreeManager(repo).cleanup(wt);
  });

  test("re-preparing the same session continues the same branch", () => {
    const m = new WorktreeManager(repo);
    const a = m.prepare({ sessionId: "s_wt00000004", label: "x" })!;
    const b = m.prepare({ sessionId: "s_wt00000004", label: "x" })!;
    expect(b.reused).toBe(true);
    expect(b.root).toBe(a.root);
    m.cleanup(a);
  });

  test("copies .env files and, with worktree_deps=link, links node_modules; neither lands in a commit", () => {
    const r = newRepo();
    fs.writeFileSync(path.join(r, ".env.local"), "SECRET=1\n");
    fs.mkdirSync(path.join(r, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(r, ".gitignore"), "");
    const m = new WorktreeManager(r);
    const wt = m.prepare({ sessionId: "s_wt00000005", label: "x", deps: "link" })!;
    expect(fs.readFileSync(path.join(wt.cwd, ".env.local"), "utf-8")).toBe("SECRET=1\n");
    expect(fs.lstatSync(path.join(wt.cwd, "node_modules")).isSymbolicLink()).toBe(true);
    fs.writeFileSync(path.join(wt.cwd, "real.txt"), "work\n");
    const d = m.finalize(wt, { title: "t", label: "x", sessionId: "s_wt00000005" });
    expect(d.committed).toBe(true);
    const files = sh(`git show --name-only --format= ${d.headSha}`, wt.root).split("\n");
    expect(files).toEqual(["real.txt"]); // no .env.local, no node_modules symlink
    m.cleanup(wt);
  });

  // An `npm ci` in a head empties node_modules first; through the old shared symlink that emptied the operator's
  // checkout (reproduced with npm 11: the repo's folder left empty, its mtime changed, the link itself deleted).
  test("by default node_modules is never a link into the repo: an installer emptying the head's copy leaves the repo's alone", () => {
    const r = newRepo();
    fs.mkdirSync(path.join(r, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(r, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(r, ".gitignore"), "node_modules\n");
    const m = new WorktreeManager(r);
    const wt = m.prepare({ sessionId: "s_wt00000015", label: "x" })!;
    const nm = path.join(wt.cwd, "node_modules");
    if (fs.existsSync(nm)) {
      expect(fs.lstatSync(nm).isSymbolicLink()).toBe(false);
      if (process.platform === "darwin") expect(fs.readFileSync(path.join(nm, "pkg", "index.js"), "utf-8")).toBe("module.exports = 1;\n");
      for (const e of fs.readdirSync(nm)) fs.rmSync(path.join(nm, e), { recursive: true, force: true }); // what npm ci does first
    }
    expect(fs.readFileSync(path.join(r, "node_modules", "pkg", "index.js"), "utf-8")).toBe("module.exports = 1;\n");
    m.cleanup(wt);
    expect(fs.existsSync(path.join(r, "node_modules", "pkg", "index.js"))).toBe(true);
  });

  test("a worktree whose lockfile differs from the repo's gets no node_modules: the repo's would not fit it", () => {
    const r = newRepo();
    fs.mkdirSync(path.join(r, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(r, ".gitignore"), "node_modules\n");
    fs.writeFileSync(path.join(r, "package-lock.json"), '{"v":1}\n');
    sh(`${G} add -A && ${G} commit -qm v1`, r);
    const v1 = sh("git rev-parse HEAD", r);
    fs.writeFileSync(path.join(r, "package-lock.json"), '{"v":2}\n');
    sh(`${G} commit -qam v2`, r);
    const m = new WorktreeManager(r);
    const wt = m.prepare({ sessionId: "s_wt00000016", label: "x", startRef: v1 })!; // a checkpoint before the lockfile changed
    expect(fs.existsSync(path.join(wt.cwd, "node_modules"))).toBe(false);
    expect(wt.notes.join(" ")).toContain("lockfile differs");
    m.cleanup(wt);
  });

  test("worktree_deps=off gives the worktree no node_modules", () => {
    const r = newRepo();
    fs.mkdirSync(path.join(r, "node_modules", "pkg"), { recursive: true });
    const m = new WorktreeManager(r);
    const wt = m.prepare({ sessionId: "s_wt00000017", label: "x", deps: "off" })!;
    expect(fs.existsSync(path.join(wt.cwd, "node_modules"))).toBe(false);
    m.cleanup(wt);
  });
});

describe("finalize", () => {
  test("commits the agent's work with the harness's identity, not the operator's", () => {
    const m = new WorktreeManager(repo);
    const wt = m.prepare({ sessionId: "s_wt00000006", label: "worker" })!;
    fs.writeFileSync(path.join(wt.cwd, "feature.ts"), "export {}\n");
    const d = m.finalize(wt, { title: "add feature", label: "worker", sessionId: "s_wt00000006", turnId: "t_1" });
    expect(d).toMatchObject({ committed: true, filesChanged: 1, insertions: 1 });
    expect(sh("git log -1 --format=%an", wt.root)).toBe("trb-agent");
    expect(sh("git log -1 --format=%B", wt.root)).toContain("Turn: t_1");
    m.cleanup(wt);
  });

  test("an unchanged worktree commits nothing", () => {
    const m = new WorktreeManager(repo);
    const wt = m.prepare({ sessionId: "s_wt00000007", label: "x" })!;
    expect(m.finalize(wt, { title: "t", label: "x", sessionId: "s_wt00000007" }).committed).toBe(false);
    m.cleanup(wt);
  });

  test("a failed turn's leftovers are kept as a wip commit, not discarded", () => {
    const m = new WorktreeManager(repo);
    const wt = m.prepare({ sessionId: "s_wt00000008", label: "x" })!;
    fs.writeFileSync(path.join(wt.cwd, "half.txt"), "half done\n");
    m.finalize(wt, { title: "task", label: "x", sessionId: "s_wt00000008", wip: true });
    expect(sh("git log -1 --format=%s", wt.root)).toBe("wip: task");
    m.cleanup(wt);
  });

  test("trb's own scaffold files are unstaged unless the repo tracks them", () => {
    const m = new WorktreeManager(repo);
    const wt = m.prepare({ sessionId: "s_wt00000009", label: "x" })!;
    fs.mkdirSync(path.join(wt.cwd, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(wt.cwd, ".cursor", "mcp.json"), "{}");
    fs.mkdirSync(path.join(wt.cwd, ".claude", "skills", "s1"), { recursive: true });
    fs.writeFileSync(path.join(wt.cwd, ".claude", "skills", "s1", "SKILL.md"), "x");
    fs.writeFileSync(path.join(wt.cwd, "real.txt"), "work\n");
    const d = m.finalize(wt, { title: "t", label: "x", sessionId: "s_wt00000009" });
    expect(sh(`git show --name-only --format= ${d.headSha}`, wt.root)).toBe("real.txt");
    m.cleanup(wt);
  });
});

describe("mergePatch", () => {
  test("applies a worktree's committed changes to another checkout as uncommitted edits", () => {
    const m = new WorktreeManager(repo);
    const wt = m.prepare({ sessionId: "s_wt00000010", label: "x" })!;
    fs.writeFileSync(path.join(wt.cwd, "a.txt"), "changed by child\n");
    fs.writeFileSync(path.join(wt.cwd, "added.txt"), "new\n");
    const d = m.finalize(wt, { title: "t", label: "x", sessionId: "s_wt00000010" });
    const res = mergePatch({ fromGitRoot: wt.gitRoot, baseSha: wt.baseSha, headSha: d.headSha!, targetDir: repo });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf-8")).toBe("changed by child\n");
    expect(sh("git status --short", repo)).toContain("added.txt");
    expect(sh("git log --oneline | wc -l", repo)).toBe("1"); // nothing was committed in the target
    sh("git checkout -- . && git clean -fdq", repo);
    m.cleanup(wt);
  });

  test("a conflicting patch changes nothing and says why", () => {
    const r = newRepo();
    const m = new WorktreeManager(r);
    const wt = m.prepare({ sessionId: "s_wt00000011", label: "x" })!;
    fs.writeFileSync(path.join(wt.cwd, "a.txt"), "child version\n");
    const d = m.finalize(wt, { title: "t", label: "x", sessionId: "s_wt00000011" });
    fs.writeFileSync(path.join(r, "a.txt"), "parent moved on\n"); // the parent edited the same line meanwhile
    const res = mergePatch({ fromGitRoot: wt.gitRoot, baseSha: wt.baseSha, headSha: d.headSha!, targetDir: r });
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(path.join(r, "a.txt"), "utf-8")).toBe("parent moved on\n");
    m.cleanup(wt);
  });
});

describe("sweep", () => {
  test("removes worktrees nobody owns and spares live ones", () => {
    const r = newRepo();
    const m = new WorktreeManager(r);
    const keep = m.prepare({ sessionId: "s_keepkeepke", label: "x" })!;
    const drop = m.prepare({ sessionId: "s_dropdropdr", label: "x" })!;
    const removed = WorktreeManager.sweep((short) => short === "keepkeepke");
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(keep.root)).toBe(true);
    expect(fs.existsSync(drop.root)).toBe(false);
    m.cleanup(keep);
  });
});
