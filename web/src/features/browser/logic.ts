/**
 * Pure logic for the preview tab: URL normalisation and the safety rules around it, device frames.
 */

import type { BugKind } from "../lab/kinds";

export interface UiOrigin {
  /** e.g. "http://127.0.0.1:4477": the origin this app is served from. */
  origin: string;
  hostname: string;
  port: string;
}

export type UrlResult = { ok: true; url: string; rewrittenHost?: boolean } | { ok: false; error: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

function isLocalHost(host: string): boolean {
  return LOOPBACK.has(host) || /^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local") || host.endsWith(".localhost");
}

/**
 * Turn what someone typed into a URL a preview may load, or say why not.
 *
 * Rules, each there for a reason:
 *  - only http/https: `javascript:`, `data:`, `file:` and friends never load in the frame;
 *  - never this app's own origin: a page framed from it would run beside the signed-in session;
 *  - loopback previews use the OTHER loopback name than the app does (the app on 127.0.0.1, previews on
 *    localhost, and vice versa): cookies are scoped by host, so the app's session cookie is then never sent
 *    to, or readable by, whatever dev server is being previewed;
 *  - no credentials in URLs, no search-engine guessing for bare words.
 */
export function normalizeUrl(input: string, ui: UiOrigin): UrlResult {
  let s = input.trim();
  if (!s) return { ok: false, error: "Enter a URL, like localhost:3000" };

  // ":3000", ":3000/path", "3000"
  const portOnly = /^:?(\d{2,5})(\/.*)?$/.exec(s);
  if (portOnly) {
    const port = Number(portOnly[1]);
    if (port < 1 || port > 65535) return { ok: false, error: `${portOnly[1]} is not a valid port` };
    s = `http://localhost:${port}${portOnly[2] ?? ""}`;
  } else if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) || /^(\[[^\]]+\]|[^/?#\s:]+):\d+(?:[/?#]|$)/.test(s)) {
    // No scheme (or "host:port" which looks like one). Decide http vs https from the host.
    const hostPart = /^([^/?#:]+|\[[^\]]+\])/.exec(s)?.[1] ?? "";
    const looksHost = hostPart === "localhost" || hostPart.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostPart) || (hostPart.includes(".") && !/\s/.test(s));
    if (!looksHost) return { ok: false, error: "That does not look like a URL. Try localhost:3000 or https://example.com" };
    s = `${isLocalHost(hostPart) ? "http" : "https"}://${s}`;
  }

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "That is not a valid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: `${u.protocol} URLs cannot be previewed` };
  if (u.username || u.password) return { ok: false, error: "URLs with a username or password are not allowed" };

  const host = u.hostname === "::1" ? "[::1]" : u.hostname;
  const uiPort = ui.port || (ui.origin.startsWith("https") ? "443" : "80");
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const sameHost = LOOPBACK.has(host) || host === ui.hostname;
  if (sameHost && port === uiPort) return { ok: false, error: "This is the app itself. It cannot be previewed inside itself." };

  let rewrittenHost = false;
  if (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "0.0.0.0") {
    const want = ui.hostname === "localhost" ? "127.0.0.1" : "localhost";
    if (host !== want) {
      u.hostname = want;
      rewrittenHost = true;
    }
  }
  let out = u.toString();
  if (u.pathname === "/" && !u.search && !u.hash) out = out.replace(/\/$/, "");
  return { ok: true, url: out, rewrittenHost };
}

/** A short title for a tab: "localhost:3000/docs". */
export function titleFor(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}

/* ------------------------------------------------------------ the frame's own navigation */

export interface History {
  stack: string[];
  i: number;
}

/** What the injected script posts when the page's location changes. */
export function isLocationMessage(d: unknown): d is { type: "trb-location"; href: string; replace?: boolean } {
  return !!d && typeof d === "object" && (d as any).type === "trb-location" && typeof (d as any).href === "string";
}

/** The address the operator should see for a location reported from behind the proxy, or null if it is not on the proxy. */
export function userFacingUrl(href: string, proxyPort: number, targetPort: number): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || u.port !== String(proxyPort)) return null;
  u.port = String(targetPort);
  const out = u.toString();
  return u.pathname === "/" && !u.search && !u.hash ? out.replace(/\/$/, "") : out;
}

/** The history after the page itself moved to `url`: same entry stays, replaceState swaps it, anything else is a new entry. */
export function followFrame(h: History, url: string, replace: boolean): History {
  if (h.stack[h.i] === url) return h;
  if (h.i < 0) return { stack: [url], i: 0 };
  const base = h.stack.slice(0, replace ? h.i : h.i + 1);
  return { stack: [...base, url], i: base.length };
}

/* ------------------------------------------------------------ device frame */

export interface Device {
  id: string;
  label: string;
  /** null width = responsive. */
  w: number | null;
  h: number | null;
  kind: "responsive" | "phone" | "tablet" | "laptop" | "desktop";
}

export const DEVICES: Device[] = [
  { id: "responsive", label: "Responsive", w: null, h: null, kind: "responsive" },
  { id: "iphone", label: "iPhone 15", w: 393, h: 852, kind: "phone" },
  { id: "ipad", label: "iPad", w: 820, h: 1180, kind: "tablet" },
  { id: "laptop", label: "Laptop", w: 1280, h: 800, kind: "laptop" },
  { id: "desktop", label: "Desktop", w: 1920, h: 1080, kind: "desktop" },
];

export interface Frame {
  /** CSS pixels the page believes its viewport is. */
  width: number;
  height: number;
  /** transform: scale() applied to the frame. */
  scale: number;
}

export const MIN_RESPONSIVE_W = 240;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

/**
 * Size and scale of the preview frame inside a pane of `avail` pixels.
 *  - responsive: the page gets `responsiveW` wide and fills the pane's height; `zoom` scales it.
 *  - a device: its own size (swapped when rotated); `fit` shrinks it to the pane (never enlarges),
 *    otherwise `zoom` applies.
 */
export function computeFrame(o: { device: Device; rotated: boolean; avail: { w: number; h: number }; zoom: number; fit: boolean; responsiveW: number }): Frame {
  const { device, avail } = o;
  if (device.w === null || device.h === null) {
    const scale = clampZoom(o.zoom);
    const width = Math.max(MIN_RESPONSIVE_W, Math.round(o.responsiveW));
    return { width, height: Math.max(100, Math.floor(avail.h / scale)), scale };
  }
  const w = o.rotated ? device.h : device.w;
  const h = o.rotated ? device.w : device.h;
  const scale = o.fit ? Math.min(1, Math.max(0.05, avail.w / w), Math.max(0.05, avail.h / h)) : clampZoom(o.zoom);
  return { width: w, height: h, scale };
}

/** The initial responsive width: the pane, as the page would see it at the current zoom. */
export function defaultResponsiveWidth(availW: number, zoom: number): number {
  return Math.max(MIN_RESPONSIVE_W, Math.floor(availW / clampZoom(zoom)));
}

/* ------------------------------------------------------------ reachability */

export type Reach = "up" | "down" | "unknown";

/**
 * Is a local server listening where this URL points? Answered from the daemon's list of listening ports, not
 * by fetching from the page: a cross-origin fetch to another loopback address trips the browser's local-network
 * permission prompt, and the app's CSP forbids it anyway. Non-local hosts cannot be judged (`unknown`), and an
 * empty list means the daemon could not enumerate ports at all (it always has its own listener).
 */
export function reachability(url: string, listening: Array<{ port: number }>): Reach {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "unknown";
  }
  const host = u.hostname;
  if (!(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1")) return "unknown";
  if (listening.length === 0) return "unknown";
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return listening.some((p) => p.port === port) ? "up" : "down";
}

/** One thing the operator did in the page, as the injected script records it. */
export type Step =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target: string }
  | { kind: "input"; target: string; value: string | null }
  | { kind: "submit"; target: string }
  | { kind: "key"; key: "Enter" | "Escape"; target: string };

export const MAX_STEPS = 50;

export interface TimedStep {
  step: Step;
  at: number;
}

/** What the injected script posts for each step. */
export function isStepMessage(d: unknown): d is { type: "trb-step"; step: Step } {
  if (!d || typeof d !== "object" || (d as any).type !== "trb-step") return false;
  const s = (d as any).step;
  if (!s || typeof s !== "object") return false;
  switch (s.kind) {
    case "navigate":
      return typeof s.url === "string";
    case "click":
    case "submit":
      return typeof s.target === "string";
    case "input":
      return typeof s.target === "string" && (s.value === null || typeof s.value === "string");
    case "key":
      return typeof s.target === "string" && (s.key === "Enter" || s.key === "Escape");
    default:
      return false;
  }
}

/** The newest `MAX_STEPS` steps, oldest first. */
export function pushStep(ring: TimedStep[], step: Step, at: number): TimedStep[] {
  return [...ring, { step, at }].slice(-MAX_STEPS);
}

/** `role "name"` as the injected script writes a target, or null when the target is a selector. */
function named(target: string): { role: string; name: string } | null {
  const m = /^([a-z-]+) "(.*)"$/.exec(target);
  return m ? { role: m[1]!, name: m[2]! } : null;
}

const quoted = (target: string) => {
  const n = named(target);
  return n ? `"${n.name}"` : target;
};

/** A step as one line a person can follow, such as `Click "Pay now" button`. */
export function stepLine(s: Step): string {
  switch (s.kind) {
    case "navigate":
      return `Go to ${s.url}`;
    case "click": {
      const n = named(s.target);
      return n ? `Click "${n.name}" ${n.role}` : `Click ${s.target}`;
    }
    case "submit": {
      const n = named(s.target);
      return n ? `Submit "${n.name}" ${n.role}` : `Submit ${s.target}`;
    }
    case "key":
      return /^(body|html)$/.test(s.target) ? `Press ${s.key}` : `Press ${s.key} in ${quoted(s.target)}`;
    case "input": {
      const n = named(s.target);
      const to = quoted(s.target);
      if (s.value === null) return `Fill in ${to} (value not recorded)`;
      if (n?.role === "checkbox" || n?.role === "radio") return `${s.value === "on" ? "Check" : "Uncheck"} ${to}`;
      const v = s.value.replace(/\s+/g, " ");
      if (!v) return `Clear ${to}`;
      return n?.role === "select" ? `Select "${v}" in ${to}` : `Type "${v}" into ${to}`;
    }
  }
}

export const DIALOG_STEPS = 15;

/** The lines the bug dialog starts with: the last steps, newest last. */
export function stepLines(ring: TimedStep[], max = DIALOG_STEPS): string[] {
  return ring.slice(-max).map((t) => stepLine(t.step));
}

/** `list` with the item at `i` moved one place up (-1) or down (1). A move off either end changes nothing. */
export function moveItem<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

export const MAX_TITLE = 200;
export const MAX_BUG_STEPS = 50;
export const MAX_BUG_STEP = 300;

export const QA_COMPACT_BELOW = 720;

/** Where the QA panel docks: beside the frame, or as a strip under it when the browser is narrow. */
export const qaDock = (width: number): "side" | "strip" => (width < QA_COMPACT_BELOW ? "strip" : "side");

/** The lines for the steps recorded at or after `since`, newest `DIALOG_STEPS` of them. */
export function stepsSince(ring: TimedStep[], since: number): string[] {
  return stepLines(ring.filter((t) => t.at >= since));
}

/** `path` on the origin of `base`, for a QA step that points at a page. Null when there is no page to take the origin from. */
export function resolvePath(path: string, base: string | null): string | null {
  if (!base) return null;
  try {
    const u = new URL(base);
    return new URL(path, u.origin).toString();
  } catch {
    return null;
  }
}

/** What a caller (the QA panel) fills the bug dialog with. */
export interface BugPrefill {
  title: string;
  kind: BugKind;
  steps: string[];
  expected: string;
  actual: string;
}

export interface DraftState {
  title: string;
  kind: BugKind;
  steps: string[];
  expected: string;
  actual: string;
}

/** The dialog's fields when it opens: the prefill, or an empty bug with the steps recorded in the preview. */
export function initialDraft(prefill: BugPrefill | undefined, recorded: string[]): DraftState {
  if (!prefill) return { title: "", kind: "functional", steps: recorded, expected: "", actual: "" };
  return { ...prefill, title: prefill.title.slice(0, MAX_TITLE), steps: prefill.steps.slice(-MAX_BUG_STEPS) };
}
