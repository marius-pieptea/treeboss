/**
 * Reading a skill directory safely: what files it holds, with limits, and copying it.
 *
 * A skill is a folder, not a file: `SKILL.md` plus whatever it points at (scripts, references, templates). So
 * importing and materialising copy the whole tree. A skill folder comes from somewhere the operator may not
 * control (a downloaded repo), so the walk is bounded and cannot loop: symlinks are followed only to real
 * directories not already visited, counts and sizes are capped, and dependency/VCS directories are skipped.
 */
import fs from "fs";
import path from "path";
import { UserError } from "../util";

export const MAX_SKILL_FILES = 2000;
export const MAX_SKILL_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DEPTH = 12;
const SKIP = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".venv"]);

export interface SkillFile {
  /** Path relative to the skill directory, forward slashes. */
  rel: string;
  abs: string;
  size: number;
  /** Last write and last status change, in ms: a file whose content or metadata changed has a new one of them. */
  mtimeMs: number;
  ctimeMs: number;
}

export interface SkillWalk {
  files: SkillFile[];
  dirs: string[];
  bytes: number;
  /** Things left out and why, shown to the operator instead of silently dropped. */
  skipped: string[];
}

/** Every file a skill owns. Throws UserError when it is too big to be a skill. */
export function walkSkillDir(root: string): SkillWalk {
  const out: SkillWalk = { files: [], dirs: [], bytes: 0, skipped: [] };
  const visited = new Set<string>();
  const walk = (dir: string, rel: string, depth: number) => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) {
      out.skipped.push(`${rel || "."}: symlink loop`);
      return;
    }
    visited.add(real);
    if (depth > MAX_DEPTH) {
      out.skipped.push(`${rel}: nested too deep`);
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) {
        if (entry.name !== ".DS_Store") out.skipped.push(`${path.posix.join(rel, entry.name)}: ${entry.name === ".git" ? "version control" : "dependencies"} not copied`);
        continue;
      }
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs); // follows a symlink
      } catch {
        out.skipped.push(`${childRel}: broken link`);
        continue;
      }
      if (st.isDirectory()) {
        out.dirs.push(childRel);
        walk(abs, childRel, depth + 1);
      } else if (st.isFile()) {
        if (st.size > MAX_SKILL_FILE_BYTES) throw new UserError(`${childRel} is ${(st.size / 1048576).toFixed(1)} MB; a single skill file may not exceed ${MAX_SKILL_FILE_BYTES / 1048576} MB.`);
        out.files.push({ rel: childRel, abs, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
        out.bytes += st.size;
        if (out.files.length > MAX_SKILL_FILES) throw new UserError(`More than ${MAX_SKILL_FILES} files: that is a repository, not a skill. Point at the skill's own folder.`);
        if (out.bytes > MAX_SKILL_BYTES) throw new UserError(`The skill is larger than ${MAX_SKILL_BYTES / 1048576} MB.`);
      }
    }
  };
  walk(root, "", 0);
  return out;
}

/** Copy a walked skill to `dest` (replacing it), keeping file modes (a skill's scripts must stay executable). */
export function copyWalk(w: SkillWalk, dest: string, onFile?: (f: SkillFile, done: number) => void): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const d of w.dirs) fs.mkdirSync(path.join(dest, d), { recursive: true });
  let done = 0;
  for (const f of w.files) {
    fs.copyFileSync(f.abs, path.join(dest, f.rel));
    onFile?.(f, ++done);
  }
}

/** Same copy, but yielding to the event loop between files so a big import never freezes the daemon. */
export async function copyWalkAsync(w: SkillWalk, dest: string, onFile?: (f: SkillFile, done: number) => void, shouldStop?: () => boolean): Promise<void> {
  await fs.promises.rm(dest, { recursive: true, force: true });
  await fs.promises.mkdir(dest, { recursive: true });
  for (const d of w.dirs) await fs.promises.mkdir(path.join(dest, d), { recursive: true });
  let done = 0;
  for (const f of w.files) {
    if (shouldStop?.()) {
      await fs.promises.rm(dest, { recursive: true, force: true }); // never leave half a skill behind
      throw new UserError("Import cancelled.");
    }
    await fs.promises.copyFile(f.abs, path.join(dest, f.rel));
    onFile?.(f, ++done);
    if (done % 25 === 0) await new Promise((r) => setImmediate(r));
  }
}
