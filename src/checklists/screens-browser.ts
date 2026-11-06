/**
 * The browser side of the screenshot judgement (screens.ts): a headless Chrome loads the served page in each viewport, measures
 * every link and button, and takes the picture. Modelled on preview/shot.ts, so it has the same limits: only loopback pages
 * (a dev server) are loaded, and a page behind a login looks as a visitor sees it. The measuring is a script run in the page;
 * what the measurements mean is decided in screens.ts, where the call to action vocabulary is.
 */
import { CHROME_MISSING, findChrome } from "../browser/chrome";
import { VIEWPORTS, type PageMeasure, type MeasuredAction, type Shooter, type Shot, type ViewportName } from "./screens";

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
/** A page has hundreds of links; a call to action is never past the first few hundred of them. */
const MAX_ACTIONS = 300;

/** Run in the page. Reads, never changes: the element rects, and what covers or pins each. */
const MEASURE = `(() => {
  const label = (el) => (el.getAttribute("aria-label") || el.innerText || el.value || el.title || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  const visible = (el, r) => {
    if (r.width <= 0 || r.height <= 0 || el.closest('[aria-hidden="true"]')) return false;
    if (getComputedStyle(el).visibility === "hidden") return false;
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || Number(s.opacity) === 0) return false;
    }
    return true;
  };
  const pinned = (el) => {
    for (let n = el; n; n = n.parentElement) if (["fixed", "sticky"].includes(getComputedStyle(n).position)) return true;
    return false;
  };
  const actions = [];
  for (const el of document.querySelectorAll('a[href], button, input[type="submit"], input[type="button"], [role="button"]')) {
    if (actions.length >= ${MAX_ACTIONS}) break;
    const text = label(el);
    if (!text) continue;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    actions.push({
      label: text,
      kind: el.tagName === "A" || el.getAttribute("role") === "link" ? "link" : "button",
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      visible: visible(el, r),
      topmost: !!hit && (hit === el || el.contains(hit)),
      pinned: pinned(el),
    });
  }
  return { url: location.href, innerHeight: window.innerHeight, scrollHeight: document.documentElement.scrollHeight, actions };
})()`;

interface InPage {
  url: string;
  innerHeight: number;
  scrollHeight: number;
  actions: MeasuredAction[];
}

/** Loads the page in each viewport and returns its measurements and pictures. One browser serves all the viewports. */
export function browserShooter(): Shooter {
  return async (url, viewports) => {
    const u = (() => {
      try {
        return new URL(url);
      } catch {
        return null;
      }
    })();
    if (!u || !LOOPBACK.includes(u.hostname)) return { error: "only loopback pages are screenshotted" };
    const chrome = findChrome();
    if (!chrome) return { error: CHROME_MISSING };
    let browser: import("playwright-core").Browser | null = null;
    try {
      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath: chrome.path, headless: true, args: ["--no-first-run", "--no-default-browser-check", "--mute-audio"], timeout: 15_000 });
      const shots: Shot[] = [];
      for (const viewport of viewports) shots.push(await shoot(browser, url, viewport));
      return { shots };
    } catch (err: any) {
      return { error: String(err?.message ?? err).split("\n")[0]!.slice(0, 160) };
    } finally {
      await browser?.close().catch(() => {});
    }
  };
}

async function shoot(browser: import("playwright-core").Browser, url: string, viewport: ViewportName): Promise<Shot> {
  const page = await browser.newPage({ viewport: VIEWPORTS[viewport] });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 15_000 });
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    const topRead = (await page.evaluate(MEASURE)) as InPage;
    const png = await page.screenshot({ type: "png" });
    let scrolled: MeasuredAction[] | null = null;
    let scrolledPng: Uint8Array | null = null;
    // A phone is where a bar that stays on screen matters; the page is scrolled well down, not to the very end, where a footer sits.
    if (viewport === "mobile" && topRead.scrollHeight > topRead.innerHeight) {
      const to = Math.min(Math.max(2 * topRead.innerHeight, topRead.scrollHeight / 2), topRead.scrollHeight - topRead.innerHeight);
      await page.evaluate(`window.scrollTo({ top: ${Math.round(to)}, behavior: "instant" })`);
      await page.waitForTimeout(250);
      scrolled = ((await page.evaluate(MEASURE)) as InPage).actions;
      scrolledPng = await page.screenshot({ type: "png" });
    }
    const measure: PageMeasure = { viewport, url: page.url(), innerHeight: topRead.innerHeight, scrollHeight: topRead.scrollHeight, top: topRead.actions, scrolled };
    return { viewport, measure, png, scrolledPng };
  } finally {
    await page.close().catch(() => {});
  }
}
