/**
 * A screenshot of one element, taken by a headless Chrome that loads the page fresh at the picked address.
 * It does not share the operator's iframe (a cross-origin frame cannot be captured from outside), so a page
 * that depends on a logged-in session may look different; the caller says so when it fails.
 */
import { CHROME_MISSING, findChrome } from "../browser/chrome";
import { newPickFile } from "./picks";

export interface ShotInput {
  url: string;
  selector: string;
  viewport: { width: number; height: number };
}

const loopback = (url: string): boolean => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

const clampViewport = (v: { width: number; height: number }) => ({ width: Math.min(Math.max(v.width, 240), 2400), height: Math.min(Math.max(v.height, 200), 2000) });

/** Loads the page in a fresh headless Chrome and hands it to `take`; any failure comes back as `{ error }`. */
async function withPage(url: string, viewport: { width: number; height: number }, take: (page: import("playwright-core").Page, file: string) => Promise<void>): Promise<{ path: string } | { error: string }> {
  if (!loopback(url)) return { error: "only loopback pages are captured" };
  const chrome = findChrome();
  if (!chrome) return { error: CHROME_MISSING };
  let browser: import("playwright-core").Browser | null = null;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath: chrome.path, headless: true, args: ["--no-first-run", "--no-default-browser-check", "--mute-audio"], timeout: 15_000 });
    const page = await browser.newPage({ viewport: clampViewport(viewport) });
    await page.goto(url, { waitUntil: "load", timeout: 15_000 });
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    const file = newPickFile("png");
    await take(page, file);
    return { path: file };
  } catch (err: any) {
    return { error: String(err?.message ?? err).split("\n")[0].slice(0, 160) };
  } finally {
    await browser?.close().catch(() => {});
  }
}

export function shootElement(input: ShotInput): Promise<{ path: string } | { error: string }> {
  return withPage(input.url, input.viewport, async (page, file) => {
    const loc = page.locator(input.selector).first();
    await loc.waitFor({ state: "attached", timeout: 3000 });
    await loc.screenshot({ path: file, timeout: 8000 });
  });
}

export function shootViewport(input: { url: string; viewport: { width: number; height: number } }): Promise<{ path: string } | { error: string }> {
  return withPage(input.url, input.viewport, async (page, file) => {
    await page.screenshot({ path: file, timeout: 8000 });
  });
}
