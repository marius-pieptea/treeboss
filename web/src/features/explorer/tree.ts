/**
 * Explorer logic with no React in it: turning per-directory listings plus the expanded set into the flat
 * list of rows the tree renders (which is also what keyboard navigation and windowing walk), name
 * validation for new / renamed entries, git decoration roll-up, and drag-and-drop rules.
 */
import type { GitFile, TreeEntry } from "@/lib/types";
import { basename, dirname } from "@/lib/utils";

export type Listing = TreeEntry[] | "loading" | "error" | undefined;

export interface InlineInput {
  mode: "file" | "dir" | "rename";
  /** Directory the new entry goes in (for rename: the entry's own parent). */
  parent: string;
  /** Rename only: the path being renamed. */
  target?: string;
}

export type Row =
  | { kind: "entry"; entry: TreeEntry; depth: number; expanded: boolean }
  | { kind: "input"; input: InlineInput; depth: number; initial: string }
  | { kind: "status"; id: string; depth: number; text: string; tone: "muted" | "error" };

export const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
export const parentOf = (p: string): string => dirname(p);

/** Every ancestor directory of a path, outermost first: "a/b/c.ts" -> ["a", "a/b"]. */
export function ancestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** The daemon stops listing a directory at this many entries; seeing exactly this many means there are more. */
export const LISTING_LIMIT = 5000;

export function flattenTree(listings: Map<string, Listing>, expanded: ReadonlySet<string>, input: InlineInput | null): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string, depth: number) => {
    const listing = listings.get(dir);
    if (input && input.mode !== "rename" && input.parent === dir) rows.push({ kind: "input", input, depth, initial: "" });
    if (listing === "loading" || listing === undefined) {
      rows.push({ kind: "status", id: `loading:${dir}`, depth, text: "Loading…", tone: "muted" });
      return;
    }
    if (listing === "error") {
      rows.push({ kind: "status", id: `error:${dir}`, depth, text: "Could not read this folder", tone: "error" });
      return;
    }
    if (listing.length === 0 && !(input && input.mode !== "rename" && input.parent === dir)) {
      rows.push({ kind: "status", id: `empty:${dir}`, depth, text: "Empty folder", tone: "muted" });
      return;
    }
    for (const entry of listing) {
      if (input?.mode === "rename" && input.target === entry.path) {
        rows.push({ kind: "input", input, depth, initial: entry.name });
        if (entry.type === "dir" && expanded.has(entry.path)) walk(entry.path, depth + 1);
        continue;
      }
      const open = entry.type === "dir" && expanded.has(entry.path);
      rows.push({ kind: "entry", entry, depth, expanded: open });
      if (open) walk(entry.path, depth + 1);
    }
    if (listing.length >= LISTING_LIMIT) rows.push({ kind: "status", id: `truncated:${dir}`, depth, text: `Showing the first ${LISTING_LIMIT.toLocaleString("en-US")} entries`, tone: "muted" });
  };
  walk("", 0);
  return rows;
}

/** The row's stable identity (for keys and selection). */
export function rowKey(r: Row): string {
  return r.kind === "entry" ? r.entry.path : r.kind === "input" ? `input:${r.input.mode}:${r.input.target ?? r.input.parent}` : r.id;
}

/* ----------------------------------------------------------------------- names */

const RESERVED = new Set([".git"]);

/**
 * A reason this name cannot be used, or null. `allowPath` lets a NEW entry be typed as "a/b/c.ts" (the
 * server creates the directories); a rename is always a single segment.
 */
export function validateName(raw: string, opts: { siblings: readonly string[]; allowPath?: boolean; current?: string }): string | null {
  const name = raw.trim();
  if (!name) return "A name is required";
  if (/[\0-\x1f]/.test(name)) return "Control characters are not allowed";
  if (name.includes("\\")) return "Backslashes are not allowed";
  if (name.startsWith("/")) return "Use a path relative to this folder";
  const segments = name.split("/");
  if (!opts.allowPath && segments.length > 1) return "A name cannot contain /";
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s === "") return i === segments.length - 1 ? "Remove the trailing /" : "Empty path segment";
    if (s === "." || s === "..") return `"${s}" is not a valid name`;
    if (s !== s.trim()) return "Names cannot start or end with a space";
    if (s.length > 255) return "A name is limited to 255 characters";
    if (RESERVED.has(s.toLowerCase())) return `"${s}" is reserved`;
  }
  const first = segments[0].toLowerCase();
  const clash = opts.siblings.find((sib) => sib.toLowerCase() === first && sib !== opts.current);
  // Case-insensitive on purpose: two names differing only by case cannot coexist on macOS or Windows.
  if (clash !== undefined) return segments.length > 1 ? `"${clash}" already exists here` : `"${clash}" already exists in this folder`;
  return null;
}

/** "a.txt" -> "a copy.txt" -> "a copy 2.txt". Dotfiles and folders get the suffix at the end. */
export function uniqueCopyName(name: string, siblings: readonly string[]): string {
  const taken = new Set(siblings.map((s) => s.toLowerCase()));
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem} copy${n === 1 ? "" : ` ${n}`}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} copy ${Date.now()}${ext}`;
}

/* ------------------------------------------------------------------ drag and drop */

/** Why `src` cannot be moved into `destDir`, or null when it can (or the move would change nothing). */
export function moveBlocked(src: string, destDir: string): string | null {
  if (src === destDir) return "Cannot move a folder into itself";
  if (destDir === src || destDir.startsWith(`${src}/`)) return "Cannot move a folder into itself";
  return null;
}

export function isNoopMove(src: string, destDir: string): boolean {
  return parentOf(src) === destDir;
}

export const moveTarget = (src: string, destDir: string): string => join(destDir, basename(src));

/* ------------------------------------------------------------------- git decoration */

export type Tone = "red" | "amber" | "green" | "blue" | "violet";
export interface Decoration {
  letter: string;
  tone: Tone;
  label: string;
}

export function decorationFor(f: GitFile): Decoration {
  if (f.conflict) return { letter: "!", tone: "red", label: "Merge conflict" };
  if (f.worktree === "?") return { letter: "U", tone: "green", label: "Untracked" };
  if (f.index === "A") return { letter: "A", tone: "green", label: "Added" };
  if (f.index === "D" || f.worktree === "D") return { letter: "D", tone: "red", label: "Deleted" };
  if (f.index === "R") return { letter: "R", tone: "blue", label: "Renamed" };
  if (f.index === "T" || f.worktree === "T") return { letter: "T", tone: "violet", label: "Type changed" };
  return { letter: "M", tone: "amber", label: f.index !== "." && f.worktree !== "." ? "Modified (partly staged)" : f.index !== "." ? "Staged" : "Modified" };
}

const PRIORITY: Tone[] = ["red", "amber", "violet", "blue", "green"];

/** Git paths are repo-relative; the tree is workspace-relative. Entries outside the workspace are dropped. */
export function buildDecorations(files: readonly GitFile[], prefix: string | undefined): { files: Map<string, Decoration>; dirs: Map<string, { count: number; tone: Tone }> } {
  const p = prefix ?? "";
  const fileMap = new Map<string, Decoration>();
  const dirs = new Map<string, { count: number; tone: Tone }>();
  for (const f of files) {
    if (p && !f.path.startsWith(p)) continue;
    const rel = p ? f.path.slice(p.length) : f.path;
    const d = decorationFor(f);
    fileMap.set(rel, d);
    for (const dir of ancestors(rel)) {
      const cur = dirs.get(dir);
      if (!cur) dirs.set(dir, { count: 1, tone: d.tone });
      else {
        cur.count++;
        if (PRIORITY.indexOf(d.tone) < PRIORITY.indexOf(cur.tone)) cur.tone = d.tone;
      }
    }
  }
  return { files: fileMap, dirs };
}

/* ---------------------------------------------------------------------- windowing */

export const ROW_HEIGHT = 24;

/** Which rows to render for a scroll position: the visible band plus overscan. */
export function visibleWindow(total: number, scrollTop: number, viewport: number, overscan = 8): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + overscan);
  return { start, end };
}

/** The scrollTop that brings row `index` fully into view, or null when it already is. */
export function scrollToReveal(index: number, scrollTop: number, viewport: number): number | null {
  const top = index * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewport) return bottom - viewport;
  return null;
}
