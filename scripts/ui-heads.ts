/** Drive the heads panel and the head session tab against the scripted engine; screenshots to /tmp/trb-shots/heads-*.png. */
import { withUi } from "./ui-harness";

const lead = [
  `CALL_TOOL subagent_create {"brief":"THINK\\nREAD src/greet.ts\\nTOOL Grep greet 1200\\nWRITE notes/scout.md mapped the greet module\\nGIT_COMMIT scout notes\\nSLEEP 7000\\nSAY Mapped the greet module: one exported function, no tests.","role":"scout","title":"Map the greet module"}`,
  `CALL_TOOL subagent_create {"brief":"BASH ls src\\nWRITE src/greet.test.ts import { greet } from './greet'; // tests\\nGIT_COMMIT add greet tests\\nWRITE src/utils/clamp.ts export const clamp = (n: number) => n;\\nGIT_COMMIT add clamp\\nSLEEP 10000\\nSAYMD 1","role":"worker","title":"Write greet tests"}`,
  `CALL_TOOL subagent_create {"brief":"READ src/server.ts\\nSLEEP 16000\\nSAY Looks fine.","role":"reviewer","title":"Review server wiring"}`,
  `CALL_TOOL subagent_wait {"mode":"all","timeout_sec":60}`,
].join("\n");

const seed = async (page: any, wid: string, leadId: string, extra: Record<string, unknown> = {}) => {
  await page.evaluate(
    ([wid, leadId, extra]: any) => {
      const raw = localStorage.getItem("trb.ui.v1");
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
      cur.state = { ...cur.state, ...(extra.theme ? { theme: extra.theme } : {}), rightOpen: true, rightTab: "heads", leftOpen: true, byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: leadId, expanded: [], history: [] } } };
      localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
    },
    [wid, leadId, extra],
  );
};

async function setup(trb: any, page: any, url: string, workspaceId: string, theme?: string) {
  const pair = trb("pair", "add", "--title", "Fake Hydra", "--lead", "fake", "--role", "scout=fake", "--role", "worker=fake", "--role", "reviewer=fake", "--max-heads", "4");
  if (pair.code !== 0) throw new Error(pair.stderr);
  const run = trb("run", "-p", "Fake Hydra", "-e", "fake", "-d", lead);
  const leadId = run.stdout.trim();
  if (!/^s_/.test(leadId)) throw new Error(`no lead id: ${run.stdout} ${run.stderr}`);
  await page.goto(`${url}/w/${workspaceId}`);
  await seed(page, workspaceId, leadId, { theme });
  await page.reload();
  await page.waitForSelector("[data-head-id]", { timeout: 20000 });
  return leadId;
}

const checks: string[] = [];
const check = (name: string, ok: boolean) => {
  checks.push(`${ok ? "PASS" : "FAIL"} ${name}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};

await withUi(async ({ page, shot, trb, workspaceId, url, repo }) => {
  const leadId = await setup(trb, page, url, workspaceId);
  await page.waitForTimeout(1500);
  console.log(await shot("heads-dark-working"));

  // Wait for the first two heads to settle with work ready to merge.
  await page.waitForFunction(() => [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Merge").length >= 2, null, { timeout: 40000 });
  console.log(await shot("heads-dark-ready"));
  check("two heads show a Merge button", true);

  // Keyboard: j selects the first card, k stays, Enter opens its session tab.
  await page.locator('[aria-label="Heads"]').focus();
  await page.keyboard.press("j");
  const sel1 = await page.evaluate(() => document.querySelector('[data-head-id] > div[class*="border-accent"]')?.closest("[data-head-id]")?.getAttribute("data-head-id"));
  check("j selects a card", !!sel1);
  await page.keyboard.press("j");
  const sel2 = await page.evaluate(() => document.querySelector('[data-head-id] > div[class*="border-accent"]')?.closest("[data-head-id]")?.getAttribute("data-head-id"));
  check("j again moves to the next card", !!sel2 && sel2 !== sel1);
  await page.keyboard.press("k");

  // Expand the first card: answer + follow-up box.
  await page.locator('[data-head-id]').first().locator('button[aria-label="Expand"]').click();
  await page.waitForTimeout(500);
  console.log(await shot("heads-dark-expanded"));
  check("expanded card shows the follow-up box", (await page.locator('input[aria-label="Follow-up message"]').count()) > 0);

  // Merge the worker via the card: confirm dialog, then the file lands uncommitted in the checkout.
  const worker = page.locator('[data-head-id]', { hasText: "Write greet tests" });
  await worker.getByRole("button", { name: "Merge", exact: true }).click();
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(350);
  console.log(await shot("heads-dark-merge-confirm"));
  await page.getByRole("button", { name: "Merge", exact: true }).last().click();
  await page.waitForFunction(() => document.body.innerText.includes("merged"), null, { timeout: 10000 });
  await page.waitForTimeout(600);
  console.log(await shot("heads-dark-merged"));
  const fs = await import("fs");
  check("merge applied the worker's files to the checkout", fs.existsSync(`${repo}/src/greet.test.ts`) && fs.existsSync(`${repo}/src/utils/clamp.ts`));

  // Open the scout in a session tab, on Changes.
  const scout = page.locator('[data-head-id]', { hasText: "Map the greet module" });
  await scout.locator('button[aria-label="View changes"]').click();
  await page.waitForSelector('[role="tab"][aria-selected="true"]:has-text("Changes")');
  await page.waitForTimeout(800);
  console.log(await shot("heads-dark-session-changes"));
  check("session tab opened on Changes with a diff", (await page.locator("text=notes/scout.md").count()) > 0);

  for (const [name, file] of [["Conversation", "conversation"], ["Files", "files"], ["Info", "info"]] as const) {
    await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
    await page.waitForTimeout(700);
    console.log(await shot(`heads-dark-session-${file}`));
  }

  // Spawn dialog.
  await page.getByRole("button", { name: "Spawn head" }).click();
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(350);
  console.log(await shot("heads-dark-spawn"));
  await page.locator("textarea").fill("SAY spawned by hand\nSLEEP 1500");
  await page.getByRole("button", { name: "Spawn", exact: true }).click();
  await page.waitForSelector('[data-head-id]:has-text("SAY spawned by hand")', { timeout: 10000 });
  check("a hand-spawned head appears in the panel", true);

  // Close a finished head (unmerged work asks first).
  await scout.locator('button[aria-label="Close head"]').click();
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(350);
  console.log(await shot("heads-dark-close-confirm"));
  await page.getByRole("button", { name: "Close head" }).click();
  const gone = await page.waitForSelector('[data-head-id]:has-text("Map the greet module")', { state: "detached", timeout: 5000 }).then(() => true, () => false);
  check("closed head leaves the panel", gone);
  console.log(await shot("heads-dark-after-close"));
});

await withUi(
  async ({ page, shot, trb, workspaceId, url }) => {
    await setup(trb, page, url, workspaceId, "light");
    await page.waitForTimeout(1500);
    console.log(await shot("heads-light-working"));
    await page.waitForFunction(() => [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Merge").length >= 2, null, { timeout: 40000 });
    const w = page.locator('[data-head-id]', { hasText: "Write greet tests" });
    await w.locator('button[aria-label="View changes"]').click();
    await page.waitForTimeout(1000);
    console.log(await shot("heads-light-session-changes"));
    await page.getByRole("tab", { name: /^Conversation/ }).click();
    await page.waitForTimeout(800);
    console.log(await shot("heads-light-session-conversation"));
    await page.getByRole("button", { name: "Spawn head" }).click();
    await page.waitForTimeout(400);
    console.log(await shot("heads-light-spawn"));
  },
  { theme: "light" },
);

console.log("\n" + checks.join("\n"));
