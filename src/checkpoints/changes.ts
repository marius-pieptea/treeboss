/**
 * Which files a turn changed, from the checkpoints. Every turn ends with a snapshot of the working tree
 * (checkpoints/store.ts), so a turn's changes are the diff between its snapshot and the one before it. That is one
 * `git diff` between two tree objects git already holds: no scan of the working tree, and new, changed and deleted
 * files alike. The treeboss gate and the verify step both read a turn this way.
 */
import { LOCAL_GIT_TIMEOUT_MS, runGit } from "../git/run";
import { checkpointBefore, checkpointOfTurn, type Checkpoint } from "./store";

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export interface Changes {
  /** Every file the diff touches, relative to the session's directory. */
  files: string[];
  added: AddedLine[];
}

const DIFF_FILE = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A unified diff (zero context lines) into the files it touches and the lines it adds, with their numbers. */
export function parseDiff(diff: string): Changes {
  const files: string[] = [];
  const added: AddedLine[] = [];
  let file = "";
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const l of diff.split("\n")) {
    // Inside a hunk the header's counts say what each line is, so a removed line that reads "--- x" is not a header.
    if (oldLeft > 0 || newLeft > 0) {
      if (l.startsWith("+")) {
        added.push({ file, line, text: l.slice(1) });
        line++;
        newLeft--;
      } else if (l.startsWith("-")) {
        oldLeft--;
      } else if (!l.startsWith("\\")) {
        oldLeft--;
        newLeft--;
        line++;
      }
      continue;
    }
    const f = DIFF_FILE.exec(l);
    if (f) {
      file = f[2]!;
      files.push(file);
      continue;
    }
    const h = HUNK.exec(l);
    if (h) {
      oldLeft = Number(h[1] ?? 1);
      newLeft = Number(h[3] ?? 1);
      line = Number(h[2]);
    }
  }
  return { files, added };
}

/** The git diff between a turn's snapshot and the one before it, relative to the session's directory. Null when git refuses. */
export async function turnChanges(cwd: string, from: string, to: string): Promise<Changes | null> {
  const r = await runGit(["diff", "--relative", "--no-renames", "--no-color", "-U0", from, to], { cwd, maxBytes: 256 * 1024 * 1024, timeoutMs: LOCAL_GIT_TIMEOUT_MS }).catch(() => null);
  return r && r.code === 0 ? parseDiff(r.stdout.toString()) : null;
}

/** The turn's changes, or the reason they could not be read. The reason is for the caller to log. */
export async function turnChangesOf(s: { id: string; cwd: string }, turnId: string, seq: number): Promise<Changes | string> {
  const now: Checkpoint | null = checkpointOfTurn(s.id, turnId);
  const before: Checkpoint | null = checkpointBefore(s.id, seq);
  if (!now || !before || before.git_root !== now.git_root) return "no checkpoint for this turn (not a git repository?), so its files were not checked.";
  const changes = await turnChanges(s.cwd, before.tree_sha, now.tree_sha);
  if (!changes) return "git could not diff this turn, so its files were not checked.";
  return changes;
}
