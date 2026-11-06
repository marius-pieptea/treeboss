/** Where findChrome looks on Windows, and that TRB_CHROME wins over every default. */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { findChrome, windowsBrowsers } from "../src/browser/chrome";

const w = (...parts: string[]) => path.win32.join(...parts);

describe("windowsBrowsers", () => {
  test("Chrome in Program Files, Program Files (x86) and the user's profile, then Edge", () => {
    const env = { PROGRAMFILES: String.raw`C:\Program Files`, "PROGRAMFILES(X86)": String.raw`C:\Program Files (x86)`, LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` };
    expect(windowsBrowsers(env)).toEqual([
      String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
      String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
      String.raw`C:\Users\me\AppData\Local\Google\Chrome\Application\chrome.exe`,
      String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
      String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
    ]);
  });

  test("a folder the environment does not name is left out", () => {
    expect(windowsBrowsers({ LOCALAPPDATA: String.raw`C:\L` })).toEqual([w("C:", "L", "Google", "Chrome", "Application", "chrome.exe")]);
    expect(windowsBrowsers({})).toEqual([]);
  });
});

describe("findChrome", () => {
  const was = process.env.TRB_CHROME;
  afterEach(() => {
    if (was === undefined) delete process.env.TRB_CHROME;
    else process.env.TRB_CHROME = was;
    findChrome({ fresh: true });
  });

  test("TRB_CHROME comes first, whatever else is installed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-chrome-"));
    const exe = path.join(dir, process.platform === "win32" ? "mychrome.cmd" : "mychrome");
    fs.writeFileSync(exe, "", { mode: 0o755 });
    process.env.TRB_CHROME = exe;
    expect(findChrome({ fresh: true })).toEqual({ path: exe, source: "env" });
  });

  test.skipIf(process.platform !== "win32")("on Windows, without TRB_CHROME, an installed Chrome or Edge is found", () => {
    delete process.env.TRB_CHROME;
    const installed = windowsBrowsers(process.env).filter((p) => fs.existsSync(p));
    if (!installed.length) return;
    expect(findChrome({ fresh: true })).toEqual({ path: installed[0]!, source: "installed" });
  });
});
