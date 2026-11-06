/**
 * How far a page has drifted from the code it describes.
 *
 * A page that records `generated.commit` and `covers` makes a checkable claim: "this is true of these
 * paths as of that commit". Staleness is the size of the change to those paths since: commits that touched
 * them and files that changed, were renamed or were deleted. A page without both keys makes no claim, so
 * it is `unmanaged` and nothing is said about it.
 *
 *   fresh      nothing under `covers` changed since the recorded commit (HEAD may have moved on)
 *   drifting   a little changed
 *   stale      a lot changed, or too much time in commits has gone by
 *   unknown    the claim cannot be checked (not a repository, or the commit is gone)
 *   unmanaged  no `generated.commit` or no `covers`
 */
import fs from "fs";
import path from "path";
import { runCmd } from "../git/run";
import type { DocMeta } from "./frontmatter";

export type Freshness = "fresh" | "drifting" | "stale" | "unknown" | "unmanaged";

export interface ChangedFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  /** renamed: where it was. */
  from?: string;
}

export interface Staleness {
  state: Freshness;
  /** Why `unknown` or `unmanaged`, in a sentence. */
  reason: string | null;
  /** Commits since the recorded one that touched the covered paths. */
  commitsBehind: number;
  /** Commits since the recorded one, whatever they touched. */
  headBehind: number;
  filesChanged: number;
  /** Capped at FILE_LIST_CAP; `filesChanged` has the full count. */
  files: ChangedFile[];
  generatedCommit: string | null;
  head: string | null;
}

/** The thresholds, in one place: up to these counts a page is `drifting`, past either one it is `stale`. */
export const THRESHOLDS = { driftingCommits: 5, driftingFiles: 8 } as const;
export const FILE_LIST_CAP = 100;

const GLOB_CHARS = /[*?[\]{}!]/;

/**
 * `covers` entries are globs or plain paths. A path without glob characters that is a directory (or ends
 * in `/`) means everything under it; a plain file means that file.
 */
export function normalizeCovers(rootDir: string, covers: string[]): string[] {
  const out: string[] = [];
  for (const raw of covers) {
    let c = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    if (!c || c.includes("\0") || c.split("/").includes("..")) continue;
    if (!GLOB_CHARS.test(c)) {
      const isDir = c.endsWith("/") || (() => {
        try {
          return fs.statSync(path.join(rootDir, c)).isDirectory();
        } catch {
          return false;
        }
      })();
      if (isDir) c = `${c.replace(/\/+$/, "")}/**`;
    }
    out.push(c);
  }
  return [...new Set(out)];
}

const globsOf = (patterns: string[]) => patterns.map((p) => new Bun.Glob(p));
const matches = (globs: Bun.Glob[], file: string) => globs.some((g) => g.match(file));

/** The covers a page claims, as git pathspecs. */
const pathspecs = (patterns: string[]) => patterns.map((p) => `:(glob)${p}`);

const git = (rootDir: string, args: string[]) => runCmd("git", args, { cwd: rootDir, timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024 });

export async function headSha(rootDir: string): Promise<string | null> {
  const r = await git(rootDir, ["rev-parse", "--verify", "-q", "HEAD"]);
  return r.code === 0 ? r.stdout.toString().trim() : null;
}

async function resolveCommit(rootDir: string, ref: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,64}$/i.test(ref)) return null;
  const r = await git(rootDir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.toString().trim() : null;
}

/** name-status between a commit and HEAD, with renames folded: `R100\told\tnew`. */
export function parseNameStatus(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [st, a, b] = line.split("\t");
    if (st.startsWith("R") || st.startsWith("C")) files.push({ path: b ?? a, from: a, status: st.startsWith("R") ? "renamed" : "added" });
    else if (st.startsWith("D")) files.push({ path: a, status: "deleted" });
    else if (st.startsWith("A")) files.push({ path: a, status: "added" });
    else files.push({ path: a, status: "modified" });
  }
  return files;
}

export function classify(commitsBehind: number, filesChanged: number): Freshness {
  if (filesChanged === 0) return "fresh";
  if (commitsBehind > THRESHOLDS.driftingCommits || filesChanged > THRESHOLDS.driftingFiles) return "stale";
  return "drifting";
}

const unmanaged = (reason: string): Staleness => ({ state: "unmanaged", reason, commitsBehind: 0, headBehind: 0, filesChanged: 0, files: [], generatedCommit: null, head: null });

interface CacheEntry {
  key: string;
  value: Staleness;
}
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 400;

export function clearStalenessCache(): void {
  cache.clear();
}

/** Work out one page. Bounded: two git calls, 10s each, 4 MB of output at most. Never throws. */
export async function pageStaleness(rootDir: string, meta: DocMeta, head?: string | null): Promise<Staleness> {
  const commit = meta.generated?.commit ?? null;
  if (!commit) return unmanaged("The page does not record a generated commit.");
  if (!meta.covers.length) return { ...unmanaged("The page does not list what it covers."), generatedCommit: commit };
  const patterns = normalizeCovers(rootDir, meta.covers);
  if (!patterns.length) return { ...unmanaged("None of the covers entries is a usable path."), generatedCommit: commit };
  try {
    const tip = head === undefined ? await headSha(rootDir) : head;
    if (!tip) return { ...unmanaged("Not a git repository, or it has no commits."), state: "unknown", generatedCommit: commit };
    const key = `${rootDir}\0${commit}\0${tip}\0${patterns.join("\0")}`;
    const hit = cache.get(key);
    if (hit) return hit.value;

    const from = await resolveCommit(rootDir, commit);
    let value: Staleness;
    if (!from) {
      value = { state: "unknown", reason: `Commit ${commit.slice(0, 8)} is not in this repository (history rewritten, or another clone).`, commitsBehind: 0, headBehind: 0, filesChanged: 0, files: [], generatedCommit: commit, head: tip };
    } else if (from === tip) {
      value = { state: "fresh", reason: null, commitsBehind: 0, headBehind: 0, filesChanged: 0, files: [], generatedCommit: commit, head: tip };
    } else {
      const [diff, covering, any] = await Promise.all([
        git(rootDir, ["diff", "--name-status", "-M", "--no-ext-diff", `${from}..${tip}`]),
        git(rootDir, ["rev-list", "--count", `${from}..${tip}`, "--", ...pathspecs(patterns)]),
        git(rootDir, ["rev-list", "--count", `${from}..${tip}`]),
      ]);
      if (diff.code !== 0) {
        value = { state: "unknown", reason: "git could not compare the recorded commit with HEAD.", commitsBehind: 0, headBehind: 0, filesChanged: 0, files: [], generatedCommit: commit, head: tip };
      } else {
        const globs = globsOf(patterns);
        // A rename into or out of the covered paths counts: either side matching is a change to them.
        const changed = parseNameStatus(diff.stdout.toString()).filter((f) => matches(globs, f.path) || (f.from ? matches(globs, f.from) : false));
        const commitsBehind = Number.parseInt(covering.stdout.toString().trim(), 10) || 0;
        const headBehind = Number.parseInt(any.stdout.toString().trim(), 10) || 0;
        value = { state: classify(commitsBehind, changed.length), reason: null, commitsBehind, headBehind, filesChanged: changed.length, files: changed.slice(0, FILE_LIST_CAP), generatedCommit: commit, head: tip };
      }
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { key, value });
    return value;
  } catch (e: any) {
    return { state: "unknown", reason: String(e?.message ?? e).slice(0, 160), commitsBehind: 0, headBehind: 0, filesChanged: 0, files: [], generatedCommit: commit, head: null };
  }
}

/** Worst first: what "Refresh stale pages" works through. */
export const FRESHNESS_RANK: Record<Freshness, number> = { stale: 0, drifting: 1, unknown: 2, unmanaged: 3, fresh: 4 };
