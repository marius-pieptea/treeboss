/**
 * The in-page measuring of the screenshot judge, against a real headless browser. Skipped when no Chrome-family browser is found.
 * On Windows findChrome has no default paths: set TRB_CHROME to chrome.exe or msedge.exe to run it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { findChrome } from "../src/browser/chrome";
import { browserShooter } from "../src/checklists/screens-browser";
import { SCREEN_ITEMS, type PageMeasure } from "../src/checklists/screens";

const CTA = '<a href="/signup" style="display:inline-block;padding:12px 24px">Start free trial</a>';
const SPACER = (px: number) => `<div style="height:${px}px">Long page</div>`;
const BAR = '<a href="/signup" style="position:fixed;bottom:0;left:0;right:0;height:48px;display:block;background:#111;color:#fff">Start free trial</a>';
const WALL = '<div style="position:fixed;inset:0;background:#fff;z-index:9"><p>We use cookies.</p><button>Accept all</button></div>';
const html = (body: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture</title></head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  "/hero": html(`<h1>Acme</h1>${CTA}${SPACER(3000)}`),
  "/below": html(`<h1>Acme</h1>${SPACER(1500)}${CTA}${SPACER(800)}`),
  "/sticky": html(`<h1>Acme</h1>${SPACER(3000)}${BAR}`),
  "/wall": html(`<h1>Acme</h1>${CTA}${SPACER(3000)}${WALL}`),
  "/short": html(`<h1>Acme</h1>${CTA}`),
};

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => (PAGES[new URL(req.url).pathname] ? new Response(PAGES[new URL(req.url).pathname], { headers: { "content-type": "text/html" } }) : new Response("no", { status: 404 })) });
});
afterAll(() => server?.stop(true));

const found = findChrome() !== null;
const shootPage = async (p: string): Promise<{ above: ReturnType<typeof SCREEN_ITEMS["cta-above-fold"]["judge"]>; sticky: ReturnType<typeof SCREEN_ITEMS["sticky-mobile-cta"]["judge"]>; measures: PageMeasure[]; png: Uint8Array }> => {
  const r = await browserShooter()(`http://127.0.0.1:${server.port}${p}`, ["desktop", "mobile"]);
  if ("error" in r) throw new Error(r.error);
  const measures = r.shots.map((s) => s.measure);
  return { above: SCREEN_ITEMS["cta-above-fold"].judge(measures), sticky: SCREEN_ITEMS["sticky-mobile-cta"].judge(measures), measures, png: r.shots[0]!.png };
};

describe.skipIf(!found)("browserShooter and the judges, on fixture pages", () => {
  test("a call to action in the hero is seen on both viewports, and a long page with no bar has no sticky one", async () => {
    const r = await shootPage("/hero");
    expect(r.above.observed).toBe("seen");
    expect(r.sticky.observed).toBe("missing");
    expect([...r.png.slice(1, 4)]).toEqual([80, 78, 71]);
    expect(r.measures.map((m) => [m.viewport, m.innerHeight])).toEqual([["desktop", 900], ["mobile", 844]]);
    expect(r.measures[0]!.scrolled).toBeNull();
    expect(r.measures[1]!.scrolled).not.toBeNull();
  }, 60_000);

  test("a call to action 1500px down is missing, and the reason says where it is", async () => {
    const r = await shootPage("/below");
    expect(r.above.observed).toBe("missing");
    expect(r.above.reason).toMatch(/below 900px|below 844px/);
  }, 60_000);

  test("a fixed bottom bar is seen after scrolling", async () => {
    expect((await shootPage("/sticky")).sticky.observed).toBe("seen");
  }, 60_000);

  test("a cookie wall over the hero button means the visitor cannot see it", async () => {
    const r = await shootPage("/wall");
    expect(r.above.observed).toBe("missing");
    expect(r.above.reason).toContain("covered");
  }, 60_000);

  test("a one-screen page is too short to judge for a sticky bar", async () => {
    expect((await shootPage("/short")).sticky.observed).toBe("unknown");
  }, 60_000);

  test("a page that is not on this machine is refused", async () => {
    expect(await browserShooter()("https://example.com/", ["mobile"])).toEqual({ error: "only loopback pages are screenshotted" });
  });
});
