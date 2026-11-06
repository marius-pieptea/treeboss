/** Drive the Chat | Trace agent panel, the composer settings popover and the shelf against the scripted engine; shots to /tmp/trb-shots/chatui-*.png. */
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

const results: string[] = [];
const check = (name: string, ok: boolean, extra?: string) => {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`;
  results.push(line);
  console.log(line);
};

const plain = ["SAY I'll start by reading the project layout.", "THINK", "READ src/server.ts", "BASH ls src", "TOOL Grep greet 700", "BASH bun test", "SLEEP 2500", "SAYMD 1"].join("\n");
const failing = ["SAY Trying the migration.", "BASH ls src", "FAIL migration exploded: table users is locked"].join("\n");
const hydra = [
  `CALL_TOOL subagent_create {"brief":"THINK\\nREAD src/greet.ts\\nTOOL Grep greet 1200\\nWRITE notes/scout.md mapped the greet module\\nGIT_COMMIT scout notes\\nSLEEP 5000\\nSAY Mapped the greet module: one exported function, no tests.","role":"scout","title":"Map the greet module"}`,
  `CALL_TOOL subagent_create {"brief":"BASH ls src\\nWRITE src/greet.test.ts import { greet } from './greet'; // tests\\nGIT_COMMIT add greet tests\\nSLEEP 9000\\nSAY Added tests for greet.","role":"worker","title":"Write greet tests"}`,
  `CALL_TOOL subagent_wait {"mode":"all","timeout_sec":60}`,
  "SAY Both heads are done.",
].join("\n");

async function seed(page: Page, wid: string, sid: string | null) {
  await page.evaluate(
    ([wid, sid]) => {
      const raw = localStorage.getItem("trb.ui.v1");
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
      cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: sid, expanded: [], history: [] } } };
      localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
    },
    [wid, sid] as [string, string | null],
  );
}

const mode = (page: Page, m: "chat" | "trace") => page.locator(`[data-view-mode="${m}"]`);
const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

for (const theme of ["dark", "light"] as const) {
  await withUi(
    async ({ page, shot, trb, workspaceId, url }) => {
      const t: string = theme;
      trb("pair", "add", "--title", "Fake Hydra", "--lead", "fake", "--role", "scout=fake", "--role", "worker=fake", "--max-heads", "3");

      // ---- a brand-new session: the empty state and the settings popover work before the first message
      await page.goto(`${url}/w/${workspaceId}`);
      await seed(page, workspaceId, null);
      await page.reload();
      await page.waitForSelector('textarea[aria-label="Message"]');
      await page.waitForTimeout(500);
      await shot(`chatui-${t}-empty`);
      check(`${t}: new session has no sliders button and no settings chip row`, (await page.locator("[data-settings-button]").count()) === 0 && (await page.getByRole("button", { name: /^Effort:/ }).count()) === 0);
      await page.locator("[data-engine-chip]").click();
      await page.waitForSelector("[data-run-with]");
      await page.waitForTimeout(250);
      await shot(`chatui-${t}-runwith`);
      const body = await page.locator("[data-run-with]").innerText();
      check(`${t}: Run with offers Harness and Hydra, with engine and effort under Harness`, ["Harness", "Hydra", "Engine", "Effort"].every((w) => body.includes(w)));
      await page.locator('[data-run-tab="hydra"]').click();
      await page.getByText("Fake Hydra").first().waitFor();
      await page.waitForTimeout(250);
      await shot(`chatui-${t}-runwith-hydra`);
      await page.getByText("Fake Hydra").first().click();
      await page.waitForTimeout(250);
      check(`${t}: choosing a pair replaces the harness chip with the pair chip`, (await page.locator("[data-pair-chip]").count()) === 1);
      await shot(`chatui-${t}-empty-with-pair`);
      // back to no pair for the plain runs
      await page.locator("[data-engine-chip]").click();
      await page.locator('[data-run-tab="hydra"]').click();
      await page.getByText("No pair").click();
      await page.keyboard.press("Escape");

      // ---- a plain session: Chat, then Trace, on the same session
      const plainId = trb("run", "-e", "fake", "-d", plain).stdout.trim();
      await seed(page, workspaceId, plainId);
      await page.reload();
      await page.waitForSelector("[data-chat-thread]");
      await page.waitForTimeout(1200);
      await shot(`chatui-${t}-chat-running`);
      await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop the running turn"]'), null, { timeout: 25000 });
      await page.waitForTimeout(600);
      await shot(`chatui-${t}-chat-done`);
      let txt = await bodyText(page);
      check(`${t}: chat shows no cost, tokens, durations or Finished card`, !/\$\d|\btokens?\b|\bin ·|Finished|follow-up/i.test(await page.locator("[data-chat-thread]").innerText()));
      check(`${t}: chat has the markdown answer and ONE tools line per run`, (await page.locator(".markdown h2").count()) > 0 && (await page.locator("[data-chat-thread] button[aria-expanded]").count()) >= 1);
      const toolLine = page.locator("[data-chat-thread] button[aria-expanded]").first();
      await toolLine.click();
      await page.waitForTimeout(250);
      await shot(`chatui-${t}-chat-tools-open`);
      check(`${t}: tool line expands to a quiet list`, (await page.locator("[data-chat-thread] li").count()) >= 4);

      await mode(page, "trace").click();
      await page.waitForTimeout(500);
      await shot(`chatui-${t}-trace`);
      txt = await bodyText(page);
      check(`${t}: trace keeps the detailed view (Finished card, engine badge)`, /Finished/.test(txt) && (await page.locator("[data-chat-thread]").count()) === 0);
      await mode(page, "chat").click();
      await page.waitForSelector("[data-chat-thread]");
      // Cmd/Ctrl-. toggles
      await page.keyboard.press("Control+.");
      await page.waitForTimeout(300);
      check(`${t}: Ctrl-. toggles to trace`, (await mode(page, "trace").getAttribute("aria-selected")) === "true");
      await page.keyboard.press("Control+.");
      await page.waitForTimeout(300);
      // persistence per session and as default
      await mode(page, "trace").click();
      await page.reload();
      await page.waitForSelector('[data-view-mode="trace"][aria-selected="true"]');
      check(`${t}: the choice survives a reload`, true);
      await mode(page, "chat").click();

      // menu: Continue in terminal is enabled when idle
      await page.getByRole("button", { name: "Session actions" }).click();
      await page.waitForTimeout(200);
      await shot(`chatui-${t}-menu-idle`);
      const cont = page.getByRole("menuitem", { name: /Continue in terminal/ });
      check(`${t}: Continue in terminal is enabled when idle`, (await cont.getAttribute("aria-disabled")) !== "true" && (await cont.getAttribute("data-disabled")) === null);
      await page.keyboard.press("Escape");

      // follow-up while running: menu entry disabled
      await page.locator('textarea[aria-label="Message"]').fill("SAY one more thing\nSLEEP 4000");
      await page.locator('textarea[aria-label="Message"]').press("Enter");
      await page.waitForSelector('button[aria-label="Stop the running turn"]');
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: "Session actions" }).click();
      await page.waitForTimeout(200);
      await shot(`chatui-${t}-menu-running`);
      const cont2 = page.getByRole("menuitem", { name: /Continue in terminal/ });
      check(`${t}: Continue in terminal is disabled while a turn runs`, (await cont2.getAttribute("data-disabled")) !== null || (await cont2.getAttribute("aria-disabled")) === "true");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop the running turn"]'), null, { timeout: 15000 });

      // ---- a failing session
      const failId = trb("run", "-e", "fake", "-d", failing).stdout.trim();
      await seed(page, workspaceId, failId);
      await page.reload();
      await page.waitForSelector("[data-chat-thread]");
      await page.waitForSelector('[role="alert"]', { timeout: 15000 });
      await page.waitForTimeout(500);
      await shot(`chatui-${t}-chat-failed`);
      check(`${t}: a failed turn shows the daemon's message and Retry`, /table users is locked/.test(await page.locator('[role="alert"]').first().innerText()) && (await page.getByRole("button", { name: "Retry" }).count()) >= 1);

      // ---- a Hydra run with heads: cards in the thread, chips on the shelf
      const leadId = trb("run", "-p", "Fake Hydra", "-e", "fake", "-d", hydra).stdout.trim();
      await seed(page, workspaceId, leadId);
      await page.reload();
      await page.waitForSelector("[data-shelf-head]", { timeout: 25000 });
      await page.waitForSelector("[data-chat-head]", { timeout: 25000 });
      await page.waitForTimeout(1500);
      await shot(`chatui-${t}-hydra-working`);
      check(`${t}: shelf shows a lead and one chip per head`, (await page.locator("[data-shelf-head]").count()) === 2 && /Lead/.test(await page.locator("[data-shelf]").innerText()));
      check(`${t}: thread has ONE card per head`, (await page.locator("[data-chat-head]").count()) === 2);
      await mode(page, "trace").click();
      await page.waitForTimeout(500);
      await shot(`chatui-${t}-hydra-trace`);
      check(`${t}: trace view keeps the shelf too`, (await page.locator("[data-shelf-head]").count()) === 2);
      await mode(page, "chat").click();
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Merge"), null, { timeout: 40000 });
      await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop the running turn"]'), null, { timeout: 40000 });
      await page.waitForTimeout(800);
      await shot(`chatui-${t}-hydra-done`);
      check(`${t}: finished head cards offer Merge and a diff stat`, (await page.getByRole("button", { name: "Merge", exact: true }).count()) >= 1 && /\+\d/.test(await page.locator("[data-chat-head]").first().innerText()));
      await page.locator("[data-shelf-head]").first().click();
      await page.waitForTimeout(800);
      await shot(`chatui-${t}-head-opened`);
      check(`${t}: clicking a shelf chip opens the head's session tab`, (await page.locator('[role="tab"]').count()) > 0);
    },
    { theme },
  );
}

console.log("\n" + results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
