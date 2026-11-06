/**
 * adb, spoken through Deps: each method runs one adb command and turns its output into a domain value
 * (a boolean, a PNG with its size, a list of on-screen elements), so nothing above this file reads raw adb text.
 *
 * `adb shell` joins its arguments with spaces and hands the line to the device's sh, so every argument is
 * single-quoted here (`shq`): a URL with `&` or a package name with `;` reaches the device as one word.
 */
import type { Deps } from "./deps";

export const SERIAL = "emulator-5554";

export class AdbError extends Error {}

/** Quote one word for the device's sh. */
export function shq(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface Screencap {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface UiElement {
  text: string;
  desc: string;
  id: string;
  cls: string;
  clickable: boolean;
  bounds: { x1: number; y1: number; x2: number; y2: number };
}

export interface AdbClient {
  serial: string;
  bootCompleted(): Promise<boolean>;
  screencap(): Promise<Screencap>;
  /** Runs `adb shell <args>`; throws AdbError on a non-zero exit. */
  shell(args: string[], timeoutMs?: number): Promise<string>;
  reverse(port: number): Promise<void>;
  install(apk: string): Promise<string>;
  logcat(tag: string, lines: number): Promise<string>;
  uiDump(): Promise<UiElement[]>;
  /** The AVD the running emulator was made from, or null when nothing answers on this serial. */
  avdName(): Promise<string | null>;
  rotation(): Promise<0 | 1 | 2 | 3>;
  /** Asks the emulator to exit (`adb emu kill`). */
  kill(): Promise<void>;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

const ATTR = /([\w-]+)="([^"]*)"/g;
const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, " ").replace(/&amp;/g, "&");

/** The elements of a `uiautomator dump`: those with text, a description or a click handler, each with its bounds. */
export function parseUiDump(xml: string): UiElement[] {
  const out: UiElement[] = [];
  for (const node of xml.matchAll(/<node\b[^>]*>/g)) {
    const a: Record<string, string> = {};
    for (const m of node[0].matchAll(ATTR)) a[m[1]!] = unescapeXml(m[2]!);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds ?? "");
    if (!b) continue;
    const el: UiElement = { text: a.text ?? "", desc: a["content-desc"] ?? "", id: a["resource-id"] ?? "", cls: (a.class ?? "").split(".").pop() ?? "", clickable: a.clickable === "true", bounds: { x1: +b[1]!, y1: +b[2]!, x2: +b[3]!, y2: +b[4]! } };
    if (el.text || el.desc || el.clickable) out.push(el);
  }
  return out;
}

export function adbClient(deps: Deps, adbBin: string, serial = SERIAL): AdbClient {
  const base = [adbBin, "-s", serial];
  const run = async (args: string[], timeoutMs = 30_000) => {
    const r = await deps.exec.run([...base, ...args], { timeoutMs });
    if (r.code !== 0) throw new AdbError(`adb ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || text(r.stdout)).trim().split("\n")[0] || `exit ${r.code}`}`);
    return r;
  };
  const shell = async (args: string[], timeoutMs?: number) => text((await run(["shell", args.map(shq).join(" ")], timeoutMs)).stdout);

  return {
    serial,
    shell,
    async bootCompleted() {
      try {
        return (await shell(["getprop", "sys.boot_completed"], 8000)).trim() === "1";
      } catch {
        return false;
      }
    },
    async screencap() {
      const r = await run(["exec-out", "screencap", "-p"], 20_000);
      const size = pngSize(r.stdout);
      if (!size) throw new AdbError("screencap did not return a PNG.");
      return { bytes: r.stdout, ...size };
    },
    async reverse(port) {
      await run(["reverse", `tcp:${port}`, `tcp:${port}`], 10_000);
    },
    async install(apk) {
      const out = text((await run(["install", "-r", apk], 300_000)).stdout);
      if (!/Success/.test(out)) throw new AdbError(`adb install did not report Success: ${out.trim().split("\n").pop() ?? ""}`);
      return out.trim();
    },
    async logcat(tag, lines) {
      return text((await run(["logcat", "-d", "-t", String(lines), `${tag}:V`, "*:S"], 20_000)).stdout);
    },
    async uiDump() {
      const file = "/sdcard/trb-ui.xml";
      await shell(["uiautomator", "dump", file], 30_000);
      return parseUiDump(text((await run(["exec-out", "cat", file], 15_000)).stdout));
    },
    async avdName() {
      const r = await deps.exec.run([...base, "emu", "avd", "name"], { timeoutMs: 8000 });
      if (r.code !== 0) return null;
      const name = text(r.stdout).split(/\r?\n/)[0]?.trim();
      return name && name !== "OK" ? name : null;
    },
    async rotation() {
      const n = Number((await shell(["settings", "get", "system", "user_rotation"], 8000).catch(() => "0")).trim());
      return n === 1 || n === 2 || n === 3 ? n : 0;
    },
    async kill() {
      await deps.exec.run([...base, "emu", "kill"], { timeoutMs: 10_000 });
    },
  };
}
