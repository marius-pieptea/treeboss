/**
 * Pure logic for the agent-browser view: where a click on the picture lands on the page, when to fetch a new
 * frame, and the words for the status line.
 */

/** The address a browser tab carries when it shows the agent's browser instead of a preview. */
export const AGENT_URL = "trb://agent-browser";
export const isAgentUrl = (url: string | undefined | null): boolean => url === AGENT_URL;

export interface Size {
  width: number;
  height: number;
}

export interface Placed {
  /** Where the picture is drawn inside its box, in box pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/** An `object-contain` picture: the largest copy of the page that fits the box, centred (letterboxed). */
export function placePicture(box: Size, page: Size): Placed {
  if (box.width <= 0 || box.height <= 0 || page.width <= 0 || page.height <= 0) return { x: 0, y: 0, width: 0, height: 0, scale: 1 };
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const width = page.width * scale;
  const height = page.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height, scale };
}

/**
 * A pointer position inside the box -> a point in page pixels, or null when it is on the letterbox margin
 * (clicking the empty bars must not click the page).
 */
export function toPagePoint(pointer: { x: number; y: number }, box: Size, page: Size): { x: number; y: number } | null {
  const p = placePicture(box, page);
  if (p.width === 0) return null;
  const px = pointer.x - p.x;
  const py = pointer.y - p.y;
  if (px < 0 || py < 0 || px > p.width || py > p.height) return null;
  return { x: Math.min(page.width - 1, Math.max(0, Math.round(px / p.scale))), y: Math.min(page.height - 1, Math.max(0, Math.round(py / p.scale))) };
}

/** The inverse, to draw a marker on the picture where a page point is. */
export function toBoxPoint(point: { x: number; y: number }, box: Size, page: Size): { x: number; y: number } {
  const p = placePicture(box, page);
  return { x: p.x + point.x * p.scale, y: p.y + point.y * p.scale };
}

export interface FrameGate {
  /** Highest seq already shown. */
  shown: number;
  inFlight: boolean;
  lastFetchAt: number;
}

/**
 * Whether to fetch a new picture now. One request at a time, never for a seq already shown, and no more than
 * a few a second: a page full of animation otherwise turns the live view into a download.
 */
export function shouldFetchFrame(gate: FrameGate, latestSeq: number, now: number, minIntervalMs = 200): "now" | "later" | "no" {
  if (latestSeq <= gate.shown) return "no";
  if (gate.inFlight) return "later";
  if (now - gate.lastFetchAt < minIntervalMs) return "later";
  return "now";
}

export interface BrowserStateLike {
  open: boolean;
  busy?: boolean;
  actor?: "agent" | "you" | null;
  lastAction?: string | null;
}

/** "Agent is clicking button "Save"…", "You are in control", "Idle". */
export function statusLine(s: BrowserStateLike | null | undefined): { text: string; tone: "agent" | "you" | "idle"; busy: boolean } {
  if (!s || !s.open) return { text: "No page open", tone: "idle", busy: false };
  const action = s.lastAction ? s.lastAction.replace(/^./, (c) => c.toLowerCase()) : "";
  if (s.busy) {
    if (s.actor === "you") return { text: `You: ${action}…`, tone: "you", busy: true };
    return { text: `Agent is ${action.replace(/^(\w+)ing\b/, (_, v) => `${v}ing`)}…`, tone: "agent", busy: true };
  }
  if (s.actor === "you") return { text: "You are in control", tone: "you", busy: false };
  if (s.actor === "agent") return { text: action ? `Agent: ${action}` : "Agent is in control", tone: "agent", busy: false };
  return { text: "Idle", tone: "idle", busy: false };
}

/** Keys the live view forwards as key presses; a single printable character is typed instead. */
const SPECIAL = new Set(["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export type KeyAction = { kind: "type"; text: string } | { kind: "key"; key: string } | null;

export function keyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): KeyAction {
  if (SPECIAL.has(e.key)) return { kind: "key", key: e.shiftKey && e.key === "Tab" ? "Shift+Tab" : e.key };
  // Shortcuts belong to the app, not the page, unless they are plain edits.
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key.length === 1) return { kind: "type", text: e.key };
  return null;
}

/** Group a burst of typed characters into one request. */
export function coalesceTyping(parts: string[]): string {
  return parts.join("");
}

/** Wheel deltas arrive in tiny steps; sum them over a short window and send one scroll. */
export function accumulateWheel(acc: { dx: number; dy: number }, e: { deltaX: number; deltaY: number; deltaMode: number }, pagePx = 800): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pagePx : 1;
  return { dx: acc.dx + e.deltaX * unit, dy: acc.dy + e.deltaY * unit };
}
