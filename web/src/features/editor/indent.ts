/**
 * Indentation sniffing, so Tab inserts what the file already uses instead of imposing a style.
 * Looks at the leading whitespace of the first couple of hundred lines.
 */
export interface IndentStyle {
  /** What one level of indentation is: "\t" or N spaces. */
  unit: string;
  label: string;
}

export function detectIndent(text: string, sample = 300): IndentStyle {
  let tabs = 0;
  const diffs = new Map<number, number>();
  let prev = 0;
  let seen = 0;
  for (const line of text.split("\n", sample)) {
    if (!line.trim()) continue;
    const m = /^[ \t]*/.exec(line)![0];
    seen++;
    if (m.startsWith("\t")) {
      tabs++;
      continue;
    }
    const w = m.length;
    // A change in depth between neighbouring lines is one indentation level (or a few, for dedents).
    const d = Math.abs(w - prev);
    if (d >= 2 && d <= 8 && w > 0) diffs.set(d, (diffs.get(d) ?? 0) + 1);
    prev = w;
  }
  if (seen === 0) return { unit: "  ", label: "Spaces: 2" };
  if (tabs > seen / 3 && tabs >= (diffs.size ? Math.max(...diffs.values()) : 0)) return { unit: "\t", label: "Tabs" };
  let best = 2;
  let bestN = 0;
  for (const [d, n] of diffs) {
    // Prefer the smaller width on a tie: 4-space files also contain some 8-space jumps.
    if (n > bestN || (n === bestN && d < best)) {
      best = d;
      bestN = n;
    }
  }
  if (bestN === 0) return { unit: "  ", label: "Spaces: 2" };
  // A jump of 8 almost always means two levels of 4.
  if (best === 6) best = 2;
  return { unit: " ".repeat(best), label: `Spaces: ${best}` };
}
