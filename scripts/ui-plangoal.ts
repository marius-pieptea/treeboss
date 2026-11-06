/** Drive plan mode and goal mode in the composer against the scripted engine; shots to /tmp/trb-shots/plangoal-*.png. */
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

async function fresh(page: Page, wid: string, url: string, sid: string | null) {
  await page.goto(`${url}/w/${wid}`);
  await page.evaluate(
    ([wid, sid]) => {
      const raw = localStorage.getItem("trb.ui.v1");
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
      cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: sid, expanded: [], history: [] } } };
      localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
      // The composer defaults to the real claude; these runs must use the scripted engine.
      localStorage.setItem("trb.composer.v1", JSON.stringify({ engine: "fake", model: "", effort: "", pairId: "", worktree: false }));
    },
    [wid, sid] as [string, string | null],
  );
  await page.reload();
  await page.waitForSelector('textarea[aria-label="Message"]');
}
const send = async (page: Page, text: string) => {
  await page.locator('textarea[aria-label="Message"]').fill(text);
  await page.keyboard.press("Enter");
};
const openGoal = async (page: Page) => {
  await page.locator("[data-plus-menu]").click();
  await page.locator("[data-goal-open]").click();
};
const PLAN = JSON.stringify({ title: "Add a greeting test", summary: "Cover greet() with a test.", steps: [{ title: "Write the test", detail: "One case per branch.", files: ["src/greet.test.ts"] }, { title: "Run it", detail: "bun test." }] });
const sessionOf = async (page: Page) => (await page.evaluate(async () => (await (await fetch("/api/sessions")).json()).sessions)) as any[];

for (const theme of (process.env.THEME ? [process.env.THEME] : ["dark", "light"]) as Array<"dark" | "light">) {
  await withUi(
    async ({ page, shot, trb, workspaceId, url }) => {
      const t: string = theme;
      trb("config", "set", "default_engine", "fake");

      // ---- plan mode: toggle before the first message, plan, approve
      await fresh(page, workspaceId, url, null);
      const chip = page.locator("[data-mode-segment]");
      check(`${t}: the composer starts in build mode`, (await chip.getAttribute("data-mode")) === "build");
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Plan: quick" }).click();
      check(`${t}: the control switches to plan`, (await chip.getAttribute("data-mode")) === "plan");
      await shot(`plangoal-${t}-plan-chip`);
      await send(page, `WRITE blocked.txt nope\nCALL_TOOL plan_submit ${PLAN}`);
      await page.waitForSelector("[data-plan-row]", { timeout: 20_000 });
      await page.waitForTimeout(300);
      await shot(`plangoal-${t}-plan-ready`);
      const list = await sessionOf(page);
      check(`${t}: the session was created in plan mode`, list[0]?.mode === "plan", String(list[0]?.mode));
      check(`${t}: the plan row offers Approve and build`, (await page.locator("[data-plan-row-approve]").innerText()).includes("Approve and build"));
      await page.waitForFunction(() => !(document.querySelector("[data-plan-row-approve]") as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
      await page.locator("[data-plan-row-approve]").click();
      await page.waitForFunction(() => document.querySelector("[data-mode-segment]")?.getAttribute("data-mode") === "build", null, { timeout: 15_000 });
      await page.waitForSelector("[data-plan-row]", { state: "detached", timeout: 15_000 });
      const after = (await sessionOf(page))[0];
      check(`${t}: approving flips to build and sends the next turn`, after.mode === "build" && after.turns >= 1, `turns=${after.turns}`);

      // ---- goal mode on a brand-new session
      await fresh(page, workspaceId, url, null);
      await openGoal(page);
      await page.locator("[data-goal-text]").fill("BASH echo x >> c.txt");
      await page.locator("[data-goal-check]").fill("test $(wc -l < c.txt) -ge 2");
      await shot(`plangoal-${t}-goal-dialog`);
      await page.getByRole("button", { name: "Set goal" }).click();
      check(`${t}: the goal shows as a chip in the box`, (await page.locator("[data-composer] [data-goal-chip]").count()) === 1);
      await send(page, "SAY starting");
      await page.waitForSelector("[data-goal-bar]", { timeout: 20_000 });
      await shot(`plangoal-${t}-goal-working`);
      await page.waitForSelector('[data-goal-bar][data-goal-status="met"]', { timeout: 30_000 });
      await page.waitForTimeout(400);
      await shot(`plangoal-${t}-goal-met`);
      const turnsText = await page.locator("[data-goal-turns]").innerText();
      check(`${t}: the goal bar reports met after its turns`, turnsText.startsWith("2/12"), turnsText);
      check(`${t}: the check result shows`, (await page.locator("[data-goal-check]").first().isVisible().catch(() => false)) || (await page.locator("[data-goal-bar]").innerText()).includes("check passed"));
      await page.getByRole("button", { name: "Dismiss" }).click();
      await page.waitForSelector("[data-goal-bar]", { state: "detached", timeout: 3000 }).catch(() => {});
      check(`${t}: a finished goal can be dismissed`, (await page.locator("[data-goal-bar]").count()) === 0);

      // ---- goal on a running session, then Stop
      await send(page, "SLEEP 600\nSAY idle");
      await page.waitForTimeout(900);
      await openGoal(page);
      await page.locator("[data-goal-text]").fill("SLEEP 1500");
      await page.locator("[data-goal-check]").fill("false");
      await page.getByRole("button", { name: "Start working" }).click();
      await page.waitForSelector('[data-goal-bar][data-goal-status="active"]', { timeout: 15_000 });
      await shot(`plangoal-${t}-goal-active`);
      await page.locator("[data-goal-stop]").click();
      await page.waitForSelector('[data-goal-bar][data-goal-status="stopped"]', { timeout: 15_000 });
      check(`${t}: Stop ends the goal`, (await page.locator("[data-goal-note]").innerText()).includes("stopped by you"));
      await shot(`plangoal-${t}-goal-stopped`);
    },
    { theme },
  );
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
