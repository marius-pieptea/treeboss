/**
 * The Specs module's view of a workspace: which features exist, what state each is in, and reading,
 * writing and creating the files behind them. The files are the only source of truth. Nothing here is
 * cached in the database; every answer is derived from the directory on each call.
 *
 * Layout (Spec Kit's, so the `specify` tool keeps working on the same folders):
 *
 *   .specify/memory/constitution.md        the project's principles
 *   .specify/init-options.json             optional: { "feature_numbering": "sequential" | "timestamp" }
 *   specs/NNN-short-name/spec.md plan.md tasks.md research.md data-model.md quickstart.md contracts/
 *
 * Every path in or out is relative to the workspace and must stay inside `specs/` or `.specify/`.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { RootError, relFrom, safeJoin } from "../workspaces";
import { readFileSafe, writeFileSafe } from "../fs/files";
import { UserError } from "../util";
import { parseTasks } from "./tasks";
import { inPlansDir } from "../sessions/plansdir";
import { CONSTITUTION_PATH, INIT_OPTIONS_PATH, SPECS_DIR, constitutionTemplate, slugify, specTemplate, titleFromSlug } from "./templates";

export type FeatureStatus = "draft" | "planned" | "tasked" | "in-progress" | "done";

export interface FeatureInfo {
  /** "001-add-csv-export" */
  id: string;
  /** "001", or the timestamp prefix. */
  number: string;
  name: string;
  /** "specs/001-add-csv-export" */
  dir: string;
  title: string;
  files: { spec: boolean; plan: boolean; tasks: boolean; research: boolean; dataModel: boolean; quickstart: boolean; contracts: string[]; other: string[] };
  tasks: { done: number; total: number };
  status: FeatureStatus;
  updatedAt: number;
  /** spec.md is still the skeleton: its template placeholders are there. */
  specDraft: boolean;
  /** Open [NEEDS CLARIFICATION] markers in spec.md. */
  clarifications: number;
}

export interface SpecsOverview {
  constitution: { exists: boolean; path: string; bytes: number; /** still has the template's [PLACEHOLDER] markers */ placeholders: boolean; mtime: number | null };
  features: FeatureInfo[];
  /** The `specify` tool's path, when it is installed. Only reported; nothing here needs it. */
  specify: { path: string | null };
  numbering: "sequential" | "timestamp";
  /** Changes whenever any spec file does: the UI polls this cheaply. */
  rev: string;
}

const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const FEATURE_DIR = /^(\d{8}-\d{6}|\d{3,})-(.+)$/;

/** A path the Specs module may touch: relative, and under specs/ or .specify/. Returns the cleaned form. */
export function guardSpecPath(rootDir: string, rel: string): string {
  const cleaned = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleaned) throw new RootError("A path is required.");
  const parts = cleaned.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) throw new RootError("Path escapes the specs folder.", 403);
  // A plan file (plans/…) can be attached to a session like a spec: the plans folder is allowed too.
  if (parts[0] !== SPECS_DIR && parts[0] !== ".specify" && !inPlansDir(rootDir, cleaned)) throw new RootError("Only files under specs/, .specify/ and the plans folder are available here.", 403);
  safeJoin(rootDir, cleaned); // symlinks that leave the workspace
  return cleaned;
}

function exists(rootDir: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(rootDir, rel)).isFile();
  } catch {
    return false;
  }
}

function readText(rootDir: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(rootDir, rel), "utf-8");
  } catch {
    return null;
  }
}

export function numberingMode(rootDir: string): "sequential" | "timestamp" {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(rootDir, INIT_OPTIONS_PATH), "utf-8"));
    const v = o?.feature_numbering ?? o?.branch_numbering;
    return v === "timestamp" ? "timestamp" : "sequential";
  } catch {
    return "sequential";
  }
}

let specifyCache: { at: number; path: string | null } | null = null;
function specifyPath(): string | null {
  if (specifyCache && Date.now() - specifyCache.at < 60_000) return specifyCache.path;
  const p = Bun.which("specify", { PATH: process.env.PATH }) ?? null;
  specifyCache = { at: Date.now(), path: p };
  return p;
}

function listFiles(dir: string, base: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of entries) {
    if (out.length >= 80) return;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory() && depth > 0) listFiles(path.join(dir, e.name), rel, depth - 1, out);
    else if (e.isFile()) out.push(rel);
  }
}

const CORE = new Set(["spec.md", "plan.md", "tasks.md", "research.md", "data-model.md", "quickstart.md"]);

function featureInfo(rootDir: string, id: string): FeatureInfo | null {
  const m = FEATURE_DIR.exec(id);
  if (!m) return null;
  const dir = `${SPECS_DIR}/${id}`;
  const abs = path.join(rootDir, dir);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  const all: string[] = [];
  listFiles(abs, "", 2, all);
  const has = (f: string) => all.includes(f);
  const contracts = all.filter((f) => f.startsWith("contracts/"));
  const other = all.filter((f) => !CORE.has(f) && !f.startsWith("contracts/"));
  const tasksText = has("tasks.md") ? readText(rootDir, `${dir}/tasks.md`) : null;
  const parsed = tasksText ? parseTasks(tasksText) : null;
  const spec = has("spec.md") ? readText(rootDir, `${dir}/spec.md`) : null;
  const title = spec ? /^#\s+(?:Feature Specification:\s*)?(.+?)\s*$/m.exec(spec)?.[1] : null;
  const total = parsed?.total ?? 0;
  const done = parsed?.done ?? 0;
  let status: FeatureStatus = "draft";
  if (total > 0 && done === total) status = "done";
  else if (total > 0 && done > 0) status = "in-progress";
  else if (total > 0 || has("tasks.md")) status = "tasked";
  else if (has("plan.md")) status = "planned";
  let updatedAt = st.mtimeMs;
  for (const f of all) {
    try {
      updatedAt = Math.max(updatedAt, fs.statSync(path.join(abs, f)).mtimeMs);
    } catch {}
  }
  return {
    id,
    number: m[1],
    name: m[2],
    dir,
    title: title && !/^\[/.test(title) ? title : titleFromSlug(m[2]),
    files: { spec: has("spec.md"), plan: has("plan.md"), tasks: has("tasks.md"), research: has("research.md"), dataModel: has("data-model.md"), quickstart: has("quickstart.md"), contracts, other },
    tasks: { done, total },
    status,
    updatedAt: Math.round(updatedAt),
    specDraft: spec ? /\[(Short title|Describe this journey[^\]]*|specific capability|Entity)\]/.test(spec) : false,
    clarifications: spec ? (spec.match(/\[NEEDS CLARIFICATION/g) ?? []).length : 0,
  };
}

export function listFeatures(rootDir: string): FeatureInfo[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(rootDir, SPECS_DIR));
  } catch {
    return [];
  }
  const out: FeatureInfo[] = [];
  for (const n of names) {
    const f = featureInfo(rootDir, n);
    if (f) out.push(f);
  }
  return out.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

export function overview(rootDir: string): SpecsOverview {
  const features = listFeatures(rootDir);
  let bytes = 0;
  let mtime: number | null = null;
  let text: string | null = null;
  try {
    const st = fs.statSync(path.join(rootDir, CONSTITUTION_PATH));
    bytes = st.size;
    mtime = Math.round(st.mtimeMs);
    text = readText(rootDir, CONSTITUTION_PATH);
  } catch {}
  const hash = createHash("sha1");
  hash.update(String(mtime ?? "-"));
  for (const f of features) hash.update(`${f.id}:${f.updatedAt}:${f.tasks.done}/${f.tasks.total}`);
  return {
    constitution: { exists: mtime !== null, path: CONSTITUTION_PATH, bytes, placeholders: text ? /\[[A-Z0-9_]{3,}\]/.test(text) : false, mtime },
    features,
    specify: { path: specifyPath() },
    numbering: numberingMode(rootDir),
    rev: hash.digest("hex").slice(0, 12),
  };
}

/** "001", "001-add-csv", "add-csv", "specs/001-add-csv" → the feature, or null. */
export function findFeature(rootDir: string, ref: string): FeatureInfo | null {
  const q = String(ref ?? "").trim().replace(/^specs\//, "").replace(/\/+$/, "");
  if (!q) return null;
  const all = listFeatures(rootDir);
  return all.find((f) => f.id === q) ?? all.find((f) => f.number === q || f.number === q.padStart(3, "0")) ?? all.find((f) => f.name === q) ?? all.filter((f) => f.id.startsWith(q) || f.name.startsWith(q))[0] ?? null;
}

export function requireFeature(rootDir: string, ref: string): FeatureInfo {
  const f = findFeature(rootDir, ref);
  if (!f) throw new RootError(`No feature "${ref}" under specs/. See \`trb spec ls\`.`, 404);
  return f;
}

function nextNumber(rootDir: string, mode: "sequential" | "timestamp"): string {
  if (mode === "timestamp") {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  let max = 0;
  try {
    for (const n of fs.readdirSync(path.join(rootDir, SPECS_DIR))) {
      const m = /^(\d{3,})-/.exec(n);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {}
  return String(max + 1).padStart(3, "0");
}

/** Allocate specs/NNN-name/ and write a spec.md skeleton. The only file this creates. */
export function createFeature(rootDir: string, input: { name: string; description?: string | null }): FeatureInfo {
  const raw = String(input.name ?? "").trim();
  if (!raw) throw new UserError("A feature needs a name.");
  const slug = slugify(raw);
  if (!slug) throw new UserError(`"${raw}" has no letters or digits to name a folder with.`);
  const dup = listFeatures(rootDir).find((f) => f.name === slug);
  if (dup) throw new UserError(`A feature named "${slug}" already exists (${dup.id}).`);
  const id = `${nextNumber(rootDir, numberingMode(rootDir))}-${slug}`;
  const rel = `${SPECS_DIR}/${id}/spec.md`;
  const abs = safeJoin(rootDir, rel);
  if (fs.existsSync(path.dirname(abs))) throw new UserError(`${SPECS_DIR}/${id} already exists.`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const title = (raw[0].toUpperCase() + raw.slice(1)).replace(/\s+/g, " ").slice(0, 100);
  fs.writeFileSync(abs, specTemplate(title, input.description?.trim() || raw, id));
  return featureInfo(rootDir, id)!;
}

/** Write the constitution template. Refuses to replace an existing one. */
export function initConstitution(rootDir: string, project?: string | null): { path: string } {
  const rel = CONSTITUTION_PATH;
  const abs = safeJoin(rootDir, rel);
  if (fs.existsSync(abs)) throw new UserError("A constitution already exists. Edit it instead.");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, constitutionTemplate(project?.trim() || path.basename(rootDir)));
  return { path: rel };
}

export function readSpecFile(rootDir: string, rel: string) {
  return readFileSafe(rootDir, guardSpecPath(rootDir, rel));
}

export function writeSpecFile(rootDir: string, rel: string, content: string, opts: { expectedMtime?: number | null; create?: boolean } = {}) {
  const p = guardSpecPath(rootDir, rel);
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new UserError("That file is too large for the specs editor (2 MB at most).");
  return writeFileSafe(rootDir, p, content, opts);
}

/** The path of one of a feature's files, by short name. */
export function featureFile(f: FeatureInfo, which: "spec" | "plan" | "tasks" | "research" | "data-model" | "quickstart"): string {
  return `${f.dir}/${which}.md`;
}

export { relFrom };
