import { describe, expect, test } from "bun:test";
import { classifyGesture, formatBytes, keyFromEvent, progressOf, queueLive, rotateTarget, screenOf, toDevicePoint, type LiveItem } from "../../web/src/features/emulator/emulator-logic";

const phone = { width: 720, height: 1600 };
const key = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("where a pointer lands on the phone", () => {
  test("a box with the phone's own aspect ratio maps 1:1 scaled", () => {
    expect(toDevicePoint({ x: 180, y: 400 }, { width: 360, height: 800 }, phone)).toEqual({ x: 360, y: 800 });
  });

  test("a wide box letterboxes the sides: the left bar is not the phone", () => {
    const box = { width: 800, height: 800 }; // the phone is 360x800, centred at x 220..580
    expect(toDevicePoint({ x: 100, y: 400 }, box, phone)).toBeNull();
    expect(toDevicePoint({ x: 220, y: 0 }, box, phone)).toEqual({ x: 0, y: 0 });
    expect(toDevicePoint({ x: 400, y: 400 }, box, phone)).toEqual({ x: 360, y: 800 });
  });

  test("a tall box letterboxes top and bottom", () => {
    const box = { width: 360, height: 1000 }; // the phone is 360x800, centred at y 100..900
    expect(toDevicePoint({ x: 100, y: 50 }, box, phone)).toBeNull();
    expect(toDevicePoint({ x: 180, y: 500 }, box, phone)).toEqual({ x: 360, y: 800 });
  });

  test("a landscape frame maps with its own size", () => {
    expect(toDevicePoint({ x: 400, y: 180 }, { width: 800, height: 360 }, { width: 1600, height: 720 })).toEqual({ x: 800, y: 360 });
  });

  test("an unmeasured box maps nothing", () => {
    expect(toDevicePoint({ x: 1, y: 1 }, { width: 0, height: 0 }, phone)).toBeNull();
  });
});

describe("what a press-and-release means", () => {
  test("a quick press that barely moves is a tap at the press point", () => {
    expect(classifyGesture({ x: 100, y: 200 }, { x: 103, y: 202 }, 80)).toEqual({ kind: "tap", x: 100, y: 200 });
  });

  test("holding still past the threshold is a long press", () => {
    expect(classifyGesture({ x: 100, y: 200 }, { x: 100, y: 200 }, 700)).toEqual({ kind: "long_press", x: 100, y: 200, ms: 700 });
  });

  test("moving past the slop is a swipe, however fast, carrying its duration", () => {
    expect(classifyGesture({ x: 100, y: 1200 }, { x: 100, y: 400 }, 150)).toEqual({ kind: "swipe", x1: 100, y1: 1200, x2: 100, y2: 400, ms: 150 });
  });

  test("a slow drag is a swipe, not a long press", () => {
    expect(classifyGesture({ x: 10, y: 10 }, { x: 300, y: 10 }, 900).kind).toBe("swipe");
  });

  test("a swipe is never shorter than a few frames for the device to register it", () => {
    const s = classifyGesture({ x: 10, y: 10 }, { x: 300, y: 10 }, 2);
    expect(s.kind === "swipe" && (s.ms ?? 0) >= 50).toBe(true);
  });
});

describe("what a key press on the phone means", () => {
  test("Backspace deletes and Enter enters", () => {
    expect(keyFromEvent(key("Backspace"))).toEqual({ kind: "key", key: "delete" });
    expect(keyFromEvent(key("Enter"))).toEqual({ kind: "key", key: "enter" });
  });

  test("Tab, Escape and the arrows are device keys", () => {
    expect(keyFromEvent(key("Tab"))).toEqual({ kind: "key", key: "tab" });
    expect(keyFromEvent(key("Escape"))).toEqual({ kind: "key", key: "escape" });
    expect(keyFromEvent(key("ArrowLeft"))).toEqual({ kind: "key", key: "dpad_left" });
  });

  test("a printable character is typed, shifted or not", () => {
    expect(keyFromEvent(key("a"))).toEqual({ kind: "text", text: "a" });
    expect(keyFromEvent(key("A", { shiftKey: true }))).toEqual({ kind: "text", text: "A" });
    expect(keyFromEvent(key(" "))).toEqual({ kind: "text", text: " " });
  });

  test("shortcuts belong to the app: modifier combos and unknown keys map to nothing", () => {
    expect(keyFromEvent(key("c", { ctrlKey: true }))).toBeNull();
    expect(keyFromEvent(key("v", { metaKey: true }))).toBeNull();
    expect(keyFromEvent(key("Enter", { altKey: true }))).toBeNull();
    expect(keyFromEvent(key("F5"))).toBeNull();
    expect(keyFromEvent(key("Shift"))).toBeNull();
  });
});

describe("which screen the view shows", () => {
  const avd = { name: "trb", image: "x", abi: "x86_64", api: 35, width: 720, height: 1600, dpi: 320, ramMb: 2048, dataMb: 4096 } as const;
  const installed = { kind: "installed", root: "r", owned: true, avd } as const;
  test("the SDK decides until it is installed", () => {
    expect(screenOf({ sdk: { kind: "absent" }, device: { kind: "stopped" } })).toBe("absent");
    expect(screenOf({ sdk: { kind: "failed", reason: "x", retryable: true }, device: { kind: "stopped" } })).toBe("sdk-failed");
  });
  test("then the device does", () => {
    expect(screenOf({ sdk: installed, device: { kind: "stopped" } })).toBe("stopped");
    expect(screenOf({ sdk: installed, device: { kind: "failed", reason: "x", logTail: "" } })).toBe("device-failed");
    expect(screenOf({ sdk: installed, device: { kind: "running", serial: "s", screen: phone, rotation: 0, seq: 1, live: false } })).toBe("running");
  });
});

describe("the words and numbers on the install screens", () => {
  test("sizes read in the largest fitting unit", () => {
    expect(formatBytes(1.74e9)).toBe("1.7 GB");
    expect(formatBytes(460e6)).toBe("460 MB");
  });
  test("progress stays between 0 and 1, and is 0 before a total is known", () => {
    expect(progressOf(50, 200)).toBe(0.25);
    expect(progressOf(300, 200)).toBe(1);
    expect(progressOf(5, 0)).toBe(0);
  });
  test("the toolbar asks for the other orientation", () => {
    expect(rotateTarget({ width: 720, height: 1600 })).toBe("landscape");
    expect(rotateTarget({ width: 1600, height: 720 })).toBe("portrait");
  });
});

describe("what waits for the live channel", () => {
  const down = (x: number): LiveItem => ({ kind: "pointer", phase: "down", x, y: 0 });
  const move = (x: number): LiveItem => ({ kind: "pointer", phase: "move", x, y: 0 });
  const up = (x: number): LiveItem => ({ kind: "pointer", phase: "up", x, y: 0 });
  const text = (t: string): LiveItem => ({ kind: "input", input: { kind: "text", text: t } });
  const back: LiveItem = { kind: "input", input: { kind: "key", key: "back" } };
  const fill = (...items: LiveItem[]) => items.reduce<LiveItem[]>(queueLive, []);

  test("a move replaces the move still waiting; a press and a release are kept, in order", () => {
    expect(fill(down(1), move(2), move(3), move(4), up(5))).toEqual([down(1), move(4), up(5)]);
    expect(fill(move(1), up(2), move(3))).toEqual([move(1), up(2), move(3)]);
  });

  test("typed text joins text still waiting; a key in between keeps them apart", () => {
    expect(fill(text("a"), text("b"), back, text("c"), text("d"))).toEqual([text("ab"), back, text("cd")]);
    expect(fill(back, back)).toEqual([back, back]);
  });
});
