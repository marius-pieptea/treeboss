/** Drive the Specs module against the scripted engine; shots to /tmp/trb-shots/specs-*.png. */
import fs from "fs";
import path from "path";
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

async function fresh(page: Page, wid: string, url: string, patch: Record<string, unknown> = {}) {
  await page.goto(`${url}/w/${wid}`);
  await page.evaluate(
    ([wid, patch]) => {
      const raw = localStorage.getItem("trb.ui.v1");
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
      cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, activity: "specs", byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: null, expanded: [], history: [] } }, ...patch };
      localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
      // The composer defaults to the real claude; these runs must use the scripted engine.
      localStorage.setItem("trb.composer.v1", JSON.stringify({ engine: "fake", model: "", effort: "", pairId: "", worktree: false }));
    },
    [wid, patch] as [string, Record<string, unknown>],
  );
  await page.reload();
  await page.waitForSelector("[data-specs-sidebar]");
}
const sessions = async (page: Page) => (await page.evaluate(async () => (await (await fetch("/api/sessions")).json()).sessions)) as any[];
const until = async (fn: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

for (const theme of (process.env.THEME ? [process.env.THEME] : ["dark", "light"]) as Array<"dark" | "light">) {
  await withUi(
    async ({ page, shot, trb, repo, workspaceId, url }) => {
      const t: string = theme;
      trb("config", "set", "default_engine", "fake");
      const spec = (p: string) => path.join(repo, p);

      // ---- empty state: explicit actions, nothing created by looking
      await fresh(page, workspaceId, url);
      check(`${t}: the Specs activity is in the bar`, (await page.getByRole("button", { name: "Specs", exact: true }).count()) === 1);
      await page.waitForSelector("text=No specs yet");
      check(`${t}: empty state offers both explicit actions`, (await page.locator("[data-create-constitution]").count()) === 1 && (await page.getByRole("button", { name: "New feature" }).count()) >= 1);
      check(`${t}: opening the view creates no files`, !fs.existsSync(spec(".specify")) && !fs.existsSync(spec("specs")));
      await page.waitForTimeout(450);
      await shot(`specs-${t}-empty`);

      // ---- constitution
      await page.locator("[data-create-constitution]").first().click();
      await page.waitForSelector("text=Template: still has placeholders");
      check(`${t}: Create constitution writes the template`, fs.existsSync(spec(".specify/memory/constitution.md")));
      await page.waitForTimeout(300);
      await shot(`specs-${t}-constitution`);

      // ---- new feature
      await page.locator("[data-new-feature]").click();
      await page.locator("[data-new-feature-name]").fill("Add CSV export to the orders page");
      await page.waitForSelector("text=specs/001-add-csv-export-orders-page/");
      await page.waitForTimeout(350);
      await shot(`specs-${t}-new-feature`);
      await page.locator("[data-new-feature-confirm]").click();
      await page.waitForSelector("[data-spec-workbench]");
      check(`${t}: the feature folder and spec.md exist`, fs.existsSync(spec("specs/001-add-csv-export-orders-page/spec.md")));
      check(`${t}: the workbench opened as a tab`, (await page.locator('[data-spec-workbench="001-add-csv-export-orders-page"]').count()) === 1);
      const stepState = async (s: string) => page.locator(`[data-step="${s}"]`).getAttribute("data-state");
      check(`${t}: the stepper points at Specify (the constitution is still a template but does not block)`, (await stepState("specify")) === "active" && (await stepState("constitution")) === "ready", `${await stepState("specify")}/${await stepState("constitution")}`);
      check(`${t}: later steps are waiting`, (await stepState("tasks")) === "blocked" && (await stepState("implement")) === "blocked");
      await page.waitForSelector("[data-spec-banner]");
      check(`${t}: the spec tab warns it is still the skeleton`, (await page.locator("[data-spec-banner]").innerText()).includes("skeleton"));
      await page.waitForTimeout(400);
      await shot(`specs-${t}-workbench-new`);

      // ---- run the Specify step in a new session
      await page.locator('[data-step="specify"]').click();
      await page.waitForSelector("[data-run-confirm]");
      await page.waitForTimeout(350);
      await shot(`specs-${t}-run-dialog`);
      await page.locator("[data-run-input]").fill("Keep the current filters.");
      await page.locator("[data-run-confirm]").click();
      check(`${t}: Specify starts a session`, await until(async () => (await sessions(page)).some((s) => s.title.startsWith("Specify:"))));
      const specifySession = (await sessions(page)).find((s) => s.title.startsWith("Specify:"));
      const att = await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/specs`)).json()).attached, specifySession.id);
      check(`${t}: it carries the constitution and the feature as attachments`, att.length === 2, att.map((a: any) => a.spec_path).join(", "));
      await page.waitForTimeout(600);
      await shot(`specs-${t}-step-running`);

      // ---- plan and tasks arrive (as an agent would write them)
      fs.writeFileSync(spec("specs/001-add-csv-export-orders-page/spec.md"), "# Feature Specification: CSV export\n\n**Input**: Export orders\n\n### User Story 1 - Export (Priority: P1)\n\n- **FR-001**: The system MUST export the visible rows as CSV.\n");
      fs.writeFileSync(spec("specs/001-add-csv-export-orders-page/plan.md"), "# Implementation Plan: CSV export\n\n## Summary\n\nStream rows through a serializer.\n");
      fs.writeFileSync(
        spec("specs/001-add-csv-export-orders-page/tasks.md"),
        ["# Tasks: CSV export", "", "## Phase 1: Setup", "", "- [x] T001 Create the module in src/export/index.ts", "- [ ] T002 Add the csv dependency to package.json", "", "## Phase 2: User Story 1 (P1)", "", "- [ ] T003 [P] [US1] Add the button in web/orders/ExportButton.tsx", "- [ ] T004 [P] [US1] Add the serializer in src/export/rows.ts", "- [ ] T005 [US1] Wire the endpoint in src/api/orders.ts", ""].join("\n"),
      );
      await page.waitForSelector('[data-step="tasks"][data-state="done"]', { timeout: 15_000 });
      check(`${t}: the stepper follows the files (spec, plan and tasks are done)`, (await stepState("specify")) === "done" && (await stepState("plan")) === "done" && (await stepState("tasks")) === "done");
      check(`${t}: implement is the next step`, (await stepState("implement")) === "active");

      // ---- tasks tab
      await page.locator('[data-doc="tasks"]').click();
      await page.waitForSelector("[data-tasks-checklist]");
      check(`${t}: the checklist shows progress`, (await page.locator("[data-tasks-checklist]").innerText()).includes("1/5 done"));
      check(`${t}: [P] and story chips render`, (await page.locator("[data-task-row]").filter({ hasText: "T003" }).innerText()).includes("US1"));
      await shot(`specs-${t}-tasks`);
      await page.locator("[data-task-row]").filter({ hasText: "T002" }).locator("[data-task-box]").click();
      check(`${t}: ticking a box writes tasks.md (one line changes)`, await until(async () => fs.readFileSync(spec("specs/001-add-csv-export-orders-page/tasks.md"), "utf-8").includes("- [x] T002 Add the csv")));
      check(`${t}: the other lines are untouched`, fs.readFileSync(spec("specs/001-add-csv-export-orders-page/tasks.md"), "utf-8").includes("- [ ] T003 [P] [US1]"));
      await page.locator("[data-tasks-checklist]").getByText("2/5 done").waitFor();
      await shot(`specs-${t}-tasks-ticked`);

      await page.getByPlaceholder("Filter tasks").fill("serializer");
      check(`${t}: the filter narrows the list`, (await page.locator("[data-task-row]").count()) === 1);
      await page.getByPlaceholder("Filter tasks").fill("");
      await page.getByRole("button", { name: "[P] only" }).click();
      check(`${t}: [P] only shows the parallel tasks`, (await page.locator("[data-task-row]").count()) === 2);
      await page.getByRole("button", { name: "[P] only" }).click();

      // ---- run one task
      const row = page.locator("[data-task-row]").filter({ hasText: "T004" });
      await row.hover();
      await row.locator("[data-task-run]").click();
      await page.waitForSelector("[data-run-confirm]");
      await page.getByRole("button", { name: "New session" }).click();
      await page.locator("[data-run-confirm]").click();
      check(`${t}: Run task starts a session for that task`, await until(async () => (await sessions(page)).some((s) => s.title.startsWith("T004"))));

      // ---- implement (goal mode)
      await page.locator("[data-implement-top]").click();
      await page.waitForSelector("[data-run-test]");
      await page.locator("[data-run-test]").fill("true");
      await page.waitForTimeout(350);
      await shot(`specs-${t}-implement-dialog`);
      await page.locator("[data-run-confirm]").click();
      check(`${t}: Implement starts a goal-mode session`, await until(async () => (await sessions(page)).some((s) => s.title.startsWith("Implement:"))));
      const impl = (await sessions(page)).find((s) => s.title.startsWith("Implement:"));
      const goal = await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/goal`)).json()).goal, impl.id);
      check(`${t}: its check is "no open boxes, and the test command passes"`, !!goal && goal.check_cmd.includes("tasks.md") && goal.check_cmd.includes("( true )"), String(goal?.check_cmd).slice(0, 80));
      await page.waitForTimeout(800);
      await shot(`specs-${t}-implementing`);

      // ---- missing docs offer their step
      await page.locator('[data-doc="research"]').click();
      await page.waitForSelector("text=No research yet");
      check(`${t}: a missing doc offers the step that writes it`, (await page.locator("[data-run-missing]").count()) === 1);
      await page.locator('[data-doc="plan"]').click();
      await page.waitForSelector('[data-spec-workbench] .cm-editor', { timeout: 15_000 });
      check(`${t}: an existing doc opens in the real editor`, (await page.locator(".cm-content").first().innerText()).includes("Implementation Plan"));
      await shot(`specs-${t}-plan-editor`);

      // ---- sidebar: the list, progress, status
      const rowText = await page.locator('[data-feature="001-add-csv-export-orders-page"]').innerText();
      check(`${t}: the feature row shows status and progress`, rowText.includes("in progress") && rowText.includes("2/5"), rowText.replace(/\n/g, " | "));
      await shot(`specs-${t}-sidebar`);

      // ---- attach to a new session from the composer
      await fresh(page, workspaceId, url);
      await page.locator("[data-plus-menu]").click();
      await page.locator("[data-attach]").click();
      await page.waitForSelector("[data-attach-panel]");
      await page.locator('[data-attach-option="specs/001-add-csv-export-orders-page"]').click();
      await page.locator('[data-attach-option=".specify/memory/constitution.md"]').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-attach-option][aria-checked="true"]').length === 2, null, { timeout: 5000 }).catch(() => {});
      await page.keyboard.press("Escape");
      await page.waitForSelector("[data-attach-chips]");
      await page.waitForFunction(() => document.querySelectorAll("[data-attach-chip]").length === 2, null, { timeout: 5000 }).catch(() => {});
      check(`${t}: two chips appear in the composer`, (await page.locator("[data-attach-chip]").count()) === 2);
      await page.waitForFunction(() => document.querySelector("[data-attach-chip] .font-mono")?.textContent?.includes("~"), null, { timeout: 8000 });
      check(`${t}: each chip shows its token cost`, (await page.locator("[data-attach-chip]").first().innerText()).includes("~"));
      await shot(`specs-${t}-composer-chips`);
      const before = (await sessions(page)).length;
      await page.locator('textarea[aria-label="Message"]').fill("SAY hello");
      await page.keyboard.press("Enter");
      check(`${t}: sending creates a session`, await until(async () => (await sessions(page)).length > before));
      const created = (await sessions(page)).find((s) => s.brief === "SAY hello" || s.title === "SAY hello");
      const attached = await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/specs`)).json()).attached, created.id);
      check(`${t}: the session has both attached`, attached.length === 2, JSON.stringify(attached.map((a: any) => a.spec_path)));
      await page.waitForTimeout(700);
      await page.locator("[data-attach-chip]").first().locator('button[aria-label^="Detach"]').click();
      check(`${t}: detaching an open session's spec goes to the daemon`, await until(async () => (await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/specs`)).json()).attached.length, created.id)) === 1));
      await shot(`specs-${t}-composer-attached`);

      // ---- architecture discussion
      await page.locator("[data-architecture]").click();
      await page.waitForSelector("[data-run-confirm]");
      await page.locator("[data-run-input]").fill("How should exports be queued?");
      await page.locator("[data-run-confirm]").click();
      check(`${t}: Discuss architecture starts a plan-mode session`, await until(async () => (await sessions(page)).some((s) => s.title.startsWith("Architecture") && s.mode === "plan")));
      await page.waitForTimeout(500);
      await shot(`specs-${t}-architecture`);
    },
    { theme },
  );
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall passed");
process.exit(failed ? 1 : 0);
