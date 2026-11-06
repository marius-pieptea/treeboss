/** Taking the screenshot for a bug report: the desktop app can capture the live pane; a plain browser cannot, so the daemon re-renders the page. */

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Shot = { kind: "desktop"; png: string } | { kind: "rerender"; viewport: { width: number; height: number } };

export interface DesktopBridge {
  capturePreview?: (rect: Rect) => Promise<string | null>;
}

export const desktopBridge = (): DesktopBridge | null => (typeof window === "undefined" ? null : ((window as unknown as { treebossDesktop?: DesktopBridge }).treebossDesktop ?? null));

export const canCaptureLive = (bridge: DesktopBridge | null = desktopBridge()): boolean => typeof bridge?.capturePreview === "function";

/**
 * The visible part of the frame, in the window's CSS pixels. `frame` comes from getBoundingClientRect, which already
 * includes the zoom transform. It is clipped to `pane` (the scroll area it sits in) minus `header`, a strip across the
 * top of the pane that something else covers. Null when nothing of the frame is visible.
 */
export function previewRect(frame: RectLike, opts: { pane?: RectLike; header?: number } = {}): Rect | null {
  const pane = opts.pane ?? frame;
  const x0 = Math.max(frame.left, pane.left);
  const y0 = Math.max(frame.top, pane.top + (opts.header ?? 0));
  const x1 = Math.min(frame.left + frame.width, pane.left + pane.width);
  const y1 = Math.min(frame.top + frame.height, pane.top + pane.height);
  if (!(x1 - x0 >= 1) || !(y1 - y0 >= 1)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface FrameLike {
  getBoundingClientRect(): RectLike;
  clientWidth: number;
  clientHeight: number;
}

/** The live pixels when the desktop bridge gives them, else the size to re-render the page at (the frame's own, not the zoomed one). */
export async function takeShot(iframe: FrameLike, opts: { pane?: RectLike; header?: number; bridge?: DesktopBridge | null } = {}): Promise<Shot> {
  const bridge = opts.bridge === undefined ? desktopBridge() : opts.bridge;
  const viewport = { width: Math.round(iframe.clientWidth), height: Math.round(iframe.clientHeight) };
  const rect = canCaptureLive(bridge) ? previewRect(iframe.getBoundingClientRect(), opts) : null;
  if (rect) {
    try {
      const png = await bridge!.capturePreview!(rect);
      if (typeof png === "string" && png) return { kind: "desktop", png };
    } catch {
      // Falls through to the re-render.
    }
  }
  return { kind: "rerender", viewport };
}
