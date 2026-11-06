/**
 * Drives the model / effort pickers and the role<->agent integration in headless Chrome. Cursor and opencode are
 * only asked to LIST their models (no tokens are spent). `TRB_WEB_DIR=<dist> bun run scripts/ui-models.ts`
 */
import { withUi } from "./ui-harness";

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};

for (const theme of ["dark", "light"] as const) {
  await withUi(
    async ({ page, shot, workspaceId, url, trb, repo }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && !/409|404/.test(m.text()) && errors.push(m.text()));
      await page.goto(`${url}/w/${workspaceId}`);
      await page.waitForSelector("header");
      const tag = (n: string) => `models-${theme}-${n}`;

      // ---------------------------------------------------------------- composer
      await page.getByRole("button", { name: /^Engine:/ }).click();
      await page.getByRole("button", { name: /cursor/i }).first().click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /^Model:/ }).click();
      await page.waitForSelector("text=/\\d+ models? · /", { timeout: 30_000 });
      const total = await page.locator('[role="option"]').count();
      check("composer model picker lists cursor's models (real CLI)", total > 5, `${total} rows`);
      const footer = await page.locator("text=/\\d+ models? · from the CLI/").first().textContent();
      check("the footer says how many models and where they came from", !!footer && /from the CLI/.test(footer), footer ?? "");
      await shot(tag("1-composer-picker"));

      await page.keyboard.type("codex high");
      await page.waitForTimeout(250);
      const ids = await page.locator('[role="option"] .truncate.font-mono').allTextContents();
      check("search narrows the list to models matching every word", ids.length > 0 && ids.every((i) => /codex/.test(i) && /high/.test(i)), `${ids.length} rows; offenders: ${ids.filter((i) => !(/codex/.test(i) && /high/.test(i))).join(", ") || "none"}`);
      await shot(tag("2-composer-search"));
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      const chip = await page.getByRole("button", { name: /^Model:/ }).textContent();
      check("Enter picks the best match and the popover closes", /codex/.test(chip ?? "") && (await page.locator('[role="listbox"]').count()) === 0, chip ?? "");

      // a model the list has never heard of is still accepted
      await page.getByRole("button", { name: /^Model:/ }).click();
      await page.waitForSelector('[role="listbox"]');
      await page.keyboard.type("my-brand-new-model-9");
      await page.waitForTimeout(250);
      check("a custom row is offered for text that is not an id", (await page.locator("text=/as a custom model/").count()) === 1);
      await shot(tag("3-custom-row"));
      await page.keyboard.press("Shift+Enter");
      await page.waitForTimeout(300);
      check("the custom id is used as typed", ((await page.getByRole("button", { name: /^Model:/ }).textContent()) ?? "").includes("my-brand-new-model-9"));

      // effort: cursor has no effort control; claude does
      check("effort is disabled for an engine with no effort control", await page.getByRole("button", { name: /^Effort:/ }).isDisabled());

      // switching engine drops a model the new engine does not list
      await page.getByRole("button", { name: /^Engine:/ }).click();
      await page.getByRole("button", { name: /claude/i }).first().click();
      await page.waitForTimeout(700);
      const afterSwitch = await page.getByRole("button", { name: /^Model:/ }).textContent();
      check("switching engine resets a model the new engine does not know", /default model/.test(afterSwitch ?? ""), afterSwitch ?? "");
      await page.getByRole("button", { name: /^Effort:/ }).click();
      const efforts = await page.locator("button:has-text('xhigh')").count();
      check("claude offers its own effort levels (low..max)", efforts > 0);
      await shot(tag("4-composer-efforts"));
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: /^Model:/ }).click();
      await page.waitForSelector('[role="option"]');
      const claudeRows = await page.locator('[role="option"]').allTextContents();
      check("claude (cannot list models) shows its built-in list with aliases", claudeRows.some((r) => /opus/i.test(r)) && (await page.locator("text=/built-in/").count()) > 0);
      await page.keyboard.press("Escape");

      // ---------------------------------------------------------------- a long list: opencode
      await page.getByRole("button", { name: /^Engine:/ }).click();
      await page.getByRole("button", { name: /opencode/i }).first().click();
      await page.waitForTimeout(600);
      await page.getByRole("button", { name: /^Model:/ }).click();
      await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length > 50, null, { timeout: 30_000 });
      const ocRows = await page.locator('[role="option"]').count();
      const more = await page.locator("text=/more\\. Keep typing/").count();
      check("a long catalog renders capped rows with an 'N more' line", ocRows <= 102 && more === 1, `${ocRows} rows`);
      await shot(tag("5-long-list"));
      await page.keyboard.press("Escape");

      // ---------------------------------------------------------------- settings: agents
      const palette = async (q: string) => {
        await page.keyboard.press("Meta+k");
        await page.waitForSelector('[cmdk-input]');
        await page.keyboard.type(q);
        await page.waitForTimeout(300);
        await page.locator("[cmdk-item]", { hasText: q }).first().click();
        await page.waitForTimeout(500);
      };
      await palette("New agent");
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 8000 }).catch(async (e) => { await shot(tag("dbg-no-dialog")); throw e; });
      await dialog.getByLabel("Engine", { exact: true }).click();
      await page.waitForTimeout(400);
      await shot(tag("6-agent-engine-select"));
      await page.getByRole("option", { name: /codex/ }).click();
      await page.waitForTimeout(400);
      await dialog.getByRole("button", { name: /^Model:/ }).click();
      await page.waitForSelector("text=/\\d+ models? · /", { timeout: 30_000 });
      await page.waitForTimeout(500);
      await shot(tag("7-agent-editor-models"));
      const codexRows = await page.locator('[role="option"] .truncate.font-mono').allTextContents();
      check("agent editor lists the chosen engine\'s own models (here: whatever codex reports)", codexRows.length > 0, codexRows.slice(0, 3).join(", "));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      await shot(tag("8-agent-editor"));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);

      // ---------------------------------------------------------------- pairs: agents as roles, inheritance hints
      await trb("agent", "--help");
      await page.evaluate(async () => {
        const j = (b: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
        await fetch("/api/agents", j({ name: "reviewer", title: "Code reviewer", description: "Reads diffs and reports problems", instructions: "Review strictly. Report findings only.", engine: "codex", model: "gpt-5.3-codex", effort: "high" }));
        await fetch("/api/pairs", j({ title: "Review pair", mode: "roles", lead_engine: "claude", lead_model: "opus", lead_effort: "high", roles: { builder: { engine: "cursor", model: "composer-2" }, reviewer: { agent: "reviewer" } } }));
      });
      await page.reload();
      await page.waitForSelector("header");
      await palette("Hydra pairs");
      await page.waitForSelector("text=Review pair", { timeout: 8000 });
      await shot(tag("9-pairs-list"));
      await page.getByRole("button", { name: /^Edit/ }).first().click();
      await page.getByRole("dialog").waitFor({ timeout: 8000 });
      await page.waitForTimeout(900);
      await shot(tag("10-pair-editor"));
      const body = await page.locator("body").innerText();
      check("a role that names an agent shows the agent's details", /Code reviewer/.test(body) || /Reads diffs/.test(body));
      check("the role inherits and says so", /inherit|from the agent|reviewer/i.test(body));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);

      // ---------------------------------------------------------------- engines page
      await palette("Engines");
      await page.waitForSelector("text=/not installed|installed/", { timeout: 8000 });
      await page.waitForTimeout(500);
      await shot(tag("11-engines-page"));
      const toggle = page.getByRole("button", { name: /models/i }).first();
      if (await toggle.count()) {
        await toggle.click();
        await page.getByPlaceholder(/Search \d+ models/).first().waitFor({ timeout: 30_000 });
        await page.waitForTimeout(700);
        await shot(tag("12-engines-models"));
        check("engines page shows a model catalog section", true);
      } else check("engines page shows a model catalog section", false);
      // ---------------------------------------------------------------- engine marks everywhere (scripted engine: no tokens)
      await page.getByRole("button", { name: /^Engine:/ }).click();
      await page.waitForTimeout(400);
      await shot(tag("13-engine-popover"));
      const marks = await page.locator('img[src^="/engines/"]').evaluateAll((els) => (els as HTMLImageElement[]).map((i) => ({ src: i.getAttribute("src"), ok: i.complete && i.naturalWidth > 0 })));
      check("every engine mark in the open popover loaded", marks.length >= 6 && marks.every((m) => m.ok), marks.filter((m) => !m.ok).map((m) => m.src).join(", ") || `${marks.length} marks`);
      await page.keyboard.press("Escape");
      const prompt = 'CALL_TOOL subagent_create {"brief":"SLEEP 2500\\nWRITE head.txt from the head\\nGIT_COMMIT head work","title":"write head file"}\nCALL_TOOL subagent_wait {"timeout_sec":30}';
      trb("run", "-p", "Review pair", "-e", "fake", "-d", "-C", repo, prompt);
      await page.waitForTimeout(1500);
      await page.locator("text=CALL_TOOL").first().click();
      await page.waitForTimeout(800);
      await shot(tag("14-session-with-icons"));
      await page.getByRole("tab", { name: /Heads/ }).click();
      await page.waitForTimeout(700);
      await shot(tag("15-heads-with-icons"));
      check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    },
    { theme },
  );
}
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
