/**
 * Unified diff: parse what `git diff` prints, align it for side-by-side, mark word-level changes, and build
 * patches for a single hunk or a selection of lines (to stage, unstage or discard part of a file).
 *
 * Pure and dependency-free so it can be unit-tested against real `git apply`. Line text keeps its trailing
 * `\r`: a CRLF file's patch must carry the carriage returns or git will refuse to apply it.
 */

export type LineType = "ctx" | "add" | "del";

export interface DiffLine {
  /** `${hunkIndex}:${lineIndex}`: stable within one parsed diff, used to select lines. */
  id: string;
  type: LineType;
  oldNo: number | null;
  newNo: number | null;
  /** Text without the leading +/-/space marker, including any trailing "\r". */
  text: string;
  /** This line has no newline at end of file (the "\ No newline at end of file" marker followed it). */
  noNewline?: boolean;
}

export interface DiffHunk {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The function/section text after the second `@@`. */
  section: string;
  lines: DiffLine[];
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface DiffFile {
  /** Position in the diff, for keys. */
  index: number;
  oldPath: string | null;
  newPath: string | null;
  /** The path to show and to act on: the new path, or the old one for a deletion. */
  path: string;
  status: FileStatus;
  binary: boolean;
  /** `100644` etc., when a mode line was present. */
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** Raw header lines (`diff --git` through `+++`), reused verbatim when building patches. */
  header: string[];
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Undo git's C-style quoting of unusual paths (`"a\tb"`, octal UTF-8 bytes). */
export function unquotePath(raw: string): string {
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...enc.encode(ch));
      continue;
    }
    const next = body[++i];
    if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && body[i + 1] >= "0" && body[i + 1] <= "7") oct += body[++i];
      bytes.push(parseInt(oct, 8));
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(map[next] ?? next.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** `a/x b/x` → x, even when the path contains spaces (the two halves must match unless it is a rename). */
function pathsFromDiffGit(rest: string): { a: string; b: string } {
  if (rest.startsWith('"')) {
    // Quoted: `"a/p" "b/q"` or `"a/p" b/q`.
    const m = /^("(?:[^"\\]|\\.)*")\s+(.*)$/.exec(rest);
    if (m) return { a: unquotePath(m[1]).replace(/^a\//, ""), b: unquotePath(m[2]).replace(/^b\//, "") };
  }
  for (let i = 3; i < rest.length - 2; i++) {
    if (rest[i] !== " ") continue;
    const left = rest.slice(0, i);
    const right = rest.slice(i + 1);
    if (left.startsWith("a/") && right.startsWith("b/") && left.slice(2) === right.slice(2)) return { a: left.slice(2), b: right.slice(2) };
  }
  const k = rest.indexOf(" b/");
  if (k > 0) return { a: unquotePath(rest.slice(0, k)).replace(/^a\//, ""), b: unquotePath(rest.slice(k + 1)).replace(/^b\//, "") };
  return { a: rest, b: rest };
}

function stripTab(p: string): string {
  // Git appends a tab to ---/+++ names that contain spaces.
  const t = p.indexOf("\t");
  return t === -1 ? p : p.slice(0, t);
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!text) return files;
  const lines = text.split("\n");
  // A diff that ends with "\n" produces a final empty element: it is not a context line.
  if (lines[lines.length - 1] === "") lines.pop();

  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHeader = false;

  const startFile = (rest: string) => {
    const p = pathsFromDiffGit(rest);
    file = { index: files.length, oldPath: p.a, newPath: p.b, path: p.b, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [], header: [] };
    files.push(file);
    hunk = null;
    inHeader = true;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      startFile(line.slice("diff --git ".length));
      file!.header.push(line);
      continue;
    }
    if (!file) continue;
    const f: DiffFile = file;

    if (inHeader) {
      f.header.push(line);
      if (line.startsWith("new file mode ")) {
        f.status = "added";
        f.newMode = line.slice(14);
        f.oldPath = null;
      } else if (line.startsWith("deleted file mode ")) {
        f.status = "deleted";
        f.oldMode = line.slice(18);
        f.newPath = null;
        f.path = f.oldPath ?? f.path;
      } else if (line.startsWith("old mode ")) f.oldMode = line.slice(9);
      else if (line.startsWith("new mode ")) f.newMode = line.slice(9);
      else if (line.startsWith("similarity index ")) f.similarity = parseInt(line.slice(17), 10);
      else if (line.startsWith("rename from ")) {
        f.status = "renamed";
        f.oldPath = unquotePath(line.slice(12));
      } else if (line.startsWith("rename to ")) {
        f.status = "renamed";
        f.newPath = unquotePath(line.slice(10));
        f.path = f.newPath;
      } else if (line.startsWith("copy from ")) {
        f.status = "copied";
        f.oldPath = unquotePath(line.slice(10));
      } else if (line.startsWith("copy to ")) {
        f.status = "copied";
        f.newPath = unquotePath(line.slice(8));
        f.path = f.newPath;
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) f.binary = true;
      else if (line.startsWith("--- ")) {
        const p = stripTab(line.slice(4));
        if (p === "/dev/null") f.oldPath = null;
        else f.oldPath = unquotePath(p).replace(/^a\//, "");
      } else if (line.startsWith("+++ ")) {
        const p = stripTab(line.slice(4));
        if (p === "/dev/null") f.newPath = null;
        else {
          f.newPath = unquotePath(p).replace(/^b\//, "");
          if (f.status !== "deleted") f.path = f.newPath;
        }
        inHeader = false; // hunks follow
      } else if (line.startsWith("@@")) {
        // No ---/+++ pair (shouldn't happen); fall through to the hunk branch below.
        f.header.pop();
        inHeader = false;
      } else continue;
      if (inHeader || !line.startsWith("@@")) continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = { index: f.hunks.length, oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], section: m[5] ?? "", lines: [] };
      f.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    const h: DiffHunk = hunk;
    const marker = line[0];
    const body = line.slice(1);
    const id = `${h.index}:${h.lines.length}`;
    if (marker === "+") {
      h.lines.push({ id, type: "add", oldNo: null, newNo: newNo++, text: body });
      f.additions++;
    } else if (marker === "-") {
      h.lines.push({ id, type: "del", oldNo: oldNo++, newNo: null, text: body });
      f.deletions++;
    } else if (marker === " ") {
      h.lines.push({ id, type: "ctx", oldNo: oldNo++, newNo: newNo++, text: body });
    } else if (marker === "\\") {
      const prev = h.lines[h.lines.length - 1];
      if (prev) prev.noNewline = true;
    } else if (line === "") {
      // An empty context line whose leading space was trimmed by a tool.
      h.lines.push({ id, type: "ctx", oldNo: oldNo++, newNo: newNo++, text: "" });
    }
  }
  return files;
}

/* -------------------------------------------------------------------------- */
/* Patches                                                                    */
/* -------------------------------------------------------------------------- */

const MARK: Record<LineType, string> = { ctx: " ", add: "+", del: "-" };

function hunkHeader(oldStart: number, oldCount: number, newStart: number, newCount: number, section: string): string {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${section ? ` ${section}` : ""}`;
}

function serialize(file: DiffFile, hunkBlocks: string[]): string {
  return [...file.header, ...hunkBlocks].join("\n") + "\n";
}

function hunkBlock(h: DiffHunk): string {
  const out = [hunkHeader(h.oldStart, h.oldLines, h.newStart, h.newLines, h.section)];
  for (const l of h.lines) {
    out.push(MARK[l.type] + l.text);
    if (l.noNewline) out.push("\\ No newline at end of file");
  }
  return out.join("\n");
}

/** A patch of exactly one hunk, as printed. Apply forward to stage it, with `-R` to unstage or discard it. */
export function buildHunkPatch(file: DiffFile, hunkIndex: number): string {
  const h = file.hunks[hunkIndex];
  if (!h) throw new Error(`No hunk ${hunkIndex}`);
  return serialize(file, [hunkBlock(h)]);
}

/**
 * A patch of only the selected lines of one hunk.
 *
 * `forward`: the patch will be applied as-is (stage lines from a working-tree diff). Unselected additions
 * never reach the target, so they are dropped; unselected deletions stay in the target, so they become context.
 * `reverse`: the patch will be applied with `-R` (unstage lines from a staged diff, or discard lines from
 * the working tree). The target already has the new side, so unselected additions are context and
 * unselected deletions (already gone) are dropped.
 *
 * Returns null when nothing in the selection actually changes anything.
 */
export function buildLinesPatch(file: DiffFile, hunkIndex: number, selected: ReadonlySet<string>, direction: "forward" | "reverse" = "forward"): string | null {
  const h = file.hunks[hunkIndex];
  if (!h) throw new Error(`No hunk ${hunkIndex}`);
  const body: Array<{ marker: string; text: string; noNewline?: boolean }> = [];
  let changes = 0;
  for (const l of h.lines) {
    if (l.type === "ctx") {
      body.push({ marker: " ", text: l.text, noNewline: l.noNewline });
      continue;
    }
    const sel = selected.has(l.id);
    if (sel) {
      body.push({ marker: MARK[l.type], text: l.text, noNewline: l.noNewline });
      changes++;
    } else if (direction === "forward") {
      if (l.type === "del") body.push({ marker: " ", text: l.text, noNewline: l.noNewline });
      // an unselected add is simply absent
    } else {
      if (l.type === "add") body.push({ marker: " ", text: l.text, noNewline: l.noNewline });
      // an unselected del is already gone from the target
    }
  }
  if (changes === 0) return null;
  const oldCount = body.filter((b) => b.marker !== "+").length;
  const newCount = body.filter((b) => b.marker !== "-").length;
  // The start that matters is the target's: the old side going forward, the new side going in reverse.
  const start = direction === "forward" ? h.oldStart : h.newStart;
  const out = [hunkHeader(start, oldCount, start, newCount, h.section)];
  for (const b of body) {
    out.push(b.marker + b.text);
    if (b.noNewline) out.push("\\ No newline at end of file");
  }
  return serialize(file, [out.join("\n")]);
}

/** Every line id of a hunk that is an addition or deletion. */
export function changedLineIds(h: DiffHunk): string[] {
  return h.lines.filter((l) => l.type !== "ctx").map((l) => l.id);
}

/* -------------------------------------------------------------------------- */
/* Side-by-side alignment                                                     */
/* -------------------------------------------------------------------------- */

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pair each run of deletions with the run of additions that follows it; context appears on both sides. */
export function alignSplit(h: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = h.lines;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === "ctx") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Word-level highlights                                                      */
/* -------------------------------------------------------------------------- */

export type Range = [start: number, end: number];

const TOKEN_RE = /\s+|\w+|[^\w\s]/g;

function tokenize(s: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  for (const m of s.matchAll(TOKEN_RE)) out.push({ text: m[0], start: m.index! });
  return out;
}

/**
 * The changed spans of two similar lines, as character ranges in each. Token-level LCS; very long lines fall
 * back to common prefix/suffix so a minified file cannot stall the UI.
 */
export function wordDiff(a: string, b: string): { a: Range[]; b: Range[] } {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const keepA = new Array(ta.length).fill(false);
  const keepB = new Array(tb.length).fill(false);

  let lo = 0;
  while (lo < ta.length && lo < tb.length && ta[lo].text === tb[lo].text) {
    keepA[lo] = keepB[lo] = true;
    lo++;
  }
  let ha = ta.length - 1;
  let hb = tb.length - 1;
  while (ha >= lo && hb >= lo && ta[ha].text === tb[hb].text) {
    keepA[ha] = keepB[hb] = true;
    ha--;
    hb--;
  }
  const n = ha - lo + 1;
  const m = hb - lo + 1;
  if (n > 0 && m > 0 && n * m <= 40_000) {
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[lo + i].text === tb[lo + j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ta[lo + i].text === tb[lo + j].text) {
        keepA[lo + i] = keepB[lo + j] = true;
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
  }
  const ranges = (tokens: typeof ta, keep: boolean[]): Range[] => {
    const out: Range[] = [];
    tokens.forEach((t, i) => {
      if (keep[i] || /^\s+$/.test(t.text)) return;
      const end = t.start + t.text.length;
      const last = out[out.length - 1];
      if (last && last[1] >= t.start - 1) last[1] = end;
      else out.push([t.start, end]);
    });
    return out;
  };
  return { a: ranges(ta, keepA), b: ranges(tb, keepB) };
}

/**
 * For every deletion/addition run in a hunk, pair them up and compute word ranges. Keyed by line id. Lines
 * that are too different (little in common) get none, so a rewritten line is not a confetti of highlights.
 */
export function intraLineRanges(h: DiffHunk): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  const lines = h.lines;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "ctx") {
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const a = dels[k].text.replace(/\r$/, "");
      const b = adds[k].text.replace(/\r$/, "");
      if (!a.trim() || !b.trim() || a.length > 600 || b.length > 600) continue;
      const w = wordDiff(a, b);
      const changed = (rs: Range[]) => rs.reduce((s, r) => s + r[1] - r[0], 0);
      // If nearly everything changed, whole-line colour already says so.
      if (changed(w.a) > a.length * 0.8 && changed(w.b) > b.length * 0.8) continue;
      if (w.a.length) out.set(dels[k].id, w.a);
      if (w.b.length) out.set(adds[k].id, w.b);
    }
  }
  return out;
}

/** Number of hunks across files, for "n changes" labels. */
export function countHunks(files: DiffFile[]): number {
  return files.reduce((s, f) => s + f.hunks.length, 0);
}
