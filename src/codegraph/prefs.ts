/**
 * Per-workspace CodeGraph preferences, kept in the settings table under `cg.<pref>.<workspace id>`.
 * "Use in sessions" falls back to the global `codegraph` setting until a workspace overrides it;
 * "keep in sync" is off until a workspace turns it on. Nothing here ever touches the index.
 */
import fs from "fs";
import path from "path";
import { db } from "../db";
import { getSetting } from "../settings";

export interface CodegraphPrefs {
  /** The workspace's own choice, or null when it follows the global setting. */
  useOverride: "auto" | "off" | null;
  keepInSync: boolean;
}

function real(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

/** The registered workspace holding `dir` (the deepest one wins), read straight from the table: workspaces.ts imports the session manager, which imports this. */
export function workspaceIdFor(dir: string): string | null {
  const target = real(dir);
  let best: { id: string; len: number } | null = null;
  for (const w of db().prepare("SELECT id, path FROM workspaces").all() as Array<{ id: string; path: string }>) {
    const rel = path.relative(w.path, target);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) if (!best || w.path.length > best.len) best = { id: w.id, len: w.path.length };
  }
  return best?.id ?? null;
}

const get = (key: string): string | null => (db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
const put = (key: string, value: string | null) => {
  if (value === null) db().prepare("DELETE FROM settings WHERE key = ?").run(key);
  else db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};

export function prefsOf(workspaceId: string | null): CodegraphPrefs {
  if (!workspaceId) return { useOverride: null, keepInSync: false };
  const use = get(`cg.use.${workspaceId}`);
  return { useOverride: use === "auto" || use === "off" ? use : null, keepInSync: get(`cg.sync.${workspaceId}`) === "on" };
}

export function setPrefs(workspaceId: string, patch: { use?: boolean | null; keepInSync?: boolean }): CodegraphPrefs {
  if (patch.use !== undefined) put(`cg.use.${workspaceId}`, patch.use === null ? null : patch.use ? "auto" : "off");
  if (patch.keepInSync !== undefined) put(`cg.sync.${workspaceId}`, patch.keepInSync ? "on" : null);
  return prefsOf(workspaceId);
}

/** Whether sessions under `dir` get the CodeGraph tools: the workspace's override, else the global setting. */
export function useSetting(dir: string): "auto" | "off" {
  const own = prefsOf(workspaceIdFor(dir)).useOverride;
  if (own) return own;
  return getSetting("codegraph") === "off" ? "off" : "auto";
}

export function keepInSyncFor(dir: string): boolean {
  return prefsOf(workspaceIdFor(dir)).keepInSync;
}
