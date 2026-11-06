/**
 * The macOS driver, built only from what ships with the OS: `screencapture` and `sips` for pictures, JXA through
 * `osascript` for the pointer and the scroll wheel (CoreGraphics events), and System Events for the keyboard.
 * Nothing to install. The app that runs the daemon (the terminal, usually) needs two grants in System Settings >
 * Privacy & Security: Screen Recording for screenshots and Accessibility for the mouse and keyboard.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { runCmd } from "../git/run";
import type { ComputerDriver, MouseButton, ScrollDirection } from "./driver";
import type { Size } from "./space";

const PERMISSION_HINT = "Grant the app running trb both Screen Recording and Accessibility in System Settings > Privacy & Security, then try again.";

async function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const r = await runCmd(cmd, args, { cwd: os.tmpdir(), timeoutMs });
  const err = r.stderr.toString().trim();
  if (r.timedOut) throw new Error(`${cmd} did not finish within ${timeoutMs / 1000}s.`);
  if (r.code !== 0) {
    const denied = /not allowed|not authorized|assistive|1743|could not create image/i.test(err);
    throw new Error(`${cmd} failed${err ? `: ${err.split("\n")[0]}` : ""}.${denied ? ` ${PERMISSION_HINT}` : ""}`);
  }
  return r.stdout.toString().trim();
}

/** Run a JXA snippet with CoreGraphics loaded. `args` are passed as a JSON literal: numbers and plain strings only. */
function jxa(body: string, args: Record<string, unknown>): Promise<string> {
  return run("osascript", ["-l", "JavaScript", "-e", `ObjC.import("CoreGraphics");\nconst A = ${JSON.stringify(args)};\n${body}`]);
}

/** AppleScript string literal. */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function systemEvents(lines: string[]): Promise<void> {
  const args = ["-e", 'tell application "System Events"', ...lines.flatMap((l) => ["-e", l]), "-e", "end tell"];
  await run("osascript", args);
}

/** Key names to macOS virtual key codes (Carbon kVK_* values), for keys that are not a single character. */
const KEY_CODES: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53, forwarddelete: 117,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, arrowleft: 123, right: 124, arrowright: 124, down: 125, arrowdown: 125, up: 126, arrowup: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MODIFIERS: Record<string, string> = { cmd: "command down", command: "command down", meta: "command down", ctrl: "control down", control: "control down", alt: "option down", option: "option down", opt: "option down", shift: "shift down" };

/** A chord such as "cmd+shift+4" as the AppleScript that presses it. Throws on a name it does not know. */
export function chordScript(chord: string): string {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error("Give a key name, e.g. Return or cmd+s.");
  const mods: string[] = [];
  for (const m of parts) {
    const down = MODIFIERS[m.toLowerCase()];
    if (!down) throw new Error(`Unknown modifier "${m}". Use cmd, ctrl, alt or shift.`);
    mods.push(down);
  }
  const using = mods.length ? ` using {${mods.join(", ")}}` : "";
  if (key.length === 1) return `keystroke ${q(key)}${using}`;
  const code = KEY_CODES[key.toLowerCase()];
  if (code === undefined) throw new Error(`Unknown key "${key}". Use a single character or a name such as Return, Escape, Tab, ArrowDown or F5.`);
  return `key code ${code}${using}`;
}

/** Typed text as AppleScript: each run of characters is a keystroke, newlines and tabs are Return and Tab. */
export function typeScript(text: string): string[] {
  return text.split(/(\n|\t)/).filter((t) => t !== "").map((t) => (t === "\n" ? "key code 36" : t === "\t" ? "key code 48" : `keystroke ${q(t)}`));
}

async function pointerClick(p: { x: number; y: number }, button: MouseButton, clicks: number): Promise<void> {
  await jxa(
    `const map = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] }[A.button];
for (let i = 1; i <= A.clicks; i++) {
  for (const type of [map[0], map[1]]) {
    const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(A.x, A.y), map[2]);
    $.CGEventSetIntegerValueField(e, 1, i); // kCGMouseEventClickState
    $.CGEventPost(0, e);
  }
}
"ok";`,
    { ...p, button, clicks },
  );
}

export const macDriver: ComputerDriver = {
  async displaySize(): Promise<Size> {
    const out = await jxa(`const b = $.CGDisplayBounds($.CGMainDisplayID()); JSON.stringify({ width: b.size.width, height: b.size.height });`, {});
    return JSON.parse(out) as Size;
  },

  async capture({ region, out }): Promise<Buffer> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-screen-"));
    try {
      const raw = path.join(dir, "raw.png");
      const jpg = path.join(dir, "out.jpg");
      // -R takes whole points.
      const target = region ? ["-R", [region.x, region.y, Math.max(1, region.width), Math.max(1, region.height)].map(Math.round).join(",")] : ["-m"];
      await run("screencapture", ["-x", ...target, "-t", "png", raw]);
      const size = out ? ["-z", String(Math.round(out.height)), String(Math.round(out.width))] : ["-Z", "1280"];
      await run("sips", [...size, "-s", "format", "jpeg", "-s", "formatOptions", "80", raw, "--out", jpg]);
      return fs.readFileSync(jpg);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  click: pointerClick,

  async move(p): Promise<void> {
    await jxa(`$.CGEventPost(0, $.CGEventCreateMouseEvent(null, 5, $.CGPointMake(A.x, A.y), 0)); "ok";`, p);
  },

  async drag(from, to): Promise<void> {
    await jxa(
      `const steps = 12;
$.CGEventPost(0, $.CGEventCreateMouseEvent(null, 5, $.CGPointMake(A.from.x, A.from.y), 0));
$.CGEventPost(0, $.CGEventCreateMouseEvent(null, 1, $.CGPointMake(A.from.x, A.from.y), 0));
for (let i = 1; i <= steps; i++) {
  const x = A.from.x + ((A.to.x - A.from.x) * i) / steps, y = A.from.y + ((A.to.y - A.from.y) * i) / steps;
  $.CGEventPost(0, $.CGEventCreateMouseEvent(null, 6, $.CGPointMake(x, y), 0));
}
$.CGEventPost(0, $.CGEventCreateMouseEvent(null, 2, $.CGPointMake(A.to.x, A.to.y), 0));
"ok";`,
      { from, to },
    );
  },

  async scroll(p, direction, lines): Promise<void> {
    // CoreGraphics wheel 1 is vertical (positive scrolls up), wheel 2 horizontal. Horizontal sign is untested on hardware.
    const dy = direction === "up" ? lines : direction === "down" ? -lines : 0;
    const dx = direction === "right" ? lines : direction === "left" ? -lines : 0;
    await jxa(
      `if (A.p) $.CGEventPost(0, $.CGEventCreateMouseEvent(null, 5, $.CGPointMake(A.p.x, A.p.y), 0));
$.CGEventPost(0, $.CGEventCreateScrollWheelEvent2(null, 1, 2, A.dy, A.dx, 0));
"ok";`,
      { p, dy, dx },
    );
  },

  async type(text): Promise<void> {
    await systemEvents(typeScript(text));
  },

  async key(chord): Promise<void> {
    await systemEvents([chordScript(chord)]);
  },
};
