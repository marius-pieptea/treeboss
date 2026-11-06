/**
 * The file API's logic: list, read, write, create, rename, delete, find, grep. Pure functions over a
 * root directory; the HTTP layer only resolves the root and calls these.
 *
 * Every path in and out is relative to the root with forward slashes, and every path in goes through
 * `safeJoin` first.
 */
import fs from "fs";
import path from "path";
import { RootError, relFrom, safeJoin } from "../workspaces";
import { runCmd, runGit } from "../git/run";

export const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5000;
const MAX_FIND_FILES = 100_000;
const MAX_GREP_MATCHES = 1000;

/** Directories never worth walking when there is no .gitignore to ask. */
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build", "target", "__pycache__", ".venv", "venv", ".cache", ".DS_Store"]);

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  symlink?: boolean;
  size: number;
  mtime: number;
  /** Ignored by git (shown dimmed, never searched). */
  ignored?: boolean;
}

/** One level of a directory, directories first. `.git` is never listed. */
export async function listDir(rootDir: string, rel: string): Promise<TreeEntry[]> {
  const dir = safeJoin(rootDir, rel);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === "ENOENT") throw new RootError(`No such directory: ${rel || "."}`, 404);
    if (err.code === "ENOTDIR") throw new RootError(`${rel} is not a directory.`);
    throw err;
  }
  // Sort before capping, so an oversized folder shows the first entries alphabetically, not an arbitrary subset.
  dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const entries: TreeEntry[] = [];
  for (const d of dirents) {
    if (d.name === ".git") continue;
    const abs = path.join(dir, d.name);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs); // follows symlinks: a link to a directory is a directory
    } catch {
      continue; // broken link
    }
    entries.push({
      name: d.name,
      path: relFrom(rootDir, abs),
      type: st.isDirectory() ? "dir" : "file",
      ...(d.isSymbolicLink() ? { symlink: true } : {}),
      size: st.isDirectory() ? 0 : st.size,
      mtime: Math.round(st.mtimeMs),
    });
    if (entries.length >= MAX_TREE_ENTRIES) break;
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.type === "dir" ? -1 : 1));

  // Ask git which of these it ignores, in one call. Not a repo, or git failing: show everything undimmed.
  if (entries.length) {
    const r = await runGit(["check-ignore", "-z", "--stdin"], { cwd: rootDir, input: entries.map((e) => e.path).join("\0") + "\0", timeoutMs: 8000 });
    if (r.code === 0 || r.code === 1) {
      const ignored = new Set(r.stdout.toString().split("\0").filter(Boolean));
      for (const e of entries) if (ignored.has(e.path)) e.ignored = true;
    }
  }
  return entries;
}

export interface FileContent {
  path: string;
  content: string;
  mtime: number;
  size: number;
  eol: "lf" | "crlf";
}
export type FileRead = FileContent | { path: string; binary: true; size: number; mtime: number } | { path: string; tooLarge: true; size: number; mtime: number };

export function readFileSafe(rootDir: string, rel: string): FileRead {
  const abs = safeJoin(rootDir, rel);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (err: any) {
    if (err.code === "ENOENT") throw new RootError(`No such file: ${rel}`, 404);
    throw err;
  }
  if (st.isDirectory()) throw new RootError(`${rel} is a directory.`);
  const base = { path: relFrom(rootDir, abs), size: st.size, mtime: Math.round(st.mtimeMs) };
  if (st.size > MAX_READ_BYTES) return { ...base, tooLarge: true };
  const buf = fs.readFileSync(abs);
  // A NUL byte in the first 8KB is how git decides a file is binary; so do we.
  if (buf.subarray(0, 8192).includes(0)) return { ...base, binary: true };
  const content = buf.toString("utf-8");
  return { ...base, content, eol: content.includes("\r\n") ? "crlf" : "lf" };
}

export class ConflictError extends Error {
  constructor(public mtime: number) {
    super("The file changed on disk since you opened it.");
  }
}

/**
 * Write atomically (temp file + rename, mode kept), so a crash or a concurrent reader never sees half a
 * file. `expectedMtime` is the optimistic lock: an agent may have edited the file since it was opened.
 */
export function writeFileSafe(rootDir: string, rel: string, content: string, opts: { expectedMtime?: number | null; create?: boolean } = {}): { mtime: number; size: number } {
  const abs = safeJoin(rootDir, rel);
  if (path.basename(abs) === ".git" || abs.split(path.sep).includes(".git")) throw new RootError("Refusing to write inside .git.", 403);
  let mode = 0o644;
  if (fs.existsSync(abs)) {
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new RootError(`${rel} is a directory.`);
    if (opts.expectedMtime != null && Math.abs(Math.round(st.mtimeMs) - opts.expectedMtime) > 1) throw new ConflictError(Math.round(st.mtimeMs));
    mode = st.mode & 0o777;
  } else if (!opts.create) {
    throw new RootError(`No such file: ${rel}`, 404);
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
  }
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.trb-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  const st = fs.statSync(abs);
  return { mtime: Math.round(st.mtimeMs), size: st.size };
}

export function createEntry(rootDir: string, rel: string, type: "file" | "dir"): void {
  const abs = safeJoin(rootDir, rel);
  if (abs.split(path.sep).includes(".git")) throw new RootError("Refusing to create inside .git.", 403);
  if (fs.existsSync(abs)) throw new RootError(`${rel} already exists.`, 409);
  if (type === "dir") fs.mkdirSync(abs, { recursive: true });
  else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "", { flag: "wx" });
  }
}

export function renameEntry(rootDir: string, from: string, to: string): void {
  const a = safeJoin(rootDir, from);
  const b = safeJoin(rootDir, to);
  if (a === fs.realpathSync(rootDir)) throw new RootError("Cannot rename the workspace root.");
  if (a.split(path.sep).includes(".git") || b.split(path.sep).includes(".git")) throw new RootError("Refusing to touch .git.", 403);
  if (!fs.existsSync(a)) throw new RootError(`No such file: ${from}`, 404);
  if (fs.existsSync(b)) throw new RootError(`${to} already exists.`, 409);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
}

export function deleteEntry(rootDir: string, rel: string): void {
  const abs = safeJoin(rootDir, rel);
  if (abs === fs.realpathSync(rootDir) || rel.trim() === "" || rel === ".") throw new RootError("Cannot delete the workspace root.", 403);
  if (abs.split(path.sep).includes(".git")) throw new RootError("Refusing to delete inside .git.", 403);
  if (!fs.existsSync(abs)) throw new RootError(`No such file: ${rel}`, 404);
  fs.rmSync(abs, { recursive: true, force: true });
}

/** Every file in the workspace, for quick-open. Git's own list when it is a repo (respects .gitignore). */
export async function listAllFiles(rootDir: string): Promise<{ files: string[]; truncated: boolean }> {
  const r = await runGit(["ls-files", "-co", "--exclude-standard", "-z"], { cwd: rootDir, timeoutMs: 20_000 });
  if (r.code === 0) {
    // Deleted-but-tracked files appear in ls-files; drop what is no longer on disk.
    const files = [...new Set(r.stdout.toString().split("\0").filter(Boolean))].filter((f) => fs.existsSync(path.join(rootDir, f)));
    return { files: files.slice(0, MAX_FIND_FILES), truncated: files.length > MAX_FIND_FILES };
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_FIND_FILES) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (SKIP_DIRS.has(d.name)) continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) walk(abs);
      else if (d.isFile()) out.push(relFrom(rootDir, abs));
    }
  };
  walk(rootDir);
  return { files: out, truncated: out.length >= MAX_FIND_FILES };
}

export interface GrepOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Comma-separated globs, `!`-prefixed to exclude. */
  include?: string;
}
export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

function whichSync(cmd: string): string | null {
  return Bun.which(cmd);
}

/** ripgrep when installed, else `git grep`, else a bounded scan. Matches are capped; `truncated` says so. */
export async function grep(rootDir: string, o: GrepOptions): Promise<{ matches: GrepMatch[]; truncated: boolean; engine: string }> {
  if (!o.query) return { matches: [], truncated: false, engine: "none" };
  const globs = (o.include ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

  const rg = whichSync("rg");
  if (rg) {
    const args = ["--line-number", "--column", "--no-heading", "--color", "never", "--max-columns", "400", "--max-columns-preview", "--with-filename", "--max-count", "200"];
    if (!o.regex) args.push("-F");
    args.push(o.caseSensitive ? "-s" : "-i");
    if (o.wholeWord) args.push("-w");
    for (const g of globs) args.push("-g", g);
    args.push("-e", o.query, "--", ".");
    const r = await runCmd(rg, args, { cwd: rootDir, timeoutMs: 20_000 });
    if (r.code <= 1) return { ...parseGrepLines(r.stdout.toString(), "rg"), engine: "rg" };
    throw new RootError(r.stderr.toString().trim().split("\n")[0] || "Search failed.");
  }

  const inRepo = (await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: rootDir, timeoutMs: 5000 })).code === 0;
  if (inRepo) {
    const args = ["grep", "-n", "--column", "-I", "--untracked", "--no-color"];
    if (!o.regex) args.push("-F");
    if (!o.caseSensitive) args.push("-i");
    if (o.wholeWord) args.push("-w");
    args.push("-e", o.query, "--", ...(globs.length ? globs.filter((g) => !g.startsWith("!")) : ["."]));
    const r = await runGit(args, { cwd: rootDir, timeoutMs: 20_000 });
    if (r.code <= 1) return { ...parseGrepLines(r.stdout.toString(), "git"), engine: "git grep" };
    throw new RootError(r.stderr.toString().trim().split("\n")[0] || "Search failed.");
  }

  // Not a repo, no ripgrep: scan.
  let re: RegExp;
  try {
    re = new RegExp(o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), o.caseSensitive ? "" : "i");
    if (o.wholeWord) re = new RegExp(`\\b(?:${re.source})\\b`, re.flags);
  } catch (err: any) {
    throw new RootError(`Bad regular expression: ${err.message}`);
  }
  const { files } = await listAllFiles(rootDir);
  const matches: GrepMatch[] = [];
  for (const f of files) {
    if (matches.length >= MAX_GREP_MATCHES) break;
    const abs = path.join(rootDir, f);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.size > MAX_READ_BYTES) continue;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) continue;
    buf
      .toString("utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (matches.length >= MAX_GREP_MATCHES) return;
        const m = re.exec(line);
        if (m) matches.push({ path: f, line: i + 1, column: m.index + 1, text: line.slice(0, 400) });
      });
  }
  return { matches, truncated: matches.length >= MAX_GREP_MATCHES, engine: "scan" };
}

function parseGrepLines(out: string, source: "rg" | "git"): { matches: GrepMatch[]; truncated: boolean } {
  const matches: GrepMatch[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    // path:line:col:text  (paths may contain ':' on exotic systems; the numeric fields anchor the split)
    const m = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    matches.push({ path: m[1].replace(/^\.\//, ""), line: Number(m[2]), column: Number(m[3]), text: m[4].slice(0, 400) });
    if (matches.length >= MAX_GREP_MATCHES) return { matches, truncated: true };
  }
  void source;
  return { matches, truncated: false };
}
