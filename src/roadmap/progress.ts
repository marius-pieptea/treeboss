/**
 * What an item's `(spec: …)` and `(docs: …)` links point at: do they exist, and how far along is the spec.
 * Task counts come from the specs module's own parser, so a card and the Specs view always agree.
 */
import fs from "fs";
import path from "path";
import { countTasks } from "../specs/tasks";

export { countTasks };

export interface LinkState {
  /** The link exactly as written in ROADMAP.md. */
  value: string;
  ok: boolean;
  /** Why it is not ok, in a sentence. */
  reason: string | null;
  /** Workspace-relative path it resolved to. */
  path: string | null;
}

export type SpecStatus = "not_started" | "in_progress" | "done";

export interface SpecProgress {
  /** Workspace-relative feature folder, e.g. "specs/003-chat". */
  dir: string;
  done: number;
  total: number;
  hasTasks: boolean;
  status: SpecStatus;
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolve a workspace-relative link; refuses anything that leaves the workspace (including through a symlink). */
function resolveInside(rootDir: string, value: string): { abs: string; rel: string } | { error: string } {
  const v = value.trim().replace(/^\.\//, "");
  if (!v) return { error: "empty link" };
  if (path.isAbsolute(v) || /^[a-z]+:\/\//i.test(v)) return { error: "links are relative to the workspace" };
  const root = realOf(rootDir);
  const abs = path.resolve(root, v);
  if (!inside(root, abs)) return { error: "outside the workspace" };
  if (fs.existsSync(abs) && !inside(root, fs.realpathSync(abs))) return { error: "outside the workspace" };
  return { abs, rel: path.relative(root, abs) };
}

function realOf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** `specs/003-chat`, `specs/003-chat/spec.md` or a bare `003-chat` → the feature folder (workspace-relative), or null. */
export function specDir(rootDir: string, value: string): string | null {
  const tries = [value.trim()];
  if (!/[\\/]/.test(value.trim())) tries.push(`specs/${value.trim()}`);
  for (const t of tries) {
    const r = resolveInside(rootDir, t.replace(/[\\/]+$/, ""));
    if ("error" in r || !fs.existsSync(r.abs)) continue;
    const dir = fs.statSync(r.abs).isDirectory() ? r.abs : path.dirname(r.abs);
    if (inside(realOf(rootDir), dir)) return path.relative(realOf(rootDir), dir);
  }
  return null;
}

export function checkLink(rootDir: string, value: string | null, kind: "spec" | "docs"): LinkState | null {
  if (!value) return null;
  const r = resolveInside(rootDir, value);
  if ("error" in r) return { value, ok: false, reason: r.error, path: null };
  if (kind === "spec") {
    const dir = specDir(rootDir, value);
    return dir ? { value, ok: true, reason: null, path: dir } : { value, ok: false, reason: `${value} does not exist`, path: null };
  }
  return fs.existsSync(r.abs) ? { value, ok: true, reason: null, path: r.rel } : { value, ok: false, reason: `${value} does not exist`, path: null };
}

export function specProgress(rootDir: string, value: string | null): SpecProgress | null {
  if (!value) return null;
  const dir = specDir(rootDir, value);
  if (!dir) return null;
  const tasks = path.join(realOf(rootDir), dir, "tasks.md");
  let counts = { done: 0, total: 0 };
  let hasTasks = false;
  try {
    const st = fs.statSync(tasks);
    if (st.isFile() && st.size < 2_000_000) {
      counts = countTasks(fs.readFileSync(tasks, "utf-8"));
      hasTasks = true;
    }
  } catch {}
  const status: SpecStatus = counts.total > 0 && counts.done === counts.total ? "done" : counts.done > 0 ? "in_progress" : "not_started";
  return { dir, done: counts.done, total: counts.total, hasTasks, status };
}

/** One word for a card: shipped (checked), in progress (some spec tasks ticked or a live session), not started. */
export type ItemStatus = "shipped" | "in_progress" | "not_started";

export function itemStatus(done: boolean, progress: SpecProgress | null, activeSessions: number): ItemStatus {
  if (done) return "shipped";
  if (progress?.status === "in_progress" || progress?.status === "done" || activeSessions > 0) return "in_progress";
  return "not_started";
}

export interface LaneProgress {
  items: number;
  shipped: number;
  inProgress: number;
  tasksDone: number;
  tasksTotal: number;
}
