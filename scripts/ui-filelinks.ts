/**
 * File links in the conversation, against the scripted engine: a reply that names real files (inline code, plain
 * text, a markdown link) links them, a made-up name is left alone, a click opens the file in the editor (at its line),
 * and a file the agent just wrote links in the tool list.   `TRB_WEB_DIR=<dist> bun run scripts/ui-filelinks.ts`
 */
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

async function fresh(page: Page, wid: string, url: string) {
  await page.goto(`${url}/w/${wid}`);
  await page.evaluate(
    ([wid]) => {
      const raw = localStorage.getItem("trb.ui.v1");
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
      cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: null, expanded: [], history: [] } } };
      localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
      localStorage.setItem("trb.composer.v1", JSON.stringify({ engine: "fake", model: "", effort: "", pairId: "", worktree: false }));
    },
    [wid],
  );
  await page.reload();
  await page.waitForSelector('textarea[aria-label="Message"]');
}
const idle = (page: Page) => page.waitForFunction(() => !document.querySelector('button[aria-label="Stop the running turn"]'), null, { timeout: 25_000 });

for (const theme of (process.env.THEME ? [process.env.THEME] : ["dark", "light"]) as Array<"dark" | "light">) {
  await withUi(
    async ({ page, shot, trb, workspaceId, url }) => {
      trb("config", "set", "default_engine", "fake");
      await fresh(page, workspaceId, url);
      await page.locator('textarea[aria-label="Message"]').fill("WRITE notes/new.md hello\nSAY Changed `src/greet.ts:2`, plain src/server.ts, and [the math](src/utils/math.ts#L1). Not `ghost.ts` or https://example.com/src/greet.ts.");
      await page.keyboard.press("Enter");
      await idle(page);
      await page.waitForSelector("[data-file-link]");
      const links = await page.locator(".markdown [data-file-link]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-file-link"), e.getAttribute("data-file-line")]));
      const paths = links.map((l) => l[0]);
      check(`${theme}: inline code, plain text and a markdown link to real files are links`, ["src/greet.ts", "src/server.ts", "src/utils/math.ts"].every((p) => paths.includes(p)), JSON.stringify(links));
      check(`${theme}: line numbers are kept`, links.some((l) => l[0] === "src/greet.ts" && l[1] === "2") && links.some((l) => l[0] === "src/utils/math.ts" && l[1] === "1"));
      check(`${theme}: a made-up file and a URL are not links`, !paths.includes("ghost.ts") && (await page.locator('.markdown a[href="https://example.com/src/greet.ts"]').count()) === 1);
      await shot(`filelinks-${theme}-chat`);

      await page.locator('.markdown [data-file-link="src/greet.ts"]').first().click();
      await page.waitForSelector('[role="tab"]:has-text("greet.ts")', { timeout: 10_000 });
      check(`${theme}: clicking a link opens the file in the editor`, (await page.locator('[role="tab"]:has-text("greet.ts")').count()) === 1);
      await page.waitForSelector(".cm-editor");
      await page.waitForTimeout(400);
      const active = await page.evaluate(() => document.querySelector(".cm-activeLine")?.textContent ?? "");
      check(`${theme}: the editor lands on the line`, active.includes("trimmed"), active);
      await shot(`filelinks-${theme}-editor`);

      // A file the agent wrote this turn links from its tool call even if the file list is stale.
      await page.getByRole("tab", { name: "Trace" }).click().catch(() => {});
      await page.waitForTimeout(200);
      await page.getByRole("tab", { name: "Chat" }).click().catch(() => {});
      const toolsToggle = page.locator("button[aria-expanded]").filter({ hasText: /wrote|created|file|edit|write/i }).first();
      if (await toolsToggle.count()) await toolsToggle.click();
      const wrote = await page.locator('[data-file-link="notes/new.md"]').count();
      check(`${theme}: the file the agent just wrote has an open button`, wrote >= 1, String(wrote));
    },
    { theme },
  );
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
