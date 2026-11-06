/**
 * Where a workspace keeps its plan files. Kept apart from planfile.ts because the specs module needs to
 * recognise the folder (to let a plan be attached to a session) and planfile.ts needs the specs module.
 *
 * The folder is a per-workspace preference in the settings table (`plans.dir.<workspace id>`), `plans` by
 * default. It is a single relative folder name inside the workspace: nothing here creates it.
 */
import fs from "fs";
import path from "path";
import { db } from "../db";
import { UserError } from "../util";

export const DEFAULT_PLANS_DIR = "plans";

function real(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

/** The registered workspace holding `dir` (the deepest wins). Read straight from the table: workspaces.ts imports the session manager. */
function workspaceIdFor(dir: string): string | null {
  const target = real(dir);
  let best: { id: string; len: number } | null = null;
  for (const w of db().prepare("SELECT id, path FROM workspaces").all() as Array<{ id: string; path: string }>) {
    const rel = path.relative(w.path, target);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) if (!best || w.path.length > best.len) best = { id: w.id, len: w.path.length };
  }
  return best?.id ?? null;
}

/** A folder name that is safe to join onto a workspace root: relative, no `..`, no hidden folder tricks. */
export function cleanPlansDir(raw: unknown): string {
  const v = String(raw ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (!v) return DEFAULT_PLANS_DIR;
  const parts = v.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "" || p === ".git")) throw new UserError("The plans folder must be a plain relative path inside the workspace.");
  if (v.length > 120) throw new UserError("The plans folder name is too long.");
  return v;
}

export function plansDirOf(rootDir: string): string {
  try {
    const id = workspaceIdFor(rootDir);
    if (!id) return DEFAULT_PLANS_DIR;
    const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(`plans.dir.${id}`) as { value: string } | undefined;
    return row ? cleanPlansDir(row.value) : DEFAULT_PLANS_DIR;
  } catch {
    return DEFAULT_PLANS_DIR;
  }
}

/** Set (or, with null, reset) a workspace's plans folder. */
export function setPlansDir(workspaceId: string, dir: string | null): string {
  if (dir === null || String(dir).trim() === "") {
    db().prepare("DELETE FROM settings WHERE key = ?").run(`plans.dir.${workspaceId}`);
    return DEFAULT_PLANS_DIR;
  }
  const clean = cleanPlansDir(dir);
  db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`plans.dir.${workspaceId}`, clean);
  return clean;
}

/** Is this workspace-relative path inside the plans folder? */
export function inPlansDir(rootDir: string, rel: string): boolean {
  const dir = plansDirOf(rootDir);
  const cleaned = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  return cleaned === dir || cleaned.startsWith(`${dir}/`);
}

/** What the next plan_submit of a session produces: a plans/ file ("quick", the default) or a spec feature ("spec"). A settings row, so it can be chosen before the first plan. */
export function planDepthOf(sessionId: string): "quick" | "spec" {
  const r = db().prepare("SELECT value FROM settings WHERE key = ?").get(`plan.depth.${sessionId}`) as { value: string } | undefined;
  return r?.value === "spec" ? "spec" : "quick";
}

export function storePlanDepth(sessionId: string, depth: "quick" | "spec"): void {
  if (depth === "quick") db().prepare("DELETE FROM settings WHERE key = ?").run(`plan.depth.${sessionId}`);
  else db().prepare("INSERT INTO settings (key, value) VALUES (?, 'spec') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`plan.depth.${sessionId}`);
}
