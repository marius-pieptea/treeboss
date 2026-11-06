/** Drive the Docs module against the scripted engine; shots to /tmp/trb-shots/docs-*.png. */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

const sh = (cmd: string, cwd: string) => {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};
const commit = (repo: string, msg: string) => sh(`git add -A && git -c commit.gpgsign=false commit -q -m ${JSON.stringify(msg)} && git rev-parse HEAD`, repo);

async function fresh(page: Page, wid: string, url: string, patch: Record<string, unknown> = {}, ready = "[data-docs-sidebar]") {
  await page.goto(`${url}/w/${wid}`);
  await page.evaluate(
    ([wid, patch]) => {
      const raw = localStorage.getItem("trb.ui.v1");
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
      cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, activity: "docs", byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: null, expanded: [], history: [] } }, ...patch };
      localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
      // The composer defaults to the real claude; these runs must use the scripted engine.
      localStorage.setItem("trb.composer.v1", JSON.stringify({ engine: "fake", model: "", effort: "", pairId: "", worktree: false }));
    },
    [wid, patch] as [string, Record<string, unknown>],
  );
  await page.reload();
  await page.waitForSelector(ready);
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
      const file = (p: string) => path.join(repo, p);
      const write = (rel: string, text: string) => {
        fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
        fs.writeFileSync(file(rel), text);
      };
      // The sample repo has uncommitted changes for the git panel: commit them so the history here is clean.
      commit(repo, "settle the sample");

      // ---- empty state: explicit actions, nothing created by looking
      await fresh(page, workspaceId, url);
      check(`${t}: the Docs activity is in the bar`, (await page.getByRole("button", { name: "Docs", exact: true }).count()) === 1);
      await page.waitForSelector("text=No docs folder yet");
      check(`${t}: the empty state offers both explicit actions`, (await page.locator("[data-create-folder]").count()) === 1 && (await page.locator("[data-generate-overview]").count()) === 1);
      await page.waitForTimeout(500);
      check(`${t}: opening the view creates no files`, !fs.existsSync(file("docs")));
      await shot(`docs-${t}-empty`);

      // ---- create the folder
      await page.locator("[data-create-folder]").click();
      await page.waitForSelector('[data-doc-page="docs/index.md"]');
      check(`${t}: Create folder writes an index page and nothing else`, fs.existsSync(file("docs/index.md")) && fs.readdirSync(file("docs")).length === 1);

      // ---- pages that make a claim about the code
      const base = sh("git rev-parse HEAD", repo);
      const page1 = (head: string) => `---\ntitle: Architecture\ncovers:\n  - src/**\ngenerated:\n  commit: ${head}\n  at: 2026-10-08T10:00:00.000Z\n  by: claude/opus\nstatus: draft\n---\n\n# Architecture\n\nThe server answers \`/health\` and greets by name. See [the runbook](runbook.md) and [the greeter](../src/greet.ts).\n\n<!-- keep -->\nOn-call rota: see the wiki.\n<!-- /keep -->\n\n| Part | Where |\n| --- | --- |\n| Server | \`src/server.ts\` |\n| Greeter | \`src/greet.ts\` |\n`;
      write("docs/architecture.md", page1(base));
      write("docs/runbook.md", `---\ntitle: Runbook\ncovers: [package.json]\ngenerated:\n  commit: ${base}\n  by: codex/gpt\n---\n\n# Runbook\n\nRun \`bun run dev\` to start it.\n`);
      write("docs/guides/setup.md", "# Setup\n\nInstall Bun, then `bun install`.\n");
      commit(repo, "docs");
      write("src/greet.ts", "export function greet(name: string): string {\n  return `Hi, ${name}!`;\n}\n");
      commit(repo, "greet differently");
      await page.waitForSelector('[data-doc-page="docs/architecture.md"] [data-fresh="drifting"]', { timeout: 15_000 });
      check(`${t}: the page that covers src/ is drifting`, (await page.locator('[data-doc-page="docs/architecture.md"] [data-fresh]').getAttribute("data-fresh")) === "drifting");
      check(`${t}: the page that covers package.json is fresh`, (await page.locator('[data-doc-page="docs/runbook.md"] [data-fresh]').getAttribute("data-fresh")) === "fresh");
      check(`${t}: a page without front matter is not tracked`, (await page.locator('[data-doc-page="docs/setup.md"] [data-fresh], [data-doc-page="docs/guides/setup.md"] [data-fresh]').first().getAttribute("data-fresh")) === "unmanaged");
      await page.waitForSelector("[data-docs-drift]");
      check(`${t}: the sidebar says one page drifted and offers to refresh`, (await page.locator("[data-docs-drift]").innerText()).includes("1 drifting") && (await page.locator("[data-refresh-stale]").count()) === 1);
      await page.waitForTimeout(400);
      await shot(`docs-${t}-sidebar`);

      // ---- the viewer
      await page.locator('[data-doc-page="docs/architecture.md"]').click();
      await page.waitForSelector('[data-doc-viewer="docs/architecture.md"] .markdown');
      check(`${t}: the page renders as markdown without its front matter`, (await page.locator(".markdown").innerText()).includes("The server answers") && !(await page.locator(".markdown").innerText()).includes("covers:"));
      const headerLine = await page.locator("[data-doc-headerline]").innerText();
      check(`${t}: the header says when it was written and how far behind`, headerLine.includes("generated at") && headerLine.includes("claude/opus") && headerLine.includes("1 commit behind"), headerLine);
      check(`${t}: a freshness badge shows`, (await page.locator("[data-doc-fresh]").getAttribute("data-doc-fresh")) === "drifting");
      await page.locator("[data-doc-headerline] button").click();
      await page.waitForSelector("[data-doc-changed]");
      check(`${t}: expanding lists the covered file that changed`, (await page.locator("[data-doc-changed]").innerText()).includes("src/greet.ts"));
      check(`${t}: the covers are shown as chips`, (await page.locator("[data-doc-covers]").innerText()).includes("src/**"));
      await page.waitForTimeout(400);
      await shot(`docs-${t}-viewer-drifting`);

      // links go inside the app
      await page.locator('[data-doc-link="docs/runbook.md"]').click();
      await page.waitForSelector('[data-doc-viewer="docs/runbook.md"]');
      check(`${t}: a link to another page opens it in the viewer`, (await page.locator("[data-doc-viewer]").count()) >= 1);
      await page.locator('[role="tab"]').filter({ hasText: "Architecture" }).click();
      await page.waitForSelector('[data-doc-viewer="docs/architecture.md"]');

      // ---- mark current
      await page.locator("[data-doc-current]").click();
      await page.waitForSelector('[data-doc-fresh="fresh"]', { timeout: 15_000 });
      check(`${t}: Mark current records HEAD and the page is fresh`, fs.readFileSync(file("docs/architecture.md"), "utf-8").includes(`commit: ${sh("git rev-parse HEAD", repo)}`));
      check(`${t}: only the generated key changed, the keep block is intact`, fs.readFileSync(file("docs/architecture.md"), "utf-8").includes("<!-- keep -->\nOn-call rota: see the wiki.\n<!-- /keep -->"));
      await page.waitForSelector('[data-doc-dirty]');
      check(`${t}: the page is flagged as changed since the last commit, with a diff button`, (await page.locator("[data-doc-dirty]").innerText()).includes("not committed"));
      await shot(`docs-${t}-viewer-fresh`);

      // ---- edit toggle
      await page.locator("[data-doc-edit]").click();
      await page.waitForSelector(".cm-editor");
      check(`${t}: Edit shows the file in the editor`, (await page.locator(".cm-content").innerText()).includes("title: Architecture"));
      await shot(`docs-${t}-edit`);
      await page.locator("[data-doc-edit]").click();
      await page.waitForSelector(".markdown");

      // ---- new page and decision record
      await page.locator("[data-new-page]").click();
      await page.locator("[data-new-page-title]").fill("Release process");
      check(`${t}: the file name follows the title`, (await page.locator("[data-new-page-path]").inputValue()) === "release-process.md");
      await page.waitForTimeout(300);
      await shot(`docs-${t}-new-page`);
      await page.locator("[data-new-page-confirm]").click();
      await page.waitForSelector('[data-doc-viewer="docs/release-process.md"]');
      check(`${t}: the new page exists with its template`, fs.readFileSync(file("docs/release-process.md"), "utf-8").includes("title: \"Release process\""));
      await page.locator("[data-new-page]").click();
      await page.getByRole("button", { name: "Decision record" }).click();
      await page.locator("[data-new-page-title]").fill("Use SQLite for state");
      check(`${t}: a decision record gets the next number`, (await page.locator("[data-new-page-path]").inputValue()) === "decisions/0001-use-sqlite-for-state.md");
      await page.locator("[data-new-page-confirm]").click();
      await page.waitForSelector('[data-doc-viewer="docs/decisions/0001-use-sqlite-for-state.md"]');
      check(`${t}: the record has the four sections`, ["## Status", "## Context", "## Decision", "## Consequences"].every((h) => fs.readFileSync(file("docs/decisions/0001-use-sqlite-for-state.md"), "utf-8").includes(h)));

      // ---- search
      await page.locator('button[aria-label="Search the docs"]').click();
      await page.locator("[data-docs-search]").fill("runbook");
      check(`${t}: the filter narrows the tree`, (await page.locator('[data-doc-page="docs/runbook.md"]').count()) === 1 && (await page.locator('[data-doc-page="docs/guides/setup.md"]').count()) === 0);
      await page.locator("[data-docs-search]").fill("on-call");
      await page.waitForSelector("text=In the text");
      await page.waitForFunction(() => document.body.innerText.includes("On-call rota"), null, { timeout: 8000 });
      check(`${t}: a phrase inside a page is found`, (await page.locator("[data-docs-sidebar]").innerText()).includes("architecture.md"));
      await shot(`docs-${t}-search`);
      await page.locator("[data-docs-search]").fill("");
      await page.keyboard.press("Escape");

      // ---- generate: the dialog says what would run
      await page.locator("[data-refresh-stale]").count();
      write("src/greet.ts", "export function greet(name: string): string {\n  return `Hello again, ${name}!`;\n}\n");
      commit(repo, "greet once more");
      await fresh(page, workspaceId, url);
      await page.locator("[data-generate]").click();
      await page.waitForSelector("[data-gen-confirm]");
      await page.waitForSelector("[data-gen-preview] >> text=docs/index.md", { timeout: 10_000 });
      check(`${t}: the dialog previews the page it would write or refresh`, (await page.locator("[data-gen-preview]").innerText()).includes("docs/index.md"));
      await page.waitForTimeout(350);
      await shot(`docs-${t}-generate-dialog`);
      await page.locator("[data-gen-confirm]").click();
      check(`${t}: Generate starts a docs session`, await until(async () => (await sessions(page)).some((s) => s.title.startsWith("Docs:"))));
      const run = (await sessions(page)).find((s) => s.title.startsWith("Docs:"));
      const preview = await page.evaluate(async (wid) => (await (await fetch(`/api/docs/${wid}/generate/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "overview" }) })).json()), workspaceId);
      check(`${t}: the prompt carries the contract and HEAD`, preview.prompt.includes("DOCS_TOUCHED") && preview.prompt.includes(sh("git rev-parse HEAD", repo)) && preview.prompt.includes("<!-- keep -->"));
      await until(async () => (await sessions(page)).find((s) => s.id === run.id)?.status !== "running");

      // the agent's work lands (written here as the agent would), and one more turn lets the app look at it
      write("docs/index.md", `---\ntitle: demo-app\ncovers:\n  - src/**\ngenerated:\n  commit: ${sh("git rev-parse HEAD", repo)}\n  at: 2026-10-08T12:00:00.000Z\n  by: fake\n---\n\n# demo-app\n\nA tiny server.\n`);
      write("docs/stray-notes.md", "# Notes without front matter\n");
      trb("send", run.id, "SAY done");
      await page.waitForSelector("[data-docs-last-run]", { timeout: 15_000 });
      await page.waitForFunction(() => document.querySelector("[data-docs-last-run]")?.textContent?.includes("2 pages written"), null, { timeout: 20_000 });
      const lastRun = await page.locator("[data-docs-last-run]").innerText();
      check(`${t}: the last-run card lists the pages written and what to check`, lastRun.includes("index.md") && lastRun.includes("stray-notes.md") && lastRun.includes("to check"), lastRun.replace(/\n/g, " | "));
      await page.waitForTimeout(400);
      await shot(`docs-${t}-last-run`);

      // ---- attach to a new session from the composer
      await fresh(page, workspaceId, url);
      await page.locator("[data-plus-menu]").click();
      await page.locator("[data-attach]").click();
      await page.waitForSelector("[data-attach-panel]");
      await page.locator('[data-attach-option="docs/architecture.md"]').click();
      await page.locator('[data-attach-option="docs/runbook.md"]').click();
      await page.keyboard.press("Escape");
      await page.waitForSelector("[data-attach-chips]");
      check(`${t}: two chips appear in the composer`, (await page.locator("[data-attach-chip]").count()) === 2);
      await page.waitForFunction(() => document.querySelector("[data-attach-chip] .font-mono")?.textContent?.includes("~"), null, { timeout: 8000 });
      check(`${t}: each chip shows its token cost`, (await page.locator("[data-attach-chip]").first().innerText()).includes("~"));
      await shot(`docs-${t}-composer-chips`);
      const before = (await sessions(page)).length;
      await page.locator('textarea[aria-label="Message"]').fill("SAY hello");
      await page.keyboard.press("Enter");
      check(`${t}: sending creates a session`, await until(async () => (await sessions(page)).length > before));
      const created = (await sessions(page)).find((s) => s.brief === "SAY hello" || s.title === "SAY hello");
      const attached = await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/docs`)).json()).attached, created.id);
      check(`${t}: the session has both attached`, attached.length === 2, JSON.stringify(attached.map((a: any) => a.doc_path)));
      await page.waitForTimeout(700);
      await page.locator("[data-attach-chip]").first().locator('button[aria-label^="Detach"]').click();
      check(`${t}: detaching an open session's page goes to the daemon`, await until(async () => (await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/docs`)).json()).attached.length, created.id)) === 1));
      await shot(`docs-${t}-composer-attached`);

      // ---- command palette
      await fresh(page, workspaceId, url, { activity: "explorer" }, "textarea");
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByPlaceholder("Type a command…").fill("decision record");
      await page.waitForTimeout(200);
      check(`${t}: the palette offers the docs commands`, (await page.getByText("New decision record…").count()) >= 1);
      await page.keyboard.press("Escape");
    },
    { theme },
  );
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
