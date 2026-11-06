/**
 * Keep-in-sync: after a turn changed files, bring the index up to date in the background.
 *
 * Runs only when the workspace turned the toggle on AND an index already exists (never creates one).
 * Debounced per index root, serialized through the job runner (one sync per root at a time, a request
 * that arrives mid-sync schedules exactly one more), and never awaited by the turn. A failure is
 * reported as an info line, never as an error.
 */
import { codegraphBinary, codegraphStatusAsync, findIndexRoot } from "./detect";
import { keepInSyncFor } from "./prefs";
import { jobFinished, runningJobFor, startCodegraph } from "./jobs";

const DEBOUNCE_MS = () => Number(process.env.TRB_CODEGRAPH_DEBOUNCE_MS ?? 1500);
const SYNC_TIMEOUT_MS = 5 * 60_000;
/** After "database is locked", CodeGraph's own background service holds the index: wait before trying again. */
const BUSY_BACKOFF_MS = 10 * 60_000;

type Log = (line: string) => void;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const loggers = new Map<string, Log>();
const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();
const busyUntil = new Map<string, number>();

function say(root: string, line: string): void {
  try {
    loggers.get(root)?.(line);
  } catch {}
}

async function runOnce(root: string): Promise<void> {
  if ((busyUntil.get(root) ?? 0) > Date.now()) return; // the index is busy: try again after the backoff
  const st = await codegraphStatusAsync(root, { fresh: true });
  if (!st.available || !st.root || st.pendingChanges === 0) return; // nothing changed on disk: nothing to do
  const changes = st.pendingChanges;
  try {
    const job = startCodegraph(root, "sync", { timeoutMs: SYNC_TIMEOUT_MS });
    const done = await jobFinished(job.id);
    if (done?.state === "failed" && /database is locked/i.test(done.error ?? "")) {
      busyUntil.set(root, Date.now() + BUSY_BACKOFF_MS);
      say(root, "[codegraph] index is busy (CodeGraph's background service has it open and keeps it in sync); not retrying for 10 minutes");
    } else if (done?.state === "failed") say(root, `[codegraph] sync failed: ${done.error ?? "unknown error"}`);
    else say(root, `[codegraph] index synced (${changes} change${changes === 1 ? "" : "s"})`);
  } catch (e: any) {
    say(root, `[codegraph] sync skipped: ${e?.message ?? e}`);
  }
}

async function drain(root: string): Promise<void> {
  do {
    again.delete(root);
    const running = runningJobFor(root);
    if (running) await jobFinished(running.id); // a manual sync is already on it: let it finish, then check again
    await runOnce(root);
  } while (again.has(root));
}

/** Request a sync for the project at `dir`. Returns at once; `log` gets the outcome. */
export function scheduleKeepInSync(dir: string, log?: Log): void {
  if (!keepInSyncFor(dir) || !codegraphBinary()) return;
  const root = findIndexRoot(dir);
  if (!root) return;
  if (log) loggers.set(root, log); // the latest turn to ask is the one that gets the outcome line
  clearTimeout(timers.get(root));
  timers.set(
    root,
    setTimeout(() => {
      timers.delete(root);
      if (inflight.has(root)) return void again.add(root);
      const p = drain(root)
        .catch(() => {})
        .finally(() => {
          inflight.delete(root);
          loggers.delete(root);
        });
      inflight.set(root, p);
    }, DEBOUNCE_MS()),
  );
}

/** Tests: resolve once nothing is pending or running. */
export async function keepInSyncIdle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (timers.size === 0 && inflight.size === 0) return;
    await Promise.all([...inflight.values()]);
    await Bun.sleep(20);
  }
}
