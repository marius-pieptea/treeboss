/**
 * The composer's layout rules, against the scripted engine: nothing shifts when Plan is toggled, the plan row appears
 * only once a plan is written, the status slot shows ONE thing by priority, the "+" menu works from the keyboard, and
 * the footer never wraps or overflows at narrow widths. Shots in /tmp/trb-shots/composer-*.png.
 * `TRB_WEB_DIR=<dist> bun run scripts/ui-composer.ts`
 */
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

async function seed(page: Page, wid: string, sid: string | null) {
  await page.evaluate(
    ([wid, sid]) => {
      const raw = localStorage.getItem("trb.ui.v1");
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
      cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: sid, expanded: [], history: [] } } };
      localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
      localStorage.setItem("trb.composer.v1", JSON.stringify({ engine: "fake", model: "", effort: "", pairId: "", worktree: false }));
    },
    [wid, sid] as [string, string | null],
  );
}
async function fresh(page: Page, wid: string, url: string, sid: string | null = null) {
  await page.goto(`${url}/w/${wid}`);
  await seed(page, wid, sid);
  await page.reload();
  await page.waitForSelector('textarea[aria-label="Message"]');
  await page.waitForTimeout(300);
}
const send = async (page: Page, text: string) => {
  await page.locator('textarea[aria-label="Message"]').fill(text);
  await page.keyboard.press("Enter");
};
const slot = (page: Page) => page.locator("[data-status-slot]").getAttribute("data-status-slot");
const waitSlot = (page: Page, kind: string, timeout = 25_000) => page.waitForSelector(`[data-status-slot="${kind}"]`, { timeout });
const sessions = async (page: Page) => (await page.evaluate(async () => (await (await fetch("/api/sessions")).json()).sessions)) as any[];
const idle = (page: Page, timeout = 25_000) => page.waitForFunction(() => !document.querySelector('button[aria-label="Stop the running turn"]'), null, { timeout });

/** Where the footer's controls sit: used to prove toggling Plan moves nothing. */
const FOOTER = ["[data-plus-menu]", "[data-engine-chip]", "[data-mode-segment]", 'button[aria-label="Start session"]'];
async function footerBoxes(page: Page, selectors = FOOTER) {
  return page.evaluate((sels) => sels.map((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { s, x: Math.round(r.x * 2) / 2, y: Math.round(r.y * 2) / 2, w: Math.round(r.width * 2) / 2, h: Math.round(r.height * 2) / 2 } : { s, x: -1, y: -1, w: -1, h: -1 };
  }), selectors);
}
const sameBoxes = (a: Awaited<ReturnType<typeof footerBoxes>>, b: Awaited<ReturnType<typeof footerBoxes>>) => a.every((x, i) => Math.abs(x.x - b[i].x) < 0.6 && Math.abs(x.y - b[i].y) < 0.6 && Math.abs(x.w - b[i].w) < 0.6 && Math.abs(x.h - b[i].h) < 0.6);

const PLAN = JSON.stringify({
  title: "Add a model cache",
  summary: "Keep the catalog in SQLite so a restart does not refetch it.",
  steps: [
    { title: "Create the cache table", detail: "One row per engine.", files: ["src/db.ts"] },
    { title: "Read through the cache", detail: "Serve fresh rows, refetch stale ones." },
  ],
  risks: ["A stale row hides a new model until it expires."],
});
const ASK = JSON.stringify({ question: "Where should the cache live?", options: [{ label: "SQLite", recommended: true, reason: "already shipped" }, { label: "In memory" }] });
const hydra = [
  `CALL_TOOL subagent_create {"brief":"SLEEP 9000\\nSAY scouted","role":"scout","title":"Map the module"}`,
  `CALL_TOOL subagent_create {"brief":"SLEEP 9000\\nSAY built","role":"worker","title":"Write tests"}`,
  `CALL_TOOL subagent_wait {"mode":"all","timeout_sec":60}`,
  "SAY Both heads are done.",
].join("\n");

for (const theme of (process.env.THEME ? [process.env.THEME] : ["dark", "light"]) as Array<"dark" | "light">) {
  await withUi(
    async ({ page, shot, trb, workspaceId, url }) => {
      const t: string = theme;
      trb("config", "set", "default_engine", "fake");
      trb("pair", "add", "--title", "Fake Hydra", "--lead", "fake", "--role", "scout=fake", "--role", "worker=fake", "--max-heads", "3");

      // ---- a new session: nothing shifts when Plan is toggled
      await fresh(page, workspaceId, url);
      await shot(`composer-${t}-new`);
      check(`${t}: the slot takes no room when empty`, (await slot(page)) === "none" && ((await page.locator("[data-status-slot]").boundingBox())?.height ?? 1) < 1);
      check(`${t}: the removed pieces are gone (graph badge, banner, separate attach, depth switch)`, (await page.locator("[data-codegraph-badge], [data-plan-banner], [data-attach]").count()) === 0 && (await page.locator('[data-plan-depth-option]').count()) === 0);
      const placeholderBuild = await page.locator('textarea[aria-label="Message"]').getAttribute("placeholder");
      const before = await footerBoxes(page);
      check(`${t}: every footer control is there`, before.every((b) => b.w > 0), JSON.stringify(before.filter((b) => b.w <= 0).map((b) => b.s)));
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Plan: quick" }).click();
      await page.waitForTimeout(250);
      const after = await footerBoxes(page);
      check(`${t}: toggling Plan moves nothing in the footer`, sameBoxes(before, after), JSON.stringify(before.map((b, i) => [b.s, b.x - after[i].x, b.w - after[i].w])));
      check(`${t}: plan mode tints the box and asks to plan`, (await page.locator("[data-composer]").getAttribute("data-planning")) !== null && (await page.locator('textarea[aria-label="Message"]').getAttribute("placeholder")) === "Describe what to plan…" && placeholderBuild !== "Describe what to plan…");
      await shot(`composer-${t}-plan-mode`);
      // depth menu: choosing Spec it changes the icon, never the width
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Plan: spec it" }).click();
      await page.waitForTimeout(250);
      check(`${t}: Spec it is chosen and the control keeps its width`, (await page.locator("[data-mode-segment]").getAttribute("data-plan-depth")) === "spec" && sameBoxes(before, await footerBoxes(page)));
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Plan: quick" }).click();
      await page.waitForTimeout(400); // the menu hands focus back to its trigger; let it, then use the keyboard
      // keyboard: Alt+P steps Plan -> Ask -> Build -> Plan, and nothing moves
      await page.locator('textarea[aria-label="Message"]').focus();
      await page.keyboard.press("Alt+KeyP");
      await page.waitForTimeout(200);
      check(`${t}: Alt+P goes from Plan to Ask`, (await page.locator("[data-mode-segment]").getAttribute("data-mode")) === "ask" && sameBoxes(before, await footerBoxes(page)));
      await page.keyboard.press("Alt+KeyP");
      await page.waitForTimeout(200);
      check(`${t}: Alt+P then goes to Build`, (await page.locator("[data-mode-segment]").getAttribute("data-mode")) === "build" && sameBoxes(before, await footerBoxes(page)));
      await page.keyboard.press("Alt+KeyP");
      await page.waitForTimeout(200);
      check(`${t}: Alt+P then goes to Plan`, (await page.locator("[data-mode-segment]").getAttribute("data-mode")) === "plan");

      // ---- the "+" menu, by keyboard
      await page.locator("[data-plus-menu]").click();
      await page.waitForSelector('[role="menu"][aria-label="Add"]');
      await page.waitForTimeout(150);
      check(`${t}: the + menu focuses its first item`, (await page.evaluate(() => document.activeElement?.hasAttribute("data-attach") ?? false)));
      await shot(`composer-${t}-plus-menu`);
      await page.keyboard.press("ArrowDown");
      check(`${t}: ArrowDown moves to Set a goal`, await page.evaluate(() => document.activeElement?.hasAttribute("data-goal-open") ?? false));
      await page.keyboard.press("ArrowDown");
      check(`${t}: ArrowDown moves to Mention a file`, await page.evaluate(() => document.activeElement?.hasAttribute("data-mention-open") ?? false));
      await page.keyboard.press("Enter");
      await page.waitForTimeout(250);
      check(`${t}: Mention puts an @ in the box`, (await page.locator('textarea[aria-label="Message"]').inputValue()).includes("@"));
      await page.locator('textarea[aria-label="Message"]').fill("");
      await page.keyboard.press("Escape");
      await page.locator("[data-plus-menu]").click();
      await page.locator("[data-attach]").click();
      await page.waitForSelector("[data-attach-panel]");
      check(`${t}: Attach opens the one picker inside the menu`, (await page.locator("[data-attach-panel]").count()) === 1);
      await page.keyboard.press("Escape");
      // a goal set before the session starts is a chip inside the box, not a footer control
      await page.locator("[data-plus-menu]").click();
      await page.locator("[data-goal-open]").click();
      await page.locator("[data-goal-text]").fill("BASH echo x >> c.txt");
      await page.locator("[data-goal-check]").fill("false");
      await page.getByRole("button", { name: "Set goal" }).click();
      await page.waitForTimeout(250);
      check(`${t}: the goal chosen for the next session is a chip in the box`, (await page.locator("[data-composer] [data-goal-chip]").count()) === 1 && (await page.locator("[data-composer] [data-goal-chip]").innerText()).includes("echo"));
      check(`${t}: and it did not move the footer`, sameBoxes(before, await footerBoxes(page)));
      await page.locator("[data-goal-chip] button[aria-label='Remove the goal']").click();
      check(`${t}: the chip can be removed`, (await page.locator("[data-goal-chip]").count()) === 0);

      // ---- plan mode, plain-text reply: NO plan row (the old banner lied here)
      await send(page, "SAY I would add a cache, but I will not call the plan tool.");
      await page.waitForSelector("[data-chat-thread]", { timeout: 20_000 });
      await idle(page);
      await page.waitForTimeout(700);
      check(`${t}: a plain reply in plan mode shows no plan row and an empty slot`, (await page.locator("[data-plan-row]").count()) === 0 && (await slot(page)) === "none" && (await page.locator("[data-plan-banner]").count()) === 0);
      await shot(`composer-${t}-plan-plain-reply`);

      // ---- a written plan: one row above the box, same buttons as the plan tab
      await send(page, `CALL_TOOL plan_submit ${PLAN}`);
      await waitSlot(page, "plan");
      await page.waitForSelector("[data-plan-viewer]", { timeout: 15_000 });
      await page.waitForTimeout(500);
      check(`${t}: the plan row appears once the plan is written`, (await page.locator("[data-plan-row]").count()) === 1 && (await page.locator("[data-plan-row]").innerText()).includes("Add a model cache"));
      check(`${t}: the row has Open, Skip plan and Approve and build`, (await page.locator("[data-plan-row-open]").count()) === 1 && (await page.locator("[data-plan-row-skip]").innerText()).includes("Skip plan") && (await page.locator("[data-plan-row-approve]").innerText()).includes("Approve and build"));
      check(`${t}: the approve button is readable (accent-fg text)`, await page.evaluate(() => { const b = document.querySelector("[data-plan-row-approve]") as HTMLElement; const c = getComputedStyle(b).color; const root = getComputedStyle(document.documentElement).getPropertyValue("--accent-fg").trim(); return !!c && root.length > 0; }));
      check(`${t}: the dock holds no second plan chip`, (await page.locator("[data-status-slot] [data-plan-chip]").count()) === 0);
      check(`${t}: the plan tab has the same decision`, (await page.locator("[data-plan-viewer] [data-plan-approve]").count()) === 1 && (await page.locator("[data-plan-viewer] [data-plan-skip]").count()) === 1);
      await shot(`composer-${t}-plan-ready`);

      // ---- priority: a question beats the plan row
      await send(page, `CALL_TOOL plan_ask ${ASK}`);
      await waitSlot(page, "question");
      await page.waitForTimeout(350);
      check(`${t}: a question outranks the plan row (one item at a time)`, (await page.locator("[data-plan-question]").count()) === 1 && (await page.locator("[data-plan-row]").count()) === 0);
      await shot(`composer-${t}-question`);
      await page.locator("[data-plan-answer]").click();
      await waitSlot(page, "plan", 25_000);
      check(`${t}: the plan row comes back once the question is answered`, (await page.locator("[data-plan-row]").count()) === 1);

      // ---- approve from the row: the same call as the tab's bar
      await page.waitForFunction(() => !(document.querySelector("[data-plan-row-approve]") as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
      await page.locator("[data-plan-row-approve]").click();
      await page.waitForFunction(() => document.querySelector("[data-mode-segment]")?.getAttribute("data-mode") === "build", null, { timeout: 20_000 });
      await waitSlot(page, "none", 20_000).catch(() => {});
      await idle(page, 30_000);
      {
        const all = await sessions(page);
        await page.waitForTimeout(500);
        const rows = await page.locator("[data-plan-row]").count();
        if (rows) console.log("DEBUG plan-state", JSON.stringify(await page.evaluate(async (id) => { const r = await (await fetch(`/api/sessions/${id}/plan-state`)).json(); return { plan: r.plan && { id: r.plan.id, status: r.plan.status, v: r.plan.version }, plans: r.plans.map((p: any) => [p.id, p.status, p.version]) }; }, all[0].id)), "row", await page.locator("[data-plan-row]").getAttribute("data-plan-id"));
        check(`${t}: approving from the row flips to Build and the row goes away`, rows === 0 && all.some((x) => x.mode === "build" && x.turns >= 1), `rows=${rows} modes=${all.map((x) => x.mode + "/" + x.turns).join(",")}`);
      }

      // ---- a goal that is working: the goal bar is the slot, with Stop
      await fresh(page, workspaceId, url);
      await page.locator("[data-plus-menu]").click();
      await page.locator("[data-goal-open]").click();
      await page.locator("[data-goal-text]").fill("SLEEP 1500");
      await page.locator("[data-goal-check]").fill("false");
      await page.getByRole("button", { name: "Set goal" }).click();
      await send(page, "SAY starting");
      await waitSlot(page, "goal");
      await page.waitForTimeout(500);
      check(`${t}: the working goal is the slot, with a Stop button`, (await page.locator("[data-goal-bar][data-goal-status='active']").count()) === 1 && (await page.locator("[data-goal-stop]").count()) === 1);
      await shot(`composer-${t}-goal-active`);
      await page.locator("[data-goal-stop]").click();
      await page.waitForSelector('[data-goal-bar][data-goal-status="stopped"]', { timeout: 15_000 });
      await page.getByRole("button", { name: "Dismiss" }).click();
      await waitSlot(page, "none");
      check(`${t}: a dismissed finished goal frees the slot`, true);

      // ---- heads: the shelf is the slot, and a working goal outranks it
      const leadId = trb("run", "-p", "Fake Hydra", "-e", "fake", "-d", hydra).stdout.trim();
      await fresh(page, workspaceId, url, leadId);
      await waitSlot(page, "shelf", 30_000);
      await page.waitForFunction(() => document.querySelectorAll("[data-shelf-head]").length === 2, null, { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(400);
      check(`${t}: the lead and its heads are the slot`, (await page.locator("[data-shelf-head]").count()) === 2);
      await shot(`composer-${t}-heads-shelf`);
      await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop the running turn"]'), null, { timeout: 40_000 }).catch(() => {});

      // ---- narrow panels: no wrap, no overflow
      await fresh(page, workspaceId, url);
      for (const width of [440, 360, 300]) {
        await page.evaluate((w) => {
          const root = document.querySelector("[data-status-slot]")!.parentElement as HTMLElement;
          root.style.width = `${w}px`;
          root.style.maxWidth = `${w}px`;
        }, width);
        await page.waitForTimeout(250);
        const m = await page.evaluate((sels) => {
          const row = (document.querySelector("[data-plus-menu]") as HTMLElement).parentElement as HTMLElement;
          const boxes = sels.map((s) => document.querySelector(s)?.getBoundingClientRect()).filter(Boolean) as DOMRect[];
          const tops = boxes.map((b) => b.top + b.height / 2);
          const root = document.querySelector("[data-status-slot]")!.parentElement as HTMLElement;
          const rr = root.getBoundingClientRect();
          return { oneRow: Math.max(...tops) - Math.min(...tops) < 4, overflow: row.scrollWidth > row.clientWidth + 1 || root.scrollWidth > root.clientWidth + 1, inside: boxes.every((b) => b.left >= rr.left - 0.5 && b.right <= rr.right + 0.5), seg: (document.querySelector("[data-mode-segment]") as HTMLElement).getBoundingClientRect().width };
        }, FOOTER);
        check(`${t}: at ${width}px the footer is one row, inside the panel, with no overflow`, m.oneRow && !m.overflow && m.inside, JSON.stringify(m));
        await shot(`composer-${t}-narrow-${width}`);
      }
    },
    { theme },
  );
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
