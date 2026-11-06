import { describe, expect, test } from "bun:test";
import { ACTIVITY_W, LEFT_MIN, MIN_CENTER, RIGHT_MIN, fitPanes, maxSideWidth } from "../web/src/shell/pane-fit";

const open = { leftOpen: true, rightOpen: true };

describe("fitPanes", () => {
  test("keeps the stored widths when the middle column has room", () => {
    expect(fitPanes(1600, { leftW: 280, rightW: 440, ...open })).toEqual({ left: 280, right: 440 });
  });

  test("keeps the stored widths before the row has been measured", () => {
    expect(fitPanes(0, { leftW: 560, rightW: 760, ...open })).toEqual({ left: 560, right: 760 });
  });

  test("the left pane yields first when both are wide", () => {
    const row = 1100;
    const room = row - ACTIVITY_W - MIN_CENTER;
    const { left, right } = fitPanes(row, { leftW: 560, rightW: 440, ...open });
    expect(right).toBe(440);
    expect(left).toBe(room - 440);
    expect(left + right + ACTIVITY_W + MIN_CENTER).toBe(row);
  });

  test("the right pane yields once the left is at its minimum", () => {
    const row = 1200;
    const { left, right } = fitPanes(row, { leftW: 560, rightW: 760, ...open });
    expect(left).toBe(LEFT_MIN);
    expect(right).toBe(row - ACTIVITY_W - MIN_CENTER - LEFT_MIN);
  });

  test("panes never go below their minimums, even when the window is too small for all three", () => {
    const { left, right } = fitPanes(400, { leftW: 560, rightW: 760, ...open });
    expect(left).toBe(LEFT_MIN);
    expect(right).toBe(RIGHT_MIN);
  });

  test("a closed pane takes no room, so the open one keeps more of it", () => {
    expect(fitPanes(1000, { leftW: 560, rightW: 760, leftOpen: false, rightOpen: true })).toEqual({ left: 560, right: 596 });
    expect(fitPanes(1000, { leftW: 560, rightW: 760, leftOpen: true, rightOpen: false })).toEqual({ left: 560, right: 760 });
  });
});

describe("maxSideWidth", () => {
  test("a dragged splitter stops where the other pane's room runs out", () => {
    expect(maxSideWidth(1000, 440, true)).toBe(1000 - ACTIVITY_W - MIN_CENTER - 440);
  });

  test("ignores the other pane when it is closed", () => {
    expect(maxSideWidth(1000, 440, false)).toBe(1000 - ACTIVITY_W - MIN_CENTER);
  });

  test("is unbounded before the row is measured", () => {
    expect(maxSideWidth(0, 440, true)).toBe(Infinity);
  });
});
