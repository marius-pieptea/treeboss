/**
 * The waiting indicator, end to end: a lead blocked in subagent_wait shows who it waits on, in the shelf, the
 * session header and the sessions list; the head carries an "awaited" tag; it all clears when the wait ends.
 *   bun run scripts/ui-waiting.ts            (dark, then light, one process each)
 *   TRB_WEB_DIR=<dist> THEME=dark bun run scripts/ui-waiting.ts
 */
import { spawnSync } from "child_process";
import { withUi } from "./ui-harness";

// One process per theme: a fresh Chrome and daemon each time keeps a long run from tripping over its own leftovers.
if (!process.env.THEME) {
  let bad = 0;
  for (const theme of ["dark", "light"]) bad += spawnSync(process.execPath, ["run", import.meta.path], { env: { ...process.env, THEME: theme }, stdio: "inherit" }).status ? 1 : 0;
  process.exit(bad ? 1 : 0);
}

const theme = process.env.THEME as "dark" | "light";
const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${theme}: ${name}${note ? `  (${note})` : ""}`);
};

await withUi(
  async ({ page, shot, trb, workspaceId, url, repo }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const prompt = ["Build the API", `CALL_TOOL subagent_create {"brief":"SLEEP 60000\\nSAY api done","title":"api-head"}`, `CALL_TOOL subagent_wait {}`].join("\n");
    const id = trb("run", "-e", "fake", "-d", "-C", repo, prompt).stdout.trim();

    await page.goto(`${url}/w/${workspaceId}`);
    await page.waitForSelector("header");
    await page.locator("button", { hasText: "Build the API" }).first().click();

    await page.waitForSelector("[data-shelf-waiting]", { timeout: 20_000 });
    const line = (await page.locator("[data-shelf-waiting]").textContent())?.trim() ?? "";
    check("the shelf says who the lead waits on", /^waiting on api-head, \d+s$/.test(line), line);
    check("the awaited head chip is tagged", (await page.locator("[data-shelf-head] [data-awaited]").count()) === 1);
    check("the session header carries the same chip", (await page.locator("[data-waiting-chip]").filter({ hasText: "waiting on api-head" }).count()) >= 1);
    check("the sessions list shows a compact chip", (await page.locator("[data-waiting-chip]").filter({ hasText: /^waiting \d+s$/ }).count()) >= 1);

    const before = (await page.locator("[data-shelf-waiting]").textContent()) ?? "";
    await page.waitForTimeout(2200);
    const after = (await page.locator("[data-shelf-waiting]").textContent()) ?? "";
    check("the timer ticks", before !== after, `${before.trim()} -> ${after.trim()}`);
    await page.waitForTimeout(400);
    await shot(`waiting-1-shelf-${theme}`);

    // The heads panel marks the head too.
    await page.getByRole("tab", { name: /Heads/ }).first().click();
    await page.waitForSelector("[data-head-card] [data-awaited], [data-awaited]:has-text('lead is waiting')", { timeout: 5000 }).catch(() => {});
    const tag = (await page.locator("[data-awaited]").filter({ hasText: "lead is waiting" }).first().textContent().catch(() => ""))?.trim();
    check("the heads panel tags the awaited head", tag === "lead is waiting", tag ?? "");
    await page.waitForTimeout(300);
    await shot(`waiting-2-heads-${theme}`);
    await page.getByRole("tab", { name: /Agent/ }).first().click();
    await page.waitForSelector("[data-shelf-waiting]", { timeout: 5000 });

    // Interrupt the lead: the wait ends and everything clears.
    trb("interrupt", id);
    await page.waitForSelector("[data-shelf-waiting]", { state: "detached", timeout: 15_000 });
    check("the indicator clears when the lead is interrupted", (await page.locator("[data-waiting-chip]").count()) === 0 && (await page.locator("[data-shelf-head] [data-awaited]").count()) === 0);
    await shot(`waiting-3-cleared-${theme}`);
    check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  },
  { theme },
);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
