/**
 * Building, syncing or rebuilding an index as a background job the UI can poll. A job only ever starts
 * from an explicit request (a button, a CLI command) or, for `sync`, from keep-in-sync on an index that
 * already exists. `init` is the only mode that creates a `.codegraph/`.
 *
 * The CLI runs on a pseudo-terminal when one is available: only a terminal makes it print real progress
 * ("Parsing code ... 44%", "Scanning files, 2,817 found"). Piped, it prints bare phase names. Either way
 * `parseProgress` turns what it prints into a phase and a percentage the UI can draw.
 */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { UserError } from "../util";
import { getSetting } from "../settings";
import { clearCodegraphCache, codegraphBinary, codegraphStatus, codegraphStatusAsync, findIndexRoot, setIndexBusy } from "./detect";
import { ensureCodegraphIgnored } from "./gitignore";

export type CodegraphJobMode = "init" | "sync" | "reindex";

export interface JobProgress {
  /** The phase the CLI is in ("Parsing code"), or null before it printed one. */
  phase: string | null;
  /** 1-based index of the phase among the known ones, 0 when unknown. */
  step: number;
  steps: number;
  /** Progress inside the current phase when the CLI reports it. */
  percent: number | null;
  /** Whole-job progress 0..100 across phases, or null when nothing is known yet. Never goes backwards. */
  overall: number | null;
  /** Side information from the latest line ("2,817 found"). */
  detail: string | null;
}

export interface CodegraphJob {
  id: string;
  path: string;
  mode: CodegraphJobMode;
  state: "running" | "done" | "failed" | "cancelled";
  /** The last lines the CLI printed, ANSI stripped, progress redraws left out. */
  log: string[];
  error: string | null;
  /** One line about a side effect worth telling the operator, e.g. the .gitignore entry. */
  note: string | null;
  /** The finished job in one line: "Indexed 2,816 files, 49.7k symbols in 14s". */
  summary: string | null;
  progress: JobProgress;
  /** This init made the `.codegraph/` directory (so a cancel may remove it). */
  createdRoot: boolean;
  /** The time limit that applied, in ms, 0 for none. */
  timeoutMs: number;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, CodegraphJob>();
const procs = new Map<string, ReturnType<typeof Bun.spawn>>();
const finished = new Map<string, Promise<CodegraphJob>>();
const dismissed = new Set<string>();
/** Why a job was told to stop, read by the exit handler. */
const stopReason = new Map<string, "cancel" | "timeout" | "shutdown">();
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const LOG_LINES = 60;
const dec = new TextDecoder();

export const PHASES = ["Scanning files", "Parsing code", "Resolving refs", "Linking dynamic dispatch"] as const;
/** Rough share of the whole run each phase takes (parsing dominates). */
const WEIGHTS = [0.08, 0.6, 0.27, 0.05];

export function emptyProgress(): JobProgress {
  return { phase: null, step: 0, steps: PHASES.length, percent: null, overall: null, detail: null };
}

/**
 * Fold one line of CLI output into the progress. Returns true when the line was a progress redraw
 * (so it should not be appended to the log).
 */
export function parseProgress(raw: string, p: JobProgress): boolean {
  const line = raw.replace(ANSI, "").replace(/^[^A-Za-z0-9]+/, "").trim();
  if (!line) return false;
  const idx = PHASES.findIndex((ph) => line.toLowerCase().startsWith(ph.toLowerCase()));
  const pct = /(\d{1,3})%\s*$/.exec(line);
  const found = /([\d,]+)\s+found\b/i.exec(line);
  const done = /(?:[—–-]\s*done|✓|✔)\s*$/i.test(line) || /\bdone\s*$/i.test(line);
  if (idx < 0) {
    // A phase this version knows nothing about: show it, but claim no percentage.
    if (/^[A-Z][A-Za-z ]{3,40}(?:\.\.\.|…)$/.test(line)) {
      p.phase = line.replace(/(?:\.\.\.|…)$/, "");
      p.percent = null;
      return true;
    }
    return false;
  }
  if (p.phase !== PHASES[idx]) p.detail = null; // "2,817 found" belongs to the scan, not to what follows
  p.phase = PHASES[idx];
  p.step = idx + 1;
  if (found) p.detail = `${found[1]} found`;
  const frac = done ? 1 : pct ? Math.min(100, Number(pct[1])) / 100 : null;
  p.percent = frac === null ? null : Math.round(frac * 100);
  const before = WEIGHTS.slice(0, idx).reduce((a, b) => a + b, 0);
  const overall = Math.round((before + WEIGHTS[idx] * (frac ?? 0)) * 100);
  p.overall = Math.max(p.overall ?? 0, overall);
  // Every line about a known phase is progress, not log: the log is for what the CLI says besides.
  return true;
}

export function getCodegraphJob(id: string): CodegraphJob | null {
  return jobs.get(id) ?? null;
}

export function runningJobFor(dir: string): CodegraphJob | null {
  for (const j of jobs.values()) if (j.state === "running" && j.path === dir) return j;
  return null;
}

/** The job the panel should show for a project: the one running, else the latest finished one not yet dismissed. */
export function latestJobFor(...dirs: Array<string | null>): CodegraphJob | null {
  const want = new Set(dirs.filter(Boolean) as string[]);
  let best: CodegraphJob | null = null;
  for (const j of jobs.values()) {
    if (!want.has(j.path)) continue;
    if (j.state === "running") return j;
    if (dismissed.has(j.id)) continue;
    if (!best || (j.finishedAt ?? "") > (best.finishedAt ?? "")) best = j;
  }
  return best;
}

export function dismissCodegraphJob(id: string): void {
  const j = jobs.get(id);
  if (j && j.state !== "running") dismissed.add(id);
}

/** Resolves when the job has ended (immediately for one that already has). */
export function jobFinished(id: string): Promise<CodegraphJob | null> {
  return finished.get(id) ?? Promise.resolve(jobs.get(id) ?? null);
}

export interface StartOptions {
  /** `init` only: add `.codegraph/` to the project's .gitignore once the index is built. */
  gitignore?: boolean;
  /** Time limit in ms. Default: the `codegraph_timeout_min` setting. 0: none. */
  timeoutMs?: number;
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function compactN(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

function spawnCli(cmd: string[], onData: (text: string) => void): { proc: ReturnType<typeof Bun.spawn>; pumps: Promise<unknown> } {
  const env = { ...process.env, NO_COLOR: "1", TERM: "xterm" } as Record<string, string>;
  // A pseudo-terminal on Windows is a console window that flashes up, so there we use the hidden pipes below.
  if (process.platform !== "win32") {
    try {
      const proc = Bun.spawn(cmd, {
        env,
        terminal: { cols: 120, rows: 30, data: (_t: unknown, d: Uint8Array) => onData(dec.decode(d, { stream: true })) },
      } as any);
      return { proc, pumps: Promise.resolve() };
    } catch {
      // No pseudo-terminal here: pipes still give the phase names.
    }
  }
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env, windowsHide: true });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const d = new TextDecoder();
    for await (const chunk of stream) onData(d.decode(chunk, { stream: true }));
  };
  return { proc, pumps: Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]).catch(() => {}) };
}

function stopProc(id: string, reason: "cancel" | "timeout" | "shutdown"): void {
  const proc = procs.get(id);
  if (!proc) return;
  if (!stopReason.has(id)) stopReason.set(id, reason);
  try {
    proc.kill();
  } catch {}
  // A process that ignores SIGTERM must not hold the job open.
  const t = setTimeout(() => {
    if (procs.has(id)) {
      try {
        proc.kill(9);
      } catch {}
    }
  }, 4000);
  (t as any).unref?.();
}

/**
 * Start `init` (creates the index), `sync` (changes since the last index) or `reindex` (full rebuild).
 * `sync` and `reindex` need an index to exist; only `init` makes one. A job already running for the
 * same index root is returned instead of starting a second, which is what serializes them.
 */
export function startCodegraph(dir: string, requested: CodegraphJobMode, opts: StartOptions = {}): CodegraphJob {
  let mode = requested;
  const bin = codegraphBinary();
  if (!bin) throw new UserError("CodeGraph is not available: no bundled copy, no codegraph_bin setting and nothing on PATH.");
  const root = findIndexRoot(dir);
  // A `.codegraph/` folder is not proof of an index: an interrupted init leaves an empty one. Ask the CLI.
  let leftover = false;
  if (mode === "init" && root) {
    if (codegraphStatus(root, { fresh: true }).state === "none") leftover = true;
    else mode = "reindex"; // "Initialize" on an existing index means "make sure it is indexed", not an error
  }
  if (mode === "init" || leftover) {
    try {
      fs.rmdirSync(path.join(root ?? dir, ".codegraph")); // only succeeds on an empty folder
    } catch {}
  }
  const rootNow = leftover ? null : root;
  if (mode !== "init" && !rootNow) throw new UserError(`CodeGraph is not initialized in ${dir}. Initialize it first.`);
  const target = rootNow ?? dir;
  const existing = runningJobFor(target);
  if (existing) return existing;

  const limitMin = Number(getSetting("codegraph_timeout_min")) || 0;
  const timeoutMs = opts.timeoutMs ?? limitMin * 60_000;
  const job: CodegraphJob = { id: `cg_${randomBytes(5).toString("hex")}`, path: target, mode, state: "running", log: [], error: null, note: null, summary: null, progress: emptyProgress(), createdRoot: mode === "init", timeoutMs, startedAt: new Date().toISOString(), finishedAt: null };
  jobs.set(job.id, job);

  let carry = "";
  let lastLine = "";
  const onData = (text: string) => {
    carry += text;
    const lines = carry.split(/\r\n|\r|\n/);
    carry = lines.pop() ?? "";
    for (const l of lines) {
      const clean = l.replace(ANSI, "").replace(/^[│└●◇◆\s]+/, "").trim();
      if (!clean) continue;
      const isProgress = parseProgress(clean, job.progress);
      if (isProgress || clean === lastLine) continue;
      lastLine = clean;
      job.log = [...job.log, clean].slice(-LOG_LINES);
    }
  };

  setIndexBusy(target, true);
  let proc: ReturnType<typeof Bun.spawn>, pumps: Promise<unknown>;
  try {
    ({ proc, pumps } = spawnCli([bin, mode === "reindex" ? "index" : mode, target], onData));
  } catch (e) {
    setIndexBusy(target, false);
    throw e;
  }
  procs.set(job.id, proc);
  const timer = timeoutMs > 0 ? setTimeout(() => stopProc(job.id, "timeout"), timeoutMs) : null;

  finished.set(
    job.id,
    (async () => {
      const code = await proc.exited;
      await Promise.race([pumps, Bun.sleep(500)]);
      if (carry.trim()) onData("\n");
      if (timer) clearTimeout(timer);
      procs.delete(job.id);
      setIndexBusy(job.path, false);
      const reason = stopReason.get(job.id);
      stopReason.delete(job.id);
      const ms = Date.now() - Date.parse(job.startedAt);

      // `sync` on a directory the CLI does not know prints an error and still exits 0: trust the log too.
      const refused = code === 0 && job.log.some((l) => /not initialized/i.test(l));
      const ok = code === 0 && !refused && !reason;
      let state: CodegraphJob["state"] = ok ? "done" : "failed";

      if (reason === "cancel") {
        state = "cancelled";
        // Only a directory this job made is this job's to remove.
        if (job.createdRoot) {
          try {
            fs.rmSync(path.join(job.path, ".codegraph"), { recursive: true, force: true });
            job.note = "Cancelled. The partial .codegraph/ was removed.";
          } catch (e: any) {
            job.note = `Cancelled, but .codegraph/ could not be removed: ${e?.message ?? e}`;
          }
        } else job.note = "Cancelled. The index may be incomplete: re-index to rebuild it.";
      } else if (reason === "timeout") {
        job.error = `Stopped after ${duration(timeoutMs)}: the time limit (codegraph_timeout_min) was reached. Raise it with \`trb config set codegraph_timeout_min <minutes>\`, or run \`codegraph index\` in a terminal.`;
      } else if (reason === "shutdown") {
        job.error = "The daemon stopped while this was running. The index is incomplete: re-index to finish it.";
      } else if (!ok) {
        job.error = job.log.slice(-3).join(" ") || `codegraph exited with ${code}`;
      }

      if (ok && mode === "init" && opts.gitignore) {
        try {
          const r = ensureCodegraphIgnored(job.path);
          if (r.reason === "added" || r.reason === "created") job.note = "Added .codegraph/ to .gitignore.";
          else if (r.reason === "already-ignored") job.note = ".codegraph/ was already in .gitignore.";
        } catch (e: any) {
          job.note = `Could not update .gitignore: ${e?.message ?? e}`;
        }
      }
      clearCodegraphCache();
      if (ok) {
        const syncLine = [...job.log].reverse().find((l) => /^(synced\b|already up to date)/i.test(l));
        const st = await codegraphStatusAsync(job.path, { fresh: true });
        job.summary = mode === "sync" && syncLine ? `${syncLine}${/^already/i.test(syncLine) ? "" : ` in ${duration(ms)}`}` : `${mode === "sync" ? "Synced" : "Indexed"} ${st.files.toLocaleString("en-US")} files, ${compactN(st.symbols)} symbols in ${duration(ms)}`;
        job.progress = { ...job.progress, overall: 100, percent: job.progress.phase ? 100 : null };
      }
      job.finishedAt = new Date().toISOString();
      job.state = state; // last, so a poller that sees the end also sees the note, summary and error
      // Keep the 30 newest; drop the oldest finished ones, never the job that just ended (its poller is about to read it).
      if (jobs.size > 30) {
        const old = [...jobs.values()].filter((j) => j.state !== "running" && j.id !== job.id).sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
        for (const j of old.slice(0, jobs.size - 30)) (jobs.delete(j.id), finished.delete(j.id), dismissed.delete(j.id));
      }
      return job;
    })(),
  );
  return job;
}

/** Stop a running job. A directory the job created is removed once the process is gone. */
export async function cancelCodegraphJob(id: string): Promise<CodegraphJob | null> {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.state !== "running") return job;
  stopProc(id, "cancel");
  return jobFinished(id);
}

/** Daemon shutdown: end every running job without deleting what it built, so the next start can see it is incomplete. */
export async function stopAllCodegraphJobs(): Promise<void> {
  const running = [...jobs.values()].filter((j) => j.state === "running");
  for (const j of running) stopProc(j.id, "shutdown");
  await Promise.race([Promise.all(running.map((j) => jobFinished(j.id))), Bun.sleep(5000)]);
}
