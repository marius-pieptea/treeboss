/**
 * Finding a Chrome-family browser for the agent browser. The daemon drives it over the DevTools protocol,
 * so any Chromium-based binary works; there is nothing to download.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { runCmd } from "../git/run";
import { getSetting } from "../settings";

export interface ChromeInfo {
  path: string;
  /** Where the path came from, for the doctor and for error messages. */
  source: "env" | "installed" | "playwright-cache" | "path";
}

const MAC_APPS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];
/** The standard Windows installs, from the environment's folders: Chrome first, then Edge (always there on Windows 10 and 11). */
export function windowsBrowsers(env: Record<string, string | undefined>): string[] {
  const pf = env.PROGRAMFILES;
  const pf86 = env["PROGRAMFILES(X86)"];
  const local = env.LOCALAPPDATA;
  const under = (base: string | undefined, ...rel: string[]) => (base ? [path.win32.join(base, ...rel)] : []);
  const chrome = ["Google", "Chrome", "Application", "chrome.exe"];
  const edge = ["Microsoft", "Edge", "Application", "msedge.exe"];
  return [...under(pf, ...chrome), ...under(pf86, ...chrome), ...under(local, ...chrome), ...under(pf86, ...edge), ...under(pf, ...edge)];
}
const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Browsers a previous Playwright install left in its cache: usable without installing anything new. */
function playwrightCache(): string[] {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), "Library", "Caches", "ms-playwright"), path.join(os.homedir(), ".cache", "ms-playwright")].filter(Boolean) as string[];
  const out: string[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root).filter((e) => /^chromium(_headless_shell)?-\d+$/.test(e));
    } catch {
      continue;
    }
    // Newest build first.
    entries.sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
    for (const e of entries) {
      for (const rel of ["chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium", "chrome-linux/chrome", "chrome-mac/headless_shell", "chrome-mac-arm64/headless_shell", "chrome-linux/headless_shell"]) {
        out.push(path.join(root, e, rel));
      }
    }
  }
  return out;
}

let cached: { value: ChromeInfo | null; at: number } | null = null;

/** The browser to drive, or null. Cached briefly: it is asked for on every turn that wires up tools. */
export function findChrome(opts: { fresh?: boolean } = {}): ChromeInfo | null {
  if (!opts.fresh && cached && Date.now() - cached.at < 30_000) return cached.value;
  let found: ChromeInfo | null = null;
  const env = process.env.TRB_CHROME?.trim();
  if (env && executable(env)) found = { path: env, source: "env" };
  if (!found && process.platform === "win32") {
    const p = windowsBrowsers(process.env).find(executable);
    if (p) found = { path: p, source: "installed" };
  }
  if (!found) for (const p of MAC_APPS) if (executable(p)) return (cached = { value: { path: p, source: "installed" }, at: Date.now() }).value;
  if (!found) {
    for (const n of LINUX_NAMES) {
      const w = Bun.which(n);
      if (w) {
        found = { path: w, source: "path" };
        break;
      }
    }
  }
  if (!found) {
    const p = playwrightCache().find(executable);
    if (p) found = { path: p, source: "playwright-cache" };
  }
  cached = { value: found, at: Date.now() };
  return found;
}

export const CHROME_MISSING = "Chrome not found. Install Google Chrome (or any Chromium browser) or set TRB_CHROME to its executable.";

let versionCache = new Map<string, string | null>();
export async function chromeVersion(exe: string): Promise<string | null> {
  if (versionCache.has(exe)) return versionCache.get(exe)!;
  const r = await runCmd(exe, ["--version"], { cwd: "/", timeoutMs: 8000 }).catch(() => null);
  const v = r && r.code === 0 ? r.stdout.toString().trim().split("\n")[0] : null;
  versionCache.set(exe, v);
  return v;
}

export async function browserStatus(): Promise<{ available: boolean; executable?: string; source?: string; version?: string | null; hint?: string }> {
  const c = findChrome();
  if (!c) return { available: false, hint: CHROME_MISSING };
  return { available: true, executable: c.path, source: c.source, version: await chromeVersion(c.path) };
}

/** Whether sessions should be handed browser_* tools: the setting is on and a Chrome exists. */
export function browserEnabled(): boolean {
  return getSetting("agent_browser") === "on" && findChrome() !== null;
}
