/**
 * Pure logic for the emulator view: where a pointer lands on the phone, what a press-and-release means, and what a
 * key press means to the device.
 */
import { toPagePoint, type Size } from "../browser/agent-logic";
import type { Actor, EmulatorInput, EmulatorKey, EmulatorState, InstallStep } from "./emulator-api";

/** A pointer position inside the box -> a point in device pixels, or null on the letterbox margin (the empty bars must not tap the phone). */
export const toDevicePoint: (pointer: { x: number; y: number }, box: Size, device: Size) => { x: number; y: number } | null = toPagePoint;

/** Further than this (device pixels) between press and release is a drag, not a tap. */
export const MOVE_SLOP_PX = 16;
/** Held still at least this long is a long press. */
export const LONG_PRESS_MS = 500;
/** The device registers a swipe over fewer frames as a tap. */
export const MIN_SWIPE_MS = 50;

type Point = { x: number; y: number };

export function classifyGesture(down: Point, up: Point, ms: number): Extract<EmulatorInput, { kind: "tap" | "long_press" | "swipe" }> {
  if (Math.hypot(up.x - down.x, up.y - down.y) > MOVE_SLOP_PX) return { kind: "swipe", x1: down.x, y1: down.y, x2: up.x, y2: up.y, ms: Math.max(MIN_SWIPE_MS, Math.round(ms)) };
  if (ms >= LONG_PRESS_MS) return { kind: "long_press", x: down.x, y: down.y, ms: Math.round(ms) };
  return { kind: "tap", x: down.x, y: down.y };
}

/** One thing for the live channel, sent in order: the finger (pressed, moved, lifted), a key, or typed text. */
export type LiveItem = { kind: "pointer"; phase: "down" | "move" | "up"; x: number; y: number } | { kind: "input"; input: Extract<EmulatorInput, { kind: "key" | "text" }> };

/**
 * Adds an item to what waits while a request is out. A move replaces a move still waiting (only where the finger is
 * now matters) and text joins text still waiting; a press, a release and a key are never dropped or reordered.
 */
export function queueLive(waiting: LiveItem[], item: LiveItem): LiveItem[] {
  const tail = waiting[waiting.length - 1];
  if (tail?.kind === "pointer" && tail.phase === "move" && item.kind === "pointer" && item.phase === "move") return [...waiting.slice(0, -1), item];
  if (tail?.kind === "input" && tail.input.kind === "text" && item.kind === "input" && item.input.kind === "text") return [...waiting.slice(0, -1), { kind: "input", input: { kind: "text", text: tail.input.text + item.input.text } }];
  return [...waiting, item];
}

const KEYS: Record<string, EmulatorKey> = {
  Backspace: "delete",
  Enter: "enter",
  Tab: "tab",
  Escape: "escape",
  ArrowUp: "dpad_up",
  ArrowDown: "dpad_down",
  ArrowLeft: "dpad_left",
  ArrowRight: "dpad_right",
};

export type DeviceKeyAction = { kind: "key"; key: EmulatorKey } | { kind: "text"; text: string } | null;

export function keyFromEvent(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): DeviceKeyAction {
  // Shortcuts belong to the app, not the phone.
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = KEYS[e.key];
  if (k) return { kind: "key", key: k };
  if (e.key.length === 1) return { kind: "text", text: e.key };
  return null;
}

/** The one value the view branches on: the SDK's state first, and the device's only once the SDK is installed. */
export type Screen = "absent" | "resolving" | "needs-license" | "installing" | "removing" | "sdk-failed" | "stopped" | "booting" | "running" | "stopping" | "device-failed";

export function screenOf(s: Pick<EmulatorState, "sdk" | "device">): Screen {
  switch (s.sdk.kind) {
    case "absent":
    case "resolving":
    case "needs-license":
    case "installing":
    case "removing":
      return s.sdk.kind;
    case "failed":
      return "sdk-failed";
    case "installed":
      return s.device.kind === "failed" ? "device-failed" : s.device.kind;
  }
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(0, Math.round(n / 1e3))} KB`;
}

/** 0..1, never past the ends: totals arrive before the first byte does. */
export const progressOf = (done: number, total: number): number => (total > 0 ? Math.min(1, Math.max(0, done / total)) : 0);

export function stepLabel(step: InstallStep): string {
  if (step.pkg === "avd") return "Creating the virtual device";
  const verb = step.phase === "download" ? "Downloading" : step.phase === "verify" ? "Checking" : "Unpacking";
  return `${verb} ${step.pkg}`;
}

/** Who touched the phone last: the operator, or an agent (named by its session). */
export function actorLabel(a: Actor): string {
  return a.kind === "you" ? "You" : `Agent ${a.sessionId.slice(-6)}`;
}

/** The rotation the toolbar's button asks for: the other one than the frame shows. */
export const rotateTarget = (screen: Size): "portrait" | "landscape" => (screen.width > screen.height ? "portrait" : "landscape");
