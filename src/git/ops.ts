/**
 * Git for the UI: status, diff, staging (down to hunks), commit, branches, history, stash, remotes.
 *
 * Everything shells out to the real `git` (same results as the terminal, same hooks, same config) and
 * returns plain data. Paths are repository-relative; `prefix` tells a client where its workspace sits in
 * the repo when it is a subdirectory.
 */
import fs from "fs";
import path from "path";
import { runCmd, runGit, type RunResult } from "./run";

export class GitError extends Error {
  constructor(message: string, public status = 400, public stderr = "") {
    super(message);
  }
}

const text = (r: RunResult) => r.stdout.toString("utf-8");
const errText = (r: RunResult) => (r.stderr.toString("utf-8") || r.stdout.toString("utf-8")).trim();

/** Run git and throw its own message on failure. */
async function git(cwd: string, args: string[], o: { input?: string | Buffer; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
  const r = await runGit(args, { cwd, timeoutMs: o.timeoutMs ?? 30_000, input: o.input, env: o.env });
  if (r.timedOut) throw new GitError(`git ${args[0]} timed out.`, 504);
  if (r.code !== 0) throw new GitError(firstLines(errText(r)) || `git ${args[0]} failed (exit ${r.code}).`, 400, errText(r));
  return r;
}

function firstLines(s: string, n = 6): string {
  return s.split("\n").slice(0, n).join("\n");
}

/* -------------------------------------------------------------------------- */
/* Repo info                                                                  */
/* -------------------------------------------------------------------------- */

export interface RepoInfo {
  isRepo: boolean;
  root?: string;
  /** The workspace's own location inside the repo ("" at the top, "packages/app/" in a monorepo). */
  prefix?: string;
  remotes?: Array<{ name: string; url: string }>;
  identity?: { name: string | null; email: string | null };
  /** Set when git could not answer (not installed, refused the directory, timed out): not the same as "not a repository". */
  problem?: string;
  /** The problem is git's "dubious ownership" refusal, which `trustFolder` can resolve. */
  untrusted?: boolean;
}

/** The folder git names in its "dubious ownership" refusal, or null if that is not what the error is. */
export function dubiousPath(stderr: string): string | null {
  return /detected dubious ownership in repository at '([^']+)'/i.exec(stderr)?.[1] ?? null;
}

/** Add one folder to the user's global `safe.directory` list (once). Only ever the exact path given. */
export async function addSafeDirectory(dir: string, cwd: string = dir): Promise<void> {
  const have = await runGit(["config", "--global", "--get-all", "safe.directory"], { cwd, timeoutMs: 8000 });
  if (text(have).split("\n").some((l) => l.trim() === dir)) return;
  const r = await runGit(["config", "--global", "--add", "safe.directory", dir], { cwd, timeoutMs: 8000 });
  if (r.code !== 0) throw new GitError(firstLines(errText(r)) || "Could not update the global git config.", 400, errText(r));
}

/**
 * Trust the folder git refused for its owner. The path is taken from git's own error, never from the client,
 * and nothing happens unless git is in fact refusing for ownership.
 */
export async function trustFolder(cwd: string): Promise<string> {
  const r = await runGitSafe(["rev-parse", "--show-toplevel"], cwd);
  const dir = r.code !== 0 ? dubiousPath(errText(r)) : null;
  if (!dir) throw new GitError("Git is not refusing this folder for its owner, so there is nothing to trust.", 400);
  await addSafeDirectory(dir, cwd);
  return dir;
}

/** Why `git rev-parse` failed, when the reason is not simply "there is no repository here". */
function whyGitFailed(r: RunResult): string | undefined {
  if (r.timedOut) return "git did not answer in time. Antivirus or a slow disk can cause this; try again.";
  const err = firstLines(errText(r));
  if (/not a git repository/i.test(err)) return undefined;
  if (/dubious ownership|safe\.directory/i.test(err)) return `${err}\nGit refuses folders owned by another user. Run: git config --global --add safe.directory "<this folder>"`;
  return err || `git exited with code ${r.code}.`;
}

/** `runGit`, but a missing git executable becomes a result instead of an exception. */
async function runGitSafe(args: string[], cwd: string): Promise<RunResult> {
  try {
    return await runGit(args, { cwd, timeoutMs: 8000 });
  } catch (e: any) {
    const msg = e?.code === "ENOENT" ? "git was not found. Install Git (https://git-scm.com) and make sure it is on PATH, then restart the app." : `Could not run git: ${e?.message ?? e}`;
    return { code: 127, stdout: Buffer.alloc(0), stderr: Buffer.from(msg), timedOut: false };
  }
}

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  const top = await runGitSafe(["rev-parse", "--show-toplevel", "--show-prefix"], cwd);
  if (top.code !== 0) {
    const problem = whyGitFailed(top);
    if (!problem) return { isRepo: false };
    return { isRepo: false, problem, ...(dubiousPath(errText(top)) ? { untrusted: true } : {}) };
  }
  const [root, prefix = ""] = text(top).split("\n");
  const remotesOut = await runGit(["remote", "-v"], { cwd, timeoutMs: 8000 });
  const remotes: Array<{ name: string; url: string }> = [];
  for (const line of text(remotesOut).split("\n")) {
    const m = /^(\S+)\t(\S+) \(fetch\)$/.exec(line);
    if (m) remotes.push({ name: m[1], url: m[2] });
  }
  const cfg = async (k: string) => {
    const r = await runGit(["config", "--get", k], { cwd, timeoutMs: 5000 });
    return r.code === 0 ? text(r).trim() || null : null;
  };
  return { isRepo: true, root, prefix, remotes, identity: { name: await cfg("user.name"), email: await cfg("user.email") } };
}

export async function init(cwd: string): Promise<void> {
  const made = await runGitSafe(["init", "-b", "main"], cwd);
  if (made.code !== 0) throw new GitError(firstLines(errText(made)) || "git init failed.", 400, errText(made));
  // Do not report success until git itself agrees there is a repository here (it may refuse the folder).
  const check = await runGitSafe(["rev-parse", "--show-toplevel"], cwd);
  if (check.code !== 0) throw new GitError(`git init ran, but git does not accept this folder as a repository.\n${whyGitFailed(check) ?? firstLines(errText(check))}`, 400, errText(check));
  // A repository with no commit has no HEAD, so `git worktree add` fails and heads could not get their own
  // worktree. An empty first commit gives them a base. Best effort: the repo is usable without it.
  if ((await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd, timeoutMs: 8000 })).code === 0) return;
  const has = async (k: string) => (await runGit(["config", "--get", k], { cwd, timeoutMs: 5000 })).code === 0;
  // No identity configured would make the commit fail; borrow one for this commit only, never written to config.
  const ident = [...((await has("user.name")) ? [] : ["-c", "user.name=TreeBoss"]), ...((await has("user.email")) ? [] : ["-c", "user.email=treeboss@localhost"])];
  await runGit([...ident, "commit", "--allow-empty", "--no-verify", "--no-gpg-sign", "-m", "Initial commit"], { cwd, timeoutMs: 15_000 });
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

export interface StatusFile {
  path: string;
  /** Set for renames and copies. */
  origPath?: string;
  /** Index (staged) state: M A D R C T, or "." for none. */
  index: string;
  /** Worktree (unstaged) state: M D T, "?" for untracked, or "." for none. */
  worktree: string;
  /** Unmerged (needs resolving). The two letters say who changed what, e.g. "UU", "AA", "DU". */
  conflict?: string;
}

export interface Status {
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: StatusFile[];
  /** merge / rebase / cherry-pick / revert in progress, so the UI can offer to abort or continue. */
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  stashCount: number;
}

/**
 * `git status --porcelain=v2 -z --branch`. Records are NUL-terminated; a rename record is followed by a
 * second NUL-terminated field holding the original path.
 */
export function parseStatusV2(out: string): Omit<Status, "operation" | "stashCount"> {
  const status: Omit<Status, "operation" | "stashCount"> = { branch: null, detached: false, head: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    if (f.startsWith("# ")) {
      const [, key, ...rest] = f.split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") status.head = val === "(initial)" ? null : val;
      else if (key === "branch.head") {
        status.detached = val === "(detached)";
        status.branch = status.detached ? null : val;
      } else if (key === "branch.upstream") status.upstream = val;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = f[0];
    if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path
      const parts = f.split(" ");
      const xy = parts[1];
      status.files.push({ path: parts.slice(8).join(" "), index: xy[0], worktree: xy[1] });
    } else if (kind === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = f.split(" ");
      const xy = parts[1];
      status.files.push({ path: parts.slice(9).join(" "), origPath: fields[++i], index: xy[0], worktree: xy[1] });
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = f.split(" ");
      status.files.push({ path: parts.slice(10).join(" "), index: "U", worktree: "U", conflict: parts[1] });
    } else if (kind === "?") {
      status.files.push({ path: f.slice(2), index: ".", worktree: "?" });
    }
  }
  return status;
}

function gitDir(cwd: string, name: string): string | null {
  try {
    let dir = path.resolve(cwd);
    for (;;) {
      const g = path.join(dir, ".git");
      if (fs.existsSync(g)) {
        const st = fs.statSync(g);
        if (st.isDirectory()) return path.join(g, name);
        // A linked worktree: `.git` is a file pointing at the real dir.
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, "utf-8"));
        return m ? path.join(path.resolve(dir, m[1].trim()), name) : null;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/**
 * `exclude`: absolute paths git should not look at (skill copies trb placed for a running turn). Left out of the walk
 * rather than filtered afterwards, so a few thousand scaffold files cost nothing. `:/` keeps the whole repo in scope.
 */
export async function status(cwd: string, exclude: string[] = []): Promise<Status> {
  // Only paths inside this folder: git refuses a pathspec outside the repository, and other workspaces' turns are none of its business.
  const inside = exclude.filter((p) => p.startsWith(cwd.endsWith(path.sep) ? cwd : cwd + path.sep));
  const args = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"];
  let r;
  try {
    r = await git(cwd, inside.length ? [...args, "--", ":/", ...inside.map((p) => `:(exclude)${p}`)] : args, { timeoutMs: 20_000 });
  } catch (e) {
    // A pathspec git did not like (a symlinked path, say) must not take the whole status down.
    if (!inside.length) throw e;
    r = await git(cwd, args, { timeoutMs: 20_000 });
  }
  const base = parseStatusV2(text(r));
  const has = (n: string) => {
    const p = gitDir(cwd, n);
    return Boolean(p && fs.existsSync(p));
  };
  const operation = has("MERGE_HEAD") ? "merge" : has("rebase-merge") || has("rebase-apply") ? "rebase" : has("CHERRY_PICK_HEAD") ? "cherry-pick" : has("REVERT_HEAD") ? "revert" : null;
  const stash = await runGit(["rev-list", "--walk-reflogs", "--count", "refs/stash"], { cwd, timeoutMs: 5000 });
  return { ...base, operation, stashCount: stash.code === 0 ? Number(text(stash).trim()) || 0 : 0 };
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

const MAX_DIFF_BYTES = 1024 * 1024;

export interface DiffResult {
  diff: string;
  truncated: boolean;
}

function cap(s: string): DiffResult {
  return s.length > MAX_DIFF_BYTES ? { diff: s.slice(0, MAX_DIFF_BYTES), truncated: true } : { diff: s, truncated: false };
}

export interface DiffOptions {
  path?: string;
  /** Staged changes (index vs HEAD) instead of unstaged (worktree vs index). */
  staged?: boolean;
  /** A commit: its own change (`<sha>^!`). */
  commit?: string;
  /** A range: `base..head`. */
  base?: string;
  head?: string;
  context?: number;
  /** The file is untracked: diff it against nothing. */
  untracked?: boolean;
}

const SHA_OR_REF = /^[A-Za-z0-9._\-/@^~]{1,200}$/;
function ref(value: string, what: string): string {
  if (!SHA_OR_REF.test(value) || value.startsWith("-")) throw new GitError(`Bad ${what}.`);
  return value;
}

export async function diff(cwd: string, o: DiffOptions): Promise<DiffResult> {
  const context = String(Math.min(Math.max(o.context ?? 3, 0), 1000));
  const common = ["--no-color", "--no-ext-diff", `-U${context}`, "-M"];
  const tail = o.path ? ["--", o.path] : [];

  if (o.untracked && o.path) {
    // `--no-index` exits 1 when the files differ, which is the point.
    const r = await runGit(["diff", "--no-index", ...common, "--", "/dev/null", o.path], { cwd, timeoutMs: 20_000, maxBytes: MAX_DIFF_BYTES * 2 });
    if (r.code > 1) throw new GitError(firstLines(errText(r)));
    return cap(text(r));
  }
  let args: string[];
  if (o.commit) args = ["show", "--format=", ...common, ref(o.commit, "commit"), ...tail];
  else if (o.base && o.head) args = ["diff", ...common, `${ref(o.base, "base")}..${ref(o.head, "head")}`, ...tail];
  else if (o.staged) args = ["diff", "--cached", ...common, ...tail];
  else args = ["diff", ...common, ...tail];
  const r = await git(cwd, args, { timeoutMs: 30_000 });
  return cap(text(r));
}

/** A file's content at a revision (`HEAD`, `:0` for the index), for side-by-side views. null when it does not exist there. */
export async function showFile(cwd: string, rev: string, file: string): Promise<string | null> {
  const spec = rev === ":" ? `:${file}` : `${ref(rev, "revision")}:${file}`;
  const r = await runGit(["show", spec], { cwd, timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 });
  return r.code === 0 ? text(r) : null;
}

/* -------------------------------------------------------------------------- */
/* Staging                                                                    */
/* -------------------------------------------------------------------------- */

function pathsArg(paths: string[]): string[] {
  if (!paths.length) throw new GitError("No paths given.");
  for (const p of paths) if (p.includes("\0")) throw new GitError("Bad path.");
  return ["--", ...paths];
}

export async function stage(cwd: string, paths: string[]): Promise<void> {
  await git(cwd, ["add", "-A", ...pathsArg(paths)]);
}

export async function unstage(cwd: string, paths: string[]): Promise<void> {
  const hasHead = (await runGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd, timeoutMs: 5000 })).code === 0;
  if (hasHead) await git(cwd, ["restore", "--staged", ...pathsArg(paths)]);
  else await git(cwd, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", ...pathsArg(paths)]); // no commits yet: nothing to restore from
}

/**
 * Throw away working-tree changes: tracked files go back to the index, untracked ones are deleted.
 * `all` also resets the index, i.e. back to HEAD. This is destructive and has no undo; the UI confirms.
 */
export async function discard(cwd: string, paths: string[], opts: { all?: boolean } = {}): Promise<void> {
  const st = await status(cwd);
  const byPath = new Map(st.files.map((f) => [f.path, f]));
  const untracked: string[] = [];
  const tracked: string[] = [];
  for (const p of paths) {
    const f = byPath.get(p);
    if (f && f.worktree === "?") untracked.push(p);
    else tracked.push(p);
  }
  if (tracked.length) await git(cwd, ["restore", ...(opts.all ? ["--staged", "--worktree", "--source=HEAD"] : []), ...pathsArg(tracked)]);
  if (untracked.length) await git(cwd, ["clean", "-f", "-d", "-q", ...pathsArg(untracked)]);
}

/**
 * Apply a patch built from selected hunks or lines: `cached` stages it, `reverse` undoes it (unstage a
 * hunk with cached+reverse; discard a hunk from the working tree with reverse alone).
 */
export async function applyPatch(cwd: string, patch: string, opts: { cached?: boolean; reverse?: boolean }): Promise<void> {
  if (!patch.trim()) throw new GitError("Empty patch.");
  const args = ["apply", "--recount", "--whitespace=nowarn", ...(opts.cached ? ["--cached"] : []), ...(opts.reverse ? ["-R"] : []), "-"];
  await git(cwd, args, { input: patch.endsWith("\n") ? patch : patch + "\n" });
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                     */
/* -------------------------------------------------------------------------- */

export interface CommitResult {
  sha: string;
  summary: string;
  output: string;
}

export async function commit(cwd: string, message: string, opts: { amend?: boolean; signoff?: boolean; noVerify?: boolean } = {}): Promise<CommitResult> {
  const msg = message.trim();
  if (!msg && !opts.amend) throw new GitError("A commit message is required.");
  const args = ["commit", ...(opts.amend ? ["--amend"] : []), ...(opts.signoff ? ["-s"] : []), ...(opts.noVerify ? ["--no-verify"] : []), ...(msg ? ["-F", "-"] : ["--no-edit"])];
  // Hooks can take a while (lint, tests): give them room.
  const r = await git(cwd, args, { input: msg ? msg + "\n" : undefined, timeoutMs: 180_000 });
  const sha = text(await git(cwd, ["rev-parse", "HEAD"])).trim();
  const summary = text(await git(cwd, ["log", "-1", "--format=%s"])).trim();
  return { sha, summary, output: text(r).trim() };
}

/* -------------------------------------------------------------------------- */
/* Branches                                                                   */
/* -------------------------------------------------------------------------- */

export interface Branch {
  name: string;
  remote: boolean;
  current: boolean;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  subject: string;
  date: string;
}

export async function branches(cwd: string): Promise<Branch[]> {
  const fmt = ["%(HEAD)", "%(refname)", "%(objectname:short)", "%(upstream:short)", "%(upstream:track,nobracket)", "%(contents:subject)", "%(committerdate:iso-strict)"].join("%1f");
  const r = await git(cwd, ["for-each-ref", `--format=${fmt}%1e`, "--sort=-committerdate", "refs/heads", "refs/remotes"]);
  const out: Branch[] = [];
  for (const rec of text(r).split("\x1e")) {
    const line = rec.replace(/^\n/, "");
    if (!line) continue;
    const [head, refname, sha, upstream, track, subject, date] = line.split("\x1f");
    if (refname.endsWith("/HEAD")) continue;
    const remote = refname.startsWith("refs/remotes/");
    const ahead = /ahead (\d+)/.exec(track ?? "");
    const behind = /behind (\d+)/.exec(track ?? "");
    out.push({
      name: refname.replace(/^refs\/(heads|remotes)\//, ""),
      remote,
      current: head === "*",
      sha,
      upstream: upstream || null,
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      subject: subject ?? "",
      date: date ?? "",
    });
  }
  return out;
}

const BRANCH_NAME = /^(?!-)[^\s~^:?*[\\]+$/;
function branchName(n: string): string {
  if (!BRANCH_NAME.test(n) || n.includes("..") || n.endsWith("/") || n.endsWith(".lock")) throw new GitError(`"${n}" is not a valid branch name.`);
  return n;
}

export async function checkout(cwd: string, name: string): Promise<void> {
  await git(cwd, ["switch", branchName(name)], { timeoutMs: 60_000 });
}

export async function createBranch(cwd: string, name: string, opts: { from?: string; checkout?: boolean } = {}): Promise<void> {
  const n = branchName(name);
  if (opts.checkout === false) await git(cwd, ["branch", n, ...(opts.from ? [ref(opts.from, "start point")] : [])]);
  else await git(cwd, ["switch", "-c", n, ...(opts.from ? [ref(opts.from, "start point")] : [])], { timeoutMs: 60_000 });
}

export async function checkoutRemote(cwd: string, remoteBranch: string): Promise<void> {
  const local = remoteBranch.replace(/^[^/]+\//, "");
  await git(cwd, ["switch", "-c", branchName(local), "--track", ref(remoteBranch, "branch")], { timeoutMs: 60_000 });
}

export async function deleteBranch(cwd: string, name: string, force = false): Promise<void> {
  await git(cwd, ["branch", force ? "-D" : "-d", branchName(name)]);
}

export async function merge(cwd: string, name: string): Promise<{ conflicts: boolean; output: string }> {
  const r = await runGit(["merge", "--no-edit", ref(name, "branch")], { cwd, timeoutMs: 120_000 });
  const out = errText(r);
  if (r.code === 0) return { conflicts: false, output: out };
  // A conflicted merge exits 1 but is a normal state to resolve, not an error.
  if (/CONFLICT|Automatic merge failed/i.test(out)) return { conflicts: true, output: out };
  throw new GitError(firstLines(out), 400, out);
}

export async function abortOperation(cwd: string, op: "merge" | "rebase" | "cherry-pick" | "revert"): Promise<void> {
  await git(cwd, [op, "--abort"]);
}

/** Resolve a conflicted file by taking one side wholesale, then stage it. */
export async function resolveConflict(cwd: string, file: string, side: "ours" | "theirs"): Promise<void> {
  await git(cwd, ["checkout", `--${side}`, ...pathsArg([file])]);
  await git(cwd, ["add", ...pathsArg([file])]);
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

export interface LogEntry {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  /** Branch/tag labels pointing here, e.g. `HEAD -> main`, `origin/main`, `tag: v1`. */
  refs: string[];
  subject: string;
}

export async function log(cwd: string, o: { limit?: number; skip?: number; path?: string; all?: boolean; rev?: string } = {}): Promise<LogEntry[]> {
  const fmt = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e";
  const args = ["log", `--format=${fmt}`, `-n${Math.min(o.limit ?? 100, 1000)}`, `--skip=${o.skip ?? 0}`, "--date-order"];
  if (o.all) args.push("--all");
  if (o.rev) args.push(ref(o.rev, "revision"));
  if (o.path) args.push("--", o.path);
  const r = await runGit(args, { cwd, timeoutMs: 30_000 });
  // An empty repository has no commits: that is an empty log, not an error.
  if (r.code !== 0) {
    if (/does not have any commits|unknown revision/i.test(errText(r))) return [];
    throw new GitError(firstLines(errText(r)));
  }
  const out: LogEntry[] = [];
  for (const rec of text(r).split("\x1e")) {
    const line = rec.replace(/^\n/, "");
    if (!line) continue;
    const [sha, parents, author, email, date, refs, subject] = line.split("\x1f");
    out.push({ sha, short: sha.slice(0, 7), parents: parents ? parents.split(" ") : [], author, email, date, refs: refs ? refs.split(", ").filter(Boolean) : [], subject });
  }
  return out;
}

export interface CommitDetail extends LogEntry {
  body: string;
  files: Array<{ status: string; path: string; origPath?: string }>;
}

export async function commitDetail(cwd: string, sha: string): Promise<CommitDetail> {
  const s = ref(sha, "commit");
  const head = await git(cwd, ["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b", s]);
  const [full, parents, author, email, date, refs, subject, ...bodyParts] = text(head).split("\x1f");
  const names = await git(cwd, ["show", "--format=", "--name-status", "-M", "-z", s]);
  const parts = text(names).split("\0").filter(Boolean);
  const files: CommitDetail["files"] = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (st.startsWith("R") || st.startsWith("C")) {
      files.push({ status: st[0], origPath: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      files.push({ status: st[0], path: parts[i + 1] });
      i += 1;
    }
  }
  return { sha: full.trim(), short: full.trim().slice(0, 7), parents: parents ? parents.split(" ") : [], author, email, date, refs: refs ? refs.split(", ").filter(Boolean) : [], subject, body: bodyParts.join("\x1f").trim(), files };
}

/* -------------------------------------------------------------------------- */
/* Remotes                                                                    */
/* -------------------------------------------------------------------------- */

/** Network calls: no prompts, a generous timeout, and the remote's own message when it refuses. */
export async function fetchRemote(cwd: string): Promise<string> {
  const r = await git(cwd, ["fetch", "--all", "--prune"], { timeoutMs: 120_000 });
  return errText(r);
}

export async function pull(cwd: string, mode: "ff-only" | "rebase" | "merge" = "ff-only"): Promise<string> {
  const flag = mode === "ff-only" ? "--ff-only" : mode === "rebase" ? "--rebase" : "--no-rebase";
  const r = await git(cwd, ["pull", flag], { timeoutMs: 180_000 });
  return errText(r);
}

export async function push(cwd: string, opts: { setUpstream?: boolean; forceWithLease?: boolean; remote?: string; branch?: string } = {}): Promise<string> {
  const args = ["push"];
  if (opts.forceWithLease) args.push("--force-with-lease");
  if (opts.setUpstream) {
    args.push("-u", opts.remote ?? "origin", branchName(opts.branch ?? "HEAD"));
  }
  const r = await git(cwd, args, { timeoutMs: 180_000 });
  return errText(r);
}

/* -------------------------------------------------------------------------- */
/* Publish to GitHub (via the user's own `gh` login)                          */
/* -------------------------------------------------------------------------- */

export interface GhStatus {
  installed: boolean;
  /** Signed-in account, or null when `gh` is missing or not logged in. */
  user: string | null;
}

/** `gh` never prompts (no TTY to answer) and never checks for its own updates. */
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };

async function runGh(args: string[], cwd: string, timeoutMs: number): Promise<RunResult | null> {
  try {
    return await runCmd("gh", args, { cwd, timeoutMs, env: GH_ENV });
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

export async function ghStatus(cwd: string): Promise<GhStatus> {
  const r = await runGh(["api", "user", "--jq", ".login"], cwd, 10_000);
  if (!r) return { installed: false, user: null };
  return { installed: true, user: r.code === 0 ? text(r).trim() || null : null };
}

const REPO_NAME = /^(?:[A-Za-z0-9-]+\/)?[A-Za-z0-9._-]{1,100}$/;

/**
 * Create a GitHub repository from this folder and push to it: `gh repo create --source=. --remote=origin --push`.
 * Refuses when `origin` already exists, and when there is no commit to push.
 */
export async function publishRepo(cwd: string, o: { name: string; visibility: "private" | "public"; description?: string }): Promise<{ url: string; output: string }> {
  const name = o.name.trim();
  if (!REPO_NAME.test(name) || name === "." || name === "..") throw new GitError(`"${name}" is not a valid repository name. Use letters, numbers, ".", "-" and "_" (optionally owner/name).`);
  if (o.visibility !== "private" && o.visibility !== "public") throw new GitError("Visibility must be private or public.");
  const info = await repoInfo(cwd);
  if (!info.isRepo) throw new GitError("This folder is not a git repository yet. Initialize it first.");
  if (info.remotes?.some((r) => r.name === "origin")) throw new GitError(`This repository already has an "origin" remote (${info.remotes.find((r) => r.name === "origin")!.url}).`);
  if ((await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd, timeoutMs: 8000 })).code !== 0) throw new GitError("There is no commit to publish yet. Make a first commit.");
  const gh = await ghStatus(cwd);
  if (!gh.installed) throw new GitError("The GitHub CLI (gh) was not found. Install it from https://cli.github.com and run `gh auth login`.", 412);
  if (!gh.user) throw new GitError("The GitHub CLI is not signed in. Run `gh auth login` in a terminal, then try again.", 412);
  const args = ["repo", "create", name, `--${o.visibility}`, "--source=.", "--remote=origin", "--push", ...(o.description?.trim() ? ["--description", o.description.trim()] : [])];
  const r = await runGh(args, cwd, 180_000);
  if (!r) throw new GitError("The GitHub CLI (gh) was not found.", 412);
  if (r.timedOut) throw new GitError("gh repo create timed out.", 504);
  if (r.code !== 0) throw new GitError(firstLines(errText(r)) || `gh repo create failed (exit ${r.code}).`, 400, errText(r));
  const url = /https:\/\/github\.com\/\S+/.exec(errText(r))?.[0] ?? "";
  return { url, output: errText(r) };
}

/* -------------------------------------------------------------------------- */
/* Stash                                                                      */
/* -------------------------------------------------------------------------- */

export interface StashEntry {
  index: number;
  ref: string;
  message: string;
  date: string;
}

export async function stashList(cwd: string): Promise<StashEntry[]> {
  const r = await git(cwd, ["stash", "list", "--format=%gd%x1f%s%x1f%aI%x1e"]);
  const out: StashEntry[] = [];
  for (const rec of text(r).split("\x1e")) {
    const line = rec.replace(/^\n/, "");
    if (!line) continue;
    const [refname, message, date] = line.split("\x1f");
    const m = /stash@\{(\d+)\}/.exec(refname);
    out.push({ index: m ? Number(m[1]) : out.length, ref: refname, message, date });
  }
  return out;
}

export async function stashPush(cwd: string, o: { message?: string; includeUntracked?: boolean } = {}): Promise<string> {
  const r = await git(cwd, ["stash", "push", ...(o.includeUntracked ? ["-u"] : []), ...(o.message?.trim() ? ["-m", o.message.trim()] : [])]);
  return text(r).trim();
}

export async function stashOp(cwd: string, op: "apply" | "pop" | "drop", index: number): Promise<string> {
  if (!Number.isInteger(index) || index < 0) throw new GitError("Bad stash index.");
  const r = await runGit(["stash", op, `stash@{${index}}`], { cwd, timeoutMs: 60_000 });
  if (r.code !== 0 && !/CONFLICT/i.test(errText(r))) throw new GitError(firstLines(errText(r)));
  return errText(r);
}

/* -------------------------------------------------------------------------- */
/* Worktrees                                                                  */
/* -------------------------------------------------------------------------- */

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

export async function worktrees(cwd: string): Promise<WorktreeEntry[]> {
  const r = await git(cwd, ["worktree", "list", "--porcelain"]);
  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> | null = null;
  for (const line of text(r).split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur?.path) out.push(cur as WorktreeEntry);
      cur = { path: line.slice(9), head: null, branch: null, bare: false, detached: false };
    } else if (cur) {
      if (line.startsWith("HEAD ")) cur.head = line.slice(5);
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") cur.bare = true;
      else if (line === "detached") cur.detached = true;
    }
  }
  if (cur?.path) out.push(cur as WorktreeEntry);
  return out;
}
