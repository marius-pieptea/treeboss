/**
 * Keeps the middle column usable when both side panes are wide: the side panes give up room first, down to their
 * own minimums, so the editor and terminal never get squeezed to nothing and spill under the right panel.
 */

/** The narrowest the middle column may get. */
export const MIN_CENTER = 360;
/** Matches the Splitter bounds in Shell.tsx. */
export const LEFT_MIN = 200;
export const RIGHT_MIN = 320;
/** The activity bar's width (w-11 in ActivityBar.tsx). */
export const ACTIVITY_W = 44;

/**
 * The widths to render for the two side panes, given the row's measured width. A closed pane takes no room. Before
 * the row is measured (width 0) the stored widths are used unchanged.
 */
export function fitPanes(row: number, want: { leftW: number; rightW: number; leftOpen: boolean; rightOpen: boolean }): { left: number; right: number } {
  const left = want.leftOpen ? want.leftW : 0;
  const right = want.rightOpen ? want.rightW : 0;
  if (row <= 0 || left + right <= 0) return { left: want.leftW, right: want.rightW };
  const room = Math.max(0, row - ACTIVITY_W - MIN_CENTER);
  if (left + right <= room) return { left: want.leftW, right: want.rightW };
  // The left pane yields first, then the right; each stops at its minimum.
  const l = want.leftOpen ? Math.min(want.leftW, Math.max(LEFT_MIN, room - right)) : want.leftW;
  const r = want.rightOpen ? Math.min(want.rightW, Math.max(RIGHT_MIN, room - (want.leftOpen ? l : 0))) : want.rightW;
  return { left: l, right: r };
}

/**
 * The largest width a dragged splitter may reach, so the drag tracks the pointer instead of pushing a stored value
 * past what is shown. `other` is the width of the pane on the far side of the middle column.
 */
export function maxSideWidth(row: number, other: number, otherOpen: boolean): number {
  if (row <= 0) return Infinity;
  return Math.max(0, row - ACTIVITY_W - MIN_CENTER - (otherOpen ? other : 0));
}
