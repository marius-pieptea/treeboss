/**
 * Runs ONE turn of an engine as a child process and settles it into a result.
 *
 * A turn is one print-mode invocation of the CLI (`claude -p`, `codex exec`, …).
 * Continuity between turns is the engine's own session id, passed back as a
 * resume flag, so each turn is a fresh process that picks up the stored context.
 *
 * What this owns: spawning in its own process group (so a kill takes the whole
 * tree: the engine's MCP servers and tool subprocesses), the idle/ceiling
 * deadlines, abort, and the success/failure decision. What it does not own:
 * workspaces, persistence, or which engine to use. Those are the session
 * manager's.
 */
import { spawn } from "child_process";
import { DETACH_GROUP, killTree } from "../proctree";
import { getEngine, resolveBinary, type LaunchInput } from "./registry";
import { shimInvocation } from "./win-shim";
import type { UsageEvent } from "./context";
import { createStreamAccumulator, looksLikeResumeRejection, type StreamUsage } from "./stream";

export interface RunTurnOptions extends Omit<LaunchInput, "key"> {
  engine: string;
  key: string;
  onLog?: (line: string) => void;
  onText?: (text: string) => void;
  /** Persist this WHILE the turn runs: a daemon killed mid-turn is the case resume exists for. */
  onSessionId?: (id: string) => void;
  /** Context-size readings and compactions as the stream reports them. */
  onUsage?: (e: UsageEvent) => void;
  /** The engine process's pid, which is also its process group id on POSIX. Lets the caller remember the group (sessions/leftovers.ts). */
  onSpawn?: (pid: number) => void;
  signal?: AbortSignal;
  /** Polled when the idle window runs out; true restarts it. A lead blocked on subagent_wait prints nothing. */
  isBusy?: () => boolean;
  /** Polled on every deadline check: true while the turn is blocked on subagents that are still working. */
  isWaiting?: () => boolean;
  idleMs: number;
  /** The longest the turn may work. Time spent waiting (`isWaiting`) does not count toward it. */
  ceilingMs: number;
  /** The absolute limit, waiting included. Absent: `ceilingMs` is absolute too. */
  hardCeilingMs?: number;
}

export interface TurnResult {
  success: boolean;
  /** The assistant's final text, or the failure reason. Never the raw protocol. */
  output: string;
  sessionId: string | null;
  /** The provider refused the session we asked to resume; retry fresh with the thread replayed. */
  resumeRejected: boolean;
  aborted: boolean;
  timedOut: boolean;
  maxTurnsHit: boolean;
  usage: StreamUsage | null;
  exitCode: number | null;
  stderr: string;
}

/**
 * Failure patterns that mean "the model never ran", regardless of exit code. A CLI that
 * prints a billing error and exits non-zero still emits plenty of stdout, so success is
 * content-based. Deliberately specific: /error/i would reject every transcript that
 * successfully fixes a bug.
 */
const FAILURE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /spend limit|usage-credits|monthly (spend|usage) limit|insufficient (credit|quota|balance)|quota exceeded|out of credits|billing (hard )?limit/i, reason: "Provider spend/quota limit reached" },
  { re: /rate.?limit(ed)?|429 Too Many Requests|too many requests/i, reason: "Provider rate limit hit" },
  { re: /\binvalid api key\b|authentication (failed|error)|not (logged in|authenticated)|expired token|please (run )?(claude )?login|\/login\b/i, reason: "Provider authentication failed" },
  { re: /command not found|ENOENT|no such file or directory.*(claude|codex|cursor|opencode)/i, reason: "The CLI is not installed or not on PATH" },
];

export function classifyFailure(text: string): string | null {
  for (const { re, reason } of FAILURE_PATTERNS) if (re.test(text)) return reason;
  return null;
}

/** How long a turn's output may keep arriving after the CLI has exited. */
const EXIT_DRAIN_MS = 2000;

/**
 * Output a turn keeps in memory. Stdout is only read as the answer's fallback, so its tail is enough. Stderr is read for
 * failure patterns, which a CLI prints near its start (a billing or login message) or its end (a late error): keep both ends.
 */
const STDOUT_KEEP_CHARS = 64 * 1024;
const STDERR_HEAD_KEEP_CHARS = 16 * 1024;
const STDERR_TAIL_KEEP_CHARS = 64 * 1024;

/**
 * The text a stream produced, held to its first `head` and last `tail` characters. Once the middle is dropped the text
 * says so, so a reader never takes the cut for the whole output.
 */
function boundedText(head: number, tail: number) {
  let opening = "";
  let end = "";
  let dropped = false;
  return {
    add(text: string) {
      if (opening.length < head) {
        const take = head - opening.length;
        opening += text.slice(0, take);
        text = text.slice(take);
      }
      if (!text) return;
      end += text;
      if (end.length > tail) {
        end = end.slice(-tail);
        dropped = true;
      }
    },
    text(): string {
      return dropped ? `${opening}\n[… output dropped …]\n${end}` : opening + end;
    },
  };
}

/**
 * The limit a turn has run into, as the log names it, or null. `waitedMs` is the time it spent blocked on subagents
 * that were working: a lead waiting on its heads is not a runaway turn, so that time counts toward the hard ceiling only.
 */
export function turnLimit(elapsedMs: number, waitedMs: number, ceilingMs: number, hardCeilingMs: number): string | null {
  const min = (ms: number) => Math.round(ms / 60_000);
  if (elapsedMs - waitedMs >= ceilingMs) return `the ${min(ceilingMs)} min ceiling for one turn${waitedMs >= 60_000 ? `, not counting ${min(waitedMs)} min spent waiting on subagents` : ""}`;
  if (elapsedMs >= hardCeilingMs) return `the ${min(hardCeilingMs)} min limit for one turn, waiting on subagents included`;
  return null;
}

export function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const def = getEngine(opts.engine);
  const empty = (output: string, extra: Partial<TurnResult> = {}): TurnResult => ({
    success: false,
    output,
    sessionId: null,
    resumeRejected: false,
    aborted: false,
    timedOut: false,
    maxTurnsHit: false,
    usage: null,
    exitCode: null,
    stderr: "",
    ...extra,
  });
  if (!def) return Promise.resolve(empty(`Unknown engine "${opts.engine}".`));
  const bin = resolveBinary(def);
  if (!bin) return Promise.resolve(empty(`${def.label} is not installed (looked for: ${def.binaries.join(", ") || "TRB_FAKE_ENGINE"}).`));

  const log = opts.onLog ?? (() => {});
  const spec = def.build(opts, bin);
  for (const note of spec.notes) log(`[trb] ${note}`);

  return new Promise<TurnResult>((resolve) => {
    // An inherited ANTHROPIC_MODEL would silently override the per-run model (and a retired id
    // in someone's shell profile kills every run in seconds). The model is passed explicitly.
    const env: Record<string, string | undefined> = { ...process.env, ...spec.env };
    delete env.ANTHROPIC_MODEL;
    // Running trb from inside another Claude Code session must not make the child think it is nested.
    delete env.CLAUDECODE;

    let child;
    try {
      const inv = shimInvocation(spec.cmd, spec.args);
      child = spawn(inv.file, inv.args, { cwd: opts.cwd, env: env as NodeJS.ProcessEnv, detached: DETACH_GROUP, windowsHide: true, windowsVerbatimArguments: inv.verbatim, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err: any) {
      spec.cleanup();
      return resolve(empty(`Failed to spawn ${spec.cmd}: ${err?.message ?? err}`));
    }
    if (child.pid) opts.onSpawn?.(child.pid);
    log(
      `[trb] ${def.label}${opts.model ? ` (model: ${opts.model})` : ""}${opts.effort ? ` (effort: ${opts.effort})` : ""}` +
        `${opts.resumeId ? " — resuming session" : ""} in ${opts.cwd}`,
    );

    const stream = createStreamAccumulator((line) => log(line), opts.onSessionId, opts.engine === "fake" ? "claude" : opts.engine, { onText: opts.onText, onUsage: opts.onUsage });
    const stdoutKept = boundedText(0, STDOUT_KEEP_CHARS);
    const stderrKept = boundedText(STDERR_HEAD_KEEP_CHARS, STDERR_TAIL_KEEP_CHARS);
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let lastActivity = Date.now();
    const startedAt = Date.now();
    let drain: ReturnType<typeof setTimeout> | null = null;

    const terminate = (immediate: boolean) => {
      killTree(child.pid, immediate ? "SIGKILL" : "SIGTERM");
      if (!immediate) setTimeout(() => killTree(child.pid, "SIGKILL"), 1500).unref?.();
    };

    // Idle / ceiling deadline, checked on a timer so a silent hang still ends. The time between two checks counts as
    // waiting when the turn is waiting at the second one.
    const hardCeilingMs = opts.hardCeilingMs ?? opts.ceilingMs;
    let waitedMs = 0;
    let lastCheck = startedAt;
    const tick = setInterval(() => {
      if (settled) return;
      const now = Date.now();
      if (opts.isWaiting?.()) waitedMs += now - lastCheck;
      lastCheck = now;
      const limit = turnLimit(now - startedAt, waitedMs, opts.ceilingMs, hardCeilingMs);
      if (limit) {
        timedOut = true;
        log(`[trb] stopped at ${limit}.`);
        terminate(false);
      } else if (now - lastActivity >= opts.idleMs) {
        if (opts.isBusy?.()) {
          lastActivity = now;
          return;
        }
        timedOut = true;
        log(`[trb] stopped: no output for ${Math.round(opts.idleMs / 60_000)} min and no working subagents.`);
        terminate(false);
      }
    }, Math.max(250, Math.min(5_000, Math.floor(opts.idleMs / 4))));
    tick.unref?.();

    const onAbort = () => {
      aborted = true;
      terminate(false);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (data: Buffer) => {
      lastActivity = Date.now();
      const text = data.toString();
      stdoutKept.add(text);
      stream.push(text);
    });
    child.stderr.on("data", (data: Buffer) => {
      lastActivity = Date.now();
      const text = data.toString();
      stderrKept.add(text);
      for (const line of text.split("\n")) if (line.trim()) log(`[stderr] ${line}`);
    });

    if (spec.stdin !== null) {
      child.stdin.on("error", () => {}); // EPIPE when the CLI exits before reading its prompt
      child.stdin.write(spec.stdin);
    }
    child.stdin.end();

    const settle = (code: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      if (drain) clearTimeout(drain);
      opts.signal?.removeEventListener("abort", onAbort);
      stream.end();
      try {
        spec.cleanup();
      } catch {}

      const usage = stream.cliUsage();
      const stderrText = stderrKept.text();
      const plainStdout = stdoutKept.text().trim();
      const base = { sessionId: stream.sessionId(), usage, exitCode: code, stderr: stderrText, maxTurnsHit: stream.maxTurnsHit() };
      const answer = stream.finalText();

      if (spawnError) return resolve(empty(`Failed to execute ${spec.cmd}: ${spawnError.message}`, base));
      if (aborted) return resolve(empty(answer || "Stopped by the operator.", { ...base, aborted: true }));
      if (timedOut) return resolve(empty(answer || "Timed out.", { ...base, timedOut: true }));

      // A refused resume never reached the model: report it so the caller retries fresh.
      // stderr is checked as well as the event stream — the CLI prints it there.
      if (opts.resumeId && (stream.resumeRejected() || looksLikeResumeRejection(stderrText))) {
        log(`[trb] session ${opts.resumeId} could not be resumed; a fresh session is needed.`);
        return resolve(empty(answer || stderrText.trim(), { ...base, usage: null, resumeRejected: true }));
      }

      // A stream-json run reports its own completion, so the protocol decides rather than a
      // length heuristic: `{"count": 18}` is a complete answer. Otherwise (a CLI with no
      // terminal event) fall back to exit code + content.
      let ok: boolean;
      let reason = "";
      if (stream.maxTurnsHit()) {
        ok = true; // a capped turn did the work it had turns for; it needs a continuation, not a failure row
      } else if (stream.completed()) {
        ok = !stream.isError();
        if (!ok) reason = "The engine reported an error result";
      } else {
        const failure = classifyFailure(`${answer}\n${stderrText}`);
        ok = code === 0 && !failure && Boolean(answer || plainStdout);
        if (!ok) reason = failure ?? (code === 0 ? "The engine exited without producing an answer" : `The engine exited with code ${code}`);
      }
      if (!ok) {
        // A completed-but-errored stream still names its cause in the text; surface a known one.
        const failure = classifyFailure(`${answer}\n${stderrText}`);
        if (failure) reason = failure;
        log(`[trb] ${def.label} run failed: ${reason}.`);
      }
      const tail = stderrText.trim() && !ok ? `\n--- stderr ---\n${stderrText.trim().slice(-2000)}` : "";
      resolve({
        success: ok,
        output: ok ? answer || plainStdout : `${answer || ""}${answer ? "\n\n" : ""}[trb] ${reason}.${tail}`.trim(),
        resumeRejected: false,
        aborted: false,
        timedOut: false,
        ...base,
      });
    };

    child.on("error", (err) => settle(null, err));
    // The turn ends when the CLI exits. `close` also waits for every process still holding its stdout (a dev server
    // the agent started in the background, say), which can outlive the turn by hours. So after `exit`, give the pipes
    // a moment to deliver what is buffered, then settle without them. Such a process is left running, as before.
    child.on("exit", (code) => {
      if (settled) return;
      clearInterval(tick);
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(code);
      }, EXIT_DRAIN_MS);
    });
    child.on("close", (code) => settle(code));
  });
}
