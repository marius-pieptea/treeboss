/** Run panel and Inspect mode end to end in the real UI: start the app from the panel, preview it, pick an element, attach console errors. */
import fs from "fs";
import path from "path";
import { withUi } from "./ui-harness";

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};

const SERVER = `
const port = Number(process.env.PORT);
Bun.serve({ port, hostname: "127.0.0.1", fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/missing") return new Response("no", { status: 404 });
  return new Response(\`<!doctype html><title>Demo app</title><body style="font:18px system-ui;margin:0">
  <h1 id="title" style="margin:24px">Pricing</h1>
  <button id="cta" class="cta big" style="font-size:20px;padding:14px 30px;margin:24px;border:0;border-radius:10px;background:#2563eb;color:#fff">Buy now</button>
  <script>console.error("Hydration failed: boom"); fetch("/missing");</script></body>\`, { headers: { "content-type": "text/html" } });
} });
console.log("demo ready on " + port);
`;

await withUi(async ({ page, shot, repo, workspaceId, url }) => {
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "demo-app", scripts: { dev: "bun server.ts", "db:seed": "echo seeding && echo done" } }));
  fs.writeFileSync(path.join(repo, "server.ts"), SERVER);
  fs.writeFileSync(path.join(repo, ".env"), "SUPER_SECRET=do-not-show-me\nAPI_URL=http://x\n");

  await page.goto(`${url}/w/${workspaceId}`);
  await page.waitForSelector("header");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Open preview");
  await page.keyboard.press("Enter");
  await page.getByLabel("Address").waitFor({ timeout: 8000 });

  // Run panel.
  await page.getByRole("button", { name: /Run: dev servers/ }).click();
  await page.getByText("Dev servers").waitFor();
  const panelText = await page.locator("body").innerText();
  check("the panel lists the detected dev server and the database task", /dev/.test(panelText) && /db:seed/.test(panelText));
  await page.getByText("Environment").click();
  const envText = await page.locator("body").innerText();
  check("env files show keys only", envText.includes("SUPER_SECRET") && !envText.includes("do-not-show-me"));
  await shot("run-1-panel");

  await page.getByRole("button", { name: "Start", exact: true }).first().click();
  await page.waitForTimeout(3000);
  await shot("run-1b-started");
  await page.waitForFunction(() => /Running/.test(document.body.innerText), null, { timeout: 15000 });
  check("the server reaches Running", true);
  const logText = await page.locator("body").innerText();
  check("live logs show its output", /demo ready on \d+/.test(logText));
  const addr = await page.getByLabel("Address").inputValue();
  check("the preview points at the running server", /^http:\/\/(localhost|127\.0\.0\.1):\d{4}$/.test(addr), addr);
  await page.waitForTimeout(1200);
  await shot("run-2-running-preview");
  const frame = page.frameLocator("iframe").first();
  check("the app renders in the preview", (await frame.locator("#title").innerText().catch(() => "")) === "Pricing");

  // Database task.
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  await page.waitForFunction(() => /Done/.test(document.body.innerText), null, { timeout: 10000 });
  check("a database task runs to completion", true);

  // Inspect.
  await page.getByRole("button", { name: /Inspect: pick elements/ }).click();
  await page.waitForTimeout(2500);
  const insp = page.frameLocator("iframe").first();
  check("Inspect serves the page through the proxy", (await insp.locator("#cta").innerText().catch(() => "")) === "Buy now");
  await page.getByRole("button", { name: "Console errors and failed requests" }).waitFor({ timeout: 8000 });
  await page.waitForFunction(() => /Console errors/.test(document.body.innerHTML), null, { timeout: 5000 });
  await page.waitForTimeout(3500);
  const badge = await page.getByRole("button", { name: "Console errors and failed requests" }).innerText();
  check("console errors and the failed request are counted", Number(badge.trim()) >= 2, badge);
  await shot("run-3-inspect");

  // Attach issues to the composer.
  await page.getByRole("button", { name: "Console errors and failed requests" }).click();
  await page.getByText(/Attach \d+ to message/).click();
  await page.waitForTimeout(500);
  const composer = page.locator("textarea").last();
  const draft1 = await composer.inputValue();
  check("console errors landed in the composer", /Hydration failed: boom/.test(draft1) && /missing/.test(draft1), draft1.slice(0, 120));

  // Pick.
  await page.getByRole("button", { name: "Pick", exact: true }).click();
  const cta = await insp.locator("#cta").boundingBox();
  const fr = await page.locator("iframe").first().boundingBox();
  void fr;
  await insp.locator("#cta").hover();
  await insp.locator("#cta").click({ force: true });
  await page.waitForFunction(() => /Picked/.test(document.body.innerText), null, { timeout: 25000 }).catch(() => {});
  await shot("run-4-picked");
  const draft2 = await composer.inputValue();
  check("the pick lands in the composer with selector, box and styles", /Picked element from the live preview/.test(draft2) && /Selector: #cta/.test(draft2) && /Box: x=/.test(draft2) && /background-color/.test(draft2), draft2.slice(-400));
  check("a cropped screenshot path is attached", /Screenshot \(cropped to the element\): \/.*\.png/.test(draft2));
  const shotPath = /Screenshot \(cropped to the element\): (\/\S+\.png)/.exec(draft2)?.[1];
  check("the screenshot file exists", !!shotPath && fs.existsSync(shotPath) && fs.statSync(shotPath).size > 500, shotPath);
  void cta;

  // Stop.
  await page.getByRole("button", { name: "Stop", exact: true }).first().click();
  await page.waitForFunction(() => /Stopped/.test(document.body.innerText), null, { timeout: 10000 });
  check("Stop ends the process", true);
});

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
