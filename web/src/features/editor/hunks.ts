/**
 * Unified-diff hunks (zero context) to gutter markers: which lines of the CURRENT file are added,
 * modified, or sit just below a deletion. Pure, so the mapping is testable without an editor.
 */
export type ChangeKind = "add" | "mod" | "del";
export interface ChangeMarker {
  /** 1-based line range in the new file, inclusive. For "del" both are the line the deletion sits above (0: top of file). */
  from: number;
  to: number;
  kind: ChangeKind;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function hunksToMarkers(diff: string): ChangeMarker[] {
  const out: ChangeMarker[] = [];
  for (const line of diff.split("\n")) {
    const m = HUNK.exec(line);
    if (!m) continue;
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (newCount === 0) {
      // Pure deletion: git reports the line AFTER which the lines were removed.
      out.push({ from: newStart, to: newStart, kind: "del" });
    } else if (oldCount === 0) {
      out.push({ from: newStart, to: newStart + newCount - 1, kind: "add" });
    } else {
      const common = Math.min(oldCount, newCount);
      out.push({ from: newStart, to: newStart + common - 1, kind: "mod" });
      if (newCount > oldCount) out.push({ from: newStart + common, to: newStart + newCount - 1, kind: "add" });
      else if (oldCount > newCount) out.push({ from: newStart + newCount - 1, to: newStart + newCount - 1, kind: "del" });
    }
  }
  return out;
}

/** An untracked file is entirely new. */
export function wholeFileAdded(lineCount: number): ChangeMarker[] {
  return lineCount > 0 ? [{ from: 1, to: lineCount, kind: "add" }] : [];
}
