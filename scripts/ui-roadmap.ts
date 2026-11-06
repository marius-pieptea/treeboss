/** Drive the Roadmap module against the scripted engine; shots to /tmp/trb-shots/roadmap-*.png. */
import fs from "fs";
import path from "path";
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

async function fresh(page: Page, wid: string, url: string) {
  await page.goto(`${url}/w/${wid}`);
  await page.evaluate((wid) => {
    const raw = localStorage.getItem("trb.ui.v1");
    const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
    cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, activity: "explorer", byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: null, expanded: [], history: [] } } };
    localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
    // The composer defaults to the real claude; these runs must use the scripted engine.
    localStorage.setItem("trb.composer.v1", JSON.stringify({ engine: "fake", model: "", effort: "", pairId: "", worktree: false }));
    localStorage.removeItem("trb.roadmap.view");
  }, wid);
  await page.reload();
  await page.waitForSelector("nav");
}
const until = async (fn: () => Promise<boolean> | boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
};
const ids = (text: string, lane: string): string[] => {
  const m = new RegExp(`^## ${lane}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(text);
  return [...(m?.[1] ?? "").matchAll(/^- \[[ x]\] (.*?)(?: \{#|$)/gm)].map((x) => x[1]!.trim());
};

/** A real pointer drag: down on the card, a few moves so the threshold passes, release over the target. */
async function drag(page: Page, from: ReturnType<Page["locator"]>, to: { x: number; y: number }) {
  const b = (await from.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 14);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 12, b.y + 24, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  return async () => page.mouse.up();
}

for (const theme of (process.env.THEME ? [process.env.THEME] : ["dark", "light"]) as Array<"dark" | "light">) {
  await withUi(
    async ({ page, shot, trb, repo, workspaceId, url }) => {
      const t: string = theme;
      trb("config", "set", "default_engine", "fake");
      const file = path.join(repo, "ROADMAP.md");
      const read = () => fs.readFileSync(file, "utf-8");
      fs.mkdirSync(path.join(repo, "specs/001-chat"), { recursive: true });
      fs.writeFileSync(path.join(repo, "specs/001-chat/spec.md"), "# Feature Specification: Chat\n");
      fs.writeFileSync(path.join(repo, "specs/001-chat/tasks.md"), "- [x] T001 a\n- [x] T002 b\n- [ ] T003 c\n- [ ] T004 d\n");
      fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
      fs.writeFileSync(path.join(repo, "docs/architecture.md"), "# Architecture\n");

      // ---- empty state: explicit action, nothing created by looking
      await fresh(page, workspaceId, url);
      await page.getByRole("button", { name: "Roadmap", exact: true }).click();
      await page.waitForSelector("text=No roadmap yet");
      check(`${t}: the Roadmap button opens the tab with an explicit Create`, (await page.locator("[data-roadmap-create]").count()) === 1);
      check(`${t}: looking creates no ROADMAP.md`, !fs.existsSync(file));
      await page.waitForTimeout(400);
      await shot(`roadmap-${t}-empty`);

      // ---- create
      await page.locator("[data-roadmap-create]").click();
      await page.waitForSelector("[data-roadmap-board]");
      check(`${t}: Create writes the template with three lanes`, fs.existsSync(file) && ["Now", "Next", "Later"].every((l) => read().includes(`## ${l}`)));
      check(`${t}: the board shows the three lanes`, (await page.locator("[data-lane]").count()) === 3);

      // ---- inline add in a lane
      await page.locator('[data-lane="Now"] [data-roadmap-add-open]').click();
      await page.locator("[data-roadmap-add-input]").fill("Ship chat");
      await page.keyboard.press("Enter");
      await page.locator("[data-roadmap-add-input]").fill("Fix login");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      check(`${t}: inline add writes items with ids`, await until(() => /- \[ \] Ship chat \{#r1\}/.test(read()) && /- \[ \] Fix login \{#r2\}/.test(read())));

      // ---- richer items through the CLI
      trb("roadmap", "edit", "r1", "--spec", "specs/001-chat", "--tag", "core,ux", "--target", "2026-Q4", "--docs", "docs/architecture.md");
      trb("roadmap", "add", "Billing", "--lane", "Next", "--target", "2026-11", "--tag", "money", "-D", "Stripe subscriptions");
      trb("roadmap", "add", "Ghost link", "--lane", "Next", "--spec", "specs/404-gone");
      trb("roadmap", "add", "Dark mode", "--lane", "Later", "--target", "2027-02-14");
      trb("roadmap", "add", "Someday", "--lane", "Later");
      trb("roadmap", "add", "Odd target", "--lane", "Later", "--target", "sometime soon");
      check(`${t}: an edit made outside the app shows up without a reload`, await until(async () => (await page.locator('[data-card]:has-text("Billing")').count()) === 1, 12_000));
      await page.waitForTimeout(450);
      const chat = page.locator('[data-card]:has-text("Ship chat")');
      check(`${t}: a card shows its tags, target and spec progress`, (await chat.locator("text=core").count()) === 1 && (await chat.locator("text=2026-Q4").count()) === 1 && (await chat.locator("text=2/4").count()) === 1);
      check(`${t}: a card with a broken link says so`, (await page.locator('[data-card]:has-text("Ghost link") [data-roadmap-broken]').count()) === 1 && (await page.locator("[data-roadmap-broken-count]").count()) === 1);
      await shot(`roadmap-${t}-board`);

      // ---- drag between lanes
      await page.mouse.move(5, 5);
      const nextLane = (await page.locator('[data-lane="Next"]').boundingBox())!;
      const release = await drag(page, page.locator('[data-card]:has-text("Fix login")'), { x: nextLane.x + nextLane.width / 2, y: nextLane.y + 120 });
      check(`${t}: dragging shows an insertion line and a floating card`, (await page.locator("[data-drop-indicator]").count()) === 1);
      await shot(`roadmap-${t}-drag`);
      await release();
      check(`${t}: dropping moves the item to the other lane in the file`, await until(() => ids(read(), "Next").includes("Fix login") && !ids(read(), "Now").includes("Fix login")), 8000);
      check(`${t}: a drag does not open the drawer`, (await page.locator("[data-roadmap-drawer]").count()) === 0);

      // ---- drag to reorder inside a lane (to the top)
      const nl = (await page.locator('[data-lane="Next"]').boundingBox())!;
      const first = (await page.locator('[data-lane="Next"] [data-card]').first().boundingBox())!;
      const rel2 = await drag(page, page.locator('[data-lane="Next"] [data-card]:has-text("Ghost link")'), { x: nl.x + nl.width / 2, y: first.y - 2 });
      await rel2();
      check(`${t}: dragging to the top of a lane reorders it`, await until(() => ids(read(), "Next")[0] === "Ghost link"), 8000);

      // ---- keyboard: Alt+Arrow moves lane
      await page.locator('[data-card]:has-text("Ghost link")').focus();
      await page.keyboard.press("Alt+ArrowRight");
      check(`${t}: Alt+Right moves the focused card to the next lane`, await until(() => ids(read(), "Later").includes("Ghost link")), 8000);
      check(`${t}: focus follows the card`, await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-card") ?? "")) !== ""));
      await page.keyboard.press("Alt+ArrowLeft");
      check(`${t}: Alt+Left moves it back`, await until(() => ids(read(), "Next").includes("Ghost link")), 8000);
      // The hover buttons do the same.
      await page.locator('[data-card]:has-text("Ghost link")').hover();
      await page.locator('[data-card]:has-text("Ghost link") [data-roadmap-shift="1"]').click();
      check(`${t}: the card's arrow button moves it too`, await until(() => ids(read(), "Later").includes("Ghost link")), 8000);

      // ---- done toggle
      await page.locator('[data-card]:has-text("Billing") [data-roadmap-done]').click();
      check(`${t}: the tick ships an item in the file`, await until(() => /- \[x\] Billing/.test(read())));
      await page.locator('[data-card]:has-text("Billing") [data-roadmap-done]').click();
      check(`${t}: and reopens it`, await until(() => /- \[ \] Billing/.test(read())));

      // ---- drawer
      await page.locator('[data-card]:has-text("Ship chat")').click();
      await page.waitForSelector("[data-roadmap-drawer]");
      check(`${t}: clicking a card opens the drawer with its fields`, (await page.locator('[data-field="title"]').inputValue()) === "Ship chat" && (await page.locator('[data-field="target"]').inputValue()) === "2026-Q4");
      await page.waitForTimeout(350);
      await shot(`roadmap-${t}-drawer`);
      await page.locator('[data-field="title"]').fill("Ship chat v2");
      await page.locator('[data-field="target"]').fill("2026-12");
      await page.locator('[data-field="description"]').fill("Realtime, with history");
      await page.locator('[data-field="tags"]').click();
      check(`${t}: leaving a field saves it to the file`, await until(() => /- \[ \] Ship chat v2 \{#r1\} .*\(target: 2026-12\)\n  Realtime, with history/.test(read())), 8000);
      await page.keyboard.press("Escape");
      await page.locator('[data-field="title"]').focus();
      await page.keyboard.press("Escape"); // the first Escape leaves the field (and saves it)
      await page.keyboard.press("Escape");
      check(`${t}: Escape closes the drawer`, await until(async () => (await page.locator("[data-roadmap-drawer]").count()) === 0, 4000));

      // ---- start a spec session from an item
      await page.locator('[data-card]:has-text("Billing")').click();
      await page.waitForSelector("[data-roadmap-drawer]");
      await page.locator('[data-start="spec"]').click();
      const sess = async () => (await page.evaluate(async () => (await (await fetch("/api/sessions")).json()).sessions)) as any[];
      check(`${t}: Create spec runs the Specify step on a feature named after the item`, await until(async () => (await sess()).some((s) => s.title === "Specify: Billing")), 12_000);
      check(`${t}: the card shows a session dot`, await until(async () => (await page.locator('[data-card]:has-text("Billing") [data-session-dot]').count()) >= 1, 10_000));
      await shot(`roadmap-${t}-session`);
      check(`${t}: the item is linked to its new spec straight away`, await until(async () => (await page.locator("[data-open-spec]").count()) === 1, 8000));
      await page.locator("[data-open-spec]").click();
      check(`${t}: Open in Specs opens the feature in the Specs workbench, not a plain file`, await until(async () => (await page.locator("[data-doc-tabs]").count()) === 1, 8000));
      await page.getByRole("button", { name: /Roadmap/ }).first().click().catch(() => {});
      await page.keyboard.press("Escape");

      // ---- filters
      await page.locator("[data-roadmap-filter]").fill("billing");
      check(`${t}: the filter narrows the board`, await until(async () => (await page.locator("[data-card]").count()) === 1));
      await page.locator("[data-roadmap-filter]").fill("");
      check(`${t}: and clearing it brings everything back`, await until(async () => (await page.locator("[data-card]").count()) >= 6));

      // ---- list
      await page.getByRole("button", { name: "List", exact: true }).click();
      await page.waitForSelector("[data-roadmap-list]");
      check(`${t}: the list shows a row per item`, (await page.locator("[data-row]").count()) >= 6);
      await page.waitForTimeout(250);
      await shot(`roadmap-${t}-list`);

      // ---- timeline
      await page.getByRole("button", { name: "Timeline", exact: true }).click();
      await page.waitForSelector("[data-roadmap-timeline]");
      check(`${t}: the timeline places items with a target as bars`, (await page.locator("[data-bar]").count()) >= 3);
      check(`${t}: items without a readable target are unscheduled`, (await page.locator('[data-chip]:has-text("Someday")').count()) === 1 && (await page.locator('[data-chip]:has-text("Odd target")').count()) === 1 && (await page.locator("[data-unreadable]").count()) === 1);
      check(`${t}: there is a line for today`, (await page.locator("[data-today]").count()) >= 1);
      await page.waitForTimeout(400);
      await shot(`roadmap-${t}-timeline`);
      await page.locator('[data-bar]').first().click();
      check(`${t}: clicking a bar opens the drawer`, (await page.locator("[data-roadmap-drawer]").count()) === 1);
      await page.keyboard.press("Escape");

      // ---- the view is remembered
      await page.reload();
      await page.waitForSelector("[data-roadmap-timeline]");
      check(`${t}: the chosen view survives a reload`, true);

      // ---- narrow
      await page.setViewportSize({ width: 820, height: 800 });
      await page.getByRole("button", { name: "Board", exact: true }).click();
      await page.waitForTimeout(300);
      await shot(`roadmap-${t}-narrow`);
      check(`${t}: no horizontal page scroll at a narrow width`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    },
    { theme },
  );
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
