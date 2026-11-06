/** Drives the agent panel and sessions sidebar end to end against the scripted engine. */
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

const P = "agent";
const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, extra?: string) => {
  results.push([name, ok, extra]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

async function type(page: Page, text: string) {
  const box = page.locator('textarea[aria-label="Message"]');
  await box.fill(text);
}

async function send(page: Page) {
  await page.locator('textarea[aria-label="Message"]').press("Enter");
}

async function waitIdle(page: Page, ms = 20000) {
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop the running turn"]'), null, { timeout: ms });
}

for (const theme of ["dark", "light"] as const) {
  await withUi(
    async ({ page, shot, url, workspaceId, trb }) => {
      const tag = theme === "dark" ? "" : "-light";
      await page.goto(`${url}/w/${workspaceId}`);
      await page.waitForSelector('textarea[aria-label="Message"]');
      // The theme lives in the UI store; use the real toggle rather than seeding storage.
      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      if (isDark !== (theme === "dark")) await page.getByRole("button", { name: /(Light|Dark) theme/ }).click();
      await page.waitForTimeout(400);
      await shot(`${P}-empty${tag}`);

      // A pair for the Hydra run later.
      trb("pair", "add", "--title", "Fake Pair", "--lead", "fake", "--heads", "fake", "--max-heads", "3");

      // ---- slash commands + a streaming session
      await type(page, "/engine fake");
      await send(page);
      await page.waitForTimeout(200);
      check(`${theme}: /engine picks fake`, (await page.getByRole("button", { name: /Engine: fake/ }).count()) === 1);

      await type(page, ["SAY I'll start by reading the project layout.", "THINK", "READ src/server.ts", "BASH ls src", "TOOL Grep greet 700", "BASH git status --short", "SLEEP 2500", "SAYMD 1"].join("\n"));
      await send(page);
      await page.waitForSelector('button[aria-label="Stop the running turn"]');
      await page.waitForTimeout(1300);
      await shot(`${P}-streaming${tag}`);
      check(`${theme}: status strip shows while running`, (await page.getByText(/tools?$/).count()) > 0);
      await waitIdle(page);
      await page.waitForTimeout(500);
      await shot(`${P}-done${tag}`);
      check(`${theme}: markdown rendered (heading + table + code)`, (await page.locator(".markdown h2").count()) > 0 && (await page.locator(".markdown table").count()) > 0 && (await page.locator(".markdown pre").count()) > 0);
      check(`${theme}: turn summary card`, (await page.getByText("Finished").count()) > 0);

      // expand a tool group
      const group = page.locator('button[aria-expanded="false"]').filter({ hasText: /ran|read|command|file/i }).first();
      if (await group.count()) {
        await group.click();
        await page.waitForTimeout(250);
        await shot(`${P}-tools-open${tag}`);
      }

      // ---- follow-up on the same session
      await type(page, "SAY Follow-up answer: all good");
      await send(page);
      await page.waitForTimeout(800);
      await shot(`${P}-followup-start${tag}`);
      await waitIdle(page);
      await page.waitForTimeout(500);
      await shot(`${P}-followup${tag}`);
      check(`${theme}: follow-up shows a divider and answer`, (await page.getByText("Follow-up answer: all good").count()) > 0 && (await page.getByText("follow-up", { exact: true }).count()) > 0);

      // ---- interrupt
      await type(page, "SAY working…\nSLEEP 30000");
      await send(page);
      await page.waitForSelector('button[aria-label="Stop the running turn"]');
      await page.waitForTimeout(700);
      await shot(`${P}-pre-stop${tag}`);
      await page.getByRole("button", { name: "Stop the running turn" }).click();
      await waitIdle(page, 15000);
      await page.waitForTimeout(400);
      check(`${theme}: interrupt ends the turn`, (await page.getByText("Interrupted").count()) > 0);
      await shot(`${P}-interrupted${tag}`);

      // ---- new session that fails
      await page.getByRole("button", { name: "New session" }).first().click();
      await page.waitForTimeout(300);
      await type(page, "/engine fake");
      await send(page);
      await type(page, "SAY trying…\nFAIL the build is broken");
      await send(page);
      await page.waitForSelector('[role="alert"]', { timeout: 15000 });
      check(`${theme}: failure card with retry`, (await page.getByRole("button", { name: /Retry/ }).count()) === 1);
      await shot(`${P}-failed${tag}`);

      // ---- Hydra: a lead opening a head
      await page.getByRole("button", { name: "New session" }).first().click();
      await page.waitForTimeout(300);
      await type(page, "/pair Fake Pair");
      await send(page);
      await page.waitForTimeout(300);
      check(`${theme}: /pair selects the pair`, (await page.getByRole("button", { name: /Hydra pair: Fake Pair/ }).count()) === 1);
      await type(page, [`CALL_TOOL subagent_create {"brief":"WRITE hello.txt from the head\\nTOOL Read 400\\nSAYMD 1","title":"write hello"}`, `CALL_TOOL subagent_wait {"mode":"all","timeout_sec":20}`, "SAY All heads reported."].join("\n"));
      await send(page);
      await page.waitForSelector('button[aria-label="Stop the running turn"]', { timeout: 10000 });
      await waitIdle(page, 40000);
      await page.waitForTimeout(600);
      const railCount = await page.locator("div.border-l-2").count();
      check(`${theme}: head lines render on a rail`, railCount > 0, `${railCount} rail(s)`);
      await shot(`${P}-hydra${tag}`);

      // ---- the top of the Hydra transcript: the tool call and the head's rail
      const scroller = page.locator("div.overflow-y-auto.overflow-x-hidden").first();
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(300);
      await shot(`${P}-hydra-top${tag}`);

      // ---- the jump-to-latest pill: reading history while new output arrives
      await type(page, "SAYMD 5");
      await send(page);
      await waitIdle(page);
      await page.waitForTimeout(400);
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(200);
      await type(page, "SLEEP 800\nSAYMD 2");
      await send(page);
      await page.waitForSelector('button:has-text("Jump to latest")', { timeout: 8000 }).then(
        () => check(`${theme}: jump pill appears when scrolled away`, true),
        () => check(`${theme}: jump pill appears when scrolled away`, false),
      );
      await shot(`${P}-pill${tag}`);
      await page.getByRole("button", { name: /Jump to latest/ }).click().catch(() => {});
      await waitIdle(page);
      await page.waitForTimeout(500);
      const atBottom = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80);
      check(`${theme}: jump pill returns to the bottom`, atBottom);

      // ---- @-mention and slash suggestions on a fresh composer
      await page.getByRole("button", { name: "New session" }).first().click();
      await page.waitForTimeout(300);
      const box = page.locator('textarea[aria-label="Message"]');
      await box.click();
      await box.pressSequentially("look at @gre");
      await page.waitForSelector('[role="option"]:has-text("greet.ts")', { timeout: 8000 }).then(
        () => check(`${theme}: @ opens the file picker`, true),
        () => check(`${theme}: @ opens the file picker`, false),
      );
      await shot(`${P}-mention${tag}`);
      await box.press("Enter");
      check(`${theme}: choosing a file inserts its path`, (await box.inputValue()).includes("src/greet.ts"));
      await box.fill("");
      await box.pressSequentially("/");
      await page.waitForTimeout(200);
      check(`${theme}: / lists commands`, (await page.locator('[role="option"]').count()) >= 5);
      await shot(`${P}-slash${tag}`);
      await box.press("Escape");
      await box.fill("line one");
      await box.press("Shift+Enter");
      await box.pressSequentially("line two");
      check(`${theme}: Shift+Enter makes a new line`, (await box.inputValue()) === "line one\nline two");
      await box.fill("");

      // ---- sessions sidebar
      await page.waitForTimeout(500);
      await shot(`${P}-sessions${tag}`);
      const rows = await page.locator("button[aria-current]").count();
      check(`${theme}: sessions listed`, rows >= 3, `${rows} rows`);

      // filter
      await page.getByLabel("Filter sessions").fill("zzzz");
      await page.waitForTimeout(200);
      check(`${theme}: filter empties list`, (await page.getByText("No matching sessions").count()) === 1);
      await page.getByLabel("Filter sessions").fill("");

      // ---- rename and delete from the sidebar's context menu
      const row = page.locator("button[aria-current]").nth(1);
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: /Rename/ }).click();
      await page.getByRole("dialog").getByRole("textbox").fill("Renamed by the test");
      await page.getByRole("dialog").getByRole("textbox").press("Enter");
      await page.waitForSelector('text="Renamed by the test"', { timeout: 5000 }).then(
        () => check(`${theme}: rename from the context menu`, true),
        () => check(`${theme}: rename from the context menu`, false),
      );
      await shot(`${P}-renamed${tag}`);
      const target = page.locator("button[aria-current]", { hasText: "Renamed by the test" });
      await target.click({ button: "right" });
      await page.getByRole("menuitem", { name: /Close session/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Close session" }).click();
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: /Closed/ }).click().catch(() => {});
      await page.waitForTimeout(300);
      await shot(`${P}-closed${tag}`);
      const closedRow = page.locator("button[aria-current]", { hasText: "Renamed by the test" });
      await closedRow.click({ button: "right" });
      await page.getByRole("menuitem", { name: /Delete/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
      await page.waitForTimeout(800);
      check(`${theme}: closed session can be deleted`, (await page.locator("button[aria-current]", { hasText: "Renamed by the test" }).count()) === 0);
    },
  );
}

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
