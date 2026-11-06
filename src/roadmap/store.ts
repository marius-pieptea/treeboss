/**
 * The roadmap of one workspace: ROADMAP.md read into a view, and edited through format.ts.
 *
 * The file is the only copy of the content. The database holds two small things: which path a workspace
 * uses (default ROADMAP.md at its root), and which sessions were started from which item.
 *
 * Every mutation reads the file, applies one minimal text edit, and writes it back atomically. A caller
 * may pass the `rev` it last saw: if the file changed since (an agent, an editor, git), the edit is
 * refused with a 409 instead of landing on top of the change.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { db } from "../db";
import { UserError } from "../util";
import { getSession } from "../sessions/manager";
import { addItem, addLane, deleteItem, deleteLane, findItem, moveItem, parseRoadmap, renameLane, roadmapTemplate, updateItem, type ItemPatch, type NewItem, type ParsedRoadmap } from "./format";
import { checkLink, countTasks, itemStatus, specProgress, type ItemStatus, type LaneProgress, type LinkState, type SpecProgress } from "./progress";

export const DEFAULT_PATH = "ROADMAP.md";
const MAX_BYTES = 2_000_000;

export class RoadmapConflict extends UserError {}

let ready = false;
function tables(): void {
  if (ready) return;
  db().exec(`CREATE TABLE IF NOT EXISTS roadmap_prefs (root_dir TEXT PRIMARY KEY, path TEXT NOT NULL)`);
  db().exec(`CREATE TABLE IF NOT EXISTS roadmap_sessions (
    session_id TEXT PRIMARY KEY, root_dir TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db().exec(`CREATE INDEX IF NOT EXISTS roadmap_sessions_item ON roadmap_sessions (root_dir, item_id)`);
  ready = true;
}

const realOf = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/* -------------------------------------------------------------------------- */
/* Where the file is                                                          */
/* -------------------------------------------------------------------------- */

export function cleanRoadmapPath(value: string): string {
  const v = value.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  if (!v) return DEFAULT_PATH;
  if (path.isAbsolute(v) || v.split("/").some((p) => p === ".." || p === "" || p === ".")) throw new UserError("The roadmap path is relative to the workspace and cannot leave it.");
  if (!/\.md$/i.test(v)) throw new UserError("The roadmap file must be a .md file.");
  if (v.split("/").some((p) => p === ".git")) throw new UserError("The roadmap cannot live in .git.");
  return v;
}

export function roadmapPath(rootDir: string): string {
  tables();
  const row = db().prepare("SELECT path FROM roadmap_prefs WHERE root_dir = ?").get(realOf(rootDir)) as { path: string } | undefined;
  return row?.path ?? DEFAULT_PATH;
}

export function setRoadmapPath(rootDir: string, value: string): string {
  tables();
  const p = cleanRoadmapPath(value);
  if (p === DEFAULT_PATH) db().prepare("DELETE FROM roadmap_prefs WHERE root_dir = ?").run(realOf(rootDir));
  else db().prepare("INSERT INTO roadmap_prefs (root_dir, path) VALUES (?, ?) ON CONFLICT(root_dir) DO UPDATE SET path = excluded.path").run(realOf(rootDir), p);
  return p;
}

function fileOf(rootDir: string): string {
  const root = realOf(rootDir);
  const abs = path.resolve(root, roadmapPath(rootDir));
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new UserError("The roadmap path leaves the workspace.");
  // A symlinked parent must not lead out either.
  const parent = path.dirname(abs);
  if (fs.existsSync(parent)) {
    const r = path.relative(root, fs.realpathSync(parent));
    if (r.startsWith("..") || path.isAbsolute(r)) throw new UserError("The roadmap path leaves the workspace.");
  }
  return abs;
}

function readText(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new UserError(`${path.basename(abs)} is not a file.`);
    if (st.size > MAX_BYTES) throw new UserError(`${path.basename(abs)} is larger than ${MAX_BYTES / 1_000_000} MB.`);
    return fs.readFileSync(abs, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

const revOf = (text: string | null): string => (text === null ? "none" : crypto.createHash("sha1").update(text).digest("hex").slice(0, 12));

function writeAtomic(abs: string, text: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, abs);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

export interface ItemSession {
  id: string;
  title: string;
  status: string;
  kind: string;
  at: string;
}

export interface ItemView {
  key: string;
  /** Explicit id from the file, or null: the item has not been edited by the app yet. */
  id: string | null;
  title: string;
  done: boolean;
  description: string;
  tags: string[];
  spec: string | null;
  docs: string | null;
  target: string | null;
  lane: string;
  /** Position within its lane. */
  index: number;
  /** 1-based line in the file, for "open at the item". */
  line: number;
  status: ItemStatus;
  progress: SpecProgress | null;
  links: { spec: LinkState | null; docs: LinkState | null };
  sessions: ItemSession[];
}

export interface LaneView {
  name: string;
  items: ItemView[];
  progress: LaneProgress;
}

export interface RoadmapState {
  exists: boolean;
  path: string;
  rev: string;
  heading: string | null;
  lanes: LaneView[];
  /** Items with a broken link, for a quick count. */
  broken: number;
}

function sessionsFor(rootDir: string): Map<string, ItemSession[]> {
  tables();
  const rows = db().prepare("SELECT session_id, item_id, kind, created_at FROM roadmap_sessions WHERE root_dir = ? ORDER BY created_at DESC, rowid DESC LIMIT 400").all(realOf(rootDir)) as Array<{ session_id: string; item_id: string; kind: string; created_at: string }>;
  const out = new Map<string, ItemSession[]>();
  for (const r of rows) {
    const s = getSession(r.session_id);
    if (!s) continue;
    const list = out.get(r.item_id) ?? [];
    if (list.length < 6) list.push({ id: s.id, title: s.title ?? s.id, status: s.status, kind: r.kind, at: r.created_at });
    out.set(r.item_id, list);
  }
  return out;
}

function heading(p: ParsedRoadmap): string | null {
  // The first H1 before the first lane.
  const stop = p.lanes[0]?.line ?? p.lines.length;
  for (let i = 0; i < stop; i++) {
    const m = /^# +(.+?)\s*$/.exec(p.lines[i]!.text);
    if (m) return m[1]!;
  }
  return null;
}

function view(rootDir: string, abs: string, text: string | null): RoadmapState {
  const rel = path.relative(realOf(rootDir), abs);
  if (text === null) return { exists: false, path: rel, rev: "none", heading: null, lanes: [], broken: 0 };
  const p = parseRoadmap(text);
  const sessions = sessionsFor(rootDir);
  let broken = 0;
  const lanes: LaneView[] = p.lanes.map((lane) => {
    const lp: LaneProgress = { items: lane.items.length, shipped: 0, inProgress: 0, tasksDone: 0, tasksTotal: 0 };
    const items = lane.items.map((it, index): ItemView => {
      const progress = specProgress(rootDir, it.spec);
      const mine = sessions.get(it.id ?? "") ?? [];
      const live = mine.filter((s) => s.status === "running").length;
      const links = { spec: checkLink(rootDir, it.spec, "spec"), docs: checkLink(rootDir, it.docs, "docs") };
      if ((links.spec && !links.spec.ok) || (links.docs && !links.docs.ok)) broken++;
      const status = itemStatus(it.done, progress, live);
      if (status === "shipped") lp.shipped++;
      else if (status === "in_progress") lp.inProgress++;
      if (progress) {
        lp.tasksDone += progress.done;
        lp.tasksTotal += progress.total;
      }
      return { key: it.key, id: it.id, title: it.title, done: it.done, description: it.description, tags: it.tags, spec: it.spec, docs: it.docs, target: it.target, lane: lane.name, index, line: it.line + 1, status, progress, links, sessions: mine };
    });
    return { name: lane.name, items, progress: lp };
  });
  return { exists: true, path: rel, rev: revOf(text), heading: heading(p), lanes, broken };
}

export function readRoadmap(rootDir: string): RoadmapState {
  const abs = fileOf(rootDir);
  return view(rootDir, abs, readText(abs));
}

/** The text of one item with its context, for prompts. */
export function itemOf(rootDir: string, key: string): ItemView {
  const state = readRoadmap(rootDir);
  for (const lane of state.lanes) for (const it of lane.items) if (it.key === key || it.id === key) return it;
  throw new UserError(`No roadmap item "${key}".`);
}

/* -------------------------------------------------------------------------- */
/* Edits                                                                      */
/* -------------------------------------------------------------------------- */

/** Only on an explicit request: writes the template where the roadmap lives. Never replaces a file. */
export function createRoadmap(rootDir: string, project?: string | null): RoadmapState {
  const abs = fileOf(rootDir);
  if (fs.existsSync(abs)) throw new UserError(`${path.relative(realOf(rootDir), abs)} already exists.`);
  const name = project?.trim() || path.basename(realOf(rootDir));
  writeAtomic(abs, roadmapTemplate(name));
  return readRoadmap(rootDir);
}

function edit<T extends { text: string }>(rootDir: string, rev: string | null | undefined, fn: (text: string) => T): { state: RoadmapState; result: T } {
  const abs = fileOf(rootDir);
  const text = readText(abs);
  if (text === null) throw new UserError(`There is no ${path.relative(realOf(rootDir), abs)} yet. Create it first.`);
  if (rev && rev !== revOf(text)) throw new RoadmapConflict(`${path.basename(abs)} changed on disk since you loaded it. Reload and try again.`);
  const result = fn(text);
  if (result.text !== text) writeAtomic(abs, result.text);
  return { state: view(rootDir, abs, result.text), result };
}

type Edited = { state: RoadmapState; id: string | null };

export function addRoadmapItem(rootDir: string, input: NewItem, rev?: string | null): Edited {
  const r = edit(rootDir, rev, (t) => addItem(t, input));
  return { state: r.state, id: r.result.id };
}

export function updateRoadmapItem(rootDir: string, key: string, patch: ItemPatch, rev?: string | null): Edited {
  const r = edit(rootDir, rev, (t) => updateItem(t, key, patch));
  return { state: r.state, id: r.result.id };
}

export function moveRoadmapItem(rootDir: string, key: string, lane: string, index: number | null | undefined, rev?: string | null): Edited {
  const r = edit(rootDir, rev, (t) => moveItem(t, key, lane, index));
  return { state: r.state, id: r.result.id };
}

export function deleteRoadmapItem(rootDir: string, key: string, rev?: string | null): Edited {
  tables();
  let id: string | null = null;
  const r = edit(rootDir, rev, (t) => {
    id = findItem(parseRoadmap(t), key).id;
    return deleteItem(t, key);
  });
  if (id) db().prepare("DELETE FROM roadmap_sessions WHERE root_dir = ? AND item_id = ?").run(realOf(rootDir), id);
  return { state: r.state, id: null };
}

export function addRoadmapLane(rootDir: string, name: string, rev?: string | null): RoadmapState {
  return edit(rootDir, rev, (t) => addLane(t, name)).state;
}
export function renameRoadmapLane(rootDir: string, from: string, to: string, rev?: string | null): RoadmapState {
  return edit(rootDir, rev, (t) => renameLane(t, from, to)).state;
}
export function deleteRoadmapLane(rootDir: string, name: string, rev?: string | null): RoadmapState {
  return edit(rootDir, rev, (t) => deleteLane(t, name)).state;
}

/** Give an item an id now (starting work from it needs a stable handle). Returns the id. */
export function ensureItemId(rootDir: string, key: string): string {
  const it = itemOf(rootDir, key);
  if (it.id) return it.id;
  return updateRoadmapItem(rootDir, key, {}).id!;
}

export function recordSession(rootDir: string, itemId: string, sessionId: string, kind: string): void {
  tables();
  db().prepare("INSERT OR REPLACE INTO roadmap_sessions (session_id, root_dir, item_id, kind) VALUES (?, ?, ?, ?)").run(sessionId, realOf(rootDir), itemId, kind);
}

/* -------------------------------------------------------------------------- */
/* Pickers                                                                    */
/* -------------------------------------------------------------------------- */

export interface SpecChoice {
  path: string;
  title: string;
  done: number;
  total: number;
}

/** The feature folders under specs/ (what a `(spec: …)` link can point at). */
export function listSpecChoices(rootDir: string): SpecChoice[] {
  const root = realOf(rootDir);
  const dir = path.join(root, "specs");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    return [];
  }
  return names
    .sort()
    .slice(0, 300)
    .map((name) => {
      const feature = path.join(dir, name);
      let title = name;
      try {
        const head = fs.readFileSync(path.join(feature, "spec.md"), "utf-8").slice(0, 2000);
        const h = /^#\s+(?:Feature Specification:\s*)?(.+?)\s*$/m.exec(head);
        if (h) title = h[1]!;
      } catch {}
      let counts = { done: 0, total: 0 };
      try {
        counts = countTasks(fs.readFileSync(path.join(feature, "tasks.md"), "utf-8"));
      } catch {}
      return { path: `specs/${name}`, title, ...counts };
    });
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "vendor"]);

/** Markdown files a `(docs: …)` link can point at: docs/ (a few levels), and the .md files at the root. */
export function listDocChoices(rootDir: string): string[] {
  const root = realOf(rootDir);
  const out: string[] = [];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isFile() && /\.md$/i.test(e.name)) out.push(e.name);
  } catch {}
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || out.length > 400) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.md$/i.test(e.name)) out.push(path.relative(root, full));
    }
  };
  walk(path.join(root, "docs"), 0);
  return [...new Set(out)].sort();
}
