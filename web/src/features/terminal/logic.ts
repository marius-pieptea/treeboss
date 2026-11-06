/**
 * Pure logic for the terminal dock: colour themes, output link detection, in-buffer search, port filtering.
 * Kept free of React and xterm so it can be unit-tested without a DOM.
 */
import type { ListeningPort } from "@/lib/types";

/* ------------------------------------------------------------------ theme */

export interface TermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** The CSS custom properties the terminal theme is read from (resolved values, e.g. "#0e1115"). */
export type ThemeVars = Record<"--panel" | "--fg" | "--fg-muted" | "--fg-faint" | "--accent" | "--accent-fg" | "--green" | "--red" | "--amber" | "--blue" | "--violet" | "--raised" | "--active", string>;

export const THEME_VAR_NAMES = ["--panel", "--fg", "--fg-muted", "--fg-faint", "--accent", "--accent-fg", "--green", "--red", "--amber", "--blue", "--violet", "--raised", "--active"] as const;

/**
 * The ANSI palette is built from the app's own status colours, so `ls --color`, test runners and git
 * output sit in the same family as the rest of the UI. Bright variants are fixed per theme because
 * "lighten" on a light background would make text unreadable.
 */
export function buildTermTheme(v: ThemeVars, dark: boolean): TermTheme {
  const bright = dark
    ? { red: "#ff8f8f", green: "#7ef0a4", yellow: "#ffd466", blue: "#8cc2ff", magenta: "#c4b0ff", cyan: "#7fe6f3", white: "#f2f5f9", black: "#6b7686" }
    : { red: "#b91c1c", green: "#15803d", yellow: "#a16207", blue: "#1d4ed8", magenta: "#6d28d9", cyan: "#0e7490", white: "#0f172a", black: "#334155" };
  return {
    background: v["--panel"],
    foreground: v["--fg"],
    cursor: v["--accent"],
    cursorAccent: v["--accent-fg"],
    selectionBackground: dark ? "rgba(69, 212, 230, 0.28)" : "rgba(8, 145, 178, 0.25)",
    selectionInactiveBackground: dark ? "rgba(255, 255, 255, 0.12)" : "rgba(15, 23, 42, 0.14)",
    black: dark ? "#2a313b" : "#1c2330",
    red: v["--red"],
    green: v["--green"],
    yellow: v["--amber"],
    blue: v["--blue"],
    magenta: v["--violet"],
    cyan: v["--accent"],
    white: dark ? "#c3ccd8" : "#6b7686",
    brightBlack: bright.black,
    brightRed: bright.red,
    brightGreen: bright.green,
    brightYellow: bright.yellow,
    brightBlue: bright.blue,
    brightMagenta: bright.magenta,
    brightCyan: bright.cyan,
    brightWhite: bright.white,
  };
}

/* ------------------------------------------------------------- file links */

export interface FileLink {
  /** Zero-based [start, end) offsets into the line text. */
  start: number;
  end: number;
  path: string;
  line?: number;
  col?: number;
}

// A path is segments of safe filename characters; it must look like a file (an extension or a directory separator).
// `path:12:5`, `path:12`, and the compiler style `path(12,5)`.
const FILE_RE = /(?<![\w@~./:+-])((?:\.{1,2}\/|\/|~\/)?(?:[\w@+.-]+\/)*[\w@+-][\w@+.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?(?![\w/])/g;

/**
 * Find `path[:line[:col]]` references in one line of output. Skips URLs (`http://host/a.js:1`), version
 * numbers and timestamps. `cwd` (the terminal's working root, absolute) lets absolute paths inside it
 * become workspace-relative; absolute paths outside it and `..` escapes are dropped.
 */
export function extractFileLinks(text: string, cwd?: string): FileLink[] {
  const out: FileLink[] = [];
  FILE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_RE.exec(text))) {
    const start = m.index;
    const full = m[0];
    // A scheme right before ("https://…", "file://…") means this is part of a URL.
    if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/$/.test(text.slice(Math.max(0, start - 12), start))) continue;
    if (text[start - 1] === "/" && text.slice(Math.max(0, start - 3), start) === "://") continue;
    let path = m[1];
    if (path.startsWith("~/")) continue;
    if (path.startsWith("/")) {
      if (!cwd) continue;
      const root = cwd.replace(/\/+$/, "") + "/";
      if (!path.startsWith(root)) continue;
      path = path.slice(root.length);
    }
    path = path.replace(/^(\.\/)+/, "");
    if (path.startsWith("../") || path.includes("/../")) continue;
    if (!path || /^\d+(\.\d+)+$/.test(path)) continue; // "1.2.3"
    const line = m[2] ? Number(m[2]) : m[4] ? Number(m[4]) : undefined;
    const col = m[3] ? Number(m[3]) : m[5] ? Number(m[5]) : undefined;
    out.push({ start, end: start + full.length, path, line, col });
  }
  return out;
}

/* ------------------------------------------------------------------ search */

export interface BufferMatch {
  row: number;
  col: number;
  len: number;
}

/** Find `query` in terminal buffer rows (one string per row). Matches never span rows. */
export function findInRows(rows: string[], query: string, caseSensitive = false): BufferMatch[] {
  if (!query) return [];
  const q = caseSensitive ? query : query.toLowerCase();
  const out: BufferMatch[] = [];
  rows.forEach((raw, row) => {
    const hay = caseSensitive ? raw : raw.toLowerCase();
    let at = hay.indexOf(q);
    while (at !== -1) {
      out.push({ row, col: at, len: q.length });
      at = hay.indexOf(q, at + Math.max(1, q.length));
    }
  });
  return out;
}

/* ------------------------------------------------------------------- ports */

function inside(dir: string | null, root: string): boolean {
  if (!dir) return false;
  // Windows paths: compare with forward slashes, case-insensitively.
  const norm = (x: string) => (/^[a-z]:[\\/]/i.test(x) ? x.replace(/\\/g, "/").toLowerCase() : x);
  const r = norm(root).replace(/\/+$/, "");
  const d = norm(dir);
  return d === r || d.startsWith(r + "/");
}

/**
 * Dev servers worth showing: the ones running inside the workspace (or all, on request), never the
 * daemon's own port, one entry per port.
 */
export function portsForWorkspace(ports: ListeningPort[], workspacePath: string, opts: { all?: boolean; ownPort?: number } = {}): ListeningPort[] {
  const seen = new Set<number>();
  const out: ListeningPort[] = [];
  for (const p of ports) {
    if (opts.ownPort && p.port === opts.ownPort) continue;
    if (!opts.all && !inside(p.cwd, workspacePath)) continue;
    if (seen.has(p.port)) continue;
    seen.add(p.port);
    out.push(p);
  }
  return out.sort((a, b) => a.port - b.port);
}

/** Ports present now that were not before: what a "new dev server" toast is about. */
export function newPorts(before: Set<number>, now: ListeningPort[]): ListeningPort[] {
  return now.filter((p) => !before.has(p.port));
}

/** How a terminal tab labels where its shell lives. */
export function rootLabel(rootRef: string, workspaceRoot: string, heads: Array<{ id: string; role: string | null; engine: string }>): string | null {
  if (rootRef === workspaceRoot) return null;
  const h = heads.find((x) => x.id === rootRef);
  return h ? (h.role ?? h.engine) : rootRef.slice(0, 8);
}

export const MIN_FONT = 10;
export const MAX_FONT = 22;
export const clampFont = (n: number) => Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(n)));
