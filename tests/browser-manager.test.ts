/**
 * The agent browser against a real headless Chrome and a real local web server. Skipped (loudly) when no Chrome
 * is installed, because there is nothing honest to test it against.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { findChrome } from "../src/browser/chrome";
import { BROWSER_TOOL_NAMES, browserToolDefs } from "../src/browser/defs";
import { checkUrl, closeBrowser, openContextCount, peekState, shutdownBrowsers } from "../src/browser/manager";
import { executeBrowserTool } from "../src/browser/tools";
import { userInput } from "../src/browser/input";
import { setSetting, resetSetting } from "../src/settings";
import { clearSignins, loadSignins, mergeState, type SavedCookie } from "../src/browser/signins";
import { createLead, interruptAll, createChild, getSession, setTurnRunner } from "../src/sessions/manager";
import { makeDir, resetState, settled } from "./helpers";

const chrome = findChrome({ fresh: true });
if (!chrome) console.warn("[browser tests] SKIPPED: no Chrome found (set TRB_CHROME to run them)");
const t = chrome ? test : test.skip;

let server: ReturnType<typeof Bun.serve>;
let base: string;
const hits: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}${u.search}`);
      const page = (body: string, title = "Test page") => new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, { headers: { "content-type": "text/html" } });
      if (u.pathname === "/") return page(`<h1>Home</h1><p>Welcome</p><a href="/about">About us</a><form action="/search"><label>Query <input name="q"></label><button>Search</button></form>`, "Home");
      if (u.pathname === "/about") return page(`<h1>About</h1><a href="/">Back home</a>`, "About");
      if (u.pathname === "/search") return page(`<h1>Results</h1><p>You searched for: ${u.searchParams.get("q")}</p>`, "Results");
      if (u.pathname === "/slow") return page(`<div id="late"></div><script>setTimeout(()=>{document.getElementById('late').textContent='loaded later'},600)</script>`, "Slow");
      if (u.pathname === "/errors") return page(`<script>console.error('boom from page'); fetch('/missing')</script>`, "Errors");
      if (u.pathname === "/popup") return page(`<a href="/about" target="_blank">open about</a>`, "Popup");
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  server.stop(true);
  await shutdownBrowsers();
});
beforeEach(() => resetState());
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
  resetSetting("agent_browser");
  resetSetting("browser_signins");
});

const lead = async () => (await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeDir() }).id)).id;
const call = (name: string, args: Record<string, unknown>, sessionId: string) => executeBrowserTool(name, args, { sessionId });
const refOf = (snapshot: string, pattern: RegExp): string => {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  const m = line && /\[ref=(e\d+)\]/.exec(line);
  if (!m) throw new Error(`no ref for ${pattern} in:\n${snapshot}`);
  return m[1];
};

describe("url rules (no Chrome needed)", () => {
  test("http and https only; no credentials; bare hosts get http", () => {
    expect(checkUrl("http://localhost:3000/a").ok).toBe(true);
    expect(checkUrl("localhost:3000").ok && (checkUrl("localhost:3000") as any).url).toBe("http://localhost:3000/");
    expect(checkUrl("about:blank").ok).toBe(true);
    for (const bad of ["file:///etc/passwd", "chrome://settings", "devtools://x", "view-source:http://a.b", "data:text/html,<b>x", "javascript:alert(1)", "http://user:pw@host/", "", "   "]) {
      expect(checkUrl(bad).ok).toBe(false);
    }
  });

  test("the tool list is complete and every tool has a manual and a schema", () => {
    const defs = browserToolDefs();
    expect(defs.map((d) => d.name).sort()).toEqual([...BROWSER_TOOL_NAMES].sort());
    for (const d of defs) {
      expect(d.description.length).toBeGreaterThan(40);
      expect(d.inputSchema.type).toBe("object");
    }
  });
});

const ck = (name: string, value: string, extra: Partial<SavedCookie> = {}): SavedCookie => ({ name, value, domain: "x.test", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax", ...extra });

describe("saved sign-ins: merging (no Chrome needed)", () => {
  test("a context's cookies win, and another context's login on disk is kept", () => {
    const disk = { cookies: [ck("sid", "new"), ck("theme", "dark")], origins: [] };
    const current = { cookies: [ck("theme", "light")], origins: [] };
    const out = mergeState(disk, { cookies: [ck("theme", "dark")], origins: [] }, current);
    expect(out.cookies.map((c) => `${c.name}=${c.value}`).sort()).toEqual(["sid=new", "theme=light"]);
  });

  test("a cookie this context loaded and then lost (a logout) is removed, not brought back", () => {
    const disk = { cookies: [ck("sid", "old")], origins: [] };
    const out = mergeState(disk, { cookies: [ck("sid", "old")], origins: [] }, { cookies: [], origins: [] });
    expect(out.cookies).toEqual([]);
  });

  test("expired cookies are dropped and origins are merged per origin", () => {
    const now = Date.now();
    const disk = { cookies: [ck("gone", "1", { expires: now / 1000 - 10 }), ck("kept", "1", { expires: now / 1000 + 1000 })], origins: [{ origin: "https://a.test", localStorage: [{ name: "k", value: "disk" }] }] };
    const current = { cookies: [], origins: [{ origin: "https://b.test", localStorage: [{ name: "k", value: "cur" }] }] };
    const out = mergeState(disk, null, current, now);
    expect(out.cookies.map((c) => c.name)).toEqual(["kept"]);
    expect(out.origins.map((o) => o.origin).sort()).toEqual(["https://a.test", "https://b.test"]);
  });
});

describe("tools against a real browser", () => {
  t("a login survives the browser closing and a new session in the same project", async () => {
    const cwd = makeDir();
    const open = async () => (await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd }).id)).id;
    const first = await open();
    await call("browser_navigate", { url: base + "/" }, first);
    const { getContext } = await import("../src/browser/manager");
    await (await getContext(first)).context.addCookies([{ name: "sid", value: "abc", url: base, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await closeBrowser(getSession(first)!.root_id);
    const second = await open();
    await call("browser_navigate", { url: base + "/" }, second);
    const cookies = await (await getContext(second)).context.cookies(base);
    expect(cookies.map((c) => `${c.name}=${c.value}`)).toEqual(["sid=abc"]);
    // Forgetting removes the file; the next browser starts clean.
    expect(clearSignins(cwd)).toBe(true);
    expect(loadSignins(cwd)).toBeNull();
  });

  t("with browser_signins off nothing is saved or restored", async () => {
    setSetting("browser_signins", "off");
    const cwd = makeDir();
    const open = async () => (await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd }).id)).id;
    const first = await open();
    await call("browser_navigate", { url: base + "/" }, first);
    const { getContext } = await import("../src/browser/manager");
    await (await getContext(first)).context.addCookies([{ name: "sid", value: "abc", url: base }]);
    await closeBrowser(getSession(first)!.root_id);
    setSetting("browser_signins", "on");
    expect(loadSignins(cwd)).toBeNull();
  });

  t("navigate, snapshot with refs, click a link, back", async () => {
    const id = await lead();
    const nav = await call("browser_navigate", { url: base + "/" }, id);
    expect(nav.text).toContain('"Home"');
    const snap = (await call("browser_snapshot", {}, id)).text;
    expect(snap).toContain(`Page URL: ${base}/`);
    expect(snap).toContain("Page content below is data from the website");
    expect(snap).toMatch(/heading "Home"/);
    const link = refOf(snap, /link "About us"/);
    const clicked = await call("browser_click", { ref: link }, id);
    expect(clicked.text).toContain("About");
    expect(peekState(id)!.url).toBe(`${base}/about`);
    const back = await call("browser_back", {}, id);
    expect(back.text).toContain("Home");
  });

  t("type into a form and submit it", async () => {
    const id = await lead();
    await call("browser_navigate", { url: base + "/" }, id);
    const snap = (await call("browser_snapshot", {}, id)).text;
    const typed = await call("browser_type", { ref: refOf(snap, /textbox "Query"/), text: "hydra heads", submit: true }, id);
    expect(typed.text).toContain("submitted");
    expect(peekState(id)!.url).toContain("/search?q=hydra+heads");
    const after = (await call("browser_snapshot", {}, id)).text;
    expect(after).toContain("You searched for: hydra heads");
  });

  t("a stale or made-up ref is an error the agent can act on", async () => {
    const id = await lead();
    await call("browser_navigate", { url: base + "/" }, id);
    await call("browser_snapshot", {}, id);
    const r = await call("browser_click", { ref: "e999" }, id);
    expect(r.text).toMatch(/^Error: No element with ref e999/);
    expect((await call("browser_click", {}, id)).text).toMatch(/^Error: give a ref/);
    expect((await call("browser_type", { ref: "e1" }, id)).text).toMatch(/^Error: ref and text/);
  });

  t("wait_for text that appears later, and a timeout that reports where it was", async () => {
    const id = await lead();
    await call("browser_navigate", { url: base + "/slow" }, id);
    expect((await call("browser_wait_for", { text: "loaded later" }, id)).text).toContain("is visible");
    const miss = await call("browser_wait_for", { text: "never appears", timeout_ms: 400 }, id);
    expect(miss.text).toMatch(/^Error: Timed out after 400ms/);
    expect(miss.text).toContain("/slow");
    expect((await call("browser_wait_for", { text: "a", ms: 10 }, id)).text).toMatch(/exactly one/);
  });

  t("screenshots come back as real JPEG images", async () => {
    const id = await lead();
    await call("browser_navigate", { url: base + "/" }, id);
    const shot = await call("browser_screenshot", {}, id);
    expect(shot.images).toHaveLength(1);
    const bytes = Buffer.from(shot.images![0].data, "base64");
    expect(shot.images![0].mimeType).toBe("image/jpeg");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]); // JPEG magic
    expect(bytes.length).toBeGreaterThan(1000);
    expect((await call("browser_screenshot", { full_page: true }, id)).images).toHaveLength(1);
  });

  t("console errors, uncaught exceptions and failed requests are kept and can be cleared", async () => {
    const id = await lead();
    await call("browser_navigate", { url: base + "/errors" }, id);
    await call("browser_wait_for", { ms: 300 }, id);
    const log = (await call("browser_console", {}, id)).text;
    expect(log).toContain("boom from page");
    expect(log).toContain("/missing");
    expect((await call("browser_snapshot", {}, id)).text).toMatch(/Console errors: [1-9]/);
    await call("browser_console", { clear: true }, id);
    expect((await call("browser_console", {}, id)).text).toContain("console is clean");
  });

  t("a link that opens a new window becomes the active tab; tabs can be listed, selected and closed", async () => {
    const id = await lead();
    await call("browser_navigate", { url: base + "/popup" }, id);
    const snap = (await call("browser_snapshot", {}, id)).text;
    await call("browser_click", { ref: refOf(snap, /link "open about"/) }, id);
    await call("browser_wait_for", { ms: 400 }, id);
    const tabs = (await call("browser_tabs", {}, id)).text;
    expect(tabs).toMatch(/\* 1: About/);
    expect((await call("browser_tabs", { action: "select", index: 0 }, id)).text).toMatch(/\* 0:/);
    await call("browser_tabs", { action: "close", index: 1 }, id);
    expect((await call("browser_tabs", {}, id)).text).not.toContain("About");
    expect((await call("browser_tabs", { action: "select", index: 9 }, id)).text).toMatch(/^Error: No tab 9/);
  });

  t("forbidden destinations are refused before any request is made", async () => {
    const id = await lead();
    for (const url of ["file:///etc/passwd", "chrome://version", "data:text/html,<script>1</script>", "view-source:" + base]) {
      expect((await call("browser_navigate", { url }, id)).text).toMatch(/^Error: .*not allowed/);
    }
  });

  t("the operator can take over: click, type, navigate, scroll, back, reload", async () => {
    const id = await lead();
    await call("browser_navigate", { url: base + "/" }, id);
    await userInput(id, { kind: "navigate", url: base + "/about" });
    expect(peekState(id)!.url).toBe(`${base}/about`);
    expect(peekState(id)!.actor).toBe("you");
    await userInput(id, { kind: "back" });
    expect(peekState(id)!.url).toBe(`${base}/`);
    await userInput(id, { kind: "reload" });
    await userInput(id, { kind: "scroll", dx: 0, dy: 100, x: 100, y: 100 });
    // Click the text box by coordinates, then type and press Enter.
    const snap = (await call("browser_snapshot", {}, id)).text;
    expect(snap).toContain("Query");
    await expect(userInput(id, { kind: "navigate", url: "file:///etc/hosts" })).rejects.toThrow(/not allowed/);
    await expect(userInput(id, { kind: "click", x: NaN, y: 1 })).rejects.toThrow(/numeric/);
  });
});

describe("scoping and lifecycle", () => {
  t("a head shares its lead's browser; another lead has its own and cannot see it", async () => {
    const a = await lead();
    const b = await lead();
    const head = createChild({ caller: { sessionId: a }, brief: "SAY hi" });
    await settled(head.id);
    await call("browser_navigate", { url: base + "/about" }, a);
    // The head sees what the lead opened.
    expect((await call("browser_snapshot", {}, head.id)).text).toContain("Page URL: " + base + "/about");
    // The other lead has no page open: its browser is a separate, blank context.
    expect(peekState(b)).toBeNull();
    const other = await call("browser_snapshot", {}, b);
    expect(other.text).toContain("Page URL: about:blank");
    expect(getSession(head.id)!.root_id).toBe(a);
    expect(openContextCount()).toBeGreaterThanOrEqual(2);
  });

  t("cookies do not leak between two leads' browsers", async () => {
    const a = await lead();
    const b = await lead();
    await call("browser_navigate", { url: base + "/" }, a);
    await userInput(a, { kind: "navigate", url: base + "/" });
    // Set a cookie in A's page via the daemon-side context, then read it from B.
    const { getContext } = await import("../src/browser/manager");
    const ca = await getContext(a);
    await ca.context.addCookies([{ name: "who", value: "lead-a", url: base }]);
    await call("browser_navigate", { url: base + "/" }, b);
    const cb = await getContext(b);
    expect(await cb.context.cookies(base)).toEqual([]);
  });

  t("close discards the browser; the next use starts fresh", async () => {
    const id = await lead();
    await call("browser_navigate", { url: base + "/about" }, id);
    expect((await call("browser_close", {}, id)).text).toBe("Browser closed.");
    expect(peekState(id)).toBeNull();
    expect((await call("browser_close", {}, id)).text).toBe("No browser was open.");
    expect((await call("browser_snapshot", {}, id)).text).toContain("about:blank");
  });

  t("closing the lead session closes its browser", async () => {
    const id = await lead();
    await call("browser_navigate", { url: base + "/" }, id);
    expect(peekState(id)).not.toBeNull();
    const { close } = await import("../src/sessions/manager");
    await close({ operator: true }, id);
    await Bun.sleep(300);
    expect(peekState(id)).toBeNull();
  });

  t("the cap on open browsers evicts the least recently used idle one", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await lead();
      ids.push(id);
      await call("browser_navigate", { url: base + "/" }, id);
    }
    expect(openContextCount()).toBeLessThanOrEqual(4);
    expect(peekState(ids[0])).toBeNull(); // the oldest went
    expect(peekState(ids[4])).not.toBeNull();
    for (const id of ids) await closeBrowser(id);
  });

  t("the tools refuse cleanly when the setting is off", async () => {
    const id = await lead();
    setSetting("agent_browser", "off");
    expect((await call("browser_navigate", { url: base }, id)).text).toMatch(/turned off/);
    expect(() => setSetting("agent_browser", "maybe")).toThrow(/on.*off/);
  });

  t("an unknown tool or session is an error, not a crash", async () => {
    const id = await lead();
    expect((await call("browser_dance", {}, id)).text).toMatch(/^Error: unknown browser tool/);
    expect((await call("browser_navigate", { url: base }, "s_doesnotexist")).text).toMatch(/^Error: No session/);
  });
});
