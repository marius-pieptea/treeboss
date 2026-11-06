/**
 * The injection seam of the Android emulator: every external effect (running a program, fetching a URL,
 * the clock, the folders treeboss owns) goes through Deps, so tests never touch the network or a real adb.
 *
 * Every program is an argv array run with Bun.spawn, never a shell. A long-lived child is started in its own
 * process group and stopped with killTree, like the dev servers.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { DETACH_GROUP, killTree } from "../proctree";
import { paths } from "../paths";

export interface RunOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}
export interface RunResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}
export interface SpawnOptions {
  env: Record<string, string>;
  cwd: string;
}
/** A running long-lived process. `stop` takes down its whole tree and resolves once it has exited. */
export interface Child {
  pid: number | undefined;
  /** Output lines (stdout and stderr), as they arrive. */
  onLine(fn: (line: string) => void): void;
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface Exec {
  run(argv: string[], opts?: RunOptions): Promise<RunResult>;
  spawn(argv: string[], opts: SpawnOptions): Child;
}
export interface Fetcher {
  text(url: string): Promise<string>;
  /** Streams to `dest`, reporting the bytes written so far. */
  download(url: string, dest: string, onBytes: (total: number) => void): Promise<void>;
}
export interface Deps {
  exec: Exec;
  fetch: Fetcher;
  now(): number;
  paths: { root: string; avdHome: string; tmp: string };
}

const KILL_GRACE_MS = 4000;

/**
 * Windows shims (npx.cmd, eas.cmd) cannot be spawned directly: Node and Bun refuse them with EINVAL. Run them
 * through cmd.exe instead. Other programs keep the plain argv form.
 */
function spawnArgs(argv: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(argv[0]!)) return { file: argv[0]!, args: argv.slice(1), verbatim: false };
  const line = argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ");
  return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

const realExec: Exec = {
  async run(argv, opts = {}) {
    const proc = Bun.spawn(argv, { env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killTree(proc.pid, "SIGKILL"); }, opts.timeoutMs) : null;
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]);
      return { code: timedOut ? -1 : code, stdout, stderr: timedOut ? `${stderr}\ntimed out after ${opts.timeoutMs} ms` : stderr };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
  spawn(argv, opts) {
    const { file, args, verbatim } = spawnArgs(argv);
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, detached: DETACH_GROUP, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ["ignore", "pipe", "pipe"] });
    const listeners: ((line: string) => void)[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream?.on("data", (d: Buffer) => {
        const lines = (rest + d.toString("utf-8")).split(/\r?\n/);
        rest = lines.pop() ?? "";
        for (const line of lines) for (const fn of listeners) fn(line);
      });
    }
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("exit", (code) => resolve(code));
    });
    return {
      pid: child.pid,
      onLine: (fn) => void listeners.push(fn),
      exited,
      async stop() {
        killTree(child.pid, "SIGTERM");
        const force = setTimeout(() => killTree(child.pid, "SIGKILL"), KILL_GRACE_MS);
        try {
          await exited;
        } finally {
          clearTimeout(force);
        }
      },
    };
  },
};

const realFetch: Fetcher = {
  async text(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
    return res.text();
  },
  async download(url, dest, onBytes) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`GET ${url} failed: ${res.status}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest);
    let total = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
        onBytes(total);
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (e) {
      out.destroy();
      throw e;
    }
  },
};

export function realDeps(): Deps {
  const base = paths.android();
  const dir = (name: string) => path.join(base, name);
  return { exec: realExec, fetch: realFetch, now: () => Date.now(), paths: { root: dir("sdk"), avdHome: dir("avd"), tmp: dir("tmp") } };
}
