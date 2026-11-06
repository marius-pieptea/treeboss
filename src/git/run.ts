/**
 * Async process runner: the UI's git and search calls, the turn-end checkpoints and the turn diffs, and the Tailscale
 * probe. They must not block the daemon, which is also running agents' turns. Git writes to one repository go through
 * `serialize`, one at a time per repository. The synchronous `git()` in worktree.ts stays for worktree add/remove/prune.
 */
import fs from "fs";
import path from "path";

/** Ceiling for a local git call the daemon makes on its own (checkpoints, turn diffs), as the synchronous helpers have. */
export const LOCAL_GIT_TIMEOUT_MS = 120_000;

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  input?: string | Buffer;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Cap on captured stdout, so a runaway diff cannot exhaust memory. */
  maxBytes?: number;
  /** Stop the command once its stdout passes this many bytes: stdout is cut there and `truncated` is set. */
  stopAfter?: number;
}

export interface CmdResult extends RunResult {
  /** The command was stopped at `stopAfter` bytes of stdout, so the rest was never read. */
  truncated: boolean;
}

export async function runCmd(cmd: string, args: string[], o: RunOptions): Promise<CmdResult> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: o.cwd,
    stdin: o.input !== undefined ? new Blob([o.input as BlobPart]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: { ...process.env, ...o.env },
  });
  let timedOut = false;
  let truncated = false;
  const timer = o.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, o.timeoutMs)
    : null;
  const max = o.maxBytes ?? 64 * 1024 * 1024;
  const readCapped = async (s: ReadableStream<Uint8Array>): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of s as any as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total <= max) chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
  // Reads stdout up to `stopAfter` bytes (cut exactly there), then stops the process instead of reading the rest.
  const readUntil = async (s: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of s as any as AsyncIterable<Uint8Array>) {
      if (total + chunk.length > limit) {
        chunks.push(Buffer.from(chunk.subarray(0, limit - total)));
        truncated = true;
        proc.kill("SIGKILL");
        break;
      }
      total += chunk.length;
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
  const stdoutRead = o.stopAfter !== undefined ? readUntil(proc.stdout, o.stopAfter) : readCapped(proc.stdout);
  const [stdout, stderr] = await Promise.all([stdoutRead, readCapped(proc.stderr)]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout, stderr, timedOut, truncated };
}

/* -------------------------------------------------------------------------- */
/* Sequencing                                                                 */
/* -------------------------------------------------------------------------- */

const tails = new Map<string, Promise<void>>();

/**
 * Run `fn` once every earlier call queued under `key` has finished, one at a time. Git writes to one repository go
 * through here (the key is `gitKey` of its directory), so two snapshots, or a snapshot and a prune, never interleave.
 */
export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/** Resolves when the calls queued under `key` so far have finished. For a synchronous git call that must not overlap them. */
export function drainSerialized(key: string): Promise<void> {
  return tails.get(key) ?? Promise.resolve();
}

/** The queue key for a directory: its real path, so two spellings of one place share a queue. */
export function gitKey(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Walk a generator that asks for one command at a time and gets its result back. The same step list then runs
 * synchronously (`drive`) or off the thread (`driveAsync`), so a sequence is written once.
 */
export function drive<A, R, T>(steps: Generator<A, T, R>, exec: (a: A) => R): T {
  let next = steps.next();
  while (!next.done) next = steps.next(exec(next.value));
  return next.value;
}

export async function driveAsync<A, R, T>(steps: Generator<A, T, R>, exec: (a: A) => Promise<R>): Promise<T> {
  let next = steps.next();
  while (!next.done) next = steps.next(await exec(next.value));
  return next.value;
}

/** Never prompt (no TTY to answer), never lock the index for a read, and speak English so output can be parsed. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_PAGER: "cat", GIT_EDITOR: "true", GCM_INTERACTIVE: "never" };

export function runGit(args: string[], o: RunOptions & { env?: Record<string, string> }): Promise<CmdResult> {
  return runCmd("git", ["-c", "core.quotepath=off", ...args], { ...o, env: { ...GIT_ENV, ...o.env } });
}
