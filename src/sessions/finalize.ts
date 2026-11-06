/**
 * Finalization: what a head needs after its turn has ended, kept off the turn's own path.
 *
 * A turn ends (status, finished_at, the turn_end event) as soon as the engine says so. Its worktree commit, its
 * checkpoint and its diff summary come after, in `finalizeHead`: they run on a later tick, so a slow git call does
 * not delay the event or the recorded duration. While that is pending the session has no `finalized_at`, and
 * merge-readiness waits for it. A new turn or a merge on the same head waits for it too, so neither starts from
 * a half-recorded state.
 */
import { db } from "../db";

export interface ChangeSummary {
  files: number;
  insertions: number;
  deletions: number;
}

export function parseShortstat(stat: string): ChangeSummary {
  const num = (re: RegExp) => Number(stat.match(re)?.[1] ?? 0);
  return { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) };
}

/** `git diff --shortstat from to`, run without blocking the event loop. null when git fails. */
export async function diffSummary(gitRoot: string, from: string, to: string): Promise<ChangeSummary | null> {
  try {
    const proc = Bun.spawn(["git", "diff", "--shortstat", from, to], { cwd: gitRoot, stdout: "pipe", stderr: "ignore", windowsHide: true });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? parseShortstat(out.trim()) : null;
  } catch {
    return null;
  }
}

const pending = new Map<string, Promise<void>>();

/** The finalization still running for a session, or null. */
export function finalizingOf(sessionId: string): Promise<void> | null {
  return pending.get(sessionId) ?? null;
}

/**
 * Run a head's finalization after the current tick. `work` does the git writes (commit, checkpoint) and returns
 * the diff summary of the head, or null when it has no changes. Always records `finalized_at`, even when `work`
 * fails (with a warning), so a head is never stuck unmergeable. Finalizations of one session run in order.
 */
export function finalizeHead(sessionId: string, work: () => Promise<ChangeSummary | null> | ChangeSummary | null): Promise<void> {
  const prev = pending.get(sessionId) ?? Promise.resolve();
  const run = prev
    .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
    .then(async () => {
      let changes: ChangeSummary | null = null;
      try {
        changes = await work();
      } catch (err: any) {
        console.warn(`[trb] ${sessionId}: finalize failed: ${err?.message ?? err}`);
      }
      db().prepare("UPDATE sessions SET changes_json = ?, finalized_at = CURRENT_TIMESTAMP WHERE id = ?").run(JSON.stringify(changes), sessionId);
    })
    .catch((err: any) => console.warn(`[trb] ${sessionId}: could not record finalization: ${err?.message ?? err}`));
  const done = run.finally(() => {
    if (pending.get(sessionId) === done) pending.delete(sessionId);
  });
  pending.set(sessionId, done);
  return done;
}
