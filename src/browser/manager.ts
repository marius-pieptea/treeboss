/**
 * The agent browser: one headless Chrome per daemon, one isolated context per ROOT session.
 *
 * "Root" is the lead of a Hydra tree. A lead and its heads share one browser on purpose: a head that opens
 * the page it just built, and a lead that then checks it, should be looking at the same thing, and the
 * operator watching in the UI sees one live page for the whole tree rather than one per head. Two different
 * leads never share anything: contexts are separate, so cookies, storage and tabs are isolated.
 *
 * The browser is lazy (nothing launches until a tool or the operator first uses it), bounded (contexts, tabs,
 * an idle timeout), and never touches the operator's own browser profile. What it does keep, per project, is the
 * cookies and local storage of its contexts (see signins.ts), so a login outlives the context that made it.
 */
import { CHROME_MISSING, findChrome } from "./chrome";
import { Hub } from "../sessions/hub";
import { getSession } from "../sessions/manager";
import { clearSignins, loadSignins, saveSignins, signinsEnabled, type SignInState } from "./signins";

// Types only: playwright-core is imported on first launch so the daemon starts (and `trb run` works) without it loaded.
import type { Browser, BrowserContext, ConsoleMessage, Page } from "playwright-core";

export const VIEWPORT = { width: 1280, height: 800 } as const;
const MAX_CONTEXTS = 4;
const MAX_TABS = 8;
const IDLE_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 8_000;
const CONSOLE_RING = 200;
const FRAME_INTERVAL_MS = 400;
/** How often a context with unsaved page loads writes its sign-ins to disk. */
const SAVE_EVERY_MS = 30_000;

export class BrowserError extends Error {}

export interface ConsoleEntry {
  ts: number;
  level: "error" | "warning" | "info" | "failed-request" | "page-error";
  text: string;
  url?: string;
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserState {
  open: true;
  rootId: string;
  url: string;
  title: string;
  tabs: TabInfo[];
  active: number;
  lastAction: string | null;
  actor: "agent" | "you" | null;
  busy: boolean;
  /** Bumps whenever the picture may have changed. Clients fetch a new frame when it moves. */
  seq: number;
  width: number;
  height: number;
  consoleErrors: number;
}

type Listener = (s: BrowserState) => void;

/** URL schemes an agent may navigate to. Everything else (file:, chrome:, devtools:, view-source:, data:, ...) is refused. */
export function checkUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const s = raw.trim();
  if (!s) return { ok: false, error: "A URL is required." };
  if (s === "about:blank") return { ok: true, url: s };
  let u: URL;
  try {
    // "localhost:3000" looks like a scheme to the URL parser: a bare host:port is an address, not a scheme.
    const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !/^[^/?#\s:]+:\d+(?:[/?#]|$)/.test(s);
    u = new URL(hasScheme ? s : `http://${s}`);
  } catch {
    return { ok: false, error: `"${s}" is not a valid URL.` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: `${u.protocol} URLs are not allowed in the agent browser (only http and https).` };
  if (u.username || u.password) return { ok: false, error: "URLs with a username or password are not allowed." };
  return { ok: true, url: u.toString() };
}

class Ctx {
  tabs: Page[] = [];
  active = 0;
  console: ConsoleEntry[] = [];
  lastAction: string | null = null;
  actor: "agent" | "you" | null = null;
  busy = 0;
  seq = 0;
  lastUsed = Date.now();
  /** ref (from the last snapshot) -> readable label, for status lines like Clicking "Save". */
  refLabels = new Map<string, string>();
  listeners = new Set<Listener>();
  frame: { buf: Buffer; seq: number; at: number } | null = null;
  frameHash: bigint | number | null = null;
  frameTimer: ReturnType<typeof setInterval> | null = null;
  closed = false;
  /** A page loaded since the sign-ins were last saved. */
  dirty = false;

  constructor(
    public rootId: string,
    public context: BrowserContext,
    /** The project whose saved sign-ins this context started from and writes back to. */
    public workspace: string,
    /** What it started with, so a cookie it later lost (a logout) is not brought back by the merge. */
    public loaded: SignInState | null,
  ) {}

  get page(): Page {
    return this.tabs[this.active] ?? this.tabs[0];
  }
}

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
const contexts = new Map<string, Ctx>();
let sweeper: ReturnType<typeof setInterval> | null = null;
let hubUnsub: (() => void) | null = null;

/** The root of a session's tree, or null when the session does not exist. */
export function rootOf(sessionId: string): string | null {
  const s = getSession(sessionId);
  return s ? s.root_id : null;
}

async function launch(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  const chrome = findChrome();
  if (!chrome) throw new BrowserError(CHROME_MISSING);
  launching = (async () => {
    const { chromium } = await import("playwright-core");
    const b = await chromium.launch({ executablePath: chrome.path, headless: true, args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--mute-audio"] });
    b.on("disconnected", () => {
      browser = null;
      for (const c of contexts.values()) markClosed(c);
      contexts.clear();
    });
    browser = b;
    return b;
  })().finally(() => {
    launching = null;
  });
  return launching;
}

function ensureBackground(): void {
  if (!sweeper) {
    sweeper = setInterval(() => {
      const now = Date.now();
      for (const c of [...contexts.values()]) {
        if (c.busy === 0 && c.listeners.size === 0 && now - c.lastUsed > IDLE_MS) void closeBrowser(c.rootId, "idle");
        else if (c.dirty) void persist(c);
      }
    }, SAVE_EVERY_MS);
    sweeper.unref?.();
  }
  // A closed session takes its browser with it.
  if (!hubUnsub) {
    hubUnsub = Hub.subscribe((e) => {
      if (e.type === "state" && e.status === "closed" && e.sessionId === e.rootId) void closeBrowser(e.rootId, "session closed");
    });
  }
}

function recordConsole(c: Ctx, entry: Omit<ConsoleEntry, "ts">): void {
  c.console.push({ ts: Date.now(), ...entry });
  if (c.console.length > CONSOLE_RING) c.console.splice(0, c.console.length - CONSOLE_RING);
}

function wirePage(c: Ctx, page: Page): void {
  page.on("console", (m: ConsoleMessage) => {
    const t = m.type();
    if (t === "error" || t === "warning") recordConsole(c, { level: t === "error" ? "error" : "warning", text: m.text().slice(0, 600), url: m.location()?.url });
  });
  page.on("pageerror", (e) => recordConsole(c, { level: "page-error", text: String(e.message ?? e).slice(0, 600) }));
  page.on("requestfailed", (r) => {
    // A request cancelled by navigation is not a failure worth reporting.
    const err = r.failure()?.errorText ?? "";
    if (/ERR_ABORTED/.test(err)) return;
    recordConsole(c, { level: "failed-request", text: `${r.method()} ${r.url().slice(0, 300)} (${err})` });
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && r.request().resourceType() !== "other") recordConsole(c, { level: "failed-request", text: `${r.request().method()} ${r.url().slice(0, 300)} -> ${r.status()}` });
  });
  // A page that ends up somewhere forbidden (a redirect chain, script-driven navigation) is sent back to a blank page.
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) return;
    const v = checkUrl(f.url());
    if (!v.ok && f.url() !== "about:blank" && !f.url().startsWith("chrome-error:")) {
      recordConsole(c, { level: "error", text: `Blocked navigation to ${f.url().slice(0, 120)}: ${v.error}` });
      void page.goto("about:blank").catch(() => {});
    }
    touch(c);
  });
  page.on("load", () => {
    c.dirty = true;
    touch(c);
  });
  page.on("close", () => {
    const i = c.tabs.indexOf(page);
    if (i === -1) return;
    c.tabs.splice(i, 1);
    if (c.active >= c.tabs.length) c.active = Math.max(0, c.tabs.length - 1);
    touch(c);
  });
}

function adoptPage(c: Ctx, page: Page, activate: boolean): void {
  c.tabs.push(page);
  wirePage(c, page);
  if (activate) c.active = c.tabs.length - 1;
  touch(c);
}

function markClosed(c: Ctx): void {
  c.closed = true;
  if (c.frameTimer) clearInterval(c.frameTimer);
  c.frameTimer = null;
  for (const l of c.listeners) l({ ...snapshotState(c), tabs: [], url: "", title: "" });
}

/** Something about the page changed: tell watchers (they fetch a new frame). */
function touch(c: Ctx): void {
  c.lastUsed = Date.now();
  c.seq++;
  notify(c);
}

function notify(c: Ctx): void {
  if (!c.listeners.size) return;
  const s = snapshotState(c);
  for (const l of c.listeners) {
    try {
      l(s);
    } catch {}
  }
}

function snapshotState(c: Ctx): BrowserState {
  const tabs = c.tabs.map((p, i) => ({ index: i, url: p.url(), title: titleCache.get(p) ?? "", active: i === c.active }));
  const page = c.page;
  return {
    open: true,
    rootId: c.rootId,
    url: page?.url() ?? "",
    title: page ? (titleCache.get(page) ?? "") : "",
    tabs,
    active: c.active,
    lastAction: c.lastAction,
    actor: c.actor,
    busy: c.busy > 0,
    seq: c.seq,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    consoleErrors: c.console.filter((e) => e.level === "error" || e.level === "page-error").length,
  };
}

const titleCache = new WeakMap<Page, string>();
async function refreshTitles(c: Ctx): Promise<void> {
  await Promise.all(
    c.tabs.map(async (p) => {
      try {
        titleCache.set(p, await p.title());
      } catch {}
    }),
  );
}

/** Get (launching if needed) the context for a session's tree. */
export async function getContext(sessionId: string): Promise<Ctx> {
  const rootId = rootOf(sessionId);
  if (!rootId) throw new BrowserError(`No session "${sessionId}".`);
  const existing = contexts.get(rootId);
  if (existing && !existing.closed) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (contexts.size >= MAX_CONTEXTS) {
    // Make room by closing the least recently used idle one; refuse when every one is busy.
    const idle = [...contexts.values()].filter((c) => c.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) throw new BrowserError(`Too many agent browsers are open (${MAX_CONTEXTS}). Close one first.`);
    await closeBrowser(idle.rootId, "evicted");
  }
  const b = await launch();
  ensureBackground();
  const workspace = getSession(rootId)?.base_cwd ?? "";
  const loaded = workspace ? loadSignins(workspace) : null;
  const context = await b.newContext({ viewport: { ...VIEWPORT }, acceptDownloads: false, serviceWorkers: "block", locale: "en-US", ...(loaded ? { storageState: loaded } : {}) });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  const c = new Ctx(rootId, context, workspace, loaded);
  contexts.set(rootId, c);
  // Every new page (a tab we opened, a popup, a target=_blank link) arrives here exactly once. Bounded:
  // a page that tries to open a flood of windows gets the first few.
  context.on("page", (p) => {
    if (c.tabs.includes(p)) return;
    if (c.tabs.length >= MAX_TABS) void p.close().catch(() => {});
    else adoptPage(c, p, true);
  });
  const first = await context.newPage();
  if (!c.tabs.includes(first)) adoptPage(c, first, true);
  return c;
}

/** The state of a session's browser without launching one. */
export function peekState(sessionId: string): BrowserState | null {
  const rootId = rootOf(sessionId);
  const c = rootId ? contexts.get(rootId) : null;
  return c && !c.closed ? snapshotState(c) : null;
}

export async function stateOf(sessionId: string): Promise<BrowserState | null> {
  const rootId = rootOf(sessionId);
  const c = rootId ? contexts.get(rootId) : null;
  if (!c || c.closed) return null;
  await refreshTitles(c);
  return snapshotState(c);
}

/** Write a context's cookies and storage to its project's saved sign-ins. Never throws: a failed save must not break a close. */
async function persist(c: Ctx): Promise<void> {
  if (!signinsEnabled()) return;
  try {
    const state = (await c.context.storageState()) as SignInState;
    saveSignins(c.workspace, c.loaded, state);
    c.loaded = state;
    c.dirty = false;
  } catch {}
}

export async function closeBrowser(rootId: string, _reason = "closed"): Promise<boolean> {
  const c = contexts.get(rootId);
  if (!c) return false;
  contexts.delete(rootId);
  markClosed(c);
  await persist(c);
  await c.context.close().catch(() => {});
  return true;
}

export async function shutdownBrowsers(): Promise<void> {
  for (const id of [...contexts.keys()]) await closeBrowser(id, "shutdown");
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  hubUnsub?.();
  hubUnsub = null;
  const b = browser;
  browser = null;
  await b?.close().catch(() => {});
}

/** Forget a project's saved sign-ins, and the cookies of its browsers that are open right now. */
export async function forgetSignins(workspace: string): Promise<void> {
  clearSignins(workspace);
  for (const c of contexts.values()) {
    if (c.workspace !== workspace) continue;
    await c.context.clearCookies().catch(() => {});
    for (const page of c.tabs) await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});
    c.loaded = null;
    c.dirty = false;
  }
}

export function openContextCount(): number {
  return contexts.size;
}

/* -------------------------------------------------------------------------- */
/* Acting                                                                     */
/* -------------------------------------------------------------------------- */

export interface ActOptions {
  /** Short, human text for the status line ("Clicking \"Save\""). */
  label: string;
  actor: "agent" | "you";
  /** The session on whose behalf this runs, for the hub event. */
  sessionId: string;
}

/**
 * Run an action against the active page, marking the browser busy while it runs, publishing what is
 * happening, and letting the page settle afterwards (a click usually starts a navigation or a fetch).
 */
export async function act<T>(c: Ctx, o: ActOptions, fn: (page: Page) => Promise<T>): Promise<T> {
  c.busy++;
  c.lastAction = o.label;
  c.actor = o.actor;
  c.lastUsed = Date.now();
  touch(c);
  if (o.actor === "agent") Hub.publish({ type: "browser", sessionId: o.sessionId, rootId: c.rootId, url: c.page?.url() ?? "", action: o.label });
  try {
    const out = await fn(c.page);
    await settle(c.page);
    return out;
  } finally {
    c.busy--;
    c.lastUsed = Date.now();
    try {
      await refreshTitles(c);
    } catch {}
    touch(c);
  }
}

/** Let a navigation start, then wait (bounded) for the page to calm down. */
export async function settle(page: Page): Promise<void> {
  await new Promise((r) => setTimeout(r, 120));
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
}

export function ctxConsole(c: Ctx, o: { clear?: boolean; level?: string } = {}): ConsoleEntry[] {
  const out = c.console.filter((e) => !o.level || o.level === "all" || e.level === o.level || (o.level === "error" && e.level === "page-error"));
  if (o.clear) c.console = [];
  return out;
}

export function setActiveTab(c: Ctx, index: number): void {
  if (index < 0 || index >= c.tabs.length) throw new BrowserError(`No tab ${index}. Tabs: 0..${c.tabs.length - 1}.`);
  c.active = index;
  touch(c);
}

export async function newTab(c: Ctx, url?: string): Promise<Page> {
  if (c.tabs.length >= MAX_TABS) throw new BrowserError(`Too many tabs (${MAX_TABS}). Close one first.`);
  const page = await c.context.newPage();
  if (!c.tabs.includes(page)) adoptPage(c, page, true);
  c.active = Math.max(0, c.tabs.indexOf(page));
  if (url) {
    const v = checkUrl(url);
    if (!v.ok) throw new BrowserError(v.error);
    await page.goto(v.url, { waitUntil: "domcontentloaded" });
  }
  touch(c);
  return page;
}

export async function closeTab(c: Ctx, index: number): Promise<void> {
  const page = c.tabs[index];
  if (!page) throw new BrowserError(`No tab ${index}.`);
  if (c.tabs.length === 1) {
    await page.goto("about:blank").catch(() => {});
    return;
  }
  await page.close();
}

/* -------------------------------------------------------------------------- */
/* Frames for the live view                                                   */
/* -------------------------------------------------------------------------- */

/** A JPEG of the current viewport. Cached for a moment so many watchers cost one capture. */
export async function captureFrame(c: Ctx, o: { force?: boolean } = {}): Promise<{ buf: Buffer; seq: number }> {
  const now = Date.now();
  if (!o.force && c.frame && now - c.frame.at < 250) return c.frame;
  const buf = await c.page.screenshot({ type: "jpeg", quality: 70, timeout: 5000, animations: "allow", caret: "hide" });
  c.frame = { buf, seq: c.seq, at: Date.now() };
  return c.frame;
}

/**
 * Subscribe to a session's browser. While anyone is watching, the page is sampled a few times a second and a
 * notification goes out only when the picture actually changed (a spinner or an animation on the page counts);
 * with no watchers nothing is captured at all.
 */
export function watch(sessionId: string, l: Listener): (() => void) | null {
  const rootId = rootOf(sessionId);
  const c = rootId ? contexts.get(rootId) : null;
  if (!c || c.closed) return null;
  c.listeners.add(l);
  if (!c.frameTimer) {
    c.frameTimer = setInterval(() => {
      if (c.closed || !c.listeners.size) return;
      void (async () => {
        try {
          const f = await captureFrame(c, { force: true });
          const h = Bun.hash(f.buf);
          if (c.frameHash !== null && h !== c.frameHash) touch(c);
          c.frameHash = h;
        } catch {}
      })();
    }, FRAME_INTERVAL_MS);
    c.frameTimer.unref?.();
  }
  return () => {
    c.listeners.delete(l);
    if (!c.listeners.size && c.frameTimer) {
      clearInterval(c.frameTimer);
      c.frameTimer = null;
    }
  };
}

export type { Ctx as BrowserContextState };
