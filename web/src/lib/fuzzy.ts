/**
 * Fuzzy file matching for quick-open: every query character must appear in order. Scores favour
 * matches in the file name over the directory, consecutive runs, and the start of path segments or words.
 */
export interface FuzzyMatch {
  path: string;
  score: number;
  /** Indices into `path` that matched, for highlighting. */
  indices: number[];
}

const SEP = /[/\\._\-\s]/;

/** Whether q[from..] is a subsequence of t[start..]. */
function restMatches(q: string, from: number, t: string, start: number): boolean {
  let ti = start;
  for (let qi = from; qi < q.length; qi++) {
    const at = t.indexOf(q[qi], ti);
    if (at === -1) return false;
    ti = at + 1;
  }
  return true;
}

export function fuzzyScore(query: string, text: string): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const baseStart = text.lastIndexOf("/") + 1;
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    // Prefer a match at a word boundary within reach, else the next occurrence.
    for (let i = ti; i < t.length; i++) {
      if (t[i] !== ch) continue;
      if (found === -1) found = i;
      if (i === 0 || SEP.test(text[i - 1]) || (text[i] !== t[i] && text[i - 1] === t[i - 1])) {
        // Prefer a word boundary, but only when the rest of the query can still be matched after it:
        // "math" in "src/utils/math.ts" must not jump its `t` to the `.ts` and strand the `h`.
        if (i - ti <= 24 && restMatches(q, qi + 1, t, i + 1)) found = i;
        break;
      }
    }
    if (found === -1) return null;
    indices.push(found);
    score += 1;
    if (found === prev + 1) score += 4; // consecutive
    if (found === 0 || SEP.test(text[found - 1])) score += 5; // word start
    if (found >= baseStart) score += 2; // in the file name
    score -= Math.min(found - ti, 12) * 0.15; // gap penalty
    prev = found;
    ti = found + 1;
  }
  if (t.slice(baseStart).startsWith(q)) score += 12;
  else if (t.slice(baseStart).includes(q)) score += 6;
  score -= text.length * 0.01; // shorter paths win ties
  return { score, indices };
}

export function fuzzyFilter(query: string, paths: string[], limit = 60): FuzzyMatch[] {
  if (!query) return paths.slice(0, limit).map((path) => ({ path, score: 0, indices: [] }));
  const out: FuzzyMatch[] = [];
  for (const path of paths) {
    const m = fuzzyScore(query, path);
    if (m) out.push({ path, ...m });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}
