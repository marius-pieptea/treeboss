/** The one attach picker (specs, plans, docs) and the Workspace settings page, against the scripted engine; shots to /tmp/trb-shots/merge-*.png. `TRB_WEB_DIR=<dist> bun run scripts/ui-merge.ts` */
import fs from "fs";
import path from "path";
import { withUi } from "./ui-harness";
import type { Page } from "playwright-core";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

async function fresh(page: Page, wid: string, url: string, ws: Record<string, unknown> = {}) {
  await page.goto(`${url}/w/${wid}`);
  await page.evaluate(
    ([wid, ws]) => {
      const raw = localStorage.getItem("trb.ui.v1");
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 1 };
      cur.state = { ...cur.state, rightOpen: true, rightTab: "agent", leftOpen: true, activity: "explorer", byWs: { ...(cur.state.byWs ?? {}), [wid]: { tabs: [], activeTab: null, activeSession: null, expanded: [], history: [], ...ws } } };
      localStorage.setItem("trb.ui.v1", JSON.stringify(cur));
      // The composer defaults to the real claude; these runs must use the scripted engine.
      localStorage.setItem("trb.composer.v1", JSON.stringify({ engine: "fake", model: "", effort: "", pairId: "", worktree: false }));
    },
    [wid, ws] as [string, Record<string, unknown>],
  );
  await page.reload();
}
const api = (page: Page, p: string, init?: { method?: string; body?: unknown }) =>
  page.evaluate(
    async ([p, init]) => {
      const r = await fetch(p as string, { method: (init as any)?.method ?? "GET", headers: { "content-type": "application/json" }, body: (init as any)?.body === undefined ? undefined : JSON.stringify((init as any).body) });
      return r.json();
    },
    [p, init] as [string, typeof init],
  );
const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

for (const theme of (process.env.THEME ? [process.env.THEME] : ["dark", "light"]) as Array<"dark" | "light">) {
  await withUi(
    async ({ page, shot, trb, workspaceId, url, repo }) => {
      const t: string = theme;
      trb("config", "set", "default_engine", "fake");
      const write = (rel: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), text);
      };
      write(".specify/memory/constitution.md", "# Constitution\n\n### I. Tests first\n");
      write("specs/001-csv/spec.md", "# Feature Specification: CSV export\n\n**Input**: add csv export\n");
      write("specs/001-csv/tasks.md", "## Phase 1\n- [x] T001 a in src/a.ts\n- [ ] T002 b in src/b.ts\n");
      write("plans/2026-10-08-csv.md", '---\ntitle: "CSV export plan"\nstatus: approved\n---\n\n# CSV export plan\n\nStep one.\n');
      write("docs/architecture.md", "# Architecture\n\nThe daemon owns sessions.\n");

      // ---- one picker, three groups
      await fresh(page, workspaceId, url);
      await page.locator("[data-plus-menu]").click();
      await page.locator("[data-attach]").click();
      await page.waitForSelector("[data-attach-panel]");
      await page.waitForSelector('[data-attach-group="doc"]', { timeout: 10_000 });
      check(`${t}: the picker groups specs, plans and docs`, (await page.locator("[data-attach-group]").evaluateAll((els) => els.map((e) => e.getAttribute("data-attach-group")))).join(",") === "spec,plan,doc");
      check(`${t}: a plan shows its title and status`, (await page.locator('[data-attach-option="plans/2026-10-08-csv.md"]').locator("xpath=../..").innerText()).includes("CSV export plan"));
      await page.locator('[data-attach-option="specs/001-csv"]').click();
      await page.locator('[data-attach-option="plans/2026-10-08-csv.md"]').click();
      await page.locator('[data-attach-option="docs/architecture.md"]').click();
      await shot(`merge-${t}-picker`);
      await page.keyboard.press("Escape");
      await page.waitForSelector("[data-attach-chips]");
      check(`${t}: three chips, one per kind`, (await page.locator("[data-attach-chip]").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")).sort())).join(",") === "doc,plan,spec");
      await page.waitForFunction(() => [...document.querySelectorAll("[data-attach-chip]")].every((c) => c.textContent?.includes("~")), null, { timeout: 10_000 });
      check(`${t}: every chip shows its token cost`, true);
      check(`${t}: a plan chip reads by its title`, (await page.locator('[data-attach-chip="plans/2026-10-08-csv.md"]').innerText()).includes("CSV export plan"));
      await shot(`merge-${t}-chips`);

      // ---- sending carries all three, once
      await page.locator('textarea[aria-label="Message"]').fill("ECHO_PROMPT # Attached project files");
      await page.keyboard.press("Enter");
      let sid = "";
      check(`${t}: sending creates a session`, await until(async () => {
        const list = ((await api(page, "/api/sessions")) as any).sessions as any[];
        sid = list.find((s) => /ECHO_PROMPT/.test(`${s.brief ?? ""} ${s.title ?? ""}`))?.id ?? "";
        return !!sid;
      }));
      const att = (await api(page, `/api/sessions/${sid}/attachments`)) as any;
      check(`${t}: the session has all three attached`, att.attached.map((a: any) => a.kind).sort().join(",") === "doc,plan,spec", JSON.stringify(att.attached.map((a: any) => a.path)));
      check(`${t}: the cost covers all of them`, att.estimate.tokens > 0 && att.estimate.items.length === 3);
      check(`${t}: the first turn's prompt carries the one attachments block`, await until(async () => {
        const out = JSON.stringify(((await api(page, `/api/sessions/${sid}`)) as any).session?.output ?? "");
        return out.includes("prompt-has[# Attached project files]=yes");
      }, 20_000));

      // ---- detach through the chip goes to the unified route
      await page.waitForTimeout(600);
      await page.locator('[data-attach-chip="docs/architecture.md"] button[aria-label^="Detach"]').click();
      check(`${t}: detaching a chip removes it on the daemon`, await until(async () => (((await api(page, `/api/sessions/${sid}/attachments`)) as any).attached as any[]).length === 2));
      await shot(`merge-${t}-detached`);

      // ---- workspace folder settings
      await fresh(page, workspaceId, url, { tabs: [{ id: "settings:workspace", kind: "settings", page: "workspace", title: "Workspace" }], activeTab: "settings:workspace" });
      await page.waitForSelector("[data-pref]", { timeout: 15_000 });
      await page.waitForFunction(() => (document.querySelector('[data-pref-input="plans"]') as HTMLInputElement | null)?.value === "plans");
      check(`${t}: the page shows the three folders with their defaults`, (await page.locator("[data-pref]").count()) === 3 && (await page.locator('[data-pref-input="docs"]').inputValue()) === "docs" && (await page.locator('[data-pref-input="roadmap"]').inputValue()) === "ROADMAP.md");
      check(`${t}: Save is off until something changes`, await page.locator('[data-pref-save="plans"]').isDisabled());
      await page.locator('[data-pref-input="plans"]').fill("thinking");
      await page.locator('[data-pref-save="plans"]').click();
      check(`${t}: saving the plans folder reaches the daemon`, await until(async () => ((await api(page, `/api/workspaces/${workspaceId}/plans-dir`)) as any).dir === "thinking"));
      await page.locator('[data-pref-input="docs"]').fill("documentation");
      await page.locator('[data-pref-save="docs"]').click();
      check(`${t}: saving the docs folder reaches the daemon`, await until(async () => ((await api(page, `/api/docs/${workspaceId}?fast=1`)) as any).docs?.dir === "documentation"));
      await page.locator('[data-pref-input="roadmap"]').fill("PLAN.md");
      await page.locator('[data-pref-save="roadmap"]').click();
      check(`${t}: saving the roadmap file reaches the daemon`, await until(async () => ((await api(page, `/api/roadmap/${workspaceId}/choices`)) as any).path === "PLAN.md"));
      check(`${t}: a changed folder is marked custom`, await until(async () => (await page.locator("[data-pref] >> text=custom").count()) === 3));
      await shot(`merge-${t}-workspace`);
      await page.locator('[data-pref-reset="plans"]').click();
      check(`${t}: reset goes back to the default`, await until(async () => ((await api(page, `/api/workspaces/${workspaceId}/plans-dir`)) as any).dir === "plans"));
      await page.locator('[data-pref-input="docs"]').fill("../escape");
      await page.locator('[data-pref-save="docs"]').click();
      check(`${t}: a path that leaves the workspace is refused and the old value stays`, await until(async () => (await page.locator("[data-sonner-toast]").count()) >= 1, 6000) && ((await api(page, `/api/docs/${workspaceId}?fast=1`)) as any).docs?.dir === "documentation");
      await shot(`merge-${t}-refused`);
    },
    { theme },
  );
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
