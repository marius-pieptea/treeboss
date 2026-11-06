/** Agent browser end to end: an agent (scripted engine) uses the browser tools, the UI shows it live, the user takes over. */
import { withUi } from "./ui-harness";

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};

const site = Bun.serve({
  port: 0,
  fetch: (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/next") return new Response(`<!doctype html><title>Next page</title><body style="font:20px system-ui;padding:40px"><h1>You are on the next page</h1><a href="/">home</a></body>`, { headers: { "content-type": "text/html" } });
    return new Response(
      `<!doctype html><title>Demo shop</title><body style="font:18px system-ui;margin:0;background:#f7f7fb"><header style="background:#111827;color:#fff;padding:16px 32px;font-size:22px">Demo shop</header>
       <main style="padding:32px"><h1>Welcome back</h1><p>Pick something nice.</p>
       <div id="counter" style="font-size:42px;margin:16px 0">0</div>
       <button id="add" onclick="var c=document.getElementById('counter');c.textContent=Number(c.textContent)+1;document.title='Cart '+c.textContent" style="font-size:20px;padding:12px 28px;border-radius:10px;border:0;background:#2563eb;color:#fff;cursor:pointer">Add to cart</button>
       <p><a href="/next">Go to the next page</a></p></main></body>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const siteUrl = `http://127.0.0.1:${site.port}`;

for (const theme of ["dark", "light"] as const) {
  await withUi(
    async ({ page, shot, trb, workspaceId, url }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${url}/w/${workspaceId}`);
      await page.waitForSelector("header");

      // The agent: opens the page, reads it, waits (so there is something to watch), clicks, goes to another page.
      const prompt = [
        `CALL_TOOL browser_navigate {"url":"${siteUrl}/"}`,
        `CALL_TOOL browser_wait_for {"ms":2500}`,
        `CALL_TOOL browser_snapshot {}`,
      ].join("\n");
      const sid = trb("run", "-e", "fake", "-d", prompt).stdout.trim();
      check(`[${theme}] a session started`, /^s_/.test(sid), sid);

      // The nudge: no browser tab is open, so an agent using the browser should say so.
      await page.waitForSelector("[data-sonner-toast]", { timeout: 15000 }).catch(() => {});
      const toastText = await page.locator("[data-sonner-toast]").first().innerText().catch(() => "");
      check(`[${theme}] a toast offers the agent browser`, /agent is using the browser/i.test(toastText), toastText.replace(/\n/g, " | "));
      await shot(`abrowser-${theme}-1-toast`);

      // Pick the session, open the tab through the toast action.
      await page.locator("text=CALL_TOOL").first().click({ timeout: 5000 }).catch(async () => {
        await page.getByRole("button", { name: "Sessions" }).first().click();
        await page.locator("text=CALL_TOOL").first().click();
      });
      await page.getByText("Open agent browser").first().click({ timeout: 8000 }).catch(async () => {
        await page.keyboard.press("Meta+k");
        await page.keyboard.type("agent browser");
        await page.keyboard.press("Enter");
      });
      await page.waitForSelector('[aria-label^="Agent browser"] img, img[alt^="Agent browser"]', { timeout: 15000 });
      await page.waitForTimeout(600);
      const imgBox = await page.locator('img[alt^="Agent browser"]').boundingBox();
      check(`[${theme}] the live page is shown`, !!imgBox && imgBox.width > 300, JSON.stringify(imgBox));
      await shot(`abrowser-${theme}-2-live`);
      const bodyText = await page.locator("body").innerText();
      check(`[${theme}] the status line names the agent's action`, /Agent/.test(bodyText) && /(Reading the page|waiting|Opening|Agent:)/.test(bodyText));
      check(`[${theme}] the address shows the page`, (await page.getByLabel("Agent browser address").inputValue()) === `${siteUrl}/`);

      // Let the agent finish, so the next actions are the operator's alone.
      for (let i = 0; i < 40; i++) {
        const st = await (await page.request.get(`${url}/api/sessions/${sid}`)).json();
        if (st.session.status !== "running") break;
        await page.waitForTimeout(250);
      }
      // Take over: click the "Add to cart" button in the picture.
      const state = await (await page.request.get(`${url}/api/browser/${sid}/state`)).json();
      check(`[${theme}] state reports the page`, state.open && state.title === "Demo shop", state.title);
      const img = page.locator('img[alt^="Agent browser"]');
      const box = (await img.boundingBox())!;
      // The button sits at about (110, 230) on the 1280x800 page; the picture is scaled to box.width.
      const scale = box.width / 1280;
      for (let i = 0; i < 3; i++) {
        await page.mouse.click(box.x + 110 * scale, box.y + 310 * scale);
        await page.waitForTimeout(350);
      }
      await page.waitForTimeout(900);
      await shot(`abrowser-${theme}-3-after-clicks`);
      const afterClicks = await (await page.request.get(`${url}/api/browser/${sid}/state`)).json();
      check(`[${theme}] three clicks on the picture reached the real page`, afterClicks.title === "Cart 3", afterClicks.title);
      const counter = await page.evaluate(async (u) => {
        // Read the counter by taking a snapshot-free route: ask the daemon for a screenshot is opaque, so use the state title as a proxy.
        const s = await (await fetch(u)).json();
        return s.actor;
      }, `${url}/api/browser/${sid}/state`);
      check(`[${theme}] you are in control after clicking`, counter === "you");
      check(`[${theme}] control indicator says so`, /You are in control|You:/.test(await page.locator("body").innerText()));

      // Take over navigation through the address bar.
      await page.getByLabel("Agent browser address").fill(`${siteUrl}/next`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
      const s2 = await (await page.request.get(`${url}/api/browser/${sid}/state`)).json();
      check(`[${theme}] typing an address navigates the agent's browser`, s2.url === `${siteUrl}/next`, s2.url);
      await shot(`abrowser-${theme}-4-navigated`);

      // Keyboard take-over: focus the picture and press a key; scrolling too.
      await img.click({ position: { x: 10, y: 10 } });
      await page.keyboard.type("abc");
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(500);

      // Tabs: open a new one from the UI and close it again.
      await page.getByLabel("New tab").click();
      await page.waitForTimeout(800);
      check(`[${theme}] a new tab appears in the strip`, (await page.getByRole("tab", { name: /New tab|about:blank/ }).count()) >= 1 || (await page.locator('[role=tab][aria-selected="true"]').count()) >= 2);
      await shot(`abrowser-${theme}-5-tabs`);

      // Switch to Preview and back keeps the tab.
      await page.getByRole("tab", { name: "Preview" }).first().click();
      await page.waitForTimeout(400);
      check(`[${theme}] the mode switch changes to preview`, (await page.getByLabel("Address").count()) > 0);
      await page.getByRole("tab", { name: "Agent" }).first().click();
      await page.waitForTimeout(600);
      check(`[${theme}] and back to the agent browser`, (await page.locator('img[alt^="Agent browser"]').count()) > 0);

      // Closing it.
      await page.getByLabel("Close the agent's browser").click();
      await page.waitForTimeout(800);
      check(`[${theme}] closing shows the empty state`, /No page open yet/.test(await page.locator("body").innerText()));
      await shot(`abrowser-${theme}-6-closed`);

      check(`[${theme}] no page errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
    },
    { theme },
  );
}
site.stop(true);
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
