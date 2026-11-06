/** An end-to-end tour of the assembled UI: every panel in one session. `bun run scripts/ui-tour.ts` */
import fs from "fs";
import path from "path";
import { withUi } from "./ui-harness";

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};

await withUi(async ({ page, shot, repo, trb, workspaceId, url }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // Connection hygiene: a browser allows six HTTP/1.1 connections per host. Always-open streams must ride ONE WebSocket
  // per tab, never EventSource, or a couple of tabs make every other request queue ("daemon not answering").
  const eventSources: string[] = [];
  const liveSockets: string[] = [];
  page.on("request", (r) => r.resourceType() === "eventsource" && eventSources.push(r.url()));
  page.on("websocket", (w) => w.url().endsWith("/api/live") && liveSockets.push(w.url()));
  await page.goto(`${url}/w/${workspaceId}`);
  await page.waitForSelector("header");

  // Pair for Hydra, created over the API like the settings page does.
  await page.evaluate(async () => {
    await fetch("/api/pairs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Tour pair", lead_engine: "fake", heads_engine: "fake", max_heads: 3 }) });
  });

  // 1. Quick open -> editor -> edit -> save
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("math");
  await page.waitForTimeout(400);
  check("quick open finds a file by its full name", (await page.locator('[cmdk-item]').first().textContent())?.includes("math.ts") ?? false);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".cm-content");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+End");
  await page.keyboard.type("\nexport const max = (xs: number[]) => Math.max(...xs);\n");
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(500);
  check("save wrote the file to disk", fs.readFileSync(path.join(repo, "src/utils/math.ts"), "utf-8").includes("export const max"));
  await shot("tour-1-editor");

  // 2. Git: the saved file shows up; stage and commit it
  await page.keyboard.press("Meta+Shift+g");
  await page.waitForTimeout(800);
  const row = page.getByText("math.ts").first();
  check("git shows the edited file", await row.isVisible());
  await shot("tour-2-git");

  // 3. Agent: a Hydra run on the scripted engine, started like the CLI does, then watched in the UI
  //    (the composer defaults to a real engine, which a tour must never spend tokens on).
  await page.keyboard.press("Meta+Shift+e");
  const prompt = 'CALL_TOOL subagent_create {"brief":"SLEEP 3000\\nWRITE head.txt from the head\\nGIT_COMMIT head work","title":"write head file"}\nCALL_TOOL subagent_wait {"timeout_sec":30}';
  trb("run", "-p", "Tour pair", "-e", "fake", "-d", "-C", repo, prompt);
  await page.keyboard.press("Meta+Shift+e");
  await page.getByRole("button", { name: "Sessions" }).first().click();
  await page.waitForTimeout(1200);
  await page.locator("text=CALL_TOOL").first().click();
  await page.waitForTimeout(800);
  await shot("tour-3-agent-running");
  await page.getByRole("tab", { name: /Heads/ }).click();
  await page.waitForTimeout(600);
  await shot("tour-4-heads-working");
  await page.waitForTimeout(6000);
  await shot("tour-5-heads-done");
  const headsText = await page.locator("body").innerText();
  check("heads panel shows the head", headsText.includes("write head file"));
  await page.getByRole("tab", { name: /Agent/ }).click();
  await page.waitForTimeout(500);
  await shot("tour-5b-agent-done");

  // 4. Terminal
  await page.keyboard.press("Control+`");
  await page.waitForSelector(".xterm", { timeout: 8000 });
  await page.waitForTimeout(800);
  await page.locator(".xterm").first().click();
  await page.keyboard.type("echo tour-$((6*7))\n");
  await page.waitForTimeout(800);
  const term = await page.locator(".xterm-rows").first().innerText();
  check("terminal runs a command", term.includes("tour-42"));
  await shot("tour-6-terminal");

  // 5. Settings
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Hydra pairs");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  check("settings pairs page lists the pair", (await page.locator("body").innerText()).includes("Tour pair"));
  await shot("tour-7-settings");

  // 6. Light theme, whole app
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("light theme");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await shot("tour-8-light");

  check("no EventSource streams are opened", eventSources.length === 0, eventSources.slice(0, 3).join(", "));
  check("one live socket for this tab", liveSockets.length === 1, `${liveSockets.length}`);

  // Several more tabs of the same app: ordinary requests must still be instant.
  const others = await Promise.all([1, 2, 3].map(async () => {
    const p = await page.context().newPage();
    await p.goto(`${url}/w/${workspaceId}`);
    await p.waitForSelector("header");
    return p;
  }));
  await page.waitForTimeout(1200);
  const timings = await Promise.all([page, ...others].map((p) => p.evaluate(async () => {
    const t0 = performance.now();
    await Promise.all([fetch("/api/health"), fetch("/api/sessions"), fetch("/api/agents"), fetch("/api/skills")]);
    return Math.round(performance.now() - t0);
  })));
  check("with 4 tabs open, requests still answer immediately", Math.max(...timings) < 400, `${timings.join("ms, ")}ms`);
  check("the daemon-health banner is not showing in any tab", (await Promise.all([page, ...others].map((p) => p.locator("text=not answering").count()))).every((n) => n === 0));

  check("no console or page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  void trb;
});
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
