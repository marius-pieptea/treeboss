/** Search-panel logic with no React: pattern building, highlighting spans, grouping and flattening results. */
import type { GrepMatch } from "@/lib/types";

export interface Flags {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** The include box: "src/**, *.ts ,, src/**" -> "src/**,*.ts". Order kept, blanks and repeats dropped. */
export function normalizeInclude(input: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const g = raw.trim();
    if (!g || seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  return out.join(",");
}

export const folderToGlob = (dir: string): string => (dir ? `${dir.replace(/\/+$/, "")}/**` : "");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A global RegExp equal to what the server searched for, to find the spans to highlight. null when the pattern is invalid. */
export function buildMatcher(query: string, f: Flags): RegExp | null {
  if (!query) return null;
  try {
    const src = f.regex ? query : escapeRe(query);
    return new RegExp(f.wholeWord ? `\\b(?:${src})\\b` : src, f.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

export function regexError(query: string, f: Flags): string | null {
  if (!f.regex || !query) return null;
  try {
    new RegExp(query);
    return null;
  } catch (e: any) {
    return String(e?.message ?? "Invalid regular expression").replace(/^Invalid regular expression: /, "");
  }
}

/** [start, end) of every match in a line. Zero-width matches are skipped so a pattern like `a*` cannot loop forever. */
export function findSpans(text: string, re: RegExp | null, max = 24): Array<[number, number]> {
  if (!re) return [];
  const out: Array<[number, number]> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < max) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/**
 * Shorten a long line around its first match so the match is visible: drop leading indentation, and cut with
 * ellipses when the match would otherwise be off the end. Spans are returned relative to the shortened text.
 */
export function excerpt(text: string, spans: Array<[number, number]>, max = 130): { text: string; spans: Array<[number, number]> } {
  const lead = text.length - text.trimStart().length;
  let start = lead;
  let body = text.slice(start);
  let shifted = spans.map(([a, b]) => [a - start, b - start] as [number, number]).filter(([, b]) => b > 0);
  if (shifted.length && shifted[0][0] > max - 40) {
    // Keep ~30 characters of lead-in before the first match.
    const cut = shifted[0][0] - 30;
    body = `…${body.slice(cut)}`;
    shifted = shifted.map(([a, b]) => [a - cut + 1, b - cut + 1] as [number, number]);
    start += cut;
  }
  if (body.length > max) body = `${body.slice(0, max)}…`;
  return { text: body, spans: shifted.filter(([a]) => a < body.length).map(([a, b]) => [Math.max(a, 0), Math.min(b, body.length)] as [number, number]) };
}

export interface FileGroup {
  path: string;
  matches: GrepMatch[];
}

export function groupMatches(matches: readonly GrepMatch[]): FileGroup[] {
  const by = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const list = by.get(m.path);
    if (list) list.push(m);
    else by.set(m.path, [m]);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, ms]) => ({ path, matches: ms.sort((x, y) => x.line - y.line || x.column - y.column) }));
}

export type ResultRow = { kind: "file"; path: string; count: number; collapsed: boolean } | { kind: "match"; path: string; match: GrepMatch };

export function flattenResults(groups: readonly FileGroup[], collapsed: ReadonlySet<string>): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const g of groups) {
    const c = collapsed.has(g.path);
    rows.push({ kind: "file", path: g.path, count: g.matches.length, collapsed: c });
    if (!c) for (const match of g.matches) rows.push({ kind: "match", path: g.path, match });
  }
  return rows;
}
