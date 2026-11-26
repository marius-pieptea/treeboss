import type { ArtifactBoard, CanvasNote } from "./format";

export type View = {
  x: number;
  y: number;
  zoom: number;
};

export interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export type PositionedBoard<T extends Pick<ArtifactBoard, "x" | "y" | "w" | "h"> = ArtifactBoard> = T & {
  x: number;
  y: number;
  w: number;
  h: number;
};

export function hasBoardGeometry<T extends Pick<ArtifactBoard, "x" | "y" | "w" | "h">>(
  board: T,
): board is PositionedBoard<T> {
  return (
    typeof board.x === "number" &&
    Number.isFinite(board.x) &&
    typeof board.y === "number" &&
    Number.isFinite(board.y) &&
    typeof board.w === "number" &&
    Number.isFinite(board.w) &&
    board.w > 0 &&
    typeof board.h === "number" &&
    Number.isFinite(board.h) &&
    board.h > 0
  );
}

/** Bounding box in board coordinates covering all positioned boards and notes. */
export function boundsOf(
  boards: readonly Pick<ArtifactBoard, "x" | "y" | "w" | "h">[],
  notes: readonly Pick<CanvasNote, "x" | "y" | "w" | "maxW" | "kind">[] = [],
): CanvasBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const b of boards) {
    if (!hasBoardGeometry(b)) continue;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }

  for (const n of notes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    const rawW = n.kind === "title1" ? (n.maxW ?? n.w ?? 0) : (n.w ?? n.maxW ?? 0);
    const width = Number.isFinite(rawW) && rawW > 0 ? rawW : 0;
    const height = n.kind === "title1" ? 64 : 120;
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + width > maxX) maxX = n.x + width;
    if (n.y + height > maxY) maxY = n.y + height;
  }

  if (!Number.isFinite(minX)) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** Compute a centered view that fits `bounds` inside `(viewportW, viewportH)` with `padding`, capped at `maxZoom`. */
export function fitView(
  bounds: CanvasBounds | null,
  viewportW: number,
  viewportH: number,
  padding = 48,
  maxZoom = 1,
): View {
  if (!bounds || viewportW <= 0 || viewportH <= 0) {
    return { x: 0, y: 0, zoom: Math.min(1, maxZoom) };
  }
  const availW = Math.max(1, viewportW - padding * 2);
  const availH = Math.max(1, viewportH - padding * 2);
  const scaleX = bounds.width > 0 ? availW / bounds.width : maxZoom;
  const scaleY = bounds.height > 0 ? availH / bounds.height : maxZoom;
  const zoom = Math.max(0.001, Math.min(maxZoom, scaleX, scaleY));
  const cx = bounds.minX + bounds.width / 2;
  const cy = bounds.minY + bounds.height / 2;
  return {
    x: viewportW / 2 - cx * zoom,
    y: viewportH / 2 - cy * zoom,
    zoom,
  };
}

/** Zoom by `factor` keeping `(screenX, screenY)` fixed in board coordinates, clamped to `[min, max]`. */
export function zoomAt(
  view: View,
  screenX: number,
  screenY: number,
  factor: number,
  min = 0.05,
  max = 4,
): View {
  const nextZoom = Math.min(max, Math.max(min, view.zoom * factor));
  if (nextZoom === view.zoom) return view;
  const boardX = (screenX - view.x) / view.zoom;
  const boardY = (screenY - view.y) / view.zoom;
  return {
    x: screenX - boardX * nextZoom,
    y: screenY - boardY * nextZoom,
    zoom: nextZoom,
  };
}

/** Filter positioned boards intersecting the viewport expanded by `marginPx` on each side. */
export function visibleBoards<T extends Pick<ArtifactBoard, "x" | "y" | "w" | "h">>(
  boards: readonly T[],
  view: View,
  viewportW: number,
  viewportH: number,
  marginPx = 0,
): PositionedBoard<T>[] {
  if (viewportW <= 0 || viewportH <= 0) return [];
  const minScreenX = -marginPx;
  const minScreenY = -marginPx;
  const maxScreenX = viewportW + marginPx;
  const maxScreenY = viewportH + marginPx;

  const out: PositionedBoard<T>[] = [];
  for (const b of boards) {
    if (!hasBoardGeometry(b)) continue;
    const left = b.x * view.zoom + view.x;
    const top = b.y * view.zoom + view.y;
    const right = (b.x + b.w) * view.zoom + view.x;
    const bottom = (b.y + b.h) * view.zoom + view.y;
    if (right > minScreenX && left < maxScreenX && bottom > minScreenY && top < maxScreenY) {
      out.push(b);
    }
  }
  return out;
}
