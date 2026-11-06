/** Inspect toggle across many preview targets: the app must never go blank, and a crashing pane must be recoverable. */
import { withUi } from "./ui-harness";

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const serve = (fetch: (r: Request) => Response) => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  servers.push(s);
  return s.port;
};
const html = (b: string, h: Record<string, string> = {}) => new Response(`<!doctype html><html><head><title>t</title></head><body>${b}</body></html>`, { headers: { "content-type": "text/html", ...h } });
const plain = serve(() => html("<h1>plain</h1>"));
const xfo = serve(() => html("<h1>xfo</h1>", { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'; script-src 'self' 'unsafe-inline'" }));
const nonHtml = serve(() => new Response("{}", { headers: { "content-type": "application/json" } }));
const redirect = serve(() => new Response(null, { status: 302, headers: { location: "https://example.com/" } }));
const closed = 1; // nothing listens

// A Vite-like dev server: binds IPv6 loopback only (what "localhost" resolves to for Vite) and its client
// reloads the page whenever its HMR websocket drops. That was the white screen.
let viteHits = 0;
const hmrPage = `<!doctype html><html><head><title>hmr</title></head><body><h1>vite-like</h1><script>
const ws = new WebSocket("ws://" + location.host + "/", "vite-hmr");
ws.onclose = () => setTimeout(() => location.reload(), 150); // Vite: "server connection lost. Polling for restart..." then reload
</script></body></html>`;
const viteLike = Bun.serve({
  port: 0,
  hostname: "::1",
  fetch(req, s) {
    if (req.headers.get("upgrade") === "websocket") return s.upgrade(req, { headers: { "sec-websocket-protocol": "vite-hmr" } }) ? (undefined as any) : new Response("no", { status: 400 });
    viteHits++;
    return new Response(hmrPage, { headers: { "content-type": "text/html" } });
  },
  websocket: { message() {} },
});
servers.push(viteLike);

const pageErrors: string[] = [];
await withUi(async ({ page, url, workspaceId, shot }) => {
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${url}/w/${workspaceId}`);
  await page.waitForSelector("header");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Open preview");
  await page.keyboard.press("Enter");
  const addr = page.getByLabel("Address");
  await addr.waitFor({ timeout: 8000 });
  const alive = async () => (await page.locator("header").count()) > 0 && (await page.locator("body").innerText()).trim().length > 20;
  const inspectBtn = () => page.getByRole("button", { name: /Inspect/ });

  const targets: Array<[string, string]> = [
    ["plain localhost server", `http://localhost:${plain}`],
    ["X-Frame-Options/CSP server", `http://localhost:${xfo}`],
    ["non-HTML server", `http://localhost:${nonHtml}`],
    ["redirecting server", `http://localhost:${redirect}`],
    ["nothing listening", `http://localhost:${closed}`],
    ["the app itself", url.replace("127.0.0.1", "localhost")],
    ["https non-localhost", "https://example.com"],
  ];
  for (const withRun of [false, true]) {
    for (const [name, target] of targets) {
      const tag = `${name}${withRun ? " + Run drawer" : ""}`;
      if (withRun !== ((await page.getByText("Dev servers").count()) > 0)) await page.getByRole("button", { name: /Run: dev servers/ }).click();
      await addr.fill(target);
      await addr.press("Enter");
      await page.waitForTimeout(700);
      for (let i = 0; i < 2; i++) {
        if (!(await inspectBtn().isEnabled().catch(() => false))) break;
        await inspectBtn().click();
        await page.waitForTimeout(1200);
        const ok = await alive();
        check(`${tag}: inspect click ${i + 1} keeps the app alive`, ok);
        if (!ok) await shot(`crash-${name.replace(/\W+/g, "-")}`);
      }
    }
  }
  // Regression: Inspect on an IPv6-only dev server with HMR must not put the page in a reload loop.
  if (await page.getByText("Dev servers").count()) await page.getByRole("button", { name: /Run: dev servers/ }).click();
  await addr.fill(`http://localhost:${viteLike.port}`);
  await addr.press("Enter");
  await page.waitForTimeout(800);
  if (!(await page.getByRole("button", { name: /Inspect is on/ }).count())) await inspectBtn().click();
  viteHits = 0;
  await page.waitForTimeout(5000);
  check("Inspect on an IPv6-only HMR dev server does not reload-loop", viteHits <= 3, `${viteHits} page loads in 5s`);
  check("the app is still responsive afterwards", await Promise.race([page.evaluate(() => 1).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]));
  if (await page.getByRole("button", { name: /Inspect is on/ }).count()) await page.getByRole("button", { name: /Inspect is on/ }).click();

  // Pane boundaries: a crashing pane shows a recoverable card, the rest of the app stays.
  await page.evaluate(() => localStorage.setItem("trb.test.crash", "Browser"));
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Open agent browser");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Open preview");
  await page.keyboard.press("Enter");
  await page.getByTestId("pane-crashed").first().waitFor({ timeout: 5000 }).catch(() => {});
  const card = await page.getByTestId("pane-crashed").count();
  check("a crashing browser tab shows a pane card instead of a blank app", card > 0 && /Test crash in Browser/.test(await page.locator("body").innerText()));
  check("the rest of the app keeps rendering (header, agent panel)", (await page.locator("header").count()) > 0 && (await page.locator('textarea[aria-label="Message"]').count()) > 0);
  await shot("crash-pane-card");
  await page.evaluate(() => localStorage.removeItem("trb.test.crash"));
  await page.getByRole("button", { name: /Reload pane/ }).first().click();
  check("Reload pane recovers the browser tab", (await page.getByLabel("Address").count()) > 0 || (await page.getByTestId("pane-crashed").count()) === 0);
  check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
});
for (const s of servers) s.stop(true);
process.exit(results.every((r) => r[1]) ? 0 : 1);
