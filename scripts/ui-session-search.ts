/** Search inside conversations from the sessions list filter: toggle, ranked hits, jump to the turn, export, palette. */
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, extra?: string) => {
  results.push([name, ok, extra]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

const msg = (page: Page) => page.locator('textarea[aria-label="Message"]');
async function turn(page: Page, text: string) {
  await msg(page).fill(text);
  await msg(page).press("Enter");
  await page.waitForTimeout(400);
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop the running turn"]'), null, { timeout: 20000 });
}

await withUi(async ({ page, url, workspaceId, shot }) => {
  await page.goto(`${url}/w/${workspaceId}`);
  await page.waitForSelector('textarea[aria-label="Message"]');
  await msg(page).fill("/engine fake");
  await msg(page).press("Enter");
  await page.waitForTimeout(300);
  await turn(page, "SAY first answer about onions");
  await turn(page, "SAY second answer mentions the quokkaquartz widget");
  await turn(page, "SAY third answer about leeks");

  // Sessions list.
  const filter = page.getByLabel("Filter sessions");
  await filter.waitFor({ timeout: 8000 });
  check("a plain filter box is the default", (await filter.getAttribute("placeholder")) === "Filter sessions");

  const toggle = page.locator('button[aria-pressed][aria-label*="inside conversations"]');
  await toggle.click();
  check("the toggle switches the box to searching conversations", (await filter.getAttribute("placeholder")) === "Search inside conversations");
  await filter.fill("quokkaquartz");
  await page.waitForSelector('[data-testid="session-search-results"]', { timeout: 8000 });
  const hitText = await page.locator('[data-testid="session-search-results"]').innerText();
  check("results show the matching turn", /turn 2/.test(hitText), hitText.slice(0, 80));
  const marks = await page.locator('[data-testid="session-search-results"] mark').allInnerTexts();
  check("matched words are highlighted", marks.some((m) => /quokkaquartz/i.test(m)), marks.join(","));
  await shot("sessearch-1-results");

  // Filters popover.
  await page.getByRole("button", { name: "Search filters" }).click();
  await page.getByLabel("From date").waitFor();
  await page.getByLabel("From date").fill("2999-01-01");
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape");
  await shot("sessearch-1b-filters");
  check("filters narrow the results (a future start date finds nothing)", (await page.getByText("No matches").count()) > 0);
  await page.getByRole("button", { name: "Search filters" }).click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="session-search-results"]', { timeout: 8000 });

  // Open a hit: the replay is scrolled to the matching turn.
  await page.locator('[data-testid="session-search-results"] button').first().click();
  await page.waitForSelector("[data-turn]", { timeout: 8000 });
  await page.waitForTimeout(900);
  check("a hit opens the read-only replay", (await page.getByText(/read-only replay/).count()) > 0);
  const flashed = await page.locator('[data-turn="2"]').evaluate((el) => /amber/.test(el.className));
  check("the matching turn is highlighted", flashed);
  check("Export HTML is available in the replay", (await page.getByRole("button", { name: /Export HTML/ }).count()) > 0);
  await shot("sessearch-2-replay");

  // Row menu keeps replay and export reachable without searching.
  await toggle.click();
  await filter.fill("");
  const row = page.locator("button[aria-current]").first();
  await row.click({ button: "right" });
  check("the session menu offers Replay and Export HTML", (await page.getByRole("menuitem", { name: /Replay/ }).count()) > 0 && (await page.getByRole("menuitem", { name: /Export HTML/ }).count()) > 0);
  await page.keyboard.press("Escape");

  // Palette command focuses the list with the toggle on.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Search past sessions");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const focused = await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.getAttribute("aria-label"));
  check("the palette command focuses the sessions filter with search on", focused === "Filter sessions" && (await filter.getAttribute("placeholder")) === "Search inside conversations", String(focused));
  check("no standalone Past sessions tab remains", (await page.getByRole("tab", { name: /^Past sessions$/ }).count()) === 0 && (await page.getByText("Past sessions", { exact: true }).count()) === 0);
});
process.exit(results.every((r) => r[1]) ? 0 : 1);
