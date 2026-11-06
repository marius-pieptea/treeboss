/**
 * The operating-system side of computer use: what the executor asks of the machine, in the display's points.
 * One driver per platform. Only macOS has one for now; everything above this file is platform-neutral, and tests
 * swap in a fake through setComputerDriver.
 */
import { getSetting } from "../settings";
import type { Rect, Size } from "./space";
import { macDriver } from "./macos";
import { windowsDriver } from "./windows";

export type MouseButton = "left" | "right" | "middle";
export type ScrollDirection = "up" | "down" | "left" | "right";

export interface ComputerDriver {
  /** The main display's size in points. */
  displaySize(): Promise<Size>;
  /** A JPEG of the main display, or of `region` (points). `out` resizes it exactly; without it the image is capped at 1280px. */
  capture(o: { region?: Rect; out?: Size }): Promise<Buffer>;
  click(p: { x: number; y: number }, button: MouseButton, clicks: number): Promise<void>;
  move(p: { x: number; y: number }): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>;
  scroll(p: { x: number; y: number } | null, direction: ScrollDirection, lines: number): Promise<void>;
  type(text: string): Promise<void>;
  /** A key name or chord, e.g. "Return" or "cmd+shift+4". The caller has checked it parses. */
  key(chord: string): Promise<void>;
}

let override: ComputerDriver | null = null;

/** Tests use this to drive a fake machine. Pass null to go back to the platform's driver. */
export function setComputerDriver(d: ComputerDriver | null): void {
  override = d;
}

/** The driver for this machine, or null when computer use has none here. */
export function activeDriver(): ComputerDriver | null {
  if (override) return override;
  if (process.platform === "darwin") return macDriver;
  if (process.platform === "win32") return windowsDriver;
  return null;
}

/** Whether computer use is switched on. Checked on every call, so switching it off takes effect at once. */
export function computerUseEnabled(): boolean {
  return getSetting("computer_use") === "on";
}

/** Whether sessions should be handed the computer tools: switched on, and this machine has a driver for them. */
export function computerUseAvailable(): boolean {
  return computerUseEnabled() && activeDriver() !== null;
}
