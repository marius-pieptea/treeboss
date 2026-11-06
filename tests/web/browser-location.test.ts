import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { followFrame, isLocationMessage, userFacingUrl } from "../../web/src/features/browser/logic";
import { INSPECTOR_JS } from "../../src/preview/inspector";

describe("userFacingUrl", () => {
  test("maps the proxy port back to the dev server port", () => {
    expect(userFacingUrl("http://localhost:5555/a/b?x=1#h", 5555, 3000)).toBe("http://localhost:3000/a/b?x=1#h");
  });
  test("drops the trailing slash on a bare root, like the address bar does", () => {
    expect(userFacingUrl("http://localhost:5555/", 5555, 3000)).toBe("http://localhost:3000");
  });
  test("refuses a location that is not on the proxy", () => {
    expect(userFacingUrl("http://localhost:6000/a", 5555, 3000)).toBeNull();
    expect(userFacingUrl("https://example.com/", 5555, 3000)).toBeNull();
    expect(userFacingUrl("not a url", 5555, 3000)).toBeNull();
  });
});

describe("isLocationMessage", () => {
  test("accepts only a trb-location message with a string href", () => {
    expect(isLocationMessage({ type: "trb-location", href: "http://localhost:5555/" })).toBe(true);
    expect(isLocationMessage({ type: "trb-location" })).toBe(false);
    expect(isLocationMessage({ type: "trb-ready", href: "x" })).toBe(false);
    expect(isLocationMessage(null)).toBe(false);
  });
});

describe("followFrame", () => {
  const h = { stack: ["http://localhost:3000", "http://localhost:3000/a"], i: 1 };
  test("the frame reporting the entry it is already on changes nothing", () => {
    expect(followFrame(h, "http://localhost:3000/a", false)).toBe(h);
  });
  test("a new location becomes a history entry after the current one", () => {
    const back = { ...h, i: 0 };
    expect(followFrame(back, "http://localhost:3000/b", false)).toEqual({ stack: ["http://localhost:3000", "http://localhost:3000/b"], i: 1 });
  });
  test("replaceState swaps the current entry", () => {
    expect(followFrame(h, "http://localhost:3000/c", true)).toEqual({ stack: ["http://localhost:3000", "http://localhost:3000/c"], i: 1 });
  });
  test("an empty history starts with the location", () => {
    expect(followFrame({ stack: [], i: -1 }, "http://localhost:3000/a", false)).toEqual({ stack: ["http://localhost:3000/a"], i: 0 });
  });
});

describe("inspector location reports", () => {
  function run() {
    const sent: any[] = [];
    const listeners: Record<string, Array<() => void>> = {};
    const location = { href: "http://localhost:5555/", pathname: "/", search: "" };
    const history = {
      pushState(_s: unknown, _t: string, url: string) { location.href = "http://localhost:5555" + url; },
      replaceState(_s: unknown, _t: string, url: string) { location.href = "http://localhost:5555" + url; },
    };
    const win: any = {
      parent: { postMessage: (m: any) => sent.push(m) },
      addEventListener: (k: string, f: () => void) => (listeners[k] ??= []).push(f),
      location, history, document: { title: "T" }, console: { error() {}, warn() {} },
    };
    win.window = win;
    vm.runInNewContext(INSPECTOR_JS, { ...win, window: win, location, history, document: win.document, console: win.console });
    return { sent: () => sent.filter((m) => m.type === "trb-location"), history, listeners };
  }
  test("reports on load, pushState, replaceState, popstate and hashchange", () => {
    const { sent, history, listeners } = run();
    expect(sent().map((m) => m.href)).toEqual(["http://localhost:5555/"]);
    history.pushState({}, "", "/spa/1");
    history.replaceState({}, "", "/spa/2");
    listeners.popstate?.forEach((f) => f());
    listeners.hashchange?.forEach((f) => f());
    expect(sent().map((m) => [m.href, !!m.replace])).toEqual([
      ["http://localhost:5555/", false],
      ["http://localhost:5555/spa/1", false],
      ["http://localhost:5555/spa/2", true],
      ["http://localhost:5555/spa/2", false],
      ["http://localhost:5555/spa/2", false],
    ]);
  });
});
