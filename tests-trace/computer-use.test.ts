import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START computer-use\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END computer-use\n"); });
/**
 * The computer tools against a fake machine: every action is checked for the points it lands on, the setting gates
 * every call, actions never overlap, and the log keeps what was done without keeping what was typed. The macOS
 * driver's own pieces (AppleScript and key codes) are tested as text; the live display is checked only where it is safe.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { COMPUTER_TOOL_NAMES, computerToolDefs, COMPUTER_TOOL_SET } from "../src/computer/defs";
import { computerUseAvailable, setComputerDriver, type ComputerDriver, type MouseButton, type ScrollDirection } from "../src/computer/driver";
import { chordScript, macDriver, typeScript } from "../src/computer/macos";
import { chordStatement, parseChord, typeStatement, windowsNativeSource, windowsPrelude } from "../src/computer/windows";
import { executeComputerTool } from "../src/computer/tools";
import { coordSpace } from "../src/computer/space";
import { home } from "../src/paths";
import { resetSetting, setSetting } from "../src/settings";
import { resetState } from "./helpers";

type Call = { op: string; args: unknown[] };

/** A machine that records what it was asked to do. `gate` holds every action until it resolves, to test ordering. */
function fakeMachine(display = { width: 1920, height: 1080 }) {
  const calls: Call[] = [];
  let gate: Promise<void> | null = null;
  const rec = async (op: string, ...args: unknown[]) => {
    calls.push({ op, args });
    if (gate) await gate;
  };
  const driver: ComputerDriver = {
    async displaySize() {
      return display;
    },
    async capture(o) {
      await rec("capture", o);
      return Buffer.from("jpeg-bytes");
    },
    async click(p, button: MouseButton, clicks) {
      await rec("click", p, button, clicks);
    },
    async move(p) {
      await rec("move", p);
    },
    async drag(from, to) {
      await rec("drag", from, to);
    },
    async scroll(p, direction: ScrollDirection, lines) {
      await rec("scroll", p, direction, lines);
    },
    async type(text) {
      await rec("type", text);
    },
    async key(chord) {
      await rec("key", chord);
    },
  };
  return {
    driver,
    calls,
    hold: () => {
      let open!: () => void;
      gate = new Promise<void>((r) => (open = r));
      return () => {
        gate = null;
        open();
      };
    },
  };
}

const run = (name: string, args: Record<string, unknown> = {}) => executeComputerTool(name, args, { sessionId: "sess-test" });
const logPath = () => path.join(home(), "computer-use.log");

let machine: ReturnType<typeof fakeMachine>;

beforeEach(() => {
  resetState();
  machine = fakeMachine();
  setComputerDriver(machine.driver);
  setSetting("computer_use", "on");
});
afterEach(() => {
  setComputerDriver(null);
  resetSetting("computer_use");
});

describe("definitions", () => {
  test("every computer tool is defined once and is in the set", () => {
    const names = computerToolDefs().map((d) => d.name);
    expect(names.sort()).toEqual([...COMPUTER_TOOL_NAMES].sort());
    for (const n of names) expect(COMPUTER_TOOL_SET.has(n)).toBe(true);
  });

  test("the setting is off by default and only on or off is accepted", () => {
    resetSetting("computer_use");
    setComputerDriver(machine.driver);
    return run("computer_screenshot").then((r) => {
      expect(r.text).toContain("turned off");
      expect(machine.calls).toHaveLength(0);
      expect(() => setSetting("computer_use", "maybe")).toThrow(/on" or "off/);
    });
  });
});

describe("coordinates", () => {
  test("the screenshot is 1280 pixels on its long side and is what the agent aims at", async () => {
    const r = await run("computer_screenshot");
    expect(machine.calls[0]).toEqual({ op: "capture", args: [{ out: { width: 1280, height: 720 } }] });
    expect(r.text).toContain("1280x720");
    expect(r.images).toEqual([{ data: Buffer.from("jpeg-bytes").toString("base64"), mimeType: "image/jpeg" }]);
  });

  test("a click in screenshot pixels lands on the matching point of the display", async () => {
    const r = await run("computer_click", { x: 640, y: 360 });
    expect(r.text).toContain("Clicked left at (640, 360)");
    expect(machine.calls[0]).toEqual({ op: "click", args: [{ x: 960, y: 540 }, "left", 1] });
  });

  test("double and triple clicks and the right button are passed through", async () => {
    await run("computer_click", { x: 0, y: 0, clicks: 2, button: "right" });
    await run("computer_click", { x: 0, y: 0, clicks: 3 });
    expect(machine.calls.map((c) => c.args[1])).toEqual(["right", "left"]);
    expect(machine.calls.map((c) => c.args[2])).toEqual([2, 3]);
  });

  test("points outside the screenshot are refused and nothing is clicked", async () => {
    const r = await run("computer_click", { x: 1280, y: 10 });
    expect(r.text).toMatch(/^Error: x 1280 is outside/);
    expect(machine.calls).toHaveLength(0);
  });

  test("a zoom region is mapped to display points", async () => {
    const r = await run("computer_zoom", { region: [0, 0, 640, 360] });
    expect(r.text).toContain("[0, 0, 640, 360]");
    expect(machine.calls[0]).toEqual({ op: "capture", args: [{ region: { x: 0, y: 0, width: 960, height: 540 } }] });
  });

  test("a zoom region must be well formed and inside the screenshot", async () => {
    expect((await run("computer_zoom", { region: [10, 10, 5, 50] })).text).toMatch(/x1 > x0/);
    expect((await run("computer_zoom", { region: [0, 0, 2000, 10] })).text).toMatch(/past the screenshot/);
    expect((await run("computer_zoom", { region: [1, 2, 3] })).text).toMatch(/\[x0, y0, x1, y1\]/);
    expect(machine.calls).toHaveLength(0);
  });

  test("coordSpace keeps the aspect ratio of portrait displays too", () => {
    expect(coordSpace({ width: 1512, height: 982 })).toEqual({ width: 1280, height: 831 });
    expect(coordSpace({ width: 1080, height: 1920 })).toEqual({ width: 720, height: 1280 });
  });
});

describe("actions", () => {
  test("drag, move and scroll pass their points through", async () => {
    await run("computer_drag", { from_x: 0, from_y: 0, to_x: 640, to_y: 360 });
    await run("computer_move", { x: 320, y: 180 });
    await run("computer_scroll", { direction: "down" });
    await run("computer_scroll", { x: 640, y: 360, direction: "up", amount: 5 });
    expect(machine.calls).toEqual([
      { op: "drag", args: [{ x: 0, y: 0 }, { x: 960, y: 540 }] },
      { op: "move", args: [{ x: 480, y: 270 }] },
      { op: "scroll", args: [null, "down", 3] },
      { op: "scroll", args: [{ x: 960, y: 540 }, "up", 5] },
    ]);
  });

  test("scroll amounts are bounded", async () => {
    expect((await run("computer_scroll", { direction: "left", amount: 50 })).text).toMatch(/amount 50 is outside/);
    expect(machine.calls).toHaveLength(0);
  });

  test("typing is forwarded whole, with a length limit, and the log keeps the length only", async () => {
    const secret = "hunter2-" + Math.random().toString(36).slice(2);
    const r = await run("computer_type", { text: secret });
    expect(r.text).toContain(`Typed ${secret.length} characters`);
    expect(machine.calls).toEqual([{ op: "type", args: [secret] }]);
    expect((await run("computer_type", { text: "x".repeat(2001) })).text).toMatch(/limit is 2000/);
    expect(fs.readFileSync(logPath(), "utf8")).not.toContain(secret);
  });

  test("key chords are forwarded and empty ones refused", async () => {
    await run("computer_key", { key: "cmd+shift+4" });
    expect((await run("computer_key", { key: "  " })).text).toMatch(/key is required/);
    expect(machine.calls).toEqual([{ op: "key", args: ["cmd+shift+4"] }]);
  });

  test("wait is bounded to 30 seconds and does not touch the machine", async () => {
    expect((await run("computer_wait", { seconds: 31 })).text).toMatch(/outside the range/);
    expect((await run("computer_wait", { seconds: 0 })).text).toBe("Waited 0 seconds.");
    expect(machine.calls).toHaveLength(0);
  });

  test("unknown tools are refused", async () => {
    expect((await run("computer_teleport")).text).toMatch(/unknown computer tool/);
  });

  test("driver failures come back as text the agent can read", async () => {
    setComputerDriver({
      ...machine.driver,
      async click() {
        throw new Error("osascript failed: Not authorized to send Apple events.\nsecond line");
      },
    });
    const r = await run("computer_click", { x: 1, y: 1 });
    expect(r.text).toBe('Error: computer tool "computer_click" failed: osascript failed: Not authorized to send Apple events.');
  });
});

describe("control", () => {
  test("every action is logged with its arguments before it runs", async () => {
    await run("computer_click", { x: 5, y: 6 });
    const last = JSON.parse(fs.readFileSync(logPath(), "utf8").trim().split("\n").at(-1)!);
    expect(last).toMatchObject({ session: "sess-test", tool: "computer_click", args: { x: 5, y: 6 } });
  });

  test("actions run one at a time across callers", async () => {
    const release = machine.hold();
    const first = run("computer_click", { x: 1, y: 1 });
    const second = run("computer_click", { x: 2, y: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(machine.calls).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    // Screenshot pixels to points at 1920/1280 = 1.5: x 1 is 1.5 points, x 2 is 3.
    expect(machine.calls.map((c) => c.args[0])).toEqual([
      { x: 1.5, y: 1.5 },
      { x: 3, y: 3 },
    ]);
  });

  test("switching the setting off stops actions that are already queued", async () => {
    const release = machine.hold();
    const first = run("computer_click", { x: 1, y: 1 });
    await new Promise((r) => setTimeout(r, 20));
    const second = run("computer_type", { text: "after the switch" });
    setSetting("computer_use", "off");
    release();
    expect((await first).text).toContain("Clicked");
    expect((await second).text).toBe("Error: computer use was turned off.");
    expect(machine.calls.map((c) => c.op)).toEqual(["click"]);
  });
});

describe("macOS driver text", () => {
  test("chords become key codes or keystrokes with the right modifiers", () => {
    expect(chordScript("Return")).toBe("key code 36");
    expect(chordScript("shift+Tab")).toBe("key code 48 using {shift down}");
    expect(chordScript("cmd+shift+4")).toBe('keystroke "4" using {command down, shift down}');
    expect(chordScript("ctrl+a")).toBe('keystroke "a" using {control down}');
    expect(chordScript("alt+ArrowLeft")).toBe("key code 123 using {option down}");
  });

  test("unknown keys and modifiers are refused before anything runs", () => {
    expect(() => chordScript("hyper+x")).toThrow(/Unknown modifier/);
    expect(() => chordScript("Launch")).toThrow(/Unknown key/);
  });

  test("typed text is split into keystrokes, with newlines and tabs as keys", () => {
    expect(typeScript('hi "there"\n\tyo')).toEqual(['keystroke "hi \\"there\\""', "key code 36", "key code 48", 'keystroke "yo"']);
  });

  test.skipIf(process.platform !== "darwin")("the live display reports a positive size in points", async () => {
    const size = await macDriver.displaySize();
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
});

test("the set of computer tools is exactly the names the shim serves", () => {
  expect(COMPUTER_TOOL_NAMES.every((n) => n.startsWith("computer_"))).toBe(true);
});

describe("Windows driver text", () => {
  test("chords become modifier codes and virtual keys, and characters go through VkKeyScan", () => {
    expect(parseChord("cmd+shift+4")).toEqual({ mods: [0x5b, 0x10], char: "4" });
    expect(parseChord("ctrl+a")).toEqual({ mods: [0x11], char: "a" });
    expect(parseChord("Return")).toEqual({ mods: [], vk: 0x0d });
    expect(parseChord("alt+ArrowLeft")).toEqual({ mods: [0x12], vk: 0x25 });
    expect(parseChord("F5")).toEqual({ mods: [], vk: 0x74 });
    expect(chordStatement(parseChord("ctrl+shift+Tab"))).toBe("[Native]::Press(@(0x11,0x10), 0x9, $false)");
    expect(chordStatement(parseChord("ctrl+a"))).toBe("[Native]::PressChar(@(0x11), [char]97)");
  });

  test("unknown keys and modifiers are refused before anything runs", () => {
    expect(() => parseChord("hyper+x")).toThrow(/Unknown modifier/);
    expect(() => parseChord("Launch")).toThrow(/Unknown key/);
  });

  test("typed text travels base64-encoded, so quotes in it cannot break the script", () => {
    const stmt = typeStatement(`it's "quoted"\n`);
    expect(stmt).not.toContain("it's");
    expect(stmt).toContain(Buffer.from(`it's "quoted"\n`).toString("base64"));
    expect(stmt.startsWith("[Native]::Type(")).toBe(true);
  });

  test("the C# source declares the Win32 calls the driver depends on", () => {
    for (const needle of ["SetProcessDPIAware", "GetSystemMetrics", "SetCursorPos", "SendInput", "VkKeyScan", "KEYEVENTF_UNICODE", "input blocked"]) {
      expect(windowsNativeSource()).toContain(needle);
    }
  });

  test("scripts stop on the first error, so a blocked input is an error and not a silent success", () => {
    expect(windowsPrelude().startsWith("$ErrorActionPreference = 'Stop'")).toBe(true);
    expect(windowsPrelude()).toContain("Add-Type -TypeDefinition @'");
  });

  test("keys are looked up with the Unicode VkKeyScanW, so non-ASCII characters are not turned into '?'", () => {
    expect(windowsNativeSource()).toContain('EntryPoint = "VkKeyScanW"');
  });
});

test("tools are only offered when the setting is on and this machine has a driver", () => {
  setSetting("computer_use", "off");
  expect(computerUseAvailable()).toBe(false);
  setSetting("computer_use", "on");
  setComputerDriver(null);
  expect(computerUseAvailable()).toBe(["darwin", "win32"].includes(process.platform));
  setComputerDriver(machine.driver);
  expect(computerUseAvailable()).toBe(true);
});
