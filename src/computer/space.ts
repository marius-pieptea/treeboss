/**
 * The coordinate space the computer_* tools speak in. The agent sees the main display as a screenshot that is
 * `COORD_LONG_EDGE` pixels on its long side, origin top left, and every x/y it sends refers to that image. The
 * daemon maps those coordinates back to the display's points, so the model never has to know about Retina
 * scaling or the real resolution.
 */
export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const COORD_LONG_EDGE = 1280;

/** The size of the screenshot the agent works in, for a display of the given size in points. */
export function coordSpace(display: Size): Size {
  const k = COORD_LONG_EDGE / Math.max(display.width, display.height);
  return { width: Math.round(display.width * k), height: Math.round(display.height * k) };
}

/** A point in the agent's coordinate space, as points on the display. */
export function toPoints(x: number, y: number, display: Size, space: Size): { x: number; y: number } {
  return { x: (x * display.width) / space.width, y: (y * display.height) / space.height };
}

/** A rectangle in the agent's coordinate space, as points on the display. */
export function rectToPoints(r: Rect, display: Size, space: Size): Rect {
  const p = toPoints(r.x, r.y, display, space);
  const q = toPoints(r.x + r.width, r.y + r.height, display, space);
  return { x: p.x, y: p.y, width: q.x - p.x, height: q.y - p.y };
}
