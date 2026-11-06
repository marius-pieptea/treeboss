/** Nested heads, a failed head, closing animation and the empty states. */
import { withUi } from "./ui-harness";

const call = (name: string, args: unknown) => `CALL_TOOL ${name} ${JSON.stringify(args)}`;
const nestedBrief = [call("subagent_create", { brief: ["SLEEP 5000", "SAY nested scout finished"].join("\n"), role: "scout", title: "Nested scout" }), call("subagent_wait", { timeout_sec: 30 }), "SAY parent head finished"].join("\n");
const lead = [
  call("subagent_create", { brief: nestedBrief, role: "worker", title: "Parent head with a helper" }),
  call("subagent_create", { brief: "TOOL Bash false 400\nFAIL the build is broken", role: "reviewer", title: "Failing review" }),
  call("subagent_create", { brief: "SLEEP 14000\nSAY ok", role: "scout", title: "Slow scout" }),
  call("subagent_wait", { mode: "all", timeout_sec: 60 }),
].join("\n");

const checks: string[] = [];
const check = (name: string, ok: boolean) => (checks.push(`${ok ? "PASS" : "FAIL"} ${name}`), console.log(`${ok ? "PASS" : "FAIL"} ${name}`));

await withUi(async ({ page, shot, trb, workspaceId, url }) => {
  trb("pair", "add", "--title", "Fake Hydra", "--lead", "fake", "--role", "scout=fake", "--role", "worker=fake", "--role", "reviewer=fake");
  await page.goto(`${url}/w/${workspaceId}`);

  // No session selected: the Hydra explainer.
  await page.evaluate(() => {
    const cur = { state: { rightOpen: true, rightTab: "heads" }, version: 1 };
    localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
  });
  await page.reload();
  await page.waitForSelector("text=Hydra heads live here");
  console.log(await shot("heads-empty-none"));
  check("empty state explains Hydra when no session is active", true);

  const leadId = trb("run", "-p", "Fake Hydra", "-e", "fake", "-d", lead).stdout.trim();
  await page.evaluate((id) => {
    const cur = JSON.parse(localStorage.getItem("trb.ui.v1")!);
    const wid = location.pathname.split("/")[2];
    cur.state.byWs = { [wid]: { tabs: [], activeTab: null, activeSession: id, expanded: [], history: [] } };
    localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
  }, leadId);
  await page.reload();
  await page.waitForSelector("[data-head-id]", { timeout: 20000 });
  await page.waitForSelector('[data-head-id]:has-text("Nested scout")', { timeout: 20000 });
  await page.waitForTimeout(1200);
  console.log(await shot("heads-tree-working"));
  check("a grandchild is drawn under its parent on the rail", (await page.locator('[data-head-id]:has-text("Parent head with a helper") [data-head-id]:has-text("Nested scout")').count()) === 1);

  await page.waitForSelector('[data-head-id]:has-text("Failing review") [aria-label="failed"]', { timeout: 20000 });
  console.log(await shot("heads-tree-failed"));
  check("a failed head shows the failed mark", true);

  // Expanding the failed head shows its error.
  await page.locator('[data-head-id]:has-text("Failing review")').first().locator('button[aria-label="Expand"]').click();
  await page.waitForTimeout(700);
  check("its error is visible when expanded", (await page.locator("text=the build is broken").count()) > 0);
  console.log(await shot("heads-tree-failed-expanded"));

  // Follow up with the failed head from the card.
  await page.locator('[data-head-id]:has-text("Failing review")').first().locator('input[aria-label="Follow-up message"]').fill("SAY recovered after a nudge");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-head-id]:has-text("Failing review") [aria-label="done"]', { timeout: 15000 });
  check("a follow-up from the card re-runs the head", true);

  // Close finished closes the settled ones with nothing unmerged.
  await page.waitForFunction(() => !document.querySelector('[data-head-id] [aria-label="Interrupt"]') || true);
  await page.waitForTimeout(8000);
  await page.getByRole("button", { name: /Close finished/ }).click();
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(350);
  console.log(await shot("heads-close-finished-confirm"));
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(1500);
  console.log(await shot("heads-after-close-finished"));
  console.log(await page.evaluate(() => document.querySelectorAll("[data-head-id]").length), "heads left");
});
console.log("\n" + checks.join("\n"));
