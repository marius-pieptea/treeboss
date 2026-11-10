/** Workspaces, root metadata and the dev-server list. */
import fs from "fs";
import os from "os";
import path from "path";
import { db } from "../../db";
import { RootError, Workspaces, owningWorkspace, resolveRoot, type Workspace } from "../../workspaces";
import { repoInfo } from "../../git/ops";
import { listeningPorts } from "../../terminal/ports";
import { STOP_SIGNAL, killTree } from "../../proctree";
import { countSessions, listSessions, viewSession } from "../../sessions/manager";
import { HttpError, json, type RouteModule } from "../http";

/**
 * Windows drive roots that exist ("C:\\", "D:\\"…), for the folder picker. Probed off the main thread with a
 * short timeout each, because a disconnected network drive can take seconds to answer; cached briefly.
 */
let drivesCache: { at: number; list: string[] } | null = null;
async function listDrives(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  if (drivesCache && Date.now() - drivesCache.at < 10_000) return drivesCache.list;
  const probe = async (letter: string) => {
    const root = `${letter}:\\`;
    const ok = await Promise.race([fs.promises.stat(root).then(() => true, () => false), new Promise<boolean>((res) => setTimeout(() => res(false), 1500))]);
    return ok ? root : null;
  };
  const found = await Promise.all([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(probe));
  const list = found.filter((d): d is string => !!d);
  drivesCache = { at: Date.now(), list };
  return list;
}

export interface WorkspaceActivity {
  running: number;
  failed: number;
  /** Open leads whose last turn completed after the operator last had the workspace on screen. */
  done: number;
}

/** What is happening in every workspace at once: only the ones with running, failed or unseen finished work appear. */
export function workspaceActivity(): Record<string, WorkspaceActivity> {
  const open = listSessions({ leadsOnly: false, status: "open", limit: 500 });
  const seen = Workspaces.seenSince();
  // Idle leads whose last turn completed, newer than the oldest "seen" mark (older ones are seen everywhere).
  const oldest = [...seen.values()].sort()[0] ?? "";
  const finished = db()
    .prepare(
      `SELECT s.base_cwd, t.finished_at FROM sessions s JOIN turns t ON t.id = s.last_turn_id
       WHERE s.depth = 0 AND s.status = 'idle' AND t.status = 'completed' AND t.finished_at > ?`,
    )
    .all(oldest) as Array<{ base_cwd: string; finished_at: string }>;
  const doneBy: Record<string, number> = {};
  for (const f of finished) {
    const ws = owningWorkspace(f.base_cwd);
    if (ws && f.finished_at > (seen.get(ws) ?? "")) doneBy[ws] = (doneBy[ws] ?? 0) + 1;
  }
  const activity: Record<string, WorkspaceActivity> = {};
  for (const w of Workspaces.list()) {
    const mine = open.filter((s) => owningWorkspace(s.base_cwd) === w.id);
    const running = mine.filter((s) => s.status === "running").length;
    const failed = mine.filter((s) => s.status === "failed" && s.depth === 0).length;
    const done = doneBy[w.id] ?? 0;
    if (running || failed || done) activity[w.id] = { running, failed, done };
  }
  return activity;
}

/**
 * The sessions filter that selects one workspace's sessions. Nested workspaces own their own folders, so their
 * subtrees are excluded (same rule as owningWorkspace).
 */
export function workspaceScope(w: Workspace): { dir: string; except: string[] } {
  const nested = Workspaces.list().filter((o) => o.id !== w.id && o.path.startsWith(w.path + "/")).map((o) => o.path);
  return { dir: w.path, except: nested };
}

export const workspaceRoutes: RouteModule = async (c) => {
  let m: RegExpMatchArray | null;

  if (c.path === "/api/workspaces" && c.method === "GET") return json({ workspaces: Workspaces.list() });
  if (c.path === "/api/workspaces" && c.method === "POST") {
    const dir = String(c.body.path ?? "").trim();
    if (!dir) throw new HttpError(400, "path is required.");
    return json({ workspace: Workspaces.open(dir, c.body.name) }, 201);
  }
  if ((m = c.match(/^\/api\/workspaces\/(w_[^/]+)$/))) {
    const w = Workspaces.get(m[1]);
    if (!w) throw new HttpError(404, `No workspace "${m[1]}".`);
    if (c.method === "GET") return json({ workspace: w });
    if (c.method === "PATCH") return json({ workspace: Workspaces.rename(w.id, String(c.body.name ?? w.name)) });
    if (c.method === "DELETE") return json({ removed: Workspaces.remove(w.id) });
  }
  if ((m = c.match(/^\/api\/workspaces\/(w_[^/]+)\/open$/)) && c.method === "POST") {
    Workspaces.touch(m[1]);
    return json({ workspace: Workspaces.get(m[1]) });
  }
  // The workspace is on screen: what just finished in it is seen (the recent order is left alone).
  if ((m = c.match(/^\/api\/workspaces\/(w_[^/]+)\/seen$/)) && c.method === "POST") {
    Workspaces.markSeen(m[1]);
    return json({ ok: true });
  }

  /** What is happening in every workspace at once, so the switcher can show work finishing elsewhere. */
  if (c.path === "/api/workspaces/activity" && c.method === "GET") {
    const activity = workspaceActivity();
    return json({ activity });
  }

  /** Which workspace a session belongs to: the one whose path it was started in. */
  if ((m = c.match(/^\/api\/workspaces\/(w_[^/]+)\/sessions$/)) && c.method === "GET") {
    const w = Workspaces.get(m[1]);
    if (!w) throw new HttpError(404, `No workspace "${m[1]}".`);
    const all = c.q("all") === "1";
    // Filter in SQL, then limit: a busy neighbour must not push this workspace's sessions out of the window.
    // Nested workspaces own their own folders, so their subtrees are excluded (same rule as owningWorkspace).
    const within = workspaceScope(w);
    // closed=only: a page of closed leads (the sidebar's collapsed "Closed" group), searchable, with the total for its header.
    if (c.q("closed") === "only") {
      const filter = { leadsOnly: true, unpinned: true, status: "closed" as const, within, q: c.q("q") ?? undefined };
      const limit = Number(c.q("limit") ?? 50);
      const sessions = listSessions({ ...filter, limit, offset: Number(c.q("offset") ?? 0) });
      return json({ sessions: sessions.map((s) => viewSession(s, { withOutput: false })), total: countSessions(filter) });
    }
    const sessions = listSessions({ leadsOnly: !all, status: c.q("closed") === "1" ? null : "open", within, limit: 200 });
    return json({ sessions: sessions.map((s) => viewSession(s, { withOutput: false })) });
  }

  if ((m = c.match(/^\/api\/roots\/([^/]+)$/)) && c.method === "GET") {
    const root = resolveRoot(m[1]);
    return json({ root: { ref: root.ref, kind: root.kind, dir: root.dir, name: root.name }, repo: await repoInfo(root.dir) });
  }

  /**
   * Folder picker: the subdirectories of any directory. This reads outside the workspace roots on purpose
   * (it is how you choose one); it is no wider than the terminal the same session can already open.
   */
  if (c.path === "/api/browse" && c.method === "GET") {
    const wanted = c.q("path") || os.homedir();
    let dir: string;
    try {
      dir = fs.realpathSync(path.resolve(wanted.replace(/^~(?=$|\/)/, os.homedir())));
    } catch {
      throw new HttpError(404, `No such directory: ${wanted}`);
    }
    if (!fs.statSync(dir).isDirectory()) throw new HttpError(400, `${dir} is not a directory.`);
    const showHidden = c.q("hidden") === "1";
    let entries: Array<{ name: string; path: string; repo: boolean }> = [];
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && fs.statSync(path.join(dir, d.name), { throwIfNoEntry: false })?.isDirectory())) && (showHidden || !d.name.startsWith(".")))
        .slice(0, 800)
        .map((d) => ({ name: d.name, path: path.join(dir, d.name), repo: fs.existsSync(path.join(dir, d.name, ".git")) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    } catch (err: any) {
      throw new HttpError(403, err?.code === "EACCES" ? `Permission denied: ${dir}` : String(err?.message ?? err));
    }
    const parent = path.dirname(dir);
    return json({ path: dir, parent: parent === dir ? null : parent, home: os.homedir(), repo: fs.existsSync(path.join(dir, ".git")), drives: await listDrives(), entries });
  }

  if (c.path === "/api/ports" && c.method === "GET") return json({ ports: await listeningPorts() });
  // Stop one listed server. Only a pid that is listening on that exact port right now is signalled, never the daemon itself.
  if (c.path === "/api/ports/stop" && c.method === "POST") {
    const port = Number(c.body.port);
    const pid = Number(c.body.pid);
    const hit = (await listeningPorts()).find((p) => p.port === port && p.pid === pid);
    if (!hit) throw new HttpError(404, "That server is no longer running.");
    if (pid === process.pid || pid === process.ppid) throw new HttpError(400, "That is trb itself.");
    killTree(pid, STOP_SIGNAL);
    return json({ ok: true });
  }
  return null;
};

export { RootError };
