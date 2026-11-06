/**
 * Checkpoints: a snapshot of a session's working tree at the end of every turn, kept in hidden git refs, so a
 * turn can be rewound or a new session forked from it.
 *
 * How a snapshot is taken without touching anything of the operator's: git plumbing against a PRIVATE index file
 * (`GIT_INDEX_FILE`, kept next to the repository's own index and reused, so repeated snapshots only re-hash files
 * whose stat changed). `add -A` stages every non-ignored file (tracked, modified and untracked) into that private
 * index, `write-tree` turns it into a tree, `commit-tree` wraps the tree in a commit whose parent is HEAD, and
 * `update-ref` files it under `refs/trb/checkpoints/<session>/<turn>`. No branch, HEAD, real index, stash or
 * working-tree file is written; only objects and the one ref.
 *
 * Rewind restores files only: the files that differ between "now" and the target tree are written back (or
 * removed), after "now" itself was saved as an `undo` checkpoint, so a rewind can be undone. Branches and HEAD
 * never move. Everything is scoped to the session's own directory when that is a subfolder of a larger repo.
 *
 * Not a git repository: nothing is recorded and nothing fails; callers get `null` / an explanation.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { newId } from "../util";
import { SCAFFOLD_PATHS } from "../git/worktree";
import { drive, driveAsync, gitKey, LOCAL_GIT_TIMEOUT_MS, runGit, serialize } from "../git/run";

export type CheckpointKind = "base" | "turn" | "undo";

export interface Checkpoint {
  id: string;
  session_id: string;
  turn_id: string | null;
  /** The turn's sequence number (0 for `base` and `undo`). */
  seq: number;
  kind: CheckpointKind;
  ref: string;
  commit_sha: string;
  tree_sha: string;
  git_root: string;
  /** Files that differ from the checkpoint before it (or from HEAD, for the first). */
  changed: number;
  created_at: string;
}

export class CheckpointError extends Error {}

/** Newest checkpoints kept per session; older refs are deleted (only ever refs this module created). */
export const KEEP_PER_SESSION = 100;
export const REF_PREFIX = "refs/trb/checkpoints";

const GIT_TIMEOUT_MS = 120_000;

const prepared = new WeakSet<Database>();
function table(): Database {
  const conn = db();
  if (!prepared.has(conn)) {
    conn.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      seq INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      tree_sha TEXT NOT NULL,
      git_root TEXT NOT NULL,
      changed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`);
    conn.exec("CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at)");
    conn.exec("CREATE TABLE IF NOT EXISTS rewind_notices (session_id TEXT PRIMARY KEY, text TEXT NOT NULL)");
    prepared.add(conn);
  }
  return conn;
}

/* -------------------------------------------------------------------------- */
/* git                                                                        */
/* -------------------------------------------------------------------------- */

interface Run {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, opts: { env?: Record<string, string>; input?: string | Buffer } = {}): Run {
  const res = spawnSync("git", args, {
    windowsHide: true,
    cwd,
    input: opts.input,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
  });
  return { ok: res.status === 0, stdout: (res.stdout || "").toString(), stderr: (res.stderr || "").toString() };
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

interface Repo {
  /** The repository's top directory. */
  top: string;
  /** This session's directory relative to `top` ("" at the top). Snapshots and rewinds only touch this subtree. */
  scope: string;
  /** Absolute git dir of the working tree (a linked worktree has its own). */
  gitDir: string;
}

/*
 * The snapshot and prune steps are written once, as generators that ask for each git call (`yield`) and get its result
 * back. `drive` runs them synchronously (rewind, drop: they must throw in place) and `driveAsync` runs them off the thread
 * for the turn-end checkpoint.
 */
interface Step {
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  input?: string | Buffer;
}
type Steps<T> = Generator<Step, T, Run>;

const syncStep = (s: Step): Run => run(s.args, s.cwd, s);

async function asyncStep(s: Step): Promise<Run> {
  const r = await runGit(s.args, { cwd: s.cwd, input: s.input, timeoutMs: LOCAL_GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: "0", ...s.env } }).catch((err) => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(err?.message ?? err)) }));
  return { ok: r.code === 0, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function* repoSteps(cwd: string): Steps<Repo | null> {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const top = yield { args: ["rev-parse", "--show-toplevel"], cwd };
  if (!top.ok || !top.stdout.trim()) return null;
  const gitDir = yield { args: ["rev-parse", "--absolute-git-dir"], cwd };
  if (!gitDir.ok) return null;
  const topReal = real(top.stdout.trim());
  const rel = path.relative(topReal, real(cwd));
  return { top: topReal, scope: rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : "", gitDir: gitDir.stdout.trim() };
}

function repoOf(cwd: string): Repo | null {
  return drive(repoSteps(cwd), syncStep);
}

/** Where trb itself writes into a workspace, and dependencies: never part of a snapshot. */
function excludes(scope: string): string[] {
  const at = (p: string) => (scope ? `${scope}/${p}` : p);
  return [":(exclude,glob)**/node_modules", `:(exclude)${at("node_modules")}`, ...SCAFFOLD_PATHS.map((p) => `:(exclude)${at(p)}`)];
}

const identity = { GIT_AUTHOR_NAME: "trb-checkpoint", GIT_AUTHOR_EMAIL: "checkpoint@trb.local", GIT_COMMITTER_NAME: "trb-checkpoint", GIT_COMMITTER_EMAIL: "checkpoint@trb.local" };

function pathspec(repo: Repo): string[] {
  return ["--", repo.scope || ".", ...excludes(repo.scope)];
}

function indexFile(repo: Repo, sessionId: string): string {
  return path.join(repo.gitDir, `trb-checkpoint-${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.index`);
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

interface Snapshot {
  commit: string;
  tree: string;
  repo: Repo;
}

/** Write the working tree as a commit object (no ref yet). Throws CheckpointError when git refuses. */
function* writeSnapshotSteps(repo: Repo, sessionId: string, label: string): Steps<Snapshot> {
  const idx = indexFile(repo, sessionId);
  const env = { GIT_INDEX_FILE: idx };
  const head = (yield { args: ["rev-parse", "--verify", "--quiet", "HEAD"], cwd: repo.top }).stdout.trim();
  if (!fs.existsSync(idx) && head) {
    const seed = yield { args: ["read-tree", head], cwd: repo.top, env };
    if (!seed.ok) throw new CheckpointError(`read-tree: ${seed.stderr.trim().slice(0, 200)}`);
  }
  const add = yield { args: ["add", "-A", "--ignore-errors", ...pathspec(repo)], cwd: repo.top, env };
  // `--ignore-errors` still exits 1 when a file could not be read (a socket, a vanished temp file): the rest is staged.
  if (!add.ok && !/unable to index|Unable to|cannot|did not match/i.test(add.stderr)) throw new CheckpointError(`add: ${add.stderr.trim().slice(0, 200)}`);
  const tree = yield { args: ["write-tree"], cwd: repo.top, env };
  if (!tree.ok) throw new CheckpointError(`write-tree: ${tree.stderr.trim().slice(0, 200)}`);
  const treeSha = tree.stdout.trim();
  const commit = yield { args: ["-c", "commit.gpgsign=false", "commit-tree", treeSha, ...(head ? ["-p", head] : []), "-m", `trb checkpoint: ${label}`], cwd: repo.top, env: identity };
  if (!commit.ok) throw new CheckpointError(`commit-tree: ${commit.stderr.trim().slice(0, 200)}`);
  return { commit: commit.stdout.trim(), tree: treeSha, repo };
}

function* changedCountSteps(repo: Repo, fromTree: string | null, toTree: string): Steps<number> {
  if (!fromTree) return 0;
  const r = yield { args: ["diff-tree", "-r", "--no-renames", "--name-only", "-z", fromTree, toTree, ...pathspec(repo)], cwd: repo.top };
  return r.ok ? r.stdout.split("\0").filter(Boolean).length : 0;
}

function safeRefPart(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

type CheckpointInput = { sessionId: string; cwd: string; turnId?: string | null; seq?: number; kind: CheckpointKind; label?: string };

/** The snapshot, its ref, the row and the prune of one checkpoint. Throws CheckpointError when git refuses. */
function* recordSteps(repo: Repo, input: CheckpointInput): Steps<Checkpoint> {
  const snap = yield* writeSnapshotSteps(repo, input.sessionId, input.label ?? `${input.kind} ${input.turnId ?? ""}`.trim());
  const id = newId("cp");
  const ref = `${REF_PREFIX}/${safeRefPart(input.sessionId)}/${input.kind === "turn" && input.turnId ? safeRefPart(input.turnId) : input.kind === "base" ? "base" : `undo-${id}`}`;
  const upd = yield { args: ["update-ref", ref, snap.commit], cwd: repo.top };
  if (!upd.ok) throw new CheckpointError(`update-ref: ${upd.stderr.trim().slice(0, 200)}`);
  const prev = latest(input.sessionId);
  const prevTree = prev && prev.git_root === repo.top ? prev.tree_sha : ((yield { args: ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], cwd: repo.top }).stdout.trim() || null);
  const changed = yield* changedCountSteps(repo, prevTree, snap.tree);
  const row: Checkpoint = {
    id,
    session_id: input.sessionId,
    turn_id: input.turnId ?? null,
    seq: input.seq ?? 0,
    kind: input.kind,
    ref,
    commit_sha: snap.commit,
    tree_sha: snap.tree,
    git_root: repo.top,
    changed,
    created_at: new Date().toISOString(),
  };
  table()
    .prepare("INSERT INTO checkpoints (id, session_id, turn_id, seq, kind, ref, commit_sha, tree_sha, git_root, changed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.session_id, row.turn_id, row.seq, row.kind, row.ref, row.commit_sha, row.tree_sha, row.git_root, row.changed, row.created_at);
  yield* pruneSteps(input.sessionId);
  return row;
}

function checkpointFailed(input: CheckpointInput, err: any): null {
  console.warn(`[trb] checkpoint ${input.sessionId}: ${err?.message ?? err}`);
  return null;
}

/** Take and record a checkpoint, synchronously. For rewind, which must return its undo point in place. Null when the directory is not a git repository or git failed. */
function takeCheckpointSync(input: CheckpointInput): Checkpoint | null {
  try {
    const repo = repoOf(input.cwd);
    return repo ? drive(recordSteps(repo, input), syncStep) : null;
  } catch (err: any) {
    return checkpointFailed(input, err);
  }
}

/**
 * Take and record a checkpoint, off the daemon's thread. Writes to the repository are queued, so a snapshot never
 * interleaves with another one or a prune on the same repo. Returns null when the directory is not a git repository or
 * git failed (never throws).
 */
export async function takeCheckpoint(input: CheckpointInput): Promise<Checkpoint | null> {
  try {
    const repo = await driveAsync(repoSteps(input.cwd), asyncStep);
    if (!repo) return null;
    return await serialize(gitKey(repo.top), () => driveAsync(recordSteps(repo, input), asyncStep));
  } catch (err: any) {
    return checkpointFailed(input, err);
  }
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export function listCheckpoints(sessionId: string): Checkpoint[] {
  return table().prepare("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId) as Checkpoint[];
}

function latest(sessionId: string): Checkpoint | null {
  return (table().prepare("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(sessionId) as Checkpoint | undefined) ?? null;
}

export function getCheckpoint(id: string): Checkpoint | null {
  return (table().prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as Checkpoint | undefined) ?? null;
}

/** The checkpoint taken at the end of a turn. */
export function checkpointOfTurn(sessionId: string, turnId: string): Checkpoint | null {
  return (table().prepare("SELECT * FROM checkpoints WHERE session_id = ? AND turn_id = ? AND kind = 'turn' ORDER BY rowid DESC LIMIT 1").get(sessionId, turnId) as Checkpoint | undefined) ?? null;
}

/** What a rewind "to before turn N" goes back to: the end of the closest earlier turn, else the base checkpoint. */
export function checkpointBefore(sessionId: string, seq: number): Checkpoint | null {
  const prior = table().prepare("SELECT * FROM checkpoints WHERE session_id = ? AND kind = 'turn' AND seq < ? ORDER BY seq DESC, rowid DESC LIMIT 1").get(sessionId, seq) as Checkpoint | undefined;
  if (prior) return prior;
  return (table().prepare("SELECT * FROM checkpoints WHERE session_id = ? AND kind = 'base' ORDER BY rowid LIMIT 1").get(sessionId) as Checkpoint | undefined) ?? null;
}

/** Drop the oldest checkpoints past the cap. Deletes only refs under this session's own namespace. */
export function prune(sessionId: string, keep = KEEP_PER_SESSION): number {
  return drive(pruneSteps(sessionId, keep), syncStep);
}

function* pruneSteps(sessionId: string, keep = KEEP_PER_SESSION): Steps<number> {
  const rows = listCheckpoints(sessionId);
  const extra = rows.length - keep;
  if (extra <= 0) return 0;
  let removed = 0;
  const own = `${REF_PREFIX}/${safeRefPart(sessionId)}/`;
  for (const row of rows.slice(0, extra)) {
    // Never the base checkpoint: it is what turn 1 rewinds to.
    if (row.kind === "base") continue;
    if (row.ref.startsWith(own)) yield { args: ["update-ref", "-d", row.ref], cwd: row.git_root };
    table().prepare("DELETE FROM checkpoints WHERE id = ?").run(row.id);
    removed++;
  }
  return removed;
}

/** Remove every checkpoint of a session, once it is closed: its refs (git may then collect the commits), its rows and its private index. */
export function dropCheckpoints(sessionId: string): number {
  const rows = listCheckpoints(sessionId);
  const own = `${REF_PREFIX}/${safeRefPart(sessionId)}/`;
  for (const row of rows) {
    if (row.ref.startsWith(own)) run(["update-ref", "-d", row.ref], row.git_root);
  }
  for (const root of new Set(rows.map((row) => row.git_root))) {
    const repo = repoOf(root);
    if (repo) fs.rmSync(indexFile(repo, sessionId), { force: true });
  }
  table().prepare("DELETE FROM checkpoints WHERE session_id = ?").run(sessionId);
  table().prepare("DELETE FROM rewind_notices WHERE session_id = ?").run(sessionId);
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Rewind                                                                     */
/* -------------------------------------------------------------------------- */

export interface RewindResult {
  restored: number;
  removed: number;
  /** The state that was replaced, saved so the rewind can itself be undone. */
  undo: Checkpoint | null;
  target: Checkpoint;
  /** Files git could not write back (a directory in the way, a permission). */
  failed: string[];
}

const insideRoot = (top: string, rel: string): string | null => {
  if (!rel || rel.startsWith("/") || rel.split("/").some((p) => p === ".." || p === ".git")) return null;
  const abs = path.join(top, rel);
  return abs.startsWith(top + path.sep) ? abs : null;
};

/**
 * Put the working tree (within the session's scope) back to the target checkpoint's tree. The caller has
 * checked the session is idle. Saves an `undo` checkpoint first.
 */
export function rewindTo(sessionId: string, cwd: string, target: Checkpoint): RewindResult {
  const repo = repoOf(cwd);
  if (!repo) throw new CheckpointError("This directory is not a git repository, so there is nothing to rewind to.");
  if (repo.top !== target.git_root) throw new CheckpointError("This checkpoint belongs to a different repository.");
  if (!run(["cat-file", "-e", `${target.commit_sha}^{commit}`], repo.top).ok) throw new CheckpointError("The checkpoint's commit is gone from the repository (was it garbage collected?).");

  const undo = takeCheckpointSync({ sessionId, cwd, kind: "undo", label: `before rewinding to ${target.ref}` });
  const current = undo?.tree_sha;
  if (!current) throw new CheckpointError("Could not save the current state first, so nothing was rewound.");

  const diff = run(["diff-tree", "-r", "--no-renames", "--name-status", "-z", current, target.tree_sha, ...pathspec(repo)], repo.top);
  if (!diff.ok) throw new CheckpointError(`diff-tree: ${diff.stderr.trim().slice(0, 200)}`);
  const parts = diff.stdout.split("\0").filter(Boolean);
  const toWrite: string[] = [];
  const toRemove: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0];
    const file = parts[i + 1];
    if (status === "D") toRemove.push(file); // in the working tree now, not in the target
    else toWrite.push(file); // added, modified or type-changed in the target
  }

  let removed = 0;
  for (const rel of toRemove) {
    const abs = insideRoot(repo.top, rel);
    if (!abs) continue;
    try {
      fs.rmSync(abs, { force: true });
      removed++;
      // Directories the removal left empty go too, up to (never including) the repo top.
      for (let dir = path.dirname(abs); dir.startsWith(repo.top + path.sep); dir = path.dirname(dir)) {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
      }
    } catch {}
  }

  const failed: string[] = [];
  let restored = 0;
  if (toWrite.length) {
    const idx = path.join(repo.gitDir, `trb-rewind-${process.pid}-${Date.now().toString(36)}.index`);
    try {
      const env = { GIT_INDEX_FILE: idx };
      const read = run(["read-tree", target.tree_sha], repo.top, { env });
      if (!read.ok) throw new CheckpointError(`read-tree: ${read.stderr.trim().slice(0, 200)}`);
      // One at a time would be slow on a big rewind, and one failure would hide the rest: batch, then retry singly on failure.
      const batch = run(["checkout-index", "-f", "-z", "--stdin"], repo.top, { env, input: toWrite.join("\0") + "\0" });
      if (batch.ok) restored = toWrite.length;
      else {
        for (const rel of toWrite) {
          const abs = insideRoot(repo.top, rel);
          // A directory where the target has a file: only an empty-of-tracked-state one is cleared; otherwise report it.
          if (abs && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            try {
              fs.rmSync(abs, { recursive: true, force: true });
            } catch {}
          }
          const one = run(["checkout-index", "-f", "--", rel], repo.top, { env });
          if (one.ok) restored++;
          else failed.push(rel);
        }
      }
    } finally {
      try {
        fs.rmSync(idx, { force: true });
      } catch {}
    }
  }
  // The session's own private index described the pre-rewind tree.
  try {
    fs.rmSync(indexFile(repo, sessionId), { force: true });
  } catch {}
  return { restored, removed, undo, target, failed };
}

/* -------------------------------------------------------------------------- */
/* The note the agent gets after a rewind                                      */
/* -------------------------------------------------------------------------- */

export function setRewindNotice(sessionId: string, text: string): void {
  table().prepare("INSERT INTO rewind_notices (session_id, text) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET text = excluded.text").run(sessionId, text);
}

/** The follow-up text with the rewind notice in front of it, once. A slash command is left alone and keeps the notice for later. */
export function withRewindNotice(sessionId: string, message: string): string {
  if (/^\/\w/.test(message)) return message;
  const row = table().prepare("SELECT text FROM rewind_notices WHERE session_id = ?").get(sessionId) as { text: string } | undefined;
  if (!row) return message;
  table().prepare("DELETE FROM rewind_notices WHERE session_id = ?").run(sessionId);
  return `${row.text}\n\n${message}`;
}
