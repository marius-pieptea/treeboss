/**
 * The Windows driver. It uses only what Windows ships: PowerShell (powershell.exe, 5.1) runs a short script that calls the documented
 * Win32 functions (SetProcessDPIAware, GetSystemMetrics, SetCursorPos, SendInput) and GDI+ (System.Drawing) for
 * the screen. SendInput is Microsoft's recommended way to synthesize input; mouse_event and keybd_event are
 * deprecated. Nothing to install.
 *
 * The daemon has to run in the logged-in user's desktop session: a service or scheduled task in session 0 sees no
 * screen and its input goes nowhere. Input into a window that runs as administrator is dropped by UIPI, and
 * SendInput reports it; the driver turns that into an error the agent can read.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { runCmd } from "../git/run";
import type { ComputerDriver, MouseButton, ScrollDirection } from "./driver";
import type { Rect, Size } from "./space";

/** C#, compiled by Add-Type. Every call here is a documented Win32 function. */
const NATIVE = `using System;
using System.Runtime.InteropServices;
public static class Native {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, EntryPoint = "VkKeyScanW")] public static extern short VkKeyScan(char ch);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
  static void Send(INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == 0) throw new InvalidOperationException("input blocked: the window in front runs with higher privileges (UAC), so Windows dropped it");
  }
  public static void Mouse(uint flags, int data) {
    var i = new INPUT[1]; i[0].type = INPUT_MOUSE; i[0].u.mi.dwFlags = flags; i[0].u.mi.mouseData = unchecked((uint)data);
    Send(i);
  }
  static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B; }
  static INPUT Key(ushort vk, uint flags) {
    var i = new INPUT(); i.type = INPUT_KEYBOARD; i.u.ki.wVk = vk;
    i.u.ki.dwFlags = flags | (Extended(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
    return i;
  }
  public static void Press(int[] mods, int vk, bool shift) {
    var seq = new System.Collections.Generic.List<INPUT>();
    foreach (var m in mods) seq.Add(Key((ushort)m, 0));
    if (shift) seq.Add(Key(0x10, 0));
    seq.Add(Key((ushort)vk, 0));
    seq.Add(Key((ushort)vk, KEYEVENTF_KEYUP));
    if (shift) seq.Add(Key(0x10, KEYEVENTF_KEYUP));
    for (int k = mods.Length - 1; k >= 0; k--) seq.Add(Key((ushort)mods[k], KEYEVENTF_KEYUP));
    Send(seq.ToArray());
  }
  public static void PressChar(int[] mods, char ch) {
    short s = VkKeyScan(ch);
    if (s == -1) throw new ArgumentException("no key for character " + ch);
    bool shift = (s >> 8 & 1) != 0;
    Press(mods, s & 0xFF, shift);
  }
  public static void Type(string text) {
    var seq = new System.Collections.Generic.List<INPUT>();
    foreach (char c in text) {
      if (c == '\\n') { seq.Add(Key(0x0D, 0)); seq.Add(Key(0x0D, KEYEVENTF_KEYUP)); continue; }
      if (c == '\\t') { seq.Add(Key(0x09, 0)); seq.Add(Key(0x09, KEYEVENTF_KEYUP)); continue; }
      var d = new INPUT(); d.type = INPUT_KEYBOARD; d.u.ki.wScan = c; d.u.ki.dwFlags = KEYEVENTF_UNICODE; seq.Add(d);
      var u = d; u.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP; seq.Add(u);
    }
    Send(seq.ToArray());
  }
}`;

export function windowsNativeSource(): string {
  return NATIVE;
}

/** The script text every call starts with, for tests. */
export function windowsPrelude(): string {
  return PRELUDE;
}

/**
 * The prelude every script starts with. Stop on the first error: without it a C# exception (the UAC "input blocked"
 * one, say) only aborts its own statement and the script exits 0. DPI awareness comes next, so coordinates are real
 * pixels on scaled displays. The here-string is the literal kind, so PowerShell never expands anything inside it.
 */
const PRELUDE = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
${NATIVE}
'@
[void][Native]::SetProcessDPIAware()`;

/** Mouse flags from winuser.h. */
const MOUSE = { leftDown: 0x0002, leftUp: 0x0004, rightDown: 0x0008, rightUp: 0x0010, middleDown: 0x0020, middleUp: 0x0040, wheel: 0x0800, hwheel: 0x1000 };
const BUTTON_FLAGS: Record<MouseButton, [number, number]> = { left: [MOUSE.leftDown, MOUSE.leftUp], right: [MOUSE.rightDown, MOUSE.rightUp], middle: [MOUSE.middleDown, MOUSE.middleUp] };

/** Virtual-key codes (winuser.h) for the key names the agent uses. Backspace is 0x08 on Windows: the Mac "Delete" key. */
const VK: Record<string, number> = {
  return: 0x0d, enter: 0x0d, tab: 0x09, space: 0x20, delete: 0x08, backspace: 0x08, forwarddelete: 0x2e, escape: 0x1b, esc: 0x1b,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  left: 0x25, arrowleft: 0x25, up: 0x26, arrowup: 0x26, right: 0x27, arrowright: 0x27, down: 0x28, arrowdown: 0x28,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0x70 + i])),
};
const MODIFIER_VK: Record<string, number> = { cmd: 0x5b, command: 0x5b, meta: 0x5b, win: 0x5b, super: 0x5b, ctrl: 0x11, control: 0x11, alt: 0x12, option: 0x12, opt: 0x12, shift: 0x10 };

export interface ParsedChord {
  mods: number[];
  vk?: number;
  char?: string;
}

/** A chord such as "cmd+shift+4" as the modifier codes and the key. Throws on a name it does not know. */
export function parseChord(chord: string): ParsedChord {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error("Give a key name, e.g. Return or cmd+s.");
  const mods = parts.map((m) => {
    const vk = MODIFIER_VK[m.toLowerCase()];
    if (vk === undefined) throw new Error(`Unknown modifier "${m}". Use cmd (Windows key), ctrl, alt or shift.`);
    return vk;
  });
  if (key.length === 1) return { mods, char: key };
  const vk = VK[key.toLowerCase()];
  if (vk === undefined) throw new Error(`Unknown key "${key}". Use a single character or a name such as Return, Escape, Tab, ArrowDown or F5.`);
  return { mods, vk };
}

/** Typed text goes into the script base64-encoded, so no quote or backtick in it can break the PowerShell. */
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The statements that press a parsed chord. */
export function chordStatement(c: ParsedChord): string {
  const mods = `@(${c.mods.map((m) => `0x${m.toString(16)}`).join(",") || ""})`;
  if (c.char !== undefined) return `[Native]::PressChar(${mods}, [char]${c.char.charCodeAt(0)})`;
  return `[Native]::Press(${mods}, 0x${(c.vk as number).toString(16)}, $false)`;
}

/** The statement that types text: base64 in, so no quoting can break the script. */
export function typeStatement(text: string): string {
  return `[Native]::Type([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}')))`;
}

/** Turn a Windows failure into text the agent can act on. */
function explain(stderr: string, fallback: string): Error {
  if (/input blocked/.test(stderr)) return new Error("input blocked: the window in front runs with higher privileges (UAC), so Windows dropped the keys or clicks. Ask the operator to bring a non-elevated window forward.");
  if (/no key for character/.test(stderr)) return new Error("this keyboard layout has no key for that character.");
  return new Error(stderr.split("\n").find((l) => l.trim()) ?? fallback);
}

/**
 * Run a script in PowerShell and return its stdout. The script goes through a temp file rather than the command
 * line: a long typed text would pass the 32K command-line limit, and the file is ASCII (text travels base64).
 */
async function ps(body: string, timeoutMs = 20_000): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-ps-"));
  try {
    const file = path.join(dir, "run.ps1");
    fs.writeFileSync(file, `${PRELUDE}\n${body}\n`, "utf8");
    const r = await runCmd("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { cwd: os.tmpdir(), timeoutMs });
    if (r.timedOut) throw new Error(`PowerShell did not finish within ${timeoutMs / 1000}s.`);
    if (r.code !== 0) throw explain(r.stderr.toString(), "PowerShell failed.");
    return r.stdout.toString().trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const pt = (p: { x: number; y: number }) => `${Math.round(p.x)}, ${Math.round(p.y)}`;

/** The primary display's size in pixels (DPI-aware, so these are the real pixels). */
async function displaySize(): Promise<Size> {
  const out = await ps(`"$([Native]::GetSystemMetrics(0)) $([Native]::GetSystemMetrics(1))"`);
  const [width, height] = out.split(/\s+/).map(Number);
  if (!(width > 0 && height > 0)) throw new Error(`could not read the display size (got "${out}").`);
  return { width, height };
}

export const windowsDriver: ComputerDriver = {
  displaySize,

  async capture({ region, out }: { region?: Rect; out?: Size }): Promise<Buffer> {
    // Without `out`, match the macOS driver: the longest edge is 1280px, and small regions are enlarged so text reads.
    const area: Rect = region ?? { x: 0, y: 0, ...(await displaySize()) };
    const target = out ?? (() => {
      const k = 1280 / Math.max(area.width, area.height);
      return { width: Math.max(1, Math.round(area.width * k)), height: Math.max(1, Math.round(area.height * k)) };
    })();
    const b64out = await ps(`$src = New-Object System.Drawing.Bitmap ${Math.round(area.width)}, ${Math.round(area.height)}
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen(${Math.round(area.x)}, ${Math.round(area.y)}, 0, 0, $src.Size)
$dst = New-Object System.Drawing.Bitmap ${Math.round(target.width)}, ${Math.round(target.height)}
$g2 = [System.Drawing.Graphics]::FromImage($dst)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($src, 0, 0, $dst.Width, $dst.Height)
$ms = New-Object System.IO.MemoryStream
$dst.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
[Convert]::ToBase64String($ms.ToArray())`, 30_000);
    return Buffer.from(b64out, "base64");
  },

  async click(p, button, clicks): Promise<void> {
    const [down, up] = BUTTON_FLAGS[button];
    const presses = Array.from({ length: clicks }, () => `[Native]::Mouse(${down}, 0); [Native]::Mouse(${up}, 0)`).join("; ");
    await ps(`[void][Native]::SetCursorPos(${pt(p)}); ${presses}`);
  },

  async move(p): Promise<void> {
    await ps(`[void][Native]::SetCursorPos(${pt(p)})`);
  },

  async drag(from, to): Promise<void> {
    const steps = 12;
    const path = Array.from({ length: steps }, (_, i) => {
      const k = (i + 1) / steps;
      return `[void][Native]::SetCursorPos(${Math.round(from.x + (to.x - from.x) * k)}, ${Math.round(from.y + (to.y - from.y) * k)})`;
    }).join("\n");
    await ps(`[void][Native]::SetCursorPos(${pt(from)})
[Native]::Mouse(${MOUSE.leftDown}, 0)
${path}
[Native]::Mouse(${MOUSE.leftUp}, 0)`);
  },

  async scroll(p, direction: ScrollDirection, lines): Promise<void> {
    // One wheel notch is 120. Positive vertical scrolls up; positive horizontal scrolls right (WHEEL_DELTA, winuser.h).
    const notches = 120 * lines;
    const wheel = direction === "up" ? `[Native]::Mouse(${MOUSE.wheel}, ${notches})` : direction === "down" ? `[Native]::Mouse(${MOUSE.wheel}, ${-notches})` : direction === "right" ? `[Native]::Mouse(${MOUSE.hwheel}, ${notches})` : `[Native]::Mouse(${MOUSE.hwheel}, ${-notches})`;
    await ps(`${p ? `[void][Native]::SetCursorPos(${pt(p)})\n` : ""}${wheel}`);
  },

  async type(text): Promise<void> {
    await ps(typeStatement(text));
  },

  async key(chord): Promise<void> {
    await ps(chordStatement(parseChord(chord)));
  },
};
