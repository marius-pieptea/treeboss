/** Run verify commands: each in its own process group, killed whole on timeout or stop, output kept as a tail. */
import type { VerifyCommand } from "./detect";
import { DETACH_GROUP, killTree } from "../proctree";

export interface VerifyResult {
  name: string;
  cmd: string;
  exit: number;
  ok: boolean;
  duration_ms: number;
  timed_out: boolean;
  /** The tail of stdout+stderr, ANSI stripped. */
  output: string;
  /** Not run: an earlier command was stopped. */
  skipped?: boolean;
}

export const OUTPUT_TAIL = 4000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const tail = (s: string, n = OUTPUT_TAIL) => (s.length > n ? `…${s.slice(-n)}` : s);

export async function runOne(c: VerifyCommand, cwd: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<VerifyResult> {
  const started = Date.now();
  const env: Record<string, string | undefined> = { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" };
  delete env.TRB_TOKEN;
  const proc = Bun.spawn(["sh", "-c", c.cmd], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: DETACH_GROUP, windowsHide: true } as any);
  let timedOut = false;
  let stopped = false;
  const killGroup = () => {
    killTree(proc.pid, "SIGKILL");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, opts.timeoutMs);
  const onAbort = () => {
    stopped = true;
    killGroup();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exit = await proc.exited;
    let output = `${out}${err ? `${out && !out.endsWith("\n") ? "\n" : ""}${err}` : ""}`.replace(ANSI, "").trim();
    output = tail(output);
    if (timedOut) output = `${output}\n[timed out after ${Math.round(opts.timeoutMs / 1000)}s and was killed]`.trim();
    if (stopped) output = `${output}\n[stopped]`.trim();
    const code = timedOut ? 124 : stopped ? 130 : exit;
    return { name: c.name, cmd: c.cmd, exit: code, ok: code === 0, duration_ms: Date.now() - started, timed_out: timedOut, output };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** All commands in order (one failing does not hide the next), unless stopped. */
export async function runAll(cmds: VerifyCommand[], cwd: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const c of cmds) {
    if (opts.signal?.aborted) {
      results.push({ name: c.name, cmd: c.cmd, exit: 130, ok: false, duration_ms: 0, timed_out: false, output: "", skipped: true });
      continue;
    }
    results.push(await runOne(c, cwd, opts));
  }
  return results;
}
