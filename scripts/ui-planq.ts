import fs from "fs";
import nodePath from "path";
/** The plan questionnaire end to end against the scripted engine: answer, review, the plan as a file in its own tab (edit, approve, send back, skip, promote, Spec it). Shots in /tmp/trb-shots/planq-*.png. `TRB_WEB_DIR=<dist> bun run scripts/ui-planq.ts` */
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
    cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: null, expanded: [], history: [] } } };
    localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
    localStorage.setItem("trb.composer.v1", JSON.stringify({ engine: "fake", model: "", effort: "", pairId: "", worktree: false }));
  }, wid);
  await page.reload();
  await page.waitForSelector('textarea[aria-label="Message"]');
}
const send = async (page: Page, text: string) => {
  await page.locator('textarea[aria-label="Message"]').fill(text);
  await page.keyboard.press("Enter");
};
const sessions = async (page: Page) => (await page.evaluate(async () => (await (await fetch("/api/sessions")).json()).sessions)) as any[];

const ASK1 = JSON.stringify({
  question: "Where should the cache live?",
  options: [
    { label: "SQLite", description: "One file next to the daemon database.", recommended: true, reason: "the repo already ships bun:sqlite" },
    { label: "In memory", description: "Fast, lost on restart." },
    { label: "Redis", description: "Needs a server to run." },
  ],
});
const ASK2 = JSON.stringify({ question: "How long should entries live?", options: [{ label: "1 hour", recommended: true, reason: "matches the model catalog" }, { label: "1 day" }] });
const PLAN = JSON.stringify({
  title: "Add a model cache",
  summary: "Keep the catalog in SQLite so a restart does not refetch it. Entries expire on a timer.",
  steps: [
    { title: "Create the cache table", detail: "One row per engine with a fetched_at column.", files: ["src/db.ts", "src/engines/models.ts"] },
    { title: "Read through the cache", detail: "Serve fresh rows, refetch stale ones." },
    { title: "Cover it with tests", detail: "Fresh, stale and missing cases.", files: ["tests/models.test.ts"] },
  ],
  risks: ["A stale row hides a new model until it expires."],
});

for (const theme of (process.env.THEME ? [process.env.THEME] : ["dark", "light"]) as Array<"dark" | "light">) {
  await withUi(
    async ({ page, shot, trb, workspaceId, url, repo }) => {
      const t: string = theme;
      trb("config", "set", "default_engine", "fake");

      // ---- questions, review, plan, edit, approve
      await fresh(page, workspaceId, url);
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Plan: quick" }).click();
      await send(page, `CALL_TOOL plan_ask ${ASK1}\nCALL_TOOL plan_ask ${ASK2}\nCALL_TOOL plan_submit ${PLAN}`);
      await page.waitForSelector("[data-plan-question]", { timeout: 25_000 });
      await page.waitForTimeout(350);
      const header = await page.locator("[data-plan-flow] >> text=/Question 1 of/").first().innerText();
      check(`${t}: the first question shows its step`, header === "Question 1 of ~4", header);
      check(`${t}: the options and the recommended badge render`, (await page.locator("[data-plan-option]").count()) === 3 && (await page.locator('[data-plan-option] span:text-is("Recommended")').count()) === 1, `options=${await page.locator("[data-plan-option]").count()}`);
      check(`${t}: the recommendation is preselected, with its reason`, (await page.locator("[data-plan-option][data-selected]").getAttribute("data-plan-option")) === "SQLite" && (await page.locator("[data-plan-flow]").innerText()).includes("the repo already ships bun:sqlite"));
      await shot(`planq-${t}-question`);

      await page.keyboard.press("2");
      check(`${t}: the 2 key picks the second option`, (await page.locator("[data-plan-option][data-selected]").getAttribute("data-plan-option")) === "In memory");
      await shot(`planq-${t}-picked`);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => /Question 2 of/.test(document.querySelector("[data-plan-flow]")?.textContent ?? ""), null, { timeout: 15_000 });
      check(`${t}: Enter answers and the next question appears`, (await page.locator("[data-plan-question]").count()) === 1);
      check(`${t}: the answered question collapses to a line`, (await page.locator("[data-plan-answered]").innerText()).includes("In memory"));
      await shot(`planq-${t}-second`);

      await page.locator("[data-plan-back]").click();
      check(`${t}: Back shows the earlier answer read-only`, (await page.locator("[data-plan-flow]").innerText()).includes("(answered)") && (await page.locator("[data-plan-option][data-selected]").getAttribute("data-plan-option")) === "In memory" && (await page.locator("[data-plan-answer]").count()) === 0);
      await shot(`planq-${t}-review`);
      await page.getByRole("button", { name: /Current question/ }).click();
      check(`${t}: back to the live question`, (await page.locator("[data-plan-answer]").count()) === 1);

      await page.locator("[data-plan-custom]").fill("Two hours, then refresh in the background");
      check(`${t}: writing an answer clears the selection`, (await page.locator("[data-plan-option][data-selected]").count()) === 0);
      await page.locator("[data-plan-answer]").click();
      // The plan lands as a file and opens in its own tab, with the decision in a sticky bar.
      await page.waitForSelector("[data-plan-viewer]", { timeout: 25_000 });
      await page.waitForFunction(() => !(document.querySelector("[data-plan-approve]") as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
      await page.waitForTimeout(350);
      const doc = await page.locator("[data-plan-viewer]").innerText();
      check(`${t}: the plan opened in its own tab, rendered`, doc.includes("Add a model cache") && doc.includes("Create the cache table") && doc.includes("src/engines/models.ts") && doc.includes("Risks"), doc.slice(0, 80));
      check(`${t}: the front matter is not shown, the decisions are`, !doc.includes("status: draft") && doc.includes("Where should the cache live? In memory"));
      check(`${t}: the tab is titled after the plan`, (await page.locator('[role="tab"]').filter({ hasText: "Plan: Add a model cache" }).count()) === 1);
      check(`${t}: the slot holds one plan row, no second chip and no plan card`, (await page.locator("[data-status-slot] [data-plan-row]").count()) === 1 && (await page.locator("[data-status-slot] [data-plan-chip]").count()) === 0 && (await page.locator("[data-plan-card]").count()) === 0);
      check(`${t}: the thread has the same chip where the plan landed`, (await page.locator("[data-chat-thread] [data-plan-chip]").count()) === 1);
      check(`${t}: the bar offers skip, changes, edit, promote and approve`, (await Promise.all(["skip", "changes", "edit", "promote", "approve"].map((n) => page.locator(`[data-plan-${n}]`).count()))).every((n) => n === 1));
      const path = (await page.evaluate(async () => (await (await fetch("/api/sessions")).json()).sessions[0].id).then((id) => page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/plan-state`)).json()).plan.path, id))) as string;
      check(`${t}: it is a file under plans/`, /^plans\/\d{4}-\d{2}-\d{2}-add-a-model-cache\.md$/.test(path), path);
      await shot(`planfile-${t}-viewer`);

      // Edit the file itself: what is approved is what you edited.
      await page.locator("[data-plan-edit]").click();
      await page.waitForSelector(".cm-content", { timeout: 10_000 });
      check(`${t}: Edit shows the plan file in the editor, with the bar still there`, (await page.locator(".cm-content").innerText()).includes("title: ") && (await page.locator("[data-plan-approve]").isDisabled()));
      await page.locator(".cm-content").click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("\nOperator note: keep it behind a flag.\n");
      await page.keyboard.press("ControlOrMeta+s");
      await page.waitForTimeout(600);
      await shot(`planfile-${t}-edit`);
      await page.locator("[data-plan-edit]").click();
      await page.waitForFunction(() => document.querySelector("[data-plan-viewer]")?.textContent?.includes("Operator note"), null, { timeout: 10_000 });
      await page.waitForSelector("[data-plan-edited]", { timeout: 10_000 }).catch(() => {});
      check(`${t}: the saved edit shows in the rendered plan, tagged edited`, (await page.locator("[data-plan-edited]").count()) === 1);
      await page.waitForFunction(() => !(document.querySelector("[data-plan-approve]") as HTMLButtonElement | null)?.disabled, null, { timeout: 10_000 });
      await page.locator("[data-plan-approve]").click();
      await page.waitForFunction(() => document.querySelector("[data-mode-segment]")?.getAttribute("data-mode") === "build", null, { timeout: 20_000 });
      await page.waitForSelector('[data-plan-viewer][data-plan-status="approved"]', { timeout: 15_000 });
      check(`${t}: approving leaves a status chip and removes the decision buttons`, (await page.locator("[data-plan-status-chip]").innerText()).includes("approved") && (await page.locator("[data-plan-approve]").count()) === 0);
      await page.waitForSelector('[data-chat-thread] [data-plan-chip="approved"]', { timeout: 10_000 });
      await page.waitForSelector("[data-plan-row]", { state: "detached", timeout: 3000 }).catch(() => {});
      check(`${t}: once decided, the row above the box is gone and the thread chip says approved`, (await page.locator("[data-plan-row]").count()) === 0);
      const s = (await sessions(page))[0];
      const turns = (await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/turns`)).json()).turns, s.id)) as any[];
      const built = turns[turns.length - 1]?.prompt ?? "";
      check(`${t}: the build turn points at the file and carries the decisions`, built.includes(`Implement the approved plan in \`${path}\``) && built.includes("Where should the cache live? In memory") && built.includes("Two hours"), built.slice(0, 160));
      const file = (await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/plan/file`)).json()).text, s.id)) as string;
      check(`${t}: the file keeps the operator's edit and says approved`, file.includes("Operator note: keep it behind a flag.") && /status: approved/.test(file));
      await shot(`planfile-${t}-approved`);

      // ---- send a plan back with a note: the same file is revised
      await fresh(page, workspaceId, url);
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Plan: quick" }).click();
      await send(page, `CALL_TOOL plan_submit ${PLAN}`);
      await page.waitForSelector("[data-plan-viewer]", { timeout: 25_000 });
      await page.waitForFunction(() => !(document.querySelector("[data-plan-approve]") as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
      await page.locator("[data-plan-changes]").click();
      check(`${t}: Send note needs a note`, await page.locator("[data-plan-send-changes]").isDisabled());
      await page.locator("[data-plan-note]").fill("Split step two and skip the tests for now.");
      await shot(`planfile-${t}-changes`);
      await page.locator("[data-plan-send-changes]").click();
      await page.waitForFunction(() => /being revised/.test(document.querySelector("[data-plan-status-chip]")?.textContent ?? ""), null, { timeout: 15_000 });
      for (let i = 0; i < 60 && !(await sessions(page)).some((x) => x.mode === "plan" && x.turns >= 2 && x.status !== "running"); i++) await page.waitForTimeout(250);
      const sent = (await sessions(page)).find((x) => x.mode === "plan");
      check(`${t}: sent back, it stays in plan mode with a second turn and the tab says it is being revised`, !!sent && sent.turns >= 2, `turns=${sent?.turns}`);

      // ---- skip: plan mode off, the plan stays as superseded
      await fresh(page, workspaceId, url);
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Plan: quick" }).click();
      await send(page, `CALL_TOOL plan_submit ${PLAN}`);
      await page.waitForSelector("[data-plan-viewer]", { timeout: 25_000 });
      await page.waitForFunction(() => !(document.querySelector("[data-plan-skip]") as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
      await page.locator("[data-plan-skip]").click();
      await page.waitForFunction(() => document.querySelector("[data-mode-segment]")?.getAttribute("data-mode") === "build", null, { timeout: 20_000 });
      await page.waitForFunction(() => /skipped/.test(document.querySelector("[data-plan-status-chip]")?.textContent ?? ""), null, { timeout: 10_000 }).catch(() => {});
      check(`${t}: Skip plan leaves plan mode and marks the plan skipped`, /skipped/.test(await page.locator("[data-plan-status-chip]").innerText()));

      // ---- promote to a spec, and the Spec it depth
      await fresh(page, workspaceId, url);
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Plan: quick" }).click();
      await send(page, `CALL_TOOL plan_submit ${PLAN}`);
      await page.waitForSelector("[data-plan-viewer]", { timeout: 25_000 });
      await page.waitForFunction(() => !(document.querySelector("[data-plan-promote]") as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
      await page.locator("[data-plan-promote]").click();
      await page.waitForSelector("[data-spec-workbench]", { timeout: 15_000 });
      check(`${t}: Promote to spec opens the feature in the Specs view`, (await page.locator("[data-spec-workbench]").getAttribute("data-spec-workbench"))?.startsWith("001-") === true);
      await shot(`planfile-${t}-promoted`);

      await fresh(page, workspaceId, url);
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Plan: quick" }).click();
      await page.locator("[data-mode-trigger]").click();
      await page.getByRole("menuitem", { name: "Plan: spec it" }).click();
      await page.waitForTimeout(350);
      check(`${t}: the Spec it depth is chosen before the first message`, (await page.locator("[data-mode-segment]").getAttribute("data-plan-depth")) === "spec");
      await send(page, `CALL_TOOL plan_submit ${PLAN}`);
      await page.waitForSelector("[data-plan-viewer]", { timeout: 25_000 });
      const spec = (await sessions(page)).find((x) => x.mode === "plan");
      const planPath = (await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/plan-state`)).json()).plan?.path, spec.id)) as string;
      check(`${t}: at the spec depth the plan is a feature's plan.md`, /^specs\/\d{3}-.*\/plan\.md$/.test(planPath), planPath);
      await page.waitForFunction(() => /Approve spec/.test(document.querySelector("[data-plan-approve]")?.textContent ?? ""), null, { timeout: 10_000 });
      await shot(`planfile-${t}-spec-depth`);

      // ---- an approved spec plan continues in the specs workflow: tasks first, then Implement
      await page.locator("[data-plan-approve]").click();
      await page.waitForSelector('[data-plan-next="tasks"]', { timeout: 15_000 });
      check(`${t}: an approved spec plan offers Generate tasks next`, /Generate tasks/.test(await page.locator("[data-plan-next]").innerText()));
      await page.locator("[data-plan-next]").click();
      check(`${t}: Generate tasks opens the step dialog`, await page.waitForSelector('[role="dialog"]', { timeout: 8000 }).then(() => true).catch(() => false));
      await page.keyboard.press("Escape");
      const featureDir = planPath.replace(/\/plan\.md$/, "");
      fs.writeFileSync(nodePath.join(repo, featureDir, "tasks.md"), "## Phase 1\n- [ ] T001 Create the table in src/db.ts\n");
      await page.waitForFunction(() => document.querySelector("[data-plan-next]")?.getAttribute("data-plan-next") === "implement", null, { timeout: 15_000 });
      check(`${t}: once tasks.md exists the same button reads Implement`, /Implement/.test(await page.locator("[data-plan-next]").innerText()));
      await shot(`planfile-${t}-next-step`);
    },
    { theme },
  );
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
