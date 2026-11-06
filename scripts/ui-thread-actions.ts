/**
 * Rewind and fork in the thread, and the Verification settings page, in real Chrome against an isolated daemon
 * (throwaway TRB_HOME, random port, scripted fake engine). Shots in /tmp/trb-shots/thread-*.png.
 *   bun run build:web && TRB_WEB_DIR=web/dist bun run scripts/ui-thread-actions.ts
 */
import fs from "fs";
import path from "path";
import type { Page } from "playwright-core";
import { withUi } from "./ui-harness";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};
fs.mkdirSync("/tmp/trb-shots", { recursive: true });

const j = <T = any>(page: Page, p: string, init?: { method: string; body: unknown }) =>
  page.evaluate(async ([p, init]) => (await fetch(p as string, init ? { method: (init as any).method, headers: { "content-type": "application/json" }, body: JSON.stringify((init as any).body) } : undefined)).json(), [p, init] as [string, any]) as Promise<T>;

async function idle(page: Page, sid: string, ms = 40_000) {
  const t0 = Date.now();
  for (;;) {
    const s = (await j(page, `/api/sessions/${sid}`)).session;
    if (s.status === "idle" || s.status === "failed") return s;
    if (Date.now() - t0 > ms) throw new Error(`session ${sid} still ${s.status}`);
    await page.waitForTimeout(250);
  }
}

const opacity = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => Number(getComputedStyle(el).opacity));

await withUi(async ({ page, browser, trb, repo, shot, url, workspaceId }) => {
  trb("config", "set", "default_engine", "fake");
  const sid = trb("run", "-e", "fake", "-d", "-C", repo, "WRITE notes.txt one\nSAY first answer").stdout.trim();
  await page.goto(`${url}/w/${workspaceId}`);
  await page.evaluate(([wid, sid]) => {
    const raw = localStorage.getItem("trb.ui.v1");
    const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
    cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: sid, expanded: [], history: [] } } };
    localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
  }, [workspaceId, sid]);
  await idle(page, sid);
  trb("send", sid, "WRITE notes.txt two\nWRITE extra.txt more\nSAY second answer");
  await page.waitForTimeout(500);
  await idle(page, sid);
  const cwd = (await j(page, `/api/sessions/${sid}`)).session.cwd as string;
  const file = (n: string) => path.join(cwd, n);
  check("two turns wrote files", fs.readFileSync(file("notes.txt"), "utf-8").startsWith("two") && fs.existsSync(file("extra.txt")));

  // A long third turn keeps the session running while the buttons are inspected.
  await page.reload();
  await page.waitForSelector("[data-chat-thread]");
  await page.locator('textarea[aria-label="Message"]').fill("SLEEP 9000\nSAY third answer");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForSelector('button[aria-label="Stop the running turn"]', { timeout: 15_000 });
  await page.waitForTimeout(400);

  // ---- disabled while running
  const rw = page.locator("[data-rewind]");
  check("a rewind button sits on every user message", (await rw.count()) === 3, String(await rw.count()));
  const states = await rw.evaluateAll((els) => els.map((e) => e.getAttribute("aria-disabled")));
  check("rewind is disabled (aria-disabled) while a turn runs", states.every((s) => s === "true"), states.join());
  await page.locator("[data-chat-thread] .group\\/msg").first().hover();
  await rw.first().hover();
  await page.getByText("Stop the session to rewind", { exact: false }).first().waitFor({ timeout: 4000 });
  check("the disabled rewind button explains why in its tooltip", true);
  await shot("thread-running-disabled");
  await rw.first().click({ force: true });
  await page.waitForTimeout(300);
  check("clicking a disabled rewind opens no confirm dialog", (await page.getByText("Rewind files").count()) === 0);
  await idle(page, sid);
  await page.waitForTimeout(1500); // the checkpoints are looked at again when the turn ends

  // ---- where the buttons are, and when they show
  const fk = page.locator("[data-fork]");
  check("a fork button sits on every agent message (one per turn)", (await fk.count()) === 3, String(await fk.count()));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  check("the latest agent message shows Fork persistently", (await fk.last().evaluate((el) => Number(getComputedStyle(el).opacity))) === 1);
  check("older agent messages show Fork only on hover", (await fk.first().evaluate((el) => Number(getComputedStyle(el).opacity))) === 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator(".group\\/msg").filter({ has: fk.first() }).first().hover();
  await page.waitForTimeout(250);
  check("hovering an older message reveals its Fork", (await fk.first().evaluate((el) => Number(getComputedStyle(el).opacity))) === 1);
  await fk.first().hover();
  await page.getByText("Fork from here", { exact: true }).first().waitFor({ timeout: 4000 });
  check("Fork has its tooltip", true);
  await page.mouse.move(5, 5);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
  check("rewind is hidden until hover", (await rw.first().evaluate((el) => Number(getComputedStyle(el).opacity))) === 0);
  await rw.nth(1).focus();
  await page.waitForTimeout(250);
  check("keyboard focus reveals rewind", (await rw.nth(1).evaluate((el) => Number(getComputedStyle(el).opacity))) === 1);
  check("rewind is enabled when idle", (await rw.nth(1).getAttribute("aria-disabled")) === null);
  await shot("thread-idle-hover");

  // ---- Trace has them too
  await page.locator('[data-view-mode="trace"]').click();
  await page.waitForTimeout(500);
  check("Trace: rewind on user messages and fork on agent messages", (await rw.count()) === 3 && (await fk.count()) === 3, `${await rw.count()}/${await fk.count()}`);
  await shot("thread-trace");
  await page.locator('[data-view-mode="chat"]').click();
  await page.waitForSelector("[data-chat-thread]");

  // ---- a real rewind: before the second message
  await rw.nth(1).scrollIntoViewIfNeeded();
  await rw.nth(1).focus();
  await rw.nth(1).press("Enter");
  await page.getByText("Only the files go back", { exact: false }).waitFor({ timeout: 5000 });
  const dlg = await page.getByRole("dialog").innerText();
  check("the confirm says files only, memory kept, the agent is told", /Only the files/.test(dlg) && /keeps its memory/.test(dlg) && /told/.test(dlg));
  await shot("thread-rewind-confirm");
  await page.getByRole("button", { name: "Rewind files" }).click();
  await page.waitForSelector("text=Rewound to before turn 2", { timeout: 10_000 });
  check("rewind put notes.txt back to its first content", fs.readFileSync(file("notes.txt"), "utf-8").startsWith("one"));
  check("rewind removed the file the second turn added", !fs.existsSync(file("extra.txt")));
  await shot("thread-rewound");

  // The agent gets the notice on its next message.
  trb("send", sid, "ECHO_PROMPT rewound\nSAY after the rewind");
  await page.waitForTimeout(500);
  await idle(page, sid);
  const tail = await page.locator("[data-chat-thread]").innerText();
  check("the agent kept its conversation and was told on the next message", /after the rewind/.test(tail) && /yes/i.test(tail), tail.slice(-120).replace(/\n/g, " | "));

  // ---- a fork opens a new session
  const before = (await j(page, "/api/sessions")).sessions.length;
  await page.waitForTimeout(1500);
  await fk.last().scrollIntoViewIfNeeded();
  await fk.last().click();
  await page.waitForSelector("text=Forked into a new session", { timeout: 10_000 });
  const after = (await j(page, "/api/sessions")).sessions;
  check("fork created a new session", after.length === before + 1, `${before} -> ${after.length}`);
  const active = await page.evaluate((wid) => JSON.parse(localStorage.getItem("trb.ui.v1")!).state.byWs[wid].activeSession, workspaceId);
  check("the new session is open", active && active !== sid, String(active));
  await shot("thread-forked");

  // ---- touch: no hover, so the buttons are always visible
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await page.context().storageState() });
  const p = await phone.newPage();
  await p.goto(`${url}/w/${workspaceId}`);
  await p.evaluate(([wid, sid]) => {
    const cur = JSON.parse(localStorage.getItem("trb.ui.v1") ?? '{"state":{},"version":1}');
    cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: sid, expanded: [], history: [] } } };
    localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
  }, [workspaceId, sid]);
  await p.reload();
  await p.waitForSelector("[data-fork]", { timeout: 15_000 });
  const touch = await p.locator("[data-fork], [data-rewind]").evaluateAll((els) => els.map((e) => Number(getComputedStyle(e).opacity) > 0.3));
  check("on touch every action is visible without hover", touch.length >= 4 && touch.every(Boolean), `${touch.length} buttons`);
  const box = await p.locator("[data-fork]").first().boundingBox();
  check("touch targets are at least 28px", !!box && box.width >= 28 && box.height >= 28);
  await p.screenshot({ path: "/tmp/trb-shots/thread-mobile.png" });
  await phone.close();

  /* ----------------------------------------------------------------- verification settings */
  await page.goto(`${url}/w/${workspaceId}`);
  await page.evaluate(([wid, sid]) => {
    const cur = JSON.parse(localStorage.getItem("trb.ui.v1")!);
    cur.state.byWs[wid] = { tabs: [], activeTab: null, activeSession: sid, expanded: [], history: [] };
    localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
  }, [workspaceId, sid]);
  await page.reload();
  await page.waitForSelector("[data-verify-strip]");
  check("verification is off by default on the strip", (await page.locator("[data-verify-strip]").getAttribute("data-verify-enabled")) === "false");
  await shot("verify-strip-off");

  // The strip's own switch is this session only.
  await page.getByRole("switch", { name: "Verify this session" }).click();
  await page.waitForFunction(() => document.querySelector("[data-verify-strip]")?.getAttribute("data-verify-enabled") === "true");
  const sv = await j(page, `/api/sessions/${sid}/verify`);
  check("the strip switch turns verification on for this session only", !!sv.session_enabled && (await j(page, "/api/verify/config")).config.enabled === null);
  await page.getByRole("switch", { name: "Verify this session" }).click();
  await page.waitForFunction(() => document.querySelector("[data-verify-strip]")?.getAttribute("data-verify-enabled") === "false");

  // The strip links to the page.
  await page.locator("[data-verify-settings]").click();
  await page.waitForSelector("[data-verify-global]");
  check("the strip links to Settings > Verification", (await page.locator("h1", { hasText: "Verification" }).count()) === 1);
  const sw = page.getByRole("switch", { name: "Verify after every turn (global default)" });
  check("the global default is off", (await sw.getAttribute("aria-checked")) === "false");
  await page.locator("[data-verify-global] [data-verify-retries]").fill("4");
  await page.locator("[data-verify-global] [data-verify-timeout]").fill("90");
  await page.locator("[data-verify-global] [data-verify-commands]").fill("typecheck: bun run typecheck\nlint: bun run lint");
  await page.locator('[data-verify-save="global"]').click();
  await page.waitForSelector("text=Verification defaults saved");
  const g = (await j(page, "/api/verify/config")).config;
  check("global values saved, and it is still off", g.max_retries === 4 && g.timeout_sec === 90 && g.commands.length === 2 && g.commands[1].name === "lint" && g.enabled !== true, JSON.stringify(g));
  await shot("verify-settings-global");

  await page.locator("[data-verify-workspace]").getByRole("combobox", { name: "Verification for this workspace" }).click();
  await page.getByRole("option", { name: "On", exact: true }).click();
  await page.locator("[data-verify-workspace] [data-verify-retries]").fill("1");
  await page.locator("[data-verify-workspace] [data-verify-ws-commands]").fill("test: bun test");
  await page.locator('[data-verify-save="workspace"]').click();
  await page.waitForSelector("text=Workspace verification saved");
  const w = await j(page, `/api/workspaces/${workspaceId}/verify`);
  check("the workspace override saved (on, 1 retry, one command) without touching the global", w.config.enabled === true && w.config.max_retries === 1 && w.config.commands?.[0]?.cmd === "bun test" && w.global.max_retries === 4, JSON.stringify(w.config));
  await shot("verify-settings-workspace");

  // Reload: the saved values come back.
  await page.reload();
  await page.waitForSelector("[data-verify-global]");
  check("saved values are shown after a reload", (await page.locator("[data-verify-global] [data-verify-retries]").inputValue()) === "4" && (await page.locator("[data-verify-workspace] [data-verify-ws-commands]").inputValue()) === "test: bun test");

  // The palette opens the page.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Verification settings");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-verify-global]");
  check("the palette command opens the page", true);

  // The old dialog is gone.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Rewind or fork");
  check("the palette keeps 'Rewind or fork from a turn…'", (await page.getByText("Rewind or fork from a turn").count()) >= 1);
  await page.keyboard.press("Escape");
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
