import { describe, expect, test } from "bun:test";
import { previewRect, takeShot, type FrameLike } from "../../web/src/features/browser/capture";

const r = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
const png = "iVBORw0KGgo=";

describe("previewRect", () => {
  test("a frame fully inside the pane is its own rect", () => {
    expect(previewRect(r(100, 80, 400, 300), { pane: r(0, 40, 900, 700) })).toEqual({ x: 100, y: 80, width: 400, height: 300 });
  });

  test("a zoomed frame arrives already scaled and is not scaled again", () => {
    const zoomed = r(100, 80, 400 * 0.5, 300 * 0.5);
    expect(previewRect(zoomed, { pane: r(0, 40, 900, 700) })).toEqual({ x: 100, y: 80, width: 200, height: 150 });
  });

  test("a responsive frame as wide as the pane stays inside the pane", () => {
    expect(previewRect(r(16, 74, 868, 600), { pane: r(0, 40, 900, 700) })).toEqual({ x: 16, y: 74, width: 868, height: 600 });
  });

  test("clips to the pane on every side", () => {
    expect(previewRect(r(-50, 20, 1000, 900), { pane: r(0, 40, 900, 700) })).toEqual({ x: 0, y: 40, width: 900, height: 700 });
  });

  test("leaves out a header strip that covers the top of the pane", () => {
    expect(previewRect(r(0, 40, 400, 300), { pane: r(0, 40, 900, 700), header: 34 })).toEqual({ x: 0, y: 74, width: 400, height: 266 });
  });

  test("is null when nothing is visible", () => {
    expect(previewRect(r(0, 800, 400, 300), { pane: r(0, 40, 900, 700) })).toBeNull();
    expect(previewRect(r(0, 40, 400, 20), { pane: r(0, 40, 900, 700), header: 34 })).toBeNull();
    expect(previewRect(r(0, 0, 0, 0))).toBeNull();
  });
});

const frame = (over: Partial<FrameLike> = {}): FrameLike => ({ getBoundingClientRect: () => r(100, 80, 200, 150), clientWidth: 400, clientHeight: 300, ...over });

describe("takeShot", () => {
  test("uses the desktop bridge's png and passes the clipped rect", async () => {
    let seen: unknown;
    const s = await takeShot(frame(), { bridge: { capturePreview: async (rect) => ((seen = rect), png) } });
    expect(s).toEqual({ kind: "desktop", png });
    expect(seen).toEqual({ x: 100, y: 80, width: 200, height: 150 });
  });

  test("re-renders at the frame's own size, not the zoomed one, when there is no bridge", async () => {
    expect(await takeShot(frame(), { bridge: null })).toEqual({ kind: "rerender", viewport: { width: 400, height: 300 } });
    expect(await takeShot(frame(), { bridge: {} })).toEqual({ kind: "rerender", viewport: { width: 400, height: 300 } });
  });

  test("re-renders when the bridge returns null, an empty string, or throws", async () => {
    for (const capturePreview of [async () => null, async () => "", async () => Promise.reject(new Error("x"))]) {
      expect((await takeShot(frame(), { bridge: { capturePreview } })).kind).toBe("rerender");
    }
  });

  test("re-renders without asking the bridge when none of the frame is visible", async () => {
    let called = false;
    const s = await takeShot(frame(), { pane: r(0, 800, 10, 10), bridge: { capturePreview: async () => ((called = true), png) } });
    expect(called).toBe(false);
    expect(s.kind).toBe("rerender");
  });
});
