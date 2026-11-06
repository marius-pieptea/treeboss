/**
 * Switching a session's model between turns, against the scripted engine: the chip of an idle session opens the model
 * picker, the choice applies to the NEXT turn (a dot until it starts), a running turn and a pair lock the chip with a
 * reason, a big conversation asks before dropping the cache, and the palette opens it. Shots in /tmp/trb-shots/modelswitch-*.png.
 *   TRB_WEB_DIR=<dist> bun run scripts/ui-modelswitch.ts
 */
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

async function open(page: Page, wid: string, url: string, sid: string) {
  await page.goto(`${url}/w/${wid}`);
  await page.evaluate(
    ([wid, sid]) => {
      const raw = localStorage.getItem("trb.ui.v1");
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
      cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: sid, expanded: [], history: [] } } };
      localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
      localStorage.setItem("trb.composer.v1", JSON.stringify({ engine: "fake", model: "", effort: "", pairId: "", worktree: false }));
    },
    [wid, sid] as [string, string],
  );
  await page.reload();
  await page.waitForSelector('textarea[aria-label="Message"]');
  await page.waitForTimeout(400);
}
const session = async (page: Page, id: string) => (await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}`)).json()).session, id)) as any;
const idle = (page: Page, timeout = 25_000) => page.waitForFunction(() => !document.querySelector('button[aria-label="Stop the running turn"]'), null, { timeout });
const lastId = (trb: (...a: string[]) => { stdout: string }, ) => {
  const out = trb("ls", "--json").stdout;
  const list = JSON.parse(out);
  const arr = Array.isArray(list) ? list : list.sessions;
  return arr[0].id as string;
};
const rightBoxes = (page: Page) =>
  page.evaluate(() => ["[data-mode-segment]", 'button[aria-label="Send message"], button[aria-label="Stop the running turn"]'].map((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? [Math.round(r.x * 2) / 2, Math.round(r.y * 2) / 2, Math.round(r.width * 2) / 2] : [-1, -1, -1];
  }));

for (const theme of (process.env.THEME ? [process.env.THEME] : ["dark", "light"]) as Array<"dark" | "light">) {
  await withUi(
    async ({ page, shot, trb, workspaceId, url, repo }) => {
      const t: string = theme;
      trb("config", "set", "default_engine", "fake");

      // ---- an idle session: switch the model, it applies to the next turn
      trb("run", "-e", "fake", "-m", "alpha", "-C", repo, "-d", "SAY first answer");
      const sid = lastId(trb);
      await open(page, workspaceId, url, sid);
      await page.waitForFunction(() => document.body.innerText.includes("first answer"), null, { timeout: 15_000 });
      const chip = page.locator("[data-engine-chip]");
      check(`${t}: the model chip of an idle session is switchable`, (await chip.getAttribute("data-model-switchable")) !== null);
      check(`${t}: the chip names the model, and the tooltip says the engine needs a new session`, ((await chip.textContent()) ?? "").includes("alpha") && ((await chip.getAttribute("title")) ?? "").includes("new session to change the engine"));
      const rightBefore = await rightBoxes(page);

      await chip.click();
      await page.waitForSelector("text=Model for the next turn");
      check(`${t}: the picker names the engine as fixed and shows the cache note`, ((await page.locator("[data-model-cache-note]").textContent()) ?? "").includes("without cache"));
      await page.waitForTimeout(350);
      await shot(`modelswitch-${t}-picker`);
      await page.locator('input[placeholder^="Search"], input[placeholder^="Search or type"]').first().fill("beta-2");
      await page.keyboard.press("Enter");
      await page.waitForFunction(async (id) => (await (await fetch(`/api/sessions/${id}`)).json()).session.model === "beta-2", sid, { timeout: 8000 });
      await page.waitForTimeout(500);
      check(`${t}: the chip shows the new model with a pending dot`, ((await chip.textContent()) ?? "").includes("beta-2") && (await page.locator("[data-model-pending]").count()) === 1);
      check(`${t}: the log says when it applies`, trb("logs", sid).stdout.includes("Model changed: alpha → beta-2 (applies to the next turn)"));
      check(`${t}: nothing on the right of the footer moved`, JSON.stringify(rightBefore) === JSON.stringify(await rightBoxes(page)), JSON.stringify([rightBefore, await rightBoxes(page)]));
      await shot(`modelswitch-${t}-pending`);

      // ---- the next turn gets it, and the dot goes
      await page.locator('textarea[aria-label="Message"]').fill("ECHO_ARGS");
      await page.locator('button[aria-label="Send message"]').click();
      await page.waitForFunction(() => document.body.innerText.includes("--model beta-2"), null, { timeout: 15_000 });
      await idle(page);
      check(`${t}: the next turn ran with --model beta-2`, await page.evaluate(() => document.body.innerText.includes("--model beta-2")));
      check(`${t}: the dot is gone once the turn started`, (await page.locator("[data-model-pending]").count()) === 0 && (await session(page, sid)).model_pending === false);

      // ---- a running turn locks the chip with a reason
      await page.locator('textarea[aria-label="Message"]').fill("SLEEP 5000\nSAY slept");
      await page.locator('button[aria-label="Send message"]').click();
      await page.waitForSelector('button[aria-label="Stop the running turn"]');
      await page.waitForTimeout(300);
      check(`${t}: while it runs the chip is locked, not switchable`, (await chip.getAttribute("data-model-lock")) === "busy" && (await chip.getAttribute("data-model-switchable")) === null);
      check(`${t}: the API refuses too`, (await page.evaluate(async (id) => (await fetch(`/api/sessions/${id}/model`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "x" }) })).status, sid)) === 409);
      await shot(`modelswitch-${t}-running`);
      await idle(page, 30_000);

      // ---- the palette opens the picker
      await page.keyboard.press("Meta+k");
      await page.keyboard.type("Switch model");
      await page.waitForTimeout(250);
      await page.keyboard.press("Enter");
      await page.waitForSelector("text=Model for the next turn", { timeout: 5000 });
      check(`${t}: the palette's "Switch model…" opens the picker`, true);
      await page.keyboard.press("Escape");

      // ---- a big conversation asks before dropping the cache
      trb("run", "-e", "fake", "-m", "alpha", "-C", repo, "-d", "SAY big one\nUSAGE 84000");
      const big = lastId(trb);
      await open(page, workspaceId, url, big);
      await page.waitForFunction(() => document.body.innerText.includes("big one"), null, { timeout: 15_000 });
      await page.waitForFunction(async (id) => ((await (await fetch(`/api/sessions/${id}`)).json()).session.context?.tokens ?? 0) > 50000, big, { timeout: 10_000 });
      await page.waitForTimeout(1500);
      await page.locator("[data-engine-chip]").click();
      await page.waitForSelector("text=Model for the next turn");
      await page.locator('input[placeholder^="Search"], input[placeholder^="Search or type"]').first().fill("gamma-1");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-model-confirm]", );
      const text = (await page.locator("[data-model-confirm]").textContent()) ?? "";
      check(`${t}: above 50k tokens it asks first, with the size`, text.includes("84k") && text.includes("without the cache"), text.slice(0, 80));
      check(`${t}: nothing changed before the answer`, (await session(page, big)).model === "alpha");
      await page.waitForTimeout(350);
      await shot(`modelswitch-${t}-confirm`);
      await page.locator("[data-model-confirm-go]").click();
      await page.waitForFunction(async (id) => (await (await fetch(`/api/sessions/${id}`)).json()).session.model === "gamma-1", big, { timeout: 8000 });
      check(`${t}: confirming switches`, true);

      // ---- a pair keeps its model
      const pair = await page.evaluate(async () => (await (await fetch("/api/pairs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Duo", lead_engine: "fake", lead_model: "pair-model", heads_engine: "fake" }) })).json()).pair);
      trb("run", "-e", "fake", "-p", pair.id, "-C", repo, "-d", "SAY paired");
      const paired = lastId(trb);
      await open(page, workspaceId, url, paired);
      await page.waitForFunction(() => document.body.innerText.includes("paired"), null, { timeout: 15_000 });
      const pchip = page.locator("[data-engine-chip]");
      check(`${t}: a pair's session is locked with "Set by the pair"`, (await pchip.getAttribute("data-model-lock")) === "locked" && (await pchip.getAttribute("title")) === "Set by the pair");
      await shot(`modelswitch-${t}-pair`);

      // ---- narrow panel: still one row
      await page.setViewportSize({ width: 700, height: 800 });
      await page.waitForTimeout(300);
      const rows = await page.evaluate(() => {
        const ys = ["[data-engine-chip]", "[data-mode-segment]"].map((s) => document.querySelector(s)?.getBoundingClientRect().y ?? -1);
        return Math.abs(ys[0] - ys[1]) < 12;
      });
      check(`${t}: the chip and the mode control stay on one row when narrow`, rows);
    },
    { theme },
  );
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
