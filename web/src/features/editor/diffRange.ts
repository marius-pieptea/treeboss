/**
 * Which lines of `next` differ from `prev`, found by trimming the common prefix and suffix. Not a real
 * diff (a move shows as changed) but exactly what is needed to flash "this is what just changed on disk".
 */
export function changedLineRange(prev: string, next: string): { from: number; to: number } | null {
  if (prev === next) return null;
  const a = prev.split("\n");
  const b = next.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  // `next` only lost lines: point at where they were.
  if (endB < start) return { from: Math.min(start + 1, b.length), to: Math.min(start + 1, b.length) };
  return { from: start + 1, to: endB + 1 };
}
