/**
 * "About how many files would CodeGraph index here?", asked before the operator confirms an init.
 *
 * CodeGraph skips the usual dependency and build directories on its own (node_modules, dist, build,
 * vendor, target, .next, dot-directories) but NOT things like third_party/ or site-packages/, so those
 * are called out. The count covers source-looking files only. It never touches the index.
 */
import fs from "fs";
import path from "path";

/** Directories CodeGraph ignores by itself: leave them out of the count. */
const SKIPPED = new Set(["node_modules", "dist", "build", "vendor", "target", "out", "coverage", "Pods", "venv", "env", "__pycache__"]);
/** Looks vendored, and CodeGraph does not skip it: worth a warning when it holds many files. */
const VENDORED = /^(third_party|thirdparty|site-packages|deps|_build|generated|tmp|external|extern|bower_components)$/;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|cs|rb|php|scala|lua|dart|vue|svelte|m|mm|sol|pas|liquid)$/i;
const WALK_CAP = 150_000;
/** Past this many source files the confirm popover warns that indexing takes a while. */
export const largeProjectFiles = (): number => Number(process.env.TRB_CODEGRAPH_LARGE_FILES) || 20_000;

export interface CodegraphEstimate {
  /** Source files CodeGraph would likely index. */
  files: number;
  /** How the number was found. */
  method: "git" | "walk";
  /** True when the walk stopped at its cap: the real number is larger. */
  capped: boolean;
  /** Directories CodeGraph does not skip that look vendored, with their file counts. */
  vendored: Array<{ dir: string; files: number }>;
  /** One sentence for the confirm popover when something deserves a second look, else null. */
  warning: string | null;
}

function skipped(rel: string): boolean {
  const parts = rel.split("/");
  return parts.some((p, i) => i < parts.length - 1 && (SKIPPED.has(p) || p.startsWith(".")));
}

function tally(files: Iterable<string>, method: CodegraphEstimate["method"], capped: boolean): CodegraphEstimate {
  let n = 0;
  const vend = new Map<string, number>();
  for (const f of files) {
    if (!SOURCE.test(f) || skipped(f)) continue;
    n++;
    const top = f.split("/")[0];
    if (f.includes("/") && VENDORED.test(top)) vend.set(top, (vend.get(top) ?? 0) + 1);
  }
  const vendored = [...vend].filter(([, c]) => c >= 200).map(([dir, files]) => ({ dir, files })).sort((a, b) => b.files - a.files);
  const parts: string[] = [];
  if (n >= largeProjectFiles() || capped) parts.push(`This is a large project (${capped ? "more than " : "about "}${n.toLocaleString("en-US")} files): indexing can take several minutes and the index will be big.`);
  if (vendored.length) parts.push(`CodeGraph does not skip ${vendored.map((v) => `${v.dir}/ (${v.files.toLocaleString("en-US")} files)`).join(", ")}, so it will be indexed with your code.`);
  return { files: n, method, capped, vendored, warning: parts.length ? parts.join(" ") : null };
}

function gitFiles(dir: string): string[] | null {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { stdout: "pipe", stderr: "pipe", timeout: 15_000, windowsHide: true });
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/** Bounded walk for a directory that is not a git checkout. */
function walk(dir: string): { files: string[]; capped: boolean } {
  const out: string[] = [];
  let seen = 0;
  let capped = false;
  const stack: string[] = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_CAP) {
        capped = true;
        return { files: out, capped };
      }
      if (e.isDirectory()) {
        if (SKIPPED.has(e.name) || e.name.startsWith(".")) continue;
        stack.push(rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return { files: out, capped };
}

export function estimateIndexSize(dir: string): CodegraphEstimate {
  const git = gitFiles(dir);
  if (git) return tally(git, "git", false);
  const w = walk(dir);
  return tally(w.files, "walk", w.capped);
}
