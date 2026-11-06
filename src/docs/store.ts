/**
 * The Docs module's view of a workspace: which pages exist, what each says about itself, and reading,
 * writing and creating the files behind them. The files are the only source of truth: nothing here is
 * cached in the database, every answer is derived from the directory on each call. The one stored value is
 * where the docs folder is (`docs/` unless a workspace says otherwise).
 *
 * Every path in or out is relative to the workspace and must stay inside the docs folder, and only
 * markdown files are read or written. Nothing is ever created except by an explicit call.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { db } from "../db";
import { RootError, relFrom, safeJoin } from "../workspaces";
import { writeFileSafe } from "../fs/files";
import { UserError } from "../util";
import { type DocMeta, docMeta, firstHeading, parseFrontMatter, setGenerated, summaryLine } from "./frontmatter";
import { DECISIONS_DIR, DEFAULT_DOCS_DIR, type PageKind, pageTemplate, slugify, titleFromSlug } from "./templates";

const MD = /\.(md|mdx|markdown)$/i;
const MAX_PAGES = 600;
const MAX_DEPTH = 8;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 16 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface PageInfo {
  /** Relative to the workspace: "docs/architecture.md". */
  path: string;
  /** The file name. */
  name: string;
  /** The folder under the docs dir, "" for the top level. */
  folder: string;
  title: string;
  kind: "page" | "adr" | "index";
  size: number;
  mtime: number;
  /** Records a generated commit and covers: staleness can be checked. */
  managed: boolean;
  meta: DocMeta;
  frontMatterError: string | null;
  summary: string;
}

export interface DocsOverview {
  /** The docs folder, relative to the workspace. */
  dir: string;
  /** Whether the folder exists on disk. */
  exists: boolean;
  /** `docs_dir` was set for this workspace (otherwise it is the default). */
  custom: boolean;
  pages: PageInfo[];
  truncated: boolean;
  /** Next ADR number, "0001". */
  nextAdr: string;
  /** Changes whenever any page does: the UI polls this cheaply. */
  rev: string;
}

/* -------------------------------------------------------------------------- */
/* Where the docs live                                                        */
/* -------------------------------------------------------------------------- */

const key = (workspaceId: string) => `docs.dir.${workspaceId}`;

/** A docs folder setting, cleaned: relative, forward slashes, no `..`, not inside .git or node_modules. */
export function validateDocsDir(input: string): string {
  const cleaned = String(input ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (!cleaned) throw new UserError("The docs folder cannot be empty.");
  if (cleaned.includes("\0")) throw new UserError("Bad path.");
  const parts = cleaned.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) throw new UserError("The docs folder must be inside the workspace.");
  if (parts.some((p) => p === ".git" || p === "node_modules")) throw new UserError("The docs folder cannot be inside .git or node_modules.");
  return cleaned;
}

export function docsDirOf(workspaceId: string | null): { dir: string; custom: boolean } {
  if (workspaceId) {
    const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key(workspaceId)) as { value: string } | undefined;
    if (row?.value) {
      try {
        return { dir: validateDocsDir(row.value), custom: true };
      } catch {}
    }
  }
  return { dir: DEFAULT_DOCS_DIR, custom: false };
}

/** Set a workspace's docs folder; null goes back to the default. Creates nothing. */
export function setDocsDir(workspaceId: string, dir: string | null): { dir: string; custom: boolean } {
  if (dir === null || dir === "") db().prepare("DELETE FROM settings WHERE key = ?").run(key(workspaceId));
  else db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key(workspaceId), validateDocsDir(dir));
  return docsDirOf(workspaceId);
}

/**
 * A path the Docs module may touch: relative, a markdown file (or the docs folder itself when `allowDir`),
 * under the docs folder. Returns the cleaned relative form.
 */
export function guardDocsPath(rootDir: string, docsDir: string, rel: string, opts: { allowDir?: boolean } = {}): string {
  const cleaned = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleaned) throw new RootError("A path is required.");
  if (cleaned.includes("\0")) throw new RootError("Bad path.");
  const parts = cleaned.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) throw new RootError("Path escapes the docs folder.", 403);
  const base = docsDir.split("/");
  const inDocs = base.every((b, i) => parts[i] === b) && (parts.length > base.length || opts.allowDir);
  if (!inDocs) throw new RootError(`Only files under ${docsDir}/ are available here.`, 403);
  if (parts.length > base.length && !opts.allowDir && !MD.test(cleaned)) throw new RootError("Only markdown files (.md, .mdx) are available here.", 403);
  if (parts.some((p) => p === ".git")) throw new RootError("Refusing to touch .git.", 403);
  safeJoin(rootDir, cleaned); // symlinks that leave the workspace
  return cleaned;
}

/* -------------------------------------------------------------------------- */
/* Listing                                                                    */
/* -------------------------------------------------------------------------- */

function kindOf(rel: string, docsDir: string): PageInfo["kind"] {
  const inner = rel.slice(docsDir.length + 1);
  if (inner.startsWith(`${DECISIONS_DIR}/`) && /^\d{4}-/.test(path.basename(inner))) return "adr";
  if (/^index\.(md|mdx|markdown)$/i.test(inner) || /^readme\.(md|mdx|markdown)$/i.test(inner)) return "index";
  return "page";
}

function readHead(abs: string): string {
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function pageInfo(rootDir: string, docsDir: string, rel: string, st: fs.Stats): PageInfo {
  let head = "";
  try {
    head = readHead(path.join(rootDir, rel));
  } catch {}
  const fm = parseFrontMatter(head);
  const meta = docMeta(fm.data);
  const name = path.basename(rel);
  const folder = path.dirname(rel.slice(docsDir.length + 1)).replace(/^\.$/, "");
  return {
    path: rel,
    name,
    folder,
    title: meta.title ?? firstHeading(fm.body) ?? titleFromSlug(name),
    kind: kindOf(rel, docsDir),
    size: st.size,
    mtime: Math.round(st.mtimeMs),
    managed: !!meta.generated?.commit && meta.covers.length > 0,
    meta,
    frontMatterError: fm.error,
    summary: summaryLine(fm.body),
  };
}

export function listPages(rootDir: string, docsDir: string): { pages: PageInfo[]; truncated: boolean } {
  const pages: PageInfo[] = [];
  let truncated = false;
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(rootDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      if (pages.length >= MAX_PAGES) {
        truncated = true;
        return;
      }
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(child, depth + 1);
      } else if (e.isFile() && MD.test(e.name)) {
        try {
          pages.push(pageInfo(rootDir, docsDir, child, fs.statSync(path.join(rootDir, child))));
        } catch {}
      }
    }
  };
  // A docs dir that is itself a symlink out of the workspace is not followed.
  try {
    safeJoin(rootDir, docsDir);
  } catch {
    return { pages, truncated };
  }
  walk(docsDir, 0);
  return { pages, truncated };
}

export function nextAdrNumber(rootDir: string, docsDir: string): string {
  let max = 0;
  try {
    for (const f of fs.readdirSync(path.join(rootDir, docsDir, DECISIONS_DIR))) {
      const m = /^(\d{4})-/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {}
  return String(max + 1).padStart(4, "0");
}

export function overview(rootDir: string, docsDir: string, custom = false): DocsOverview {
  const exists = (() => {
    try {
      return fs.statSync(path.join(rootDir, docsDir)).isDirectory();
    } catch {
      return false;
    }
  })();
  const { pages, truncated } = exists ? listPages(rootDir, docsDir) : { pages: [] as PageInfo[], truncated: false };
  const h = createHash("sha1");
  for (const p of pages) h.update(`${p.path}\0${p.mtime}\0${p.size}\n`);
  return { dir: docsDir, exists, custom, pages, truncated, nextAdr: nextAdrNumber(rootDir, docsDir), rev: h.digest("hex").slice(0, 12) };
}

/* -------------------------------------------------------------------------- */
/* Reading and writing                                                        */
/* -------------------------------------------------------------------------- */

export interface PageContent {
  path: string;
  content: string;
  mtime: number;
  size: number;
  eol: "lf" | "crlf";
  title: string;
  meta: DocMeta;
  frontMatterError: string | null;
}

export function readPage(rootDir: string, docsDir: string, rel: string): PageContent {
  const p = guardDocsPath(rootDir, docsDir, rel);
  const abs = safeJoin(rootDir, p);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (e: any) {
    if (e.code === "ENOENT") throw new RootError(`No such page: ${p}`, 404);
    throw e;
  }
  if (!st.isFile()) throw new RootError(`${p} is not a file.`);
  if (st.size > 2 * 1024 * 1024) throw new RootError(`${p} is too large to open here (${Math.round(st.size / 1024)} KB).`, 413);
  const content = fs.readFileSync(abs, "utf-8");
  const fm = parseFrontMatter(content);
  const meta = docMeta(fm.data);
  return {
    path: relFrom(rootDir, abs),
    content,
    mtime: Math.round(st.mtimeMs),
    size: st.size,
    eol: content.includes("\r\n") ? "crlf" : "lf",
    title: meta.title ?? firstHeading(fm.body) ?? titleFromSlug(path.basename(p)),
    meta,
    frontMatterError: fm.error,
  };
}

export function writePage(rootDir: string, docsDir: string, rel: string, content: string, opts: { expectedMtime?: number | null; create?: boolean } = {}): { mtime: number; size: number; frontMatterError: string | null } {
  const p = guardDocsPath(rootDir, docsDir, rel);
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new UserError("That page is larger than 2 MB.");
  const out = writeFileSafe(rootDir, p, content, { expectedMtime: opts.expectedMtime ?? null, create: opts.create === true });
  // A page with broken front matter is still saved (it is a person's file); say so instead of refusing.
  return { ...out, frontMatterError: parseFrontMatter(content).error };
}

/** Create the docs folder with an index page. Refuses when the folder already holds markdown. */
export function createDocsFolder(rootDir: string, docsDir: string, project?: string | null): { dir: string; created: string[] } {
  const abs = safeJoin(rootDir, docsDir);
  const created: string[] = [];
  fs.mkdirSync(abs, { recursive: true });
  const index = `${docsDir}/index.md`;
  const hasMarkdown = listPages(rootDir, docsDir).pages.length > 0;
  if (!hasMarkdown && !fs.existsSync(path.join(rootDir, index))) {
    writeFileSafe(rootDir, index, pageTemplate((project ?? "").trim() || path.basename(rootDir), "index"), { create: true });
    created.push(index);
  }
  return { dir: docsDir, created };
}

/** A new page from a template. `rel` is relative to the docs folder ("architecture", "guides/setup.md"). */
export function createPage(rootDir: string, docsDir: string, input: { path?: string; title?: string; kind?: PageKind; content?: string }): { path: string; title: string } {
  const kind: PageKind = input.kind === "adr" ? "adr" : input.kind === "index" ? "index" : "page";
  let rel: string;
  let title: string;
  if (kind === "adr") {
    title = (input.title ?? "").trim() || "Untitled decision";
    const n = nextAdrNumber(rootDir, docsDir);
    rel = `${docsDir}/${DECISIONS_DIR}/${n}-${slugify(title) || "decision"}.md`;
    const text = input.content ?? pageTemplate(title, "adr", { number: n });
    writeNew(rootDir, docsDir, rel, text);
    return { path: rel, title: `${n}. ${title}` };
  }
  const given = String(input.path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!given && !input.title) throw new UserError("A page needs a path or a title.");
  const sub = given || `${slugify(input.title ?? "") || "page"}.md`;
  const withExt = MD.test(sub) ? sub : `${sub}.md`;
  // A caller may pass either "architecture.md" or "docs/architecture.md".
  rel = withExt.startsWith(`${docsDir}/`) ? withExt : `${docsDir}/${withExt}`;
  title = (input.title ?? "").trim() || titleFromSlug(path.basename(rel));
  writeNew(rootDir, docsDir, rel, input.content ?? pageTemplate(title, kind));
  return { path: rel, title };
}

function writeNew(rootDir: string, docsDir: string, rel: string, text: string): void {
  const p = guardDocsPath(rootDir, docsDir, rel);
  if (fs.existsSync(safeJoin(rootDir, p))) throw new RootError(`${p} already exists.`, 409);
  writeFileSafe(rootDir, p, text, { create: true });
}

/**
 * A person says this page is current as of HEAD: record that, so it is checked against later changes. It is
 * the one write that touches only front matter.
 */
export function markCurrent(rootDir: string, docsDir: string, rel: string, head: string, by = "manual"): { mtime: number; size: number } {
  const p = guardDocsPath(rootDir, docsDir, rel);
  const abs = safeJoin(rootDir, p);
  const before = fs.readFileSync(abs, "utf-8");
  const meta = docMeta(parseFrontMatter(before).data);
  if (!meta.covers.length) throw new UserError("This page does not list what it covers: add a `covers:` list to its front matter first, so there is something to check.");
  return writeFileSafe(rootDir, p, setGenerated(before, { commit: head, by }), { create: false });
}
