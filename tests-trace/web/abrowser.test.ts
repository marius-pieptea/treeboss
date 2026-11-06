import { describe, expect, test } from "bun:test";
import { AGENT_URL, accumulateWheel, isAgentUrl, keyAction, placePicture, shouldFetchFrame, statusLine, toBoxPoint, toPagePoint } from "../../web/src/features/browser/agent-logic";

const PAGE = { width: 1280, height: 800 };

describe("mapping a click on the picture to the page", () => {
  test("a box with the page's own aspect ratio maps linearly", () => {
    const box = { width: 640, height: 400 };
    expect(toPagePoint({ x: 320, y: 200 }, box, PAGE)).toEqual({ x: 640, y: 400 });
    expect(toPagePoint({ x: 0, y: 0 }, box, PAGE)).toEqual({ x: 0, y: 0 });
  });

  test("a wider box letterboxes left and right; clicks on the bars hit nothing", () => {
    const box = { width: 1000, height: 400 }; // page scaled to 640x400, centred
    const p = placePicture(box, PAGE);
    expect(p).toMatchObject({ x: 180, y: 0, width: 640, height: 400, scale: 0.5 });
    expect(toPagePoint({ x: 100, y: 200 }, box, PAGE)).toBeNull();
    expect(toPagePoint({ x: 900, y: 200 }, box, PAGE)).toBeNull();
    expect(toPagePoint({ x: 500, y: 200 }, box, PAGE)).toEqual({ x: 640, y: 400 });
  });

  test("a taller box letterboxes top and bottom", () => {
    const box = { width: 640, height: 600 };
    expect(placePicture(box, PAGE)).toMatchObject({ x: 0, y: 100, width: 640, height: 400 });
    expect(toPagePoint({ x: 10, y: 50 }, box, PAGE)).toBeNull();
    expect(toPagePoint({ x: 10, y: 110 }, box, PAGE)).toEqual({ x: 20, y: 20 });
  });

  test("the inverse maps a page point back onto the picture", () => {
    const box = { width: 1000, height: 400 };
    const pt = toBoxPoint({ x: 640, y: 400 }, box, PAGE);
    expect(toPagePoint(pt, box, PAGE)).toEqual({ x: 640, y: 400 });
  });

  test("results stay inside the page and degenerate sizes are safe", () => {
    expect(toPagePoint({ x: 640, y: 400 }, { width: 640, height: 400 }, PAGE)).toEqual({ x: 1279, y: 799 });
    expect(toPagePoint({ x: 1, y: 1 }, { width: 0, height: 0 }, PAGE)).toBeNull();
    expect(placePicture({ width: 10, height: 10 }, { width: 0, height: 0 }).width).toBe(0);
  });
});

describe("frame fetching", () => {
  const gate = (over = {}) => ({ shown: 4, inFlight: false, lastFetchAt: 0, ...over });
  test("a newer sequence number fetches; an old or equal one does not", () => {
    expect(shouldFetchFrame(gate(), 5, 1000)).toBe("now");
    expect(shouldFetchFrame(gate(), 4, 1000)).toBe("no");
    expect(shouldFetchFrame(gate(), 2, 1000)).toBe("no");
  });
  test("one request at a time, and not faster than the interval", () => {
    expect(shouldFetchFrame(gate({ inFlight: true }), 9, 1000)).toBe("later");
    expect(shouldFetchFrame(gate({ lastFetchAt: 950 }), 9, 1000, 200)).toBe("later");
    expect(shouldFetchFrame(gate({ lastFetchAt: 700 }), 9, 1000, 200)).toBe("now");
  });
});

describe("status line", () => {
  test("says who is doing what", () => {
    expect(statusLine(null)).toMatchObject({ text: "No page open", busy: false });
    expect(statusLine({ open: true, busy: true, actor: "agent", lastAction: 'Clicking button "Save"' })).toEqual({ text: 'Agent is clicking button "Save"…', tone: "agent", busy: true });
    expect(statusLine({ open: true, busy: true, actor: "you", lastAction: "Scrolling" })).toMatchObject({ text: "You: scrolling…", tone: "you" });
    expect(statusLine({ open: true, busy: false, actor: "you", lastAction: "Typing" })).toMatchObject({ text: "You are in control", tone: "you" });
    expect(statusLine({ open: true, busy: false, actor: "agent", lastAction: "Reading the page" })).toMatchObject({ text: "Agent: reading the page", tone: "agent" });
    expect(statusLine({ open: true, busy: false, actor: null })).toMatchObject({ text: "Idle", tone: "idle" });
  });
});

describe("keyboard and wheel forwarding", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => keyAction({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  test("printable characters are typed, named keys are pressed", () => {
    expect(key("a")).toEqual({ kind: "type", text: "a" });
    expect(key("A", { shiftKey: true })).toEqual({ kind: "type", text: "A" });
    expect(key("Enter")).toEqual({ kind: "key", key: "Enter" });
    expect(key("Tab", { shiftKey: true })).toEqual({ kind: "key", key: "Shift+Tab" });
    expect(key("ArrowDown")).toEqual({ kind: "key", key: "ArrowDown" });
  });
  test("shortcuts and modifier keys stay with the app", () => {
    expect(key("p", { metaKey: true })).toBeNull();
    expect(key("c", { ctrlKey: true })).toBeNull();
    expect(key("Shift", { shiftKey: true })).toBeNull();
    expect(key("F5")).toBeNull();
  });
  test("wheel deltas sum, with line and page modes converted to pixels", () => {
    let acc = { dx: 0, dy: 0 };
    acc = accumulateWheel(acc, { deltaX: 0, deltaY: 40, deltaMode: 0 });
    acc = accumulateWheel(acc, { deltaX: 5, deltaY: 2, deltaMode: 1 });
    expect(acc).toEqual({ dx: 80, dy: 72 });
    expect(accumulateWheel({ dx: 0, dy: 0 }, { deltaX: 0, deltaY: 1, deltaMode: 2 }, 800).dy).toBe(800);
  });
});

describe("the agent tab's address", () => {
  test("a sentinel distinguishes it from any real URL", () => {
    expect(isAgentUrl(AGENT_URL)).toBe(true);
    expect(isAgentUrl("http://localhost:3000")).toBe(false);
    expect(isAgentUrl("")).toBe(false);
    expect(isAgentUrl(undefined)).toBe(false);
  });
});
