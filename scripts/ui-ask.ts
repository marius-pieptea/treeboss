/**
 * Ask mode in the composer, against the scripted engine: nothing shifts when the mode changes (Build | Plan | Ask),
 * Alt+P cycles through them, an ask answer has a cost footer and the two follow-ups, "Save as doc" writes a page only on
 * Save, "Turn into a plan" switches the session, and the footer stays on one row at narrow widths. Shots in
 * /tmp/trb-shots/ask-*.png.   `TRB_WEB_DIR=<dist> bun run scripts/ui-ask.ts`
 */
import fs from "fs";
import path from "path";
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

async function fresh(page: Page, wid: string, url: string, sid: string | null = null) {
  await page.goto(`${url}/w/${wid}`);
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
  await page.reload();
  await page.waitForSelector('textarea[aria-label="Message"]');
  await page.waitForTimeout(300);
}
const sessions = async (page: Page) => (await page.evaluate(async () => (await (await fetch("/api/sessions")).json()).sessions)) as any[];
const idle = (page: Page, timeout = 25_000) => page.waitForFunction(() => !document.querySelector('button[aria-label="Stop the running turn"]'), null, { timeout });

const FOOTER = ["[data-plus-menu]", "[data-engine-chip]", "[data-mode-segment]", 'button[aria-label="Start session"]'];
async function footerBoxes(page: Page, selectors = FOOTER) {
  return page.evaluate((sels) => sels.map((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { s, x: Math.round(r.x * 2) / 2, y: Math.round(r.y * 2) / 2, w: Math.round(r.width * 2) / 2, h: Math.round(r.height * 2) / 2 } : { s, x: -1, y: -1, w: -1, h: -1 };
  }), selectors);
}
const sameBoxes = (a: Awaited<ReturnType<typeof footerBoxes>>, b: Awaited<ReturnType<typeof footerBoxes>>) => a.every((x, i) => Math.abs(x.x - b[i].x) < 0.6 && Math.abs(x.y - b[i].y) < 0.6 && Math.abs(x.w - b[i].w) < 0.6 && Math.abs(x.h - b[i].h) < 0.6);
const modeOf = (page: Page) => page.locator("[data-mode-segment]").getAttribute("data-mode");

for (const theme of (process.env.THEME ? [process.env.THEME] : ["dark", "light"]) as Array<"dark" | "light">) {
  await withUi(
    async ({ page, shot, trb, workspaceId, url, repo }) => {
      const t: string = theme;
      trb("config", "set", "default_engine", "fake");
      trb("config", "set", "ask_models", "fake=cheap-1");

      // ---- a new session: the three modes, no movement
      await fresh(page, workspaceId, url);
      const before = await footerBoxes(page);
      check(`${t}: Build, Plan and Ask are one dropdown`, (await page.locator("[data-mode-trigger]").count()) === 1 && (await modeOf(page)) === "build");
      const buildPlaceholder = await page.locator('textarea[aria-label="Message"]').getAttribute("placeholder");
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Ask" }).click();
      await page.waitForTimeout(250);
      check(`${t}: choosing Ask moves nothing in the footer`, sameBoxes(before, await footerBoxes(page)), JSON.stringify(before.map((b, i) => [b.s]).slice(0, 0)));
      check(`${t}: ask mode rings the box and asks about the project`, (await page.locator("[data-composer]").getAttribute("data-asking")) !== null && (await page.locator('textarea[aria-label="Message"]').getAttribute("placeholder")) === "Ask about this project…" && buildPlaceholder !== "Ask about this project…");
      check(`${t}: the model chip shows the cheap ask model`, ((await page.locator("[data-engine-chip]").textContent()) ?? "").includes("cheap-1"));
      await shot(`ask-${t}-new`);

      // ---- Alt+P cycles Build -> Plan -> Ask -> Build
      await page.locator('textarea[aria-label="Message"]').focus();
      await page.keyboard.press("Alt+KeyP");
      await page.waitForTimeout(150);
      const m1 = await modeOf(page);
      check(`${t}: Alt+P from Ask goes to Build`, m1 === "build" && sameBoxes(before, await footerBoxes(page)));
      await page.keyboard.press("Alt+KeyP");
      await page.waitForTimeout(150);
      const m2 = await modeOf(page);
      await page.keyboard.press("Alt+KeyP");
      await page.waitForTimeout(150);
      const m3 = await modeOf(page);
      check(`${t}: Alt+P steps Build → Plan → Ask`, m2 === "plan" && m3 === "ask" && sameBoxes(before, await footerBoxes(page)));

      // ---- ask a question: read-only, answered, with a cost footer and the follow-ups
      await page.locator('textarea[aria-label="Message"]').fill("WRITE out.txt hi\nSAY The greeting is built in src/greet.ts:1 and nowhere else.");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-ask-footer]", { timeout: 30_000 });
      await idle(page);
      const [s] = await sessions(page);
      check(`${t}: the session started in ask mode on the cheap model at low effort`, s?.mode === "ask" && s?.model === "cheap-1" && s?.effort === "low", JSON.stringify({ mode: s?.mode, model: s?.model, effort: s?.effort }));
      check(`${t}: nothing was written`, !fs.existsSync(path.join(repo, "out.txt")));
      const cost = ((await page.locator("[data-ask-cost]").first().textContent()) ?? "").trim();
      check(`${t}: the answer shows what it cost`, /^\$0\.001/.test(cost), cost);
      check(`${t}: the newest answer offers both follow-ups`, (await page.locator("[data-ask-plan]").count()) === 1 && (await page.locator("[data-ask-doc]").count()) === 1);
      check(`${t}: the header and the sessions list say ask`, (await page.getByText("ask", { exact: true }).count()) >= 2);
      check(`${t}: the composer stays in ask mode for the follow-up`, (await modeOf(page)) === "ask" && (await page.locator('textarea[aria-label="Message"]').getAttribute("placeholder")) === "Ask a follow-up…");
      await shot(`ask-${t}-answer`);

      // ---- Save as doc: a dialog first, a file only on Save
      await page.locator("[data-ask-doc]").click();
      await page.waitForSelector("[data-ask-doc-path]");
      await page.waitForFunction(() => (document.querySelector("[data-ask-doc-path]") as HTMLInputElement | null)?.value.length, null, { timeout: 10_000 });
      const pathValue = await page.locator("[data-ask-doc-path]").inputValue();
      check(`${t}: Save as doc proposes a path in docs/ and lists the files the answer cites`, /^docs\//.test(pathValue) && (await page.getByText("src/greet.ts", { exact: true }).count()) >= 1, pathValue);
      check(`${t}: nothing is written until Save`, !fs.existsSync(path.join(repo, "docs")));
      await shot(`ask-${t}-save-doc`);
      await page.locator("[data-ask-doc-path]").fill("docs/greeting.md");
      await page.locator("[data-ask-doc-save]").click();
      await page.waitForFunction(() => !document.querySelector("[data-ask-doc-save]"), null, { timeout: 10_000 });
      const page1 = path.join(repo, "docs", "greeting.md");
      check(`${t}: Save wrote the page, with covers and a generated commit`, fs.existsSync(page1) && /covers:\s*\n\s+- src\/greet\.ts/.test(fs.readFileSync(page1, "utf-8")) && /generated:/.test(fs.readFileSync(page1, "utf-8")));

      // ---- Turn into a plan: the session switches to plan mode and the question is planned
      await page.locator("[data-ask-plan]").click();
      await page.waitForFunction(() => document.querySelector("[data-mode-segment]")?.getAttribute("data-mode") === "plan", null, { timeout: 15_000 });
      await idle(page);
      check(`${t}: Turn into a plan switched the session to plan mode`, (await modeOf(page)) === "plan" && (await sessions(page))[0]?.mode === "plan");
      await shot(`ask-${t}-plan`);

      // ---- narrow panels in ask mode: no wrap, no overflow
      await fresh(page, workspaceId, url);
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Ask" }).click();
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
          return { oneRow: Math.max(...tops) - Math.min(...tops) < 4, overflow: row.scrollWidth > row.clientWidth + 1 || root.scrollWidth > root.clientWidth + 1, inside: boxes.every((b) => b.left >= rr.left - 0.5 && b.right <= rr.right + 0.5), seg: Math.round((document.querySelector("[data-mode-segment]") as HTMLElement).getBoundingClientRect().width) };
        }, FOOTER);
        check(`${t}: at ${width}px the footer is one row, inside the panel, with no overflow`, m.oneRow && !m.overflow && m.inside, JSON.stringify(m));
        await shot(`ask-${t}-narrow-${width}`);
      }
    },
    { theme },
  );
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
