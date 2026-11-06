/**
 * Importing skills from a directory: find them, then copy them as a job the UI can watch.
 *
 * Finding is a cheap walk (no copying) that reports how many skills there are and how big, so the operator can
 * see what is about to happen and pick a subset. Importing runs in the background, one skill at a time, and
 * reports progress as it goes: which skill, how many files, how many are done. A folder of skills can be
 * hundreds of megabytes; an import that says only "importing…" looks hung.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { newId, UserError } from "../util";
import { SkillStore, parseSkillFrontmatter } from "./store";
import { copyWalk, copyWalkAsync, walkSkillDir, type SkillWalk } from "./files";
import { db } from "../db";
import { paths } from "../paths";

const SCAN_DEPTH = 5;
const MAX_SKILLS_PER_SCAN = 1000;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", "build"]);

export interface FoundSkill {
  /** The name the skill will be stored under. */
  name: string;
  description: string;
  /** Where it was found, relative to the scanned root ("." when the root itself is a skill). */
  relDir: string;
  dir: string;
  files: number;
  bytes: number;
  /** Already imported (same name) — importing again needs `overwrite`. */
  exists: boolean;
  /** Reasons something was left out, or a problem that will make this one fail. */
  notes: string[];
  error?: string;
}

export interface ScanResult {
  root: string;
  skills: FoundSkill[];
  /** Directories that look like skills (have SKILL.md) but share a name with an earlier one and are ignored. */
  duplicates: string[];
  truncated: boolean;
}

export function resolveDir(input: string): string {
  const abs = path.resolve(input.replace(/^~(?=$|\/)/, os.homedir()));
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new UserError(`${input} does not exist.`);
  }
  if (!fs.statSync(real).isDirectory()) throw new UserError(`${input} is not a directory.`);
  return real;
}

/**
 * Find skill folders under `root`: a folder with a SKILL.md is a skill and is not searched further (its
 * subfolders are its own files). Looks several levels down because skills usually live in `skills/`,
 * `plugins/*​/skills/` and the like.
 */
export function scanSkills(rootInput: string): ScanResult {
  const root = resolveDir(rootInput);
  const found: FoundSkill[] = [];
  const duplicates: string[] = [];
  const names = new Set<string>();
  let truncated = false;
  const visited = new Set<string>();

  const consider = (dir: string) => {
    const rel = path.relative(root, dir) || ".";
    const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8");
    const fm = parseSkillFrontmatter(md);
    const name = (fm.name || path.basename(dir)).trim();
    if (names.has(name)) {
      duplicates.push(rel);
      return;
    }
    names.add(name);
    const skill: FoundSkill = { name, description: fm.description ?? "", relDir: rel, dir, files: 0, bytes: 0, exists: !!SkillStore.get(name), notes: [] };
    try {
      const w = walkSkillDir(dir);
      skill.files = w.files.length;
      skill.bytes = w.bytes;
      skill.notes = w.skipped;
    } catch (err: any) {
      skill.error = err.message;
    }
    found.push(skill);
  };

  const walk = (dir: string, depth: number) => {
    if (found.length >= MAX_SKILLS_PER_SCAN) {
      truncated = true;
      return;
    }
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    if (fs.existsSync(path.join(dir, "SKILL.md"))) return void consider(dir);
    if (depth >= SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) isDir = !!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory();
      if (isDir) walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return { root, skills: found, duplicates, truncated };
}

/* ------------------------------------------------------------------- jobs */

export interface ImportItemResult {
  name: string;
  status: "added" | "replaced" | "skipped" | "failed";
  files: number;
  bytes: number;
  reason?: string;
}

export interface ImportJob {
  id: string;
  status: "running" | "done" | "cancelled";
  root: string;
  /** Skills to import, and how many have been dealt with. */
  total: number;
  done: number;
  totalBytes: number;
  doneBytes: number;
  current: { name: string; filesDone: number; filesTotal: number } | null;
  results: ImportItemResult[];
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, ImportJob & { cancel: boolean }>();
const MAX_JOBS = 20;

export function getImportJob(id: string): ImportJob | null {
  const j = jobs.get(id);
  if (!j) return null;
  const { cancel: _c, ...pub } = j;
  return { ...pub, results: [...j.results], current: j.current ? { ...j.current } : null };
}

export function cancelImportJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.status !== "running") return false;
  j.cancel = true;
  return true;
}

/** Start importing the named skills (all found when `names` is omitted). Returns at once; poll the job. */
export function startImport(rootInput: string, opts: { names?: string[] | null; overwrite?: boolean } = {}): ImportJob {
  const scan = scanSkills(rootInput);
  const wanted = opts.names ? new Set(opts.names) : null;
  const picked = scan.skills.filter((s) => !wanted || wanted.has(s.name));
  if (wanted) {
    const missing = [...wanted].filter((n) => !scan.skills.some((s) => s.name === n));
    if (missing.length) throw new UserError(`Not found in ${scan.root}: ${missing.join(", ")}.`);
  }
  if (picked.length === 0) throw new UserError(`No skills (folders with a SKILL.md) found under ${scan.root}.`);

  for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - MAX_JOBS + 1))) if (jobs.get(old)!.status !== "running") jobs.delete(old);

  const job: ImportJob & { cancel: boolean } = {
    id: newId("imp"),
    status: "running",
    root: scan.root,
    total: picked.length,
    done: 0,
    totalBytes: picked.reduce((n, s) => n + s.bytes, 0),
    doneBytes: 0,
    current: null,
    results: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cancel: false,
  };
  jobs.set(job.id, job);

  void (async () => {
    for (const s of picked) {
      if (job.cancel) break;
      job.current = { name: s.name, filesDone: 0, filesTotal: s.files };
      const base = { name: s.name, files: s.files, bytes: s.bytes };
      try {
        if (s.error) throw new UserError(s.error);
        const existed = !!SkillStore.get(s.name);
        if (existed && !opts.overwrite) {
          job.results.push({ ...base, status: "skipped", reason: "already imported (turn on overwrite to replace it)" });
        } else {
          const w = walkSkillDir(s.dir);
          const dest = path.join(paths.skills(), s.name);
          await copyWalkAsync(w, dest, (_f, n) => (job.current!.filesDone = n), () => job.cancel);
          SkillStore.register(s.name, s.description, dest, s.dir);
          job.results.push({ ...base, status: existed ? "replaced" : "added" });
        }
      } catch (err: any) {
        job.results.push({ ...base, status: "failed", reason: err?.message ?? String(err) });
      }
      job.done++;
      job.doneBytes += s.bytes;
      await new Promise((r) => setImmediate(r));
    }
    job.current = null;
    job.status = job.cancel ? "cancelled" : "done";
    job.finishedAt = new Date().toISOString();
  })();

  return getImportJob(job.id)!;
}

/** The synchronous version (CLI): the same scan and copy, no job. */
export function importSync(rootInput: string, opts: { overwrite?: boolean; onProgress?: (msg: string) => void } = {}): { added: string[]; skipped: string[]; failed: Array<{ name: string; error: string }>; notes: string[] } {
  const scan = scanSkills(rootInput);
  const out = { added: [] as string[], skipped: [] as string[], failed: [] as Array<{ name: string; error: string }>, notes: [] as string[] };
  scan.skills.forEach((s, i) => {
    opts.onProgress?.(`[${i + 1}/${scan.skills.length}] ${s.name} (${s.files} file${s.files === 1 ? "" : "s"})`);
    try {
      if (s.error) throw new UserError(s.error);
      if (SkillStore.get(s.name) && !opts.overwrite) return void out.skipped.push(s.name);
      const w: SkillWalk = walkSkillDir(s.dir);
      const dest = path.join(paths.skills(), s.name);
      copyWalk(w, dest);
      SkillStore.register(s.name, s.description, dest, s.dir);
      out.added.push(s.name);
      out.notes.push(...s.notes.map((n) => `${s.name}: ${n}`));
    } catch (err: any) {
      out.failed.push({ name: s.name, error: err.message });
    }
  });
  if (scan.duplicates.length) out.notes.push(`ignored ${scan.duplicates.length} folder(s) whose skill name was already taken in this import: ${scan.duplicates.slice(0, 5).join(", ")}`);
  void db;
  return out;
}
