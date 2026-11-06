/**
 * How the emulator's screen is read and its input sent. A Transport is polled `screencap` plus `adb shell input`:
 * it works on any emulator, in the rotated screen's coordinates, at 60-170 ms an input. A LiveChannel is the
 * emulator's own gRPC endpoint (grpc.ts): input in well under a millisecond and the screen pushed as it changes.
 */
import type { AdbClient } from "./adb";
import { EMULATOR_KEYS, type EmulatorInput, type EmulatorKey } from "./types";

export class InputError extends Error {}

export interface Frame {
  bytes: Uint8Array;
  mime: "image/png";
  width: number;
  height: number;
}
export interface Transport {
  capture(): Promise<Frame>;
  input(i: EmulatorInput): Promise<void>;
}

/**
 * The emulator's own channel. Its coordinates are the display panel's, which are the screen's only while the
 * device is not rotated, so the owner uses it for the operator's live view in portrait and adb for the rest.
 */
export interface LiveChannel {
  /** The finger: pressed (or moved while pressed) at x,y, or lifted there. */
  touch(x: number, y: number, down: boolean): Promise<void>;
  key(key: EmulatorKey): Promise<void>;
  /** Printable ASCII, one line. */
  text(text: string): Promise<void>;
  /** Every new picture to `onFrame` until the returned stop is called; `onEnd` once if the stream ends by itself. */
  frames(onFrame: (f: Frame) => void, onEnd: (e: Error | null) => void): () => void;
  close(): void;
}

/** A key or typed text over the live channel, held to adb's rules (printable ASCII; a newline is an Enter press). Anything else stays on adb. */
export async function liveInput(ch: LiveChannel, i: EmulatorInput): Promise<void> {
  if (i.kind === "key") {
    if (!KEYCODE[i.key]) throw new InputError(`Unknown key "${i.key}". Keys: ${EMULATOR_KEYS.join(", ")}.`);
    return ch.key(i.key);
  }
  if (i.kind !== "text") throw new InputError(`A ${i.kind} is not sent over the live channel.`);
  if (!i.text) throw new InputError("There is no text to type.");
  const parts = i.text.split(/\r\n|\r|\n/);
  if (parts.some((p) => /[^\x20-\x7e]/.test(p))) throw new InputError("Only printable ASCII can be typed (no accents or emoji).");
  for (let k = 0; k < parts.length; k++) {
    if (parts[k]) await ch.text(parts[k]!);
    if (k < parts.length - 1) await ch.key("enter");
  }
}

const KEYCODE: Record<EmulatorKey, string> = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  recents: "KEYCODE_APP_SWITCH",
  enter: "KEYCODE_ENTER",
  delete: "KEYCODE_DEL",
  tab: "KEYCODE_TAB",
  escape: "KEYCODE_ESCAPE",
  power: "KEYCODE_POWER",
  volume_up: "KEYCODE_VOLUME_UP",
  volume_down: "KEYCODE_VOLUME_DOWN",
  menu: "KEYCODE_MENU",
  dpad_up: "KEYCODE_DPAD_UP",
  dpad_down: "KEYCODE_DPAD_DOWN",
  dpad_left: "KEYCODE_DPAD_LEFT",
  dpad_right: "KEYCODE_DPAD_RIGHT",
};
const ROTATION: Record<"portrait" | "landscape", number> = { portrait: 0, landscape: 1 };

const DEFAULT_LONG_PRESS_MS = 800;
const DEFAULT_SWIPE_MS = 300;
const MAX_GESTURE_MS = 10_000;

const px = (n: number, label: string) => {
  if (!Number.isFinite(n) || n < 0) throw new InputError(`${label} must be a non-negative number of device pixels.`);
  return String(Math.round(n));
};
const ms = (n: number | undefined, fallback: number) => String(Math.min(Math.max(Math.round(n ?? fallback), 50), MAX_GESTURE_MS));

/**
 * What `input text` can take: printable ASCII. Android's `input text` sends each character as a key event, so
 * it cannot type anything outside the keyboard layout (accents, emoji, CJK). Rather than silently drop those
 * characters we refuse the whole string, and the caller tells the agent. A space is `%s`; `input` has no way to
 * type a literal "%s". Newlines are not text: adbTransport splits on them and presses Enter between the parts.
 */
export function escapeText(text: string): string {
  if (!text) throw new InputError("There is no text to type.");
  if (text.includes("%s")) throw new InputError(`The text contains "%s", which Android's input command would type as a space. Rephrase it to avoid that sequence.`);
  if (/[^\x20-\x7e]/.test(text)) throw new InputError("Only printable ASCII can be typed (no newlines, accents or emoji). Use emulator_key enter for a line break.");
  return text.replace(/ /g, "%s");
}

/** The argv after `adb shell` for one input. Pure; adb.shell quotes each word for the device's sh. */
export function inputArgv(i: EmulatorInput): string[] {
  switch (i.kind) {
    case "tap":
      return ["input", "tap", px(i.x, "x"), px(i.y, "y")];
    case "long_press":
      return ["input", "swipe", px(i.x, "x"), px(i.y, "y"), px(i.x, "x"), px(i.y, "y"), ms(i.ms, DEFAULT_LONG_PRESS_MS)];
    case "swipe":
      return ["input", "swipe", px(i.x1, "x1"), px(i.y1, "y1"), px(i.x2, "x2"), px(i.y2, "y2"), ms(i.ms, DEFAULT_SWIPE_MS)];
    case "text":
      return ["input", "text", escapeText(i.text)];
    case "key": {
      const code = KEYCODE[i.key];
      if (!code) throw new InputError(`Unknown key "${i.key}". Keys: ${EMULATOR_KEYS.join(", ")}.`);
      return ["input", "keyevent", code];
    }
    case "rotate": {
      const to = ROTATION[i.to];
      if (to === undefined) throw new InputError(`rotate to must be portrait or landscape.`);
      return ["sh", "-c", `settings put system accelerometer_rotation 0 && settings put system user_rotation ${to}`];
    }
  }
}

export function adbTransport(adb: AdbClient): Transport {
  return {
    async capture() {
      const s = await adb.screencap();
      return { bytes: s.bytes, mime: "image/png", width: s.width, height: s.height };
    },
    async input(i) {
      if (i.kind === "text" && /[\r\n]/.test(i.text)) {
        const parts = i.text.split(/\r\n|\r|\n/);
        for (let k = 0; k < parts.length; k++) {
          if (parts[k]) await adb.shell(inputArgv({ kind: "text", text: parts[k]! }));
          if (k < parts.length - 1) await adb.shell(inputArgv({ kind: "key", key: "enter" }));
        }
        return;
      }
      await adb.shell(inputArgv(i));
    },
  };
}
