/**
 * Workspaces and file roots.
 *
 * A workspace is a directory the operator works in (usually a repo root). Everything the UI reads or
 * writes through the file, git and terminal APIs is addressed by a *root reference*:
 *   w_<id>   a registered workspace
 *   s_<id>   a session's working directory (a head's worktree, or a lead's checkout)
 * and resolved here, so no API ever accepts a raw filesystem path from the browser.
 */
import fs from "fs";
import path from "path";
import { db } from "./db";
import { newId } from "./util";
import { getSession } from "./sessions/manager";
import { SkillStore } from "./skills/store";

export interface Workspace {
  id: string;
  path: string;
  name: string;
  last_opened: string;
}

export class RootError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export const Workspaces = {
  list(): Workspace[] {
    return db().prepare("SELECT id, path, name, last_opened FROM workspaces ORDER BY last_opened DESC, rowid DESC").all() as Workspace[];
  },

  get(id: string): Workspace | null {
    return (db().prepare("SELECT id, path, name, last_opened FROM workspaces WHERE id = ?").get(id) as Workspace | undefined) ?? null;
  },

  /** Register a directory (idempotent: the same real path returns the same workspace). */
  open(dir: string, name?: string | null): Workspace {
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(dir));
    } catch {
      throw new RootError(`Directory not found: ${dir}`, 404);
    }
    if (!fs.statSync(real).isDirectory()) throw new RootError(`${real} is not a directory.`);
    const existing = db().prepare("SELECT id FROM workspaces WHERE path = ?").get(real) as { id: string } | undefined;
    if (existing) {
      db().prepare("UPDATE workspaces SET last_opened = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
      return this.get(existing.id)!;
    }
    const id = newId("w");
    db().prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(id, real, (name?.trim() || path.basename(real) || real).slice(0, 80));
    return this.get(id)!;
  },

  touch(id: string): void {
    db().prepare("UPDATE workspaces SET last_opened = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  },

  rename(id: string, name: string): Workspace | null {
    db().prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name.trim().slice(0, 80), id);
    return this.get(id);
  },

  remove(id: string): boolean {
    return db().prepare("DELETE FROM workspaces WHERE id = ?").run(id).changes > 0;
  },
};

/** The most specific registered workspace containing a directory, so a session in a nested project is not also listed in its parent. */
export function owningWorkspace(dir: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const w of Workspaces.list()) {
    if ((dir === w.path || dir.startsWith(w.path + "/")) && (!best || w.path.length > best.len)) best = { id: w.id, len: w.path.length };
  }
  return best?.id ?? null;
}

export interface ResolvedRoot {
  ref: string;
  kind: "workspace" | "session" | "skill";
  /** Absolute, real path of the directory. */
  dir: string;
  name: string;
}

/** `w_…` or `s_…` → the directory it stands for. Throws RootError (404) for anything unknown or gone. */
export function resolveRoot(ref: string): ResolvedRoot {
  if (ref.startsWith("w_")) {
    const w = Workspaces.get(ref);
    if (!w) throw new RootError(`No workspace "${ref}".`, 404);
    if (!fs.existsSync(w.path)) throw new RootError(`${w.path} no longer exists.`, 404);
    return { ref, kind: "workspace", dir: w.path, name: w.name };
  }
  if (ref.startsWith("s_")) {
    const s = getSession(ref);
    if (!s) throw new RootError(`No session "${ref}".`, 404);
    if (!fs.existsSync(s.cwd)) throw new RootError(`The working directory of ${ref} no longer exists (the session was closed).`, 404);
    return { ref, kind: "session", dir: fs.realpathSync(s.cwd), name: s.title };
  }
  // k_<name>: a stored skill's own folder, so the file API (and the editor) can work on its files.
  if (ref.startsWith("k_")) {
    const k = SkillStore.get(ref.slice(2));
    if (!k) throw new RootError(`No skill "${ref.slice(2)}".`, 404);
    if (!fs.existsSync(k.path)) throw new RootError(`The folder of skill "${k.name}" is missing.`, 404);
    return { ref, kind: "skill", dir: fs.realpathSync(k.path), name: k.name };
  }
  throw new RootError(`Bad root "${ref}": expected w_…, s_… or k_….`);
}

/**
 * Join a client-supplied relative path onto a root, refusing anything that would leave it: `..`,
 * absolute paths, NUL bytes, and symlinks whose target is outside (checked on the deepest existing
 * ancestor, so creating a new file under a symlinked directory is judged by where it would land).
 */
export function safeJoin(rootDir: string, rel: string): string {
  if (rel.includes("\0")) throw new RootError("Bad path.");
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(rootDir, cleaned);
  const rootReal = fs.realpathSync(rootDir);
  const inside = (p: string) => p === rootReal || p.startsWith(rootReal + path.sep);
  if (!inside(path.resolve(rootReal, cleaned))) throw new RootError("Path escapes the workspace.", 403);
  // Walk up to the deepest ancestor that exists and check ITS real location.
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(probe);
  } catch {
    throw new RootError("Bad path.");
  }
  if (!inside(real)) throw new RootError("Path escapes the workspace through a symlink.", 403);
  return target;
}

/** Path relative to the root, with forward slashes (what the UI and git speak). */
export function relFrom(rootDir: string, abs: string): string {
  return path.relative(rootDir, abs).split(path.sep).join("/");
}
