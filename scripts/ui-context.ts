/** Context meter, compaction divider and handoff dialog, end to end. `TRB_WEB_DIR=<dist> bun run scripts/ui-context.ts` */
import { withUi } from "./ui-harness";

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};

await withUi(async ({ page, shot, trb, workspaceId, url, repo }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const id = trb("run", "-e", "fake", "-d", "-C", repo, "Refactor the greeting module\nWRITE src/greet.ts export const g = 1;\nSAY first pass done\nUSAGE 120000\nCOMPACT 168000 24000\nSAY after the compaction\nUSAGE 150000").stdout.trim();
  for (let i = 0; i < 60 && /running/.test(trb("ls").stdout); i++) await Bun.sleep(150);

  await page.goto(`${url}/w/${workspaceId}`);
  await page.waitForSelector("header");
  await page.locator("button", { hasText: "Refactor the greeting module" }).first().click();
  await page.waitForSelector("[data-context-meter]");
  const label = (await page.locator("[data-context-meter]").first().textContent())?.trim();
  check("the composer shows context used out of the window", label === "150k / 200k", label ?? "");
  check("75% reads as amber", (await page.locator("[data-context-meter]").first().getAttribute("data-level")) === "warn");
  check("the compaction is a divider in Chat", (await page.locator("[data-compact-divider]").first().textContent())?.includes("168k → 24k") ?? false);
  check("no hand-off nudge below 80%", (await page.locator("[data-handoff-hint]").count()) === 0);
  await page.screenshot({ path: "/tmp/trb-shots/context-chat.png" });

  // Trace shows the same divider.
  await page.locator('[data-view-mode="trace"]').click();
  await page.waitForSelector("[data-compact-divider]");
  check("and in Trace", (await page.locator("[data-compact-divider]").count()) >= 1);
  await page.locator('[data-view-mode="chat"]').click();

  // Popover: breakdown + actions.
  await page.locator("[data-context-meter]").first().click();
  await page.waitForSelector("text=Cached input");
  await page.waitForTimeout(350);
  await page.screenshot({ path: "/tmp/trb-shots/context-popover.png" });
  check("the popover offers Compact and Hand off", (await page.locator("button", { hasText: "Compact" }).count()) > 0 && (await page.locator("button", { hasText: "Hand off…" }).count()) > 0);

  // Hand off.
  await page.locator("button", { hasText: "Hand off…" }).first().click();
  await page.waitForSelector("[data-handoff-summary]", { timeout: 20_000 });
  const summary = await page.locator("[data-handoff-summary]").inputValue();
  check("the dialog previews an editable summary", summary.includes("Refactor the greeting module"), `${summary.length} chars`);
  await page.locator("[data-handoff-summary]").fill(`${summary}\n\nExtra note from me.`);
  await page.waitForTimeout(350);
  await page.screenshot({ path: "/tmp/trb-shots/context-handoff.png" });
  await page.locator("[data-handoff-go]").click();
  await page.waitForSelector("[data-lineage]", { timeout: 15_000 });
  const lineage = (await page.locator("[data-lineage]").textContent())?.trim() ?? "";
  check("the new session says where it continues from", lineage.includes("continued from Refactor the greeting module"), lineage);
  const list = trb("ls", "--json").stdout;
  check("two sessions now", (list.match(/"id"/g) ?? []).length === 2);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "/tmp/trb-shots/context-new-session.png" });

  // Nudge at >= 80% (a session at 170k).
  trb("run", "-e", "fake", "-d", "-C", repo, "Another long one\nSAY ok\nUSAGE 170000");
  await page.waitForTimeout(1500);
  await page.locator("button", { hasText: "Another long one" }).first().click();
  await page.waitForSelector("[data-handoff-hint]", { timeout: 10_000 });
  check("a hand-off nudge appears past 80%", true);
  await page.screenshot({ path: "/tmp/trb-shots/context-hint.png" });
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  void id;
});

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
