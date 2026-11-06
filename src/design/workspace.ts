/**
 * A project's design system: DESIGN.md at the root and design/tokens.css, read into a view, written from
 * the library on request, and copied back into the library.
 *
 * The files are the only copy; nothing about a project's design is kept in the database. Writing never
 * replaces an existing file unless the caller says `overwrite`, and refuses a path whose parent is a
 * symlink leading out of the workspace.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { addRules, readRules } from "../memory/store";
import { cleanRule } from "../memory/block";
import { DESIGN_FILE, DESIGN_RULE, parseTokens, TOKENS_FILE, type TokenSummary } from "./contract";
import { getSystem, idFor, listSystems, saveSystem, type DesignSystem } from "./library";
import { DIRECTIONS_FILE } from "./guidance";

const MAX_BYTES = 1_000_000;
/** The directions page is shown in the UI; a larger one is reported but not sent. */
const MAX_DIRECTIONS_BYTES = 400_000;

/** The files changed since the caller looked (a 409 over HTTP). */
export class DesignConflict extends UserError {}

const realOf = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** The absolute path of a workspace-relative file, refusing anything (a symlinked parent or the file itself) that leads out. */
function fileIn(rootDir: string, rel: string): string {
  const root = realOf(rootDir);
  const abs = path.resolve(root, rel);
  const inside = (p: string) => {
    const r = path.relative(root, p);
    return !r.startsWith("..") && !path.isAbsolute(r);
  };
  for (let p = path.dirname(abs); p.length >= root.length; p = path.dirname(p)) {
    if (fs.existsSync(p)) {
      if (!inside(fs.realpathSync(p))) throw new UserError(`${rel} would be written outside the project.`);
      break;
    }
  }
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (st?.isSymbolicLink() && !inside(realOf(abs))) throw new UserError(`${rel} is a symlink that leaves the project.`);
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

const revOf = (a: string | null, b: string | null): string => (a === null && b === null ? "none" : crypto.createHash("sha1").update(`${a ?? ""}\0${b ?? ""}`).digest("hex").slice(0, 12));

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

export interface DesignState {
  exists: boolean;
  path: string;
  /** Changes whenever either file changes. */
  rev: string;
  /** The first H1 of DESIGN.md. */
  title: string | null;
  text: string | null;
  tokens: { path: string; exists: boolean; summary: TokenSummary | null };
  /** AGENTS.md carries the rule that points agents at these files. */
  agentRule: boolean;
  /** The library system whose files these are, unchanged; null when edited or not from the library. */
  matches: string | null;
  /** design/directions.html, written by a brainstorm turn: the directions to choose from. */
  directions: { path: string; exists: boolean; html: string | null; tooLarge: boolean };
}

function readDirections(rootDir: string): DesignState["directions"] {
  const abs = fileIn(rootDir, DIRECTIONS_FILE);
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st?.isFile()) return { path: DIRECTIONS_FILE, exists: false, html: null, tooLarge: false };
  if (st.size > MAX_DIRECTIONS_BYTES) return { path: DIRECTIONS_FILE, exists: true, html: null, tooLarge: true };
  return { path: DIRECTIONS_FILE, exists: true, html: fs.readFileSync(abs, "utf-8"), tooLarge: false };
}

export function hasDesignRule(rootDir: string): boolean {
  const want = cleanRule(DESIGN_RULE);
  try {
    return readRules(rootDir).some((r) => r.text === want);
  } catch {
    return false;
  }
}

/** Add the AGENTS.md rule (idempotent). */
export function addDesignRule(rootDir: string): void {
  addRules(rootDir, [DESIGN_RULE]);
}

export function readDesign(rootDir: string): DesignState {
  const text = readText(fileIn(rootDir, DESIGN_FILE));
  const tokens = readText(fileIn(rootDir, TOKENS_FILE));
  const title = text ? (/^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? null) : null;
  const matches = text !== null ? (listSystems().find((s) => s.design === text && (s.tokens || null) === tokens)?.id ?? null) : null;
  return {
    exists: text !== null,
    path: DESIGN_FILE,
    rev: revOf(text, tokens),
    title,
    text,
    tokens: { path: TOKENS_FILE, exists: tokens !== null, summary: tokens !== null ? parseTokens(tokens) : null },
    agentRule: hasDesignRule(rootDir),
    matches,
    directions: readDirections(rootDir),
  };
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Write a library system's DESIGN.md and tokens.css into a project and add the agent rule. Refuses when
 * either file exists, unless `overwrite`. Used by the Design view and by scaffolding.
 */
export function writeSystem(rootDir: string, sys: DesignSystem, o: { overwrite?: boolean; rule?: boolean } = {}): void {
  const design = fileIn(rootDir, DESIGN_FILE);
  const tokens = fileIn(rootDir, TOKENS_FILE);
  if (!o.overwrite) {
    const there = [fs.existsSync(design) && DESIGN_FILE, fs.existsSync(tokens) && TOKENS_FILE].filter(Boolean);
    if (there.length) throw new UserError(`${there.join(" and ")} already ${there.length === 1 ? "exists" : "exist"}. Replace ${there.length === 1 ? "it" : "them"} explicitly.`);
  }
  writeAtomic(design, sys.design);
  if (sys.tokens) writeAtomic(tokens, sys.tokens);
  else fs.rmSync(tokens, { force: true });
  if (o.rule !== false) addDesignRule(rootDir);
}

export function applySystem(rootDir: string, id: string, overwrite = false, rev?: string | null): DesignState {
  const sys = getSystem(id);
  if (rev && overwrite && rev !== readDesign(rootDir).rev) throw new DesignConflict(`${DESIGN_FILE} or ${TOKENS_FILE} changed since you looked. Reload and try again.`);
  writeSystem(rootDir, sys, { overwrite });
  return readDesign(rootDir);
}

/** Copy the project's DESIGN.md and tokens.css into the library as a new system. */
export function saveToLibrary(rootDir: string, input: { name: string; description?: string | null }): DesignSystem {
  const state = readDesign(rootDir);
  if (!state.exists || state.text === null) throw new UserError(`There is no ${DESIGN_FILE} in this project to save.`);
  const name = String(input.name ?? "").trim() || state.title?.replace(/\s+design system$/i, "") || path.basename(realOf(rootDir));
  const tokens = readText(fileIn(rootDir, TOKENS_FILE)) ?? "";
  const id = idFor(name, listSystems().map((s) => s.id));
  return saveSystem({ id, name, description: input.description ?? "", design: state.text, tokens });
}
