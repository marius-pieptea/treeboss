/**
 * Per-session git worktrees: how a subagent's coding work is isolated and delivered.
 *
 * Ported from Omni's `harness/worktree.ts`. Without this, two agents on one repo
 * trample each other, a re-run overwrites the previous attempt, and the only
 * record of a night's work is a dirty working tree nobody can attribute.
 *
 * Four properties this file exists to guarantee:
 *
 *   1. The operator's checkout is never written to. The worktree lives under
 *      trb's home, not inside the repo, so the agent's greps and indexers cannot
 *      see it and it can never be committed by accident. The only lasting effect
 *      on the repo is a branch.
 *   2. The agent sees what the operator sees. `git worktree add` alone checks out
 *      HEAD and silently hides uncommitted work, so dirty state is replayed into
 *      the fresh worktree and committed as a baseline (which also keeps it out of
 *      the session's own diffstat).
 *   3. Nothing is silently discarded. Whatever the agent leaves uncommitted is
 *      committed to the branch before the worktree is removed, after a failed or
 *      interrupted turn too, as a `wip:` commit.
 *   4. A re-run continues the same branch (keyed on the session id).
 *
 * Deliberately not here: pushing, remotes, pull requests. A branch is the unit of
 * delivery; publishing it is a separate, opt-in step.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { paths } from "../paths";
import { slug } from "../util";

const MAX_UNTRACKED_FILES = 2000;
const MAX_UNTRACKED_BYTES = 200 * 1024 * 1024;
/** Every git call is local-only, so a slow one means a wedged lock, not a slow network. */
const GIT_TIMEOUT_MS = 120_000;
/** Project setup commands are the one thing here that can legitimately take minutes. */
const SETUP_TIMEOUT_MS = 600_000;

export interface WorktreeSession {
  gitRoot: string;
  root: string;
  /** Where the agent runs: `root` plus the subdirectory the workspace pointed at. */
  cwd: string;
  branch: string;
  /** Commit the session starts from; diffstats are measured against it. */
  baseSha: string;
  reused: boolean;
  notes: string[];
}

export interface WorktreeDelivery {
  branch: string;
  baseSha: string;
  headSha: string | null;
  committed: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Files trb itself may write into a workspace (MCP config, materialised skills).
 * `unstageScaffolding` takes any of them back out of a commit unless the repo
 * already tracked them at the base.
 */
export const SCAFFOLD_PATHS = [".cursor/mcp.json", ".claude/skills", ".agents/skills", ".cursor/skills", ".grok/skills"];

/**
 * `spawnSync`, so two sessions in one daemon cannot interleave `worktree add` /
 * `remove` / `prune` on the same repo — exactly the race that corrupts
 * `worktrees/` and `packed-refs.lock`. The turn-end checkpoints queue their writes per
 * repository (`serialize` in git/run.ts); close waits on that queue before it runs this.
 */
export function git(args: string[], cwd: string, input?: Buffer | string): GitResult {
  const res = spawnSync("git", args, { cwd, input, encoding: "utf-8", windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
  return { ok: res.status === 0, stdout: (res.stdout || "").toString(), stderr: (res.stderr || "").toString() };
}

/** Same call, raw bytes out: a patch with binary hunks must not go through utf-8. */
export function gitBytes(args: string[], cwd: string, input?: Buffer): { ok: boolean; stdout: Buffer; stderr: string } {
  const res = spawnSync("git", args, { cwd, input, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
  return { ok: res.status === 0, stdout: (res.stdout as Buffer) || Buffer.alloc(0), stderr: (res.stderr || "").toString() };
}

export function repoRootOf(dir: string): string | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const res = git(["rev-parse", "--show-toplevel"], dir);
  return res.ok && res.stdout.trim() ? path.resolve(res.stdout.trim()) : null;
}

export function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Sandbox root for one repo, namespaced so two repos of the same name cannot collide. */
function repoWorktreeDir(gitRoot: string): string {
  const fingerprint = crypto.createHash("sha1").update(path.resolve(gitRoot)).digest("hex").slice(0, 8);
  return path.join(paths.worktrees(), `${slug(path.basename(gitRoot))}-${fingerprint}`);
}

export class WorktreeManager {
  private readonly targetPath: string;

  constructor(targetPath: string) {
    this.targetPath = path.resolve(targetPath);
  }

  gitRoot(): string | null {
    return repoRootOf(this.targetPath);
  }

  /**
   * Build (or re-enter) the sandbox for one session. Returns null when there is
   * nothing to sandbox (not a git repo, or git is unusable): the caller then runs
   * in a plain directory, because failing a run over a plain folder would be absurd.
   */
  prepare(options: { sessionId: string; label: string; setupCmd?: string | null; /** How node_modules reaches the worktree (worktree_deps); default "clone". */ deps?: DepsMode | null; onLog?: (msg: string) => void; /** Start a NEW branch at this commit (a checkpoint) instead of HEAD; the dirty checkout is then not replayed. */ startRef?: string | null }): WorktreeSession | null {
    const gitRoot = this.gitRoot();
    if (!gitRoot) return null;

    const log = options.onLog || (() => {});
    const notes: string[] = [];
    const shortId = options.sessionId.replace(/^s_/, "").slice(0, 10);
    const branch = `trb/${slug(options.label)}/${shortId}`;
    const root = path.join(repoWorktreeDir(gitRoot), shortId);
    // Through realpath: on macOS a path under /var compared with git's /private/var looks like
    // a path outside the repo, and the agent would silently lose its subdirectory.
    const relSubdir = path.relative(gitRoot, realpath(this.targetPath));

    // A crashed daemon leaves the worktree registered but possibly gone from disk.
    git(["worktree", "prune"], gitRoot);

    let reused = false;
    if (fs.existsSync(root) && this.isRegisteredWorktree(gitRoot, root)) {
      reused = true;
      log(`[worktree] continuing branch "${branch}".`);
    } else {
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(root), { recursive: true });

      const branchExists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], gitRoot).ok;
      const add = branchExists ? git(["worktree", "add", root, branch], gitRoot) : git(["worktree", "add", "-b", branch, root, options.startRef || "HEAD"], gitRoot);
      if (!add.ok) {
        // No fallback to a bare directory: that once left an agent working in an empty folder
        // that looked like a sandbox and contained none of the repo.
        log(`[worktree] could not create a worktree: ${add.stderr.trim() || "unknown error"}`);
        return null;
      }
      reused = branchExists;
      log(`[worktree] ${branchExists ? "re-checked out" : "created"} branch "${branch}".`);

      // Only on a fresh branch: an existing one already carries what was replayed the first time.
      if (!branchExists && !options.startRef) {
        const replayed = this.replayDirtyState(gitRoot, root);
        if (replayed) notes.push(replayed);
      }
    }

    notes.push(...this.materializeEnvironment(gitRoot, root, options.setupCmd, options.deps ?? "clone", log));

    const baseSha = git(["rev-parse", "HEAD"], root).stdout.trim();
    const cwd = relSubdir && !relSubdir.startsWith("..") ? path.join(root, relSubdir) : root;
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
    for (const note of notes) log(`[worktree] ${note}`);
    return { gitRoot, root, cwd, branch, baseSha, reused, notes };
  }

  /**
   * Commit whatever the agent left behind and measure it. Called for failed and
   * interrupted turns too: half-finished work on a branch is recoverable and honest;
   * discarding it with the worktree is the one outcome that cannot be undone.
   */
  finalize(session: WorktreeSession, options: { title: string; label: string; sessionId: string; turnId?: string; wip?: boolean }): WorktreeDelivery {
    const empty: WorktreeDelivery = {
      branch: session.branch,
      baseSha: session.baseSha,
      headSha: session.baseSha || null,
      committed: false,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      summary: `No file changes on ${session.branch}.`,
    };
    if (!fs.existsSync(session.root)) return empty;

    git(["add", "-A"], session.root);
    this.unstageScaffolding(session);
    const staged = git(["diff", "--cached", "--quiet"], session.root);
    // `--quiet` exits 1 when there IS something staged.
    if (staged.ok) return empty;

    const title = options.title.replace(/\s+/g, " ").trim().slice(0, 68) || "agent turn";
    const identity = `${slug(options.label)}@trb.local`;
    const commit = git(
      [
        // The commit is the harness's, not the operator's: attributing it to whoever's git config
        // is on this machine would put their name on code they have not read. gpgsign off because
        // a signing prompt in a background daemon hangs the turn forever.
        "-c", "user.name=trb-agent",
        "-c", `user.email=${identity}`,
        "-c", "commit.gpgsign=false",
        "commit", "--no-verify",
        "-m", `${options.wip ? "wip: " : ""}${title}`,
        "-m", [`Session: ${options.sessionId}`, options.turnId ? `Turn: ${options.turnId}` : null].filter(Boolean).join("\n"),
      ],
      session.root,
    );
    if (!commit.ok) return { ...empty, summary: `Could not commit on ${session.branch}: ${commit.stderr.trim().slice(0, 160)}` };

    const headSha = git(["rev-parse", "HEAD"], session.root).stdout.trim();
    const stats = this.diffStat(session.root, session.baseSha, headSha);
    return {
      branch: session.branch,
      baseSha: session.baseSha,
      headSha,
      committed: true,
      ...stats,
      summary: `${options.wip ? "Committed work-in-progress" : "Committed"} to ${session.branch}: ${stats.filesChanged} file(s), +${stats.insertions}/-${stats.deletions} (${headSha.slice(0, 8)}).`,
    };
  }

  /** Drop the worktree, keep the branch: the branch holds the work, the checkout is disposable. */
  cleanup(session: Pick<WorktreeSession, "root" | "gitRoot">): void {
    const removed = git(["worktree", "remove", "--force", session.root], session.gitRoot);
    if (!removed.ok && fs.existsSync(session.root)) {
      try {
        fs.rmSync(session.root, { recursive: true, force: true });
      } catch {}
      git(["worktree", "prune"], session.gitRoot);
    }
  }

  /* ---- internals -------------------------------------------------------- */

  /**
   * Take trb's own files back out of the commit. A linked `node_modules` is a symlink, i.e. a
   * FILE to git: the usual `node_modules/` ignore rule (directories only) does not match it
   * and `git add -A` committed it; merging that commit into a checkout with a real
   * node_modules made git delete the folder to put the link there. Copied `.env*` files are
   * local secrets and never belong on a branch. Scaffold paths go unless the base tracked them.
   */
  private unstageScaffolding(session: WorktreeSession): void {
    const drop: string[] = [];
    for (const dir of new Set([session.root, session.cwd])) {
      const nm = path.join(dir, "node_modules");
      try {
        if (fs.lstatSync(nm).isSymbolicLink()) drop.push(path.relative(session.root, nm) || "node_modules");
      } catch {}
    }
    try {
      for (const entry of fs.readdirSync(session.root)) {
        if (!entry.startsWith(".env")) continue;
        if (!git(["cat-file", "-e", `${session.baseSha}:${entry}`], session.root).ok) drop.push(entry);
      }
    } catch {}
    for (const rel of SCAFFOLD_PATHS) {
      if (!fs.existsSync(path.join(session.cwd, rel))) continue;
      const relToRoot = path.relative(session.root, path.join(session.cwd, rel));
      // Tracked at the base: the repo's own file, not ours. Only the files trb added
      // (untracked at base) leave the commit; modified tracked files were restored by cleanup.
      const listed = git(["ls-tree", "-r", "--name-only", session.baseSha, "--", relToRoot], session.root).stdout.trim();
      if (!listed) drop.push(relToRoot);
    }
    if (drop.length > 0) git(["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ...drop], session.root);
  }

  private isRegisteredWorktree(gitRoot: string, worktreePath: string): boolean {
    const res = git(["worktree", "list", "--porcelain"], gitRoot);
    if (!res.ok) return false;
    return res.stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .some((l) => realpath(l.replace("worktree ", "").trim()) === realpath(worktreePath));
  }

  /**
   * Carry the operator's uncommitted work into a fresh worktree. Tracked edits go as one patch
   * (`--binary`, so images and lockfile blobs survive); untracked files are copied, bounded,
   * with `--exclude-standard` doing the heavy lifting. Both land as one baseline commit, which
   * keeps the session's diffstat honest: otherwise every line the operator had in flight would
   * be attributed to the agent.
   */
  private replayDirtyState(gitRoot: string, worktreePath: string): string | null {
    let trackedApplied = false;
    let untrackedCopied = 0;
    let skipped = 0;

    const patch = gitBytes(["diff", "HEAD", "--binary"], gitRoot);
    if (patch.ok && patch.stdout.length > 0) {
      const applied = git(["apply", "--index", "--whitespace=nowarn", "-"], worktreePath, patch.stdout);
      trackedApplied = applied.ok;
      if (!applied.ok) skipped++;
    }

    const listed = git(["ls-files", "--others", "--exclude-standard", "-z"], gitRoot);
    if (listed.ok) {
      let bytes = 0;
      const relPaths = listed.stdout
        .split("\0")
        .filter(Boolean)
        // trb's own scaffolding is not the operator's work; a child cut from a parent's
        // checkout must not inherit the parent's generated files.
        .filter((rel) => !SCAFFOLD_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`)));
      for (const rel of relPaths) {
        if (untrackedCopied >= MAX_UNTRACKED_FILES || bytes >= MAX_UNTRACKED_BYTES) {
          skipped++;
          continue;
        }
        const from = path.join(gitRoot, rel);
        const to = path.join(worktreePath, rel);
        try {
          const stat = fs.statSync(from);
          if (!stat.isFile()) continue;
          if (bytes + stat.size > MAX_UNTRACKED_BYTES) {
            skipped++;
            continue;
          }
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
          bytes += stat.size;
          untrackedCopied++;
        } catch {
          skipped++;
        }
      }
    }

    if (!trackedApplied && untrackedCopied === 0) return null;
    git(["add", "-A"], worktreePath);
    if (git(["diff", "--cached", "--quiet"], worktreePath).ok) return null;
    git(
      ["-c", "user.name=trb-agent", "-c", "user.email=baseline@trb.local", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "chore: baseline — operator's uncommitted work at session start"],
      worktreePath,
    );
    const parts = [
      trackedApplied ? "replayed uncommitted edits" : null,
      untrackedCopied > 0 ? `${untrackedCopied} untracked file(s)` : null,
      skipped > 0 ? `${skipped} skipped` : null,
    ].filter(Boolean);
    return `baseline commit: ${parts.join(", ")}.`;
  }

  /**
   * Make the worktree runnable. A pristine checkout has no `.env` and no dependencies, so the
   * agent cannot run the tests it just wrote and burns turns discovering that. Local env files
   * are copied, and `node_modules` arrives per `deps`:
   * - "clone" (default): a copy-on-write clone (APFS clonefile, Linux reflink), so it costs almost no disk and an
   *   installer run in the head changes only the head's copy. Skipped when the lockfile differs from the repo's
   *   (the head's dependencies are not the repo's) or the filesystem cannot clone; the head then installs its own.
   * - "link": a symlink to the repo's folder. Shared: `npm ci` in a head empties the operator's node_modules through it.
   * - "off": nothing.
   * `worktree_setup_cmd`, when set, runs instead of all of these.
   */
  private materializeEnvironment(gitRoot: string, worktreePath: string, setupCmd: string | null | undefined, deps: DepsMode, log: (msg: string) => void): string[] {
    const notes: string[] = [];
    let copied = 0;
    try {
      for (const entry of fs.readdirSync(gitRoot)) {
        if (!entry.startsWith(".env")) continue;
        const from = path.join(gitRoot, entry);
        const to = path.join(worktreePath, entry);
        if (!fs.statSync(from).isFile() || fs.existsSync(to)) continue;
        fs.copyFileSync(from, to);
        copied++;
      }
    } catch {}
    if (copied > 0) notes.push(`copied ${copied} local env file(s) into the sandbox.`);

    const cmd = (setupCmd || "").trim();
    if (cmd) {
      const res = spawnSync(cmd, { cwd: worktreePath, shell: true, windowsHide: true, encoding: "utf-8", timeout: SETUP_TIMEOUT_MS });
      notes.push(res.status === 0 ? `ran project setup: ${cmd}` : `project setup failed (${cmd}): ${(res.stderr || "").trim().slice(0, 200)}`);
      return notes;
    }

    if (deps === "off") return notes;
    const source = path.join(gitRoot, "node_modules");
    const dest = path.join(worktreePath, "node_modules");
    // Same path, or a circular/broken source, would plant `node_modules -> node_modules` in the
    // operator's checkout. `existsSync` follows links and returns false on ELOOP, so it cannot decide this.
    if (path.resolve(source) === path.resolve(dest)) return notes;
    let sourceOk = false;
    try {
      sourceOk = fs.statSync(source).isDirectory();
    } catch {}
    let destExists = false;
    try {
      fs.lstatSync(dest);
      destExists = true;
    } catch {}
    if (!sourceOk || destExists) return notes;
    if (deps === "link") {
      try {
        fs.symlinkSync(source, dest, "junction");
        notes.push("linked node_modules from the repo (shared: an install run here changes the repo's copy).");
      } catch (err: any) {
        log(`[worktree] could not link node_modules: ${err.message}`);
      }
      return notes;
    }
    if (!lockfilesMatch(gitRoot, worktreePath)) {
      notes.push("node_modules not copied: the lockfile differs from the repo's. Install dependencies here.");
    } else if (cloneTree(source, dest)) {
      notes.push("cloned node_modules from the repo (copy-on-write: an install run here leaves the repo's copy alone).");
    } else {
      notes.push("node_modules not copied: this filesystem cannot clone copy-on-write. Install dependencies here, or set worktree_deps to link to share the repo's copy.");
    }
    return notes;
  }

  private diffStat(worktreePath: string, baseSha: string, headSha: string) {
    const stat = { filesChanged: 0, insertions: 0, deletions: 0 };
    if (!baseSha || !headSha || baseSha === headSha) return stat;
    const res = git(["diff", "--numstat", `${baseSha}..${headSha}`], worktreePath);
    if (!res.ok) return stat;
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed] = line.split("\t");
      stat.filesChanged++;
      // Binary files report "-" for both counts: real changes with no line count.
      if (added !== "-") stat.insertions += parseInt(added, 10) || 0;
      if (removed !== "-") stat.deletions += parseInt(removed, 10) || 0;
    }
    return stat;
  }

  /**
   * Remove sandboxes whose session is no longer live. Worktrees are removed after every turn,
   * so anything left is the residue of a daemon that died mid-turn.
   */
  static sweep(isLive: (shortId: string) => boolean): number {
    const rootDir = paths.worktrees();
    let removed = 0;
    for (const repoDir of fs.readdirSync(rootDir)) {
      const repoPath = path.join(rootDir, repoDir);
      let entries: string[] = [];
      try {
        if (!fs.statSync(repoPath).isDirectory()) continue;
        entries = fs.readdirSync(repoPath);
      } catch {
        continue;
      }
      for (const shortId of entries) {
        if (isLive(shortId)) continue;
        const worktreePath = path.join(repoPath, shortId);
        const gitRoot = WorktreeManager.repoOfWorktree(worktreePath);
        if (gitRoot) git(["worktree", "remove", "--force", worktreePath], gitRoot);
        if (fs.existsSync(worktreePath)) {
          try {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          } catch {}
        }
        if (gitRoot) git(["worktree", "prune"], gitRoot);
        removed++;
      }
    }
    return removed;
  }

  private static repoOfWorktree(worktreePath: string): string | null {
    try {
      const match = fs.readFileSync(path.join(worktreePath, ".git"), "utf-8").trim().match(/^gitdir:\s*(.+)$/);
      if (!match) return null;
      // .../<repo>/.git/worktrees/<name> -> <repo>
      const gitDir = match[1].trim();
      const idx = gitDir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
      return idx === -1 ? null : gitDir.slice(0, idx);
    } catch {
      return null;
    }
  }
}

export type DepsMode = "clone" | "link" | "off";

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

/** Every lockfile is byte-identical in both directories (or absent from both): the repo's node_modules fits the worktree. */
export function lockfilesMatch(a: string, b: string): boolean {
  const read = (dir: string, name: string) => {
    try {
      return fs.readFileSync(path.join(dir, name));
    } catch {
      return null;
    }
  };
  return LOCKFILES.every((name) => {
    const x = read(a, name);
    const y = read(b, name);
    return x === null || y === null ? x === y : x.equals(y);
  });
}

/**
 * Copy a directory tree copy-on-write: clonefile on macOS (`cp -c`), reflink on Linux. False, with nothing left behind,
 * where the filesystem cannot: a plain copy of node_modules would take minutes and gigabytes.
 */
export function cloneTree(from: string, to: string): boolean {
  const args = process.platform === "darwin" ? ["-c", "-R", from, to] : process.platform === "linux" ? ["-R", "--reflink=always", from, to] : null;
  if (!args) return false;
  const res = spawnSync("cp", args, { windowsHide: true, timeout: SETUP_TIMEOUT_MS });
  if (res.status === 0) return true;
  try {
    fs.rmSync(to, { recursive: true, force: true });
  } catch {}
  return false;
}

/**
 * Apply `base..head` from `fromGitRoot` onto `target`'s working tree as UNCOMMITTED edits, so
 * the parent owns them like its own. A patch that does not apply cleanly changes nothing.
 * Dependencies never travel in a merge.
 */
export function mergePatch(opts: { fromGitRoot: string; baseSha: string; headSha: string; targetDir: string }):
  | { ok: true; files: string[] }
  | { ok: false; reason: string; files: string[] } {
  const pathspec = ["--", ".", ":(exclude)node_modules", ":(exclude)**/node_modules"];
  const files = git(["diff", "--name-only", opts.baseSha, opts.headSha, ...pathspec], opts.fromGitRoot).stdout.split("\n").filter(Boolean);
  const patch = gitBytes(["diff", "--binary", opts.baseSha, opts.headSha, ...pathspec], opts.fromGitRoot);
  if (!patch.ok) return { ok: false, reason: `Could not build the patch: ${patch.stderr.slice(0, 300)}`, files };
  const check = gitBytes(["apply", "--check", "--whitespace=nowarn", "-"], opts.targetDir, patch.stdout);
  if (!check.ok) return { ok: false, reason: check.stderr.trim().slice(0, 600), files };
  const apply = gitBytes(["apply", "--whitespace=nowarn", "-"], opts.targetDir, patch.stdout);
  if (!apply.ok) return { ok: false, reason: `git apply failed: ${apply.stderr.slice(0, 300)}`, files };
  return { ok: true, files };
}
