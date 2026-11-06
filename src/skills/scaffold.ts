/**
 * Bookkeeping for the skill copies a turn puts in a workspace, so they can always be taken out again and never
 * look like the user's work while they are there.
 *
 * - A manifest per turn, kept under trb's home (never in the workspace), names what the turn placed. If the daemon
 *   dies mid-turn the next start sweeps it, instead of leaving thousands of files in someone's repo.
 * - While copies exist, their paths sit in a managed block of the repository's `info/exclude`, so every git tool
 *   (the terminal's `git status` included) ignores them. Only the placed skill folders are listed, never the whole
 *   skills directory, so the user's own skills there stay visible.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { paths } from "../paths";

const BEGIN = "# >>> trb skills (managed: removed when the turn ends)";
const END = "# <<< trb skills";

export interface ExcludeTarget {
  /** The repository's exclude file (the common one, which linked worktrees read too). */
  file: string;
  /** The repository's top level: patterns in the file are relative to it. */
  top: string;
}

interface Manifest {
  cwd: string;
  placed: string[];
  owned: string[];
  exclude: ExcludeTarget | null;
}

/** Where git wants ignore patterns for the repository around `cwd`; null outside one or when git cannot say. */
export function excludeTargetFor(cwd: string): ExcludeTarget | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel", "--git-path", "info/exclude"], { cwd, encoding: "utf-8", timeout: 5000, windowsHide: true });
  if (r.status !== 0) return null;
  const [top, file] = r.stdout.split("\n").map((l) => l.trim());
  if (!top || !file) return null;
  return { top: fs.realpathSync(top), file: path.resolve(cwd, file) };
}

const escapePattern = (s: string) => s.replace(/[\\*?[\]]/g, "\\$&").replace(/ +$/, (m) => "\\ ".repeat(m.length));

function stripBlock(text: string): string {
  const a = text.indexOf(BEGIN);
  if (a === -1) return text;
  const b = text.indexOf(END, a);
  const after = b === -1 ? "" : text.slice(b + END.length).replace(/^\r?\n/, "");
  return text.slice(0, a) + after;
}

/** Rewrite the managed block to list `dests` (absolute paths under `target.top`); none removes the block. */
export function syncExclude(target: ExcludeTarget, dests: string[]): void {
  try {
    const current = fs.existsSync(target.file) ? fs.readFileSync(target.file, "utf-8") : "";
    const base = stripBlock(current);
    // git reports real paths (/private/var, not /var): compare like with like. Resolve the parent only: the entry itself
    // may be a link into the skill store, and resolving it would point at the store instead of the workspace.
    const parents = new Map<string, string>();
    const real = (d: string) => {
      const dir = path.dirname(d);
      let r = parents.get(dir);
      if (r === undefined) {
        try {
          r = fs.realpathSync(dir);
        } catch {
          r = dir;
        }
        parents.set(dir, r);
      }
      return path.join(r, path.basename(d));
    };
    // No trailing slash: a link to a folder is not a folder to git, and `name/` would not match it.
    const lines = dests
      .map(real)
      .filter((d) => d.startsWith(target.top + path.sep))
      .map((d) => `/${escapePattern(path.relative(target.top, d).split(path.sep).join("/"))}`)
      .sort();
    const next = lines.length ? `${base}${base && !base.endsWith("\n") ? "\n" : ""}${BEGIN}\n${lines.join("\n")}\n${END}\n` : base;
    if (next === current) return;
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, next);
  } catch {
    // Not fatal: the daemon's own status view still leaves these out.
  }
}

/** Whether anything is at `p`, a dangling link included (`existsSync` says no to those). */
export function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Remove a placed skill. A link is unlinked and nothing more: what it points at is the skill store, never ours to delete. */
export function removePlaced(p: string): void {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) {
      try {
        fs.unlinkSync(p);
      } catch {
        fs.rmdirSync(p); // a Windows junction
      }
      return;
    }
  } catch {
    return;
  }
  fs.rmSync(p, { recursive: true, force: true });
}

/** Put `src` (a skill folder in the store) at `dest` as a link: one entry instead of a copy of every file. Throws if it cannot. */
export function linkSkill(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(fs.realpathSync(src), dest, process.platform === "win32" ? "junction" : "dir");
}

const dir = () => paths.skillRuns();

/** Record a turn's placements; returns the id to `forget` when its cleanup has run. */
export function recordRun(m: Manifest): string {
  const id = randomUUID();
  try {
    fs.writeFileSync(path.join(dir(), `${id}.json`), JSON.stringify(m));
  } catch {}
  return id;
}

export function forgetRun(id: string): void {
  try {
    fs.rmSync(path.join(dir(), `${id}.json`), { force: true });
  } catch {}
}

/**
 * Undo what turns that never got to clean up placed (the daemon was killed). Run once at startup, before any turn:
 * nothing from before it is live. Returns how many skill folders were removed.
 */
export function sweepStaleRuns(): number {
  let removed = 0;
  for (const f of fs.readdirSync(dir())) {
    const file = path.join(dir(), f);
    try {
      const m = JSON.parse(fs.readFileSync(file, "utf-8")) as Manifest;
      const root = path.resolve(m.cwd) + path.sep;
      // A manifest is only trusted for paths inside its own workspace.
      for (const p of m.placed ?? []) {
        if (path.resolve(p).startsWith(root) && present(p)) {
          removePlaced(p);
          removed++;
        }
      }
      for (const d of [...(m.owned ?? [])].reverse()) {
        if (!path.resolve(d).startsWith(root)) continue;
        try {
          fs.rmdirSync(d); // only when empty: never takes the operator's own files
        } catch {}
      }
      if (m.exclude) syncExclude(m.exclude, []);
    } catch {}
    fs.rmSync(file, { force: true });
  }
  return removed;
}
