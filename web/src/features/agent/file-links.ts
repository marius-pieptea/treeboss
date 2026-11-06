/**
 * Pure logic for file links in the conversation: which words in an assistant message are workspace files,
 * and the remark step that turns them into links. No React and no DOM, so it is unit-tested directly.
 *
 * A mention only becomes a link when it names a file that really exists (the workspace's file list, plus the
 * files the agent's own Write/Edit calls touched, which a stale list would miss). Nothing is guessed: a bare
 * `index.ts` that matches two files stays plain text.
 */
import { extractFileLinks } from "../terminal/logic";

export interface FileRef {
  /** Workspace-relative path. */
  path: string;
  line?: number;
  col?: number;
}

/** Looks a mention up in the set of real files. `find` returns the workspace-relative path, or null. */
export interface FileIndex {
  readonly size: number;
  find(path: string): string | null;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Index files by basename so `Markdown.tsx` or `agent/Markdown.tsx` finds `web/src/features/agent/Markdown.tsx`
 * when exactly one file ends that way. Exact paths always win; ambiguity returns null.
 */
export function createFileIndex(files: Iterable<string>): FileIndex {
  const all = new Set<string>();
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    if (!f || all.has(f)) continue;
    all.add(f);
    const b = base(f);
    const list = byBase.get(b);
    if (list) list.push(f);
    else byBase.set(b, [f]);
  }
  return {
    size: all.size,
    find(path) {
      if (all.has(path)) return path;
      const list = byBase.get(base(path));
      if (!list) return null;
      const hits = list.filter((f) => f.endsWith("/" + path));
      return hits.length === 1 ? hits[0] : null;
    },
  };
}

/** Workspace-relative form of a mention: strips `./`, and the absolute `cwd` prefix. Null when it leaves the workspace. */
export function relativize(raw: string, cwd?: string): string | null {
  let p = raw;
  if (p.startsWith("file://")) p = decodeURIComponent(p.slice("file://".length));
  if (p.startsWith("/")) {
    if (!cwd) return null;
    const root = cwd.replace(/\/+$/, "") + "/";
    if (!p.startsWith(root)) return null;
    p = p.slice(root.length);
  }
  p = p.replace(/^(\.\/)+/, "");
  if (!p || p.startsWith("../") || p.includes("/../") || p.includes("\0")) return null;
  return p;
}

/**
 * The whole of an inline-code span or a link target as a file mention: `src/a.ts`, `./src/a.ts:42`,
 * `src/a.ts:42:7`, `src/a.ts#L42`, `src/a.ts#L42-L50`, `src/a.ts(42,7)`, an absolute path inside `cwd`.
 * Unlike free text this needs no extension: `Makefile` and `LICENSE` qualify when they are real files.
 */
export function parseFileRef(raw: string, cwd?: string): FileRef | null {
  const s = raw.trim();
  if (!s || /\s/.test(s) || (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !s.startsWith("file://"))) return null;
  const m = /^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?|\((\d+),(\d+)\))?$/.exec(s);
  if (!m || !m[1]) return null;
  const path = relativize(m[1], cwd);
  if (!path) return null;
  const line = m[2] ?? m[4] ?? m[6];
  const col = m[3] ?? m[5] ?? m[7];
  return { path, line: line ? Number(line) : undefined, col: col ? Number(col) : undefined };
}

/** `parseFileRef` plus the lookup: the ref with its real path, or null when it is not a file here. */
export function resolveFileRef(raw: string, index: FileIndex, cwd?: string): FileRef | null {
  const ref = parseFileRef(raw, cwd);
  if (!ref) return null;
  const path = index.find(ref.path);
  return path ? { ...ref, path } : null;
}

export type TextPart = { text: string } | { text: string; ref: FileRef };

/** Split free text into plain runs and file mentions that resolve (`path`, `path:12`, `path:12:5`). */
export function linkifyText(text: string, index: FileIndex, cwd?: string): TextPart[] {
  if (!index.size) return [{ text }];
  const parts: TextPart[] = [];
  let at = 0;
  for (const l of extractFileLinks(text, cwd)) {
    const path = index.find(l.path);
    if (!path) continue;
    if (l.start > at) parts.push({ text: text.slice(at, l.start) });
    parts.push({ text: text.slice(l.start, l.end), ref: { path, line: l.line, col: l.col } });
    at = l.end;
  }
  if (!parts.length) return [{ text }];
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Paths an agent's own file-changing tool calls named, relative to the workspace. `session` limits it to one session's calls. */
export function toolFilePaths(items: ReadonlyArray<{ type: string; name?: string; arg?: string; session?: string }>, cwd?: string, session?: string): string[] {
  const out = new Set<string>();
  for (const it of items) {
    if (it.type !== "tool" || !it.arg || (session && it.session !== session) || !/write|edit|patch/i.test(it.name ?? "")) continue;
    const ref = parseFileRef(it.arg.trim(), cwd);
    if (ref) out.add(ref.path);
  }
  return [...out];
}

/* ------------------------------------------------------------------ remark */

/** The slice of an mdast node this plugin touches. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** The element a mention becomes; Markdown.tsx maps this tag to the clickable chip. */
export const FILE_LINK_TAG = "file-link";

function fileLinkNode(ref: FileRef, child: MdNode): MdNode {
  const props: Record<string, unknown> = { "data-path": ref.path };
  if (ref.line) props["data-line"] = String(ref.line);
  if (ref.col) props["data-col"] = String(ref.col);
  return { type: "fileLink", children: [child], data: { hName: FILE_LINK_TAG, hProperties: props } };
}

// Where a mention must stay what it is: existing links (and our own), headings' anchors read fine as links.
const SKIP = new Set(["link", "linkReference", "fileLink", "code", "definition", "html", "image"]);

function walk(node: MdNode, index: FileIndex, cwd: string | undefined): void {
  const kids = node.children;
  if (!kids) return;
  const next: MdNode[] = [];
  for (const kid of kids) {
    if (kid.type === "inlineCode" && kid.value !== undefined) {
      const ref = resolveFileRef(kid.value, index, cwd);
      next.push(ref ? fileLinkNode(ref, kid) : kid);
    } else if (kid.type === "text" && kid.value) {
      const parts = linkifyText(kid.value, index, cwd);
      if (parts.length === 1 && !("ref" in parts[0])) next.push(kid);
      else
        for (const p of parts) next.push("ref" in p ? fileLinkNode(p.ref, { type: "text", value: p.text }) : { type: "text", value: p.text });
    } else {
      if (!SKIP.has(kid.type)) walk(kid, index, cwd);
      next.push(kid);
    }
  }
  node.children = next;
}

/**
 * Remark plugin: inline code and plain text that name a real file become `<file-link>` elements. Fenced code
 * blocks and existing links are left alone (links to files are handled by the `a` renderer).
 */
export function remarkFileLinks(opts: { index: FileIndex; cwd?: string }) {
  return (tree: MdNode) => {
    if (opts.index.size) walk(tree, opts.index, opts.cwd);
  };
}
