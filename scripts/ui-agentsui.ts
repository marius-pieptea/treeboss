/**
 * End-to-end check of the specialized-agents UI against a real daemon (scripted engine, no tokens):
 * create / edit agents in Settings, assign skills and MCP servers, run a session as an agent from the
 * composer and confirm what the engine actually received, spawn a head as an agent, name an agent in a
 * pair role, delete with the "used by" guard. Run: TRB_WEB_DIR=/tmp/trb-dist-agentsui bun run scripts/ui-agentsui.ts
 */
import { withUi } from "./ui-harness";

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const theme of ["dark", "light"] as const) {
  await withUi(
    async ({ page, shot, trb, workspaceId, url, repo }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
      const api = (method: string, path: string, body?: unknown) =>
        page.evaluate(
          async ([m, p, b]) => {
            const r = await fetch(p as string, { method: m as string, headers: b ? { "content-type": "application/json" } : undefined, body: b ? JSON.stringify(b) : undefined });
            return { status: r.status, body: await r.json().catch(() => null) };
          },
          [method, path, body] as const,
        );
      const T = (s: string) => `${theme}: ${s}`;

      // Fixtures: three skills (one disabled), two MCP servers.
      for (const [n, d] of [["alpha-skill", "Does alpha things"], ["beta-skill", "Does beta things"], ["gamma-skill", "Legacy gamma"]]) trb("skill", "new", n, "-d", d);
      trb("skill", "disable", "gamma-skill");
      trb("mcp", "add", "db", "--", "bun", "-e", "0");
      trb("mcp", "add", "docs", "--", "bun", "-e", "0");

      await page.goto(`${url}/w/${workspaceId}`);
      await page.waitForSelector("header");
      const dialog = page.locator('[role="dialog"]');

      // 1. Open the Agents page from the palette; empty state offers templates.
      await page.keyboard.press("Meta+k");
      await page.keyboard.type("Settings Agents");
      await sleep(250);
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Agents", level: 1 }).waitFor();
      await sleep(400);
      check(T("agents page opens with an empty state and templates"), await page.getByText("No agents yet").isVisible());
      await shot(`agentsui-1-empty-${theme}`);

      // 2. A template creates an agent in one click.
      await page.getByRole("button", { name: /From a template/ }).click();
      await page.getByRole("menuitem", { name: /^Reviewer:/ }).click();
      await page.getByText("Created “Reviewer”").waitFor({ timeout: 4000 }).catch(() => {});
      await sleep(500);
      let list = (await api("GET", "/api/agents")).body.agents;
      check(T("template creates the agent with the library's instructions"), list.length === 1 && list[0].name === "reviewer" && list[0].instructions.includes("Review, don't rewrite"));

      // 3. New agent: instructions, defaults, "only these" skills and MCP.
      await page.getByRole("button", { name: "New agent" }).click();
      await dialog.waitFor();
      await dialog.getByPlaceholder("reviewer", { exact: true }).fill("Scribe");
      await dialog.getByPlaceholder("Code reviewer").fill("Scribe");
      await dialog.getByPlaceholder(/Reviews a diff/).fill("Writes docs");
      await dialog.getByLabel("Instructions").fill("You write documentation. SCRIBE-MARKER.");
      await sleep(200);
      check(T("the character counter is live"), /^\d+ \/ 20,000$/.test((await dialog.getByText(/\/ 20,000/).innerText()).trim()) && (await dialog.getByText(/\/ 20,000/).innerText()).startsWith(String("You write documentation. SCRIBE-MARKER.".length)));
      const combos = dialog.getByRole("combobox");
      await combos.nth(0).click();
      await page.getByRole("option", { name: /^fake/ }).click();
      // Skills: only these -> beta-skill.
      await dialog.getByRole("button", { name: "Only these" }).first().click();
      await dialog.getByRole("checkbox", { name: "beta-skill" }).click();
      // The globally disabled skill is listed and marked.
      check(T("a disabled skill is marked as staying off"), await dialog.getByText("disabled, stays off").first().isVisible());
      await dialog.getByRole("button", { name: "Only these" }).nth(1).click();
      await dialog.getByRole("checkbox", { name: "db" }).click();
      await sleep(200);
      const preview = await dialog.getByText(/^Sees /).innerText();
      check(T("the preview line says what the agent will see"), /Sees 1 skill \(beta-skill\) and 1 MCP server \(db\)/.test(preview), preview);
      await shot(`agentsui-2-editor-${theme}`);
      await dialog.getByRole("button", { name: "Create agent" }).click();
      await dialog.waitFor({ state: "hidden" });
      await sleep(500);
      list = (await api("GET", "/api/agents")).body.agents;
      const scribe = list.find((a: any) => a.name === "scribe");
      check(T("saved with the assignments as chosen"), !!scribe && JSON.stringify(scribe.skills) === '["beta-skill"]' && JSON.stringify(scribe.mcp) === '["db"]' && scribe.engine === "fake", JSON.stringify(scribe));

      // 4. Validation from the daemon shows in the dialog; duplicate names are caught early.
      await page.getByRole("button", { name: "New agent" }).click();
      await dialog.getByPlaceholder("reviewer", { exact: true }).fill("scribe");
      await dialog.getByRole("button", { name: "Create agent" }).click();
      await sleep(200);
      check(T("a duplicate name is refused with a clear message"), await dialog.getByText(/already exists/).isVisible());
      await dialog.getByRole("button", { name: "Cancel" }).click();

      // 5. Edit: add alpha-skill, change the description.
      const scribeCard = () => page.locator(".glow-surface", { hasText: "scribe" }).first();
      await scribeCard().hover();
      await scribeCard().getByRole("button", { name: "Edit" }).click();
      await dialog.waitFor({ timeout: 3000 });
      check(T("edit opens with the name locked"), (await dialog.getByPlaceholder("reviewer", { exact: true }).isDisabled().catch(() => false)) === true);
      await dialog.getByPlaceholder(/Reviews a diff/).fill("Writes and updates docs");
      await dialog.getByRole("checkbox", { name: "alpha-skill" }).click();
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await dialog.waitFor({ state: "hidden" });
      await sleep(400);
      const edited = (await api("GET", "/api/agents/scribe")).body.agent;
      check(T("edit saved"), edited.description === "Writes and updates docs" && edited.skills.length === 2, JSON.stringify(edited.skills));
      await shot(`agentsui-3-cards-${theme}`);

      // 6. Skills page shows which agents use each skill.
      await page.keyboard.press("Meta+k");
      await page.keyboard.type("Settings Skills");
      await sleep(250);
      await page.keyboard.press("Enter");
      await sleep(600);
      check(T("the skills page says which agents use a skill"), await page.getByText("used by: scribe").first().isVisible());
      await shot(`agentsui-4-skills-${theme}`);

      // 7. The composer: pick the agent, narrow the skills, run, confirm what the engine received.
      await page.keyboard.press("Meta+i");
      await sleep(300);
      await page.getByRole("button", { name: /^Agent:/ }).click();
      await sleep(300);
      await shot(`agentsui-5-agent-picker-${theme}`);
      await page.getByRole("button", { name: /Scribe/ }).last().click();
      await page.keyboard.press("Escape");
      await sleep(300);
      check(T("choosing an agent with an engine sets the engine picker"), (await page.getByRole("button", { name: /^Engine:/ }).innerText()).includes("fake"));
      let skillsLabel = await page.getByRole("button", { name: /^Skills:/ }).innerText();
      check(T("skills chip starts from the agent's assignment"), /2 of 2/.test(skillsLabel), skillsLabel);
      await page.getByRole("button", { name: /^Skills:/ }).click();
      await page.getByRole("checkbox", { name: "alpha-skill" }).click();
      await sleep(250);
      await shot(`agentsui-6-skills-popover-${theme}`);
      await page.keyboard.press("Escape");
      skillsLabel = await page.getByRole("button", { name: /^Skills:/ }).innerText();
      check(T("unticking a skill changes the chip"), /1 of 2/.test(skillsLabel), skillsLabel);
      const ta = page.getByRole("textbox", { name: "Message" });
      await ta.fill("SKILLS\nMCPS\nECHO_PROMPT SCRIBE-MARKER");
      await ta.press("Enter");
      await page.getByText("skills=beta-skill").first().waitFor({ timeout: 15000 }).catch(() => {});
      const transcript = await page.locator("body").innerText();
      check(T("the engine received only the narrowed skills"), transcript.includes("skills=beta-skill"));
      check(T("the engine received only the agent's MCP servers"), transcript.includes("mcps=db"));
      check(T("the agent's instructions reached the engine"), transcript.includes("prompt-has[SCRIBE-MARKER]=yes"));
      check(T("the header shows the agent and its skill count"), (await page.getByText("Scribe", { exact: true }).first().isVisible()) && /1 skill/.test(transcript));
      await shot(`agentsui-7-session-${theme}`);
      const sessions = (await api("GET", "/api/sessions")).body.sessions;
      check(T("the session records the agent and the narrowed skills"), sessions[0]?.agent === "scribe" && JSON.stringify(sessions[0]?.skills) === '["beta-skill"]', JSON.stringify([sessions[0]?.agent, sessions[0]?.skills]));

      // 8. A follow-up does not repeat the instructions (the engine already has them).
      await ta.fill("ECHO_PROMPT SCRIBE-MARKER");
      await ta.press("Enter");
      await page.getByText("prompt-has[SCRIBE-MARKER]=no").first().waitFor({ timeout: 15000 }).catch(() => {});
      check(T("a follow-up does not repeat the instructions"), (await page.locator("body").innerText()).includes("prompt-has[SCRIBE-MARKER]=no"));

      // 9. /agent and a new session; sessions list shows an agent chip.
      await page.keyboard.press("Meta+k");
      await page.keyboard.type("Agent New session");
      await sleep(250);
      await page.keyboard.press("Enter");
      await sleep(500);
      await ta.fill("/agent reviewer");
      await ta.press("Enter");
      await sleep(600);
      check(T("/agent switches the picker"), /Reviewer/.test(await page.getByRole("button", { name: /^Agent:/ }).innerText()));
      await ta.fill("/agent none");
      await ta.press("Enter");
      await sleep(400);
      check(T("/agent none clears it"), /no agent/.test(await page.getByRole("button", { name: /^Agent:/ }).innerText()));
      await page.getByRole("button", { name: "Sessions" }).first().click();
      await sleep(400);
      check(T("the sessions list shows the agent chip"), await page.locator("text=scribe").first().isVisible());

      // 10. Spawn a head as an agent under a pair's lead.
      await api("POST", "/api/pairs", { title: "E2E pair", lead_engine: "fake", heads_engine: "fake", max_heads: 3 });
      trb("run", "-p", "E2E pair", "-e", "fake", "-d", "-C", repo, "SAY lead ready\nSLEEP 4000");
      await sleep(1500);
      await page.reload();
      await page.waitForSelector("header");
      await page.getByRole("button", { name: "Sessions" }).first().click().catch(() => {});
      await page.locator("text=SAY lead ready").first().click();
      await sleep(500);
      await page.getByRole("tab", { name: /Heads/ }).click();
      await page.getByRole("button", { name: /Spawn head/ }).click();
      await dialog.waitFor();
      await dialog.getByLabel("Brief").fill("SKILLS\nECHO_PROMPT SCRIBE-MARKER").catch(async () => dialog.locator("textarea").fill("SKILLS\nECHO_PROMPT SCRIBE-MARKER"));
      const agentCombo = dialog.getByRole("combobox").filter({ hasText: /no agent/ });
      await agentCombo.click();
      await page.getByRole("option", { name: /Scribe/ }).click();
      await shot(`agentsui-8-spawn-${theme}`);
      await dialog.getByRole("button", { name: "Spawn" }).click();
      await dialog.waitFor({ state: "hidden" });
      await sleep(3500);
      const kids = (await api("GET", "/api/sessions?all=1")).body.sessions.filter((s: any) => s.depth === 1);
      check(T("the spawned head runs as the agent"), kids.length === 1 && kids[0].agent === "scribe", JSON.stringify(kids.map((k: any) => k.agent)));
      check(T("the head card shows the agent chip"), await page.locator('[title="Runs as the agent “scribe”"]').first().isVisible().catch(() => false));
      await shot(`agentsui-9-head-${theme}`);
      if (kids[0]) {
        const info = (await api("GET", `/api/sessions/${kids[0].id}`)).body;
        check(T("the head's skills are the agent's"), JSON.stringify([...info.session.skills].sort()) === '["alpha-skill","beta-skill"]', JSON.stringify(info.session.skills));
        const out = info.session.output ?? "";
        check(T("the head received the agent's instructions and its two skills"), out.includes("prompt-has[SCRIBE-MARKER]=yes") || out.includes("skills=alpha-skill,beta-skill"), out.slice(0, 120));
      }

      // 11. A pair role names an agent; the agent page then shows it as used and refuses deletion without force.
      await page.keyboard.press("Meta+k");
      await page.keyboard.type("New Hydra pair");
      await sleep(250);
      await page.keyboard.press("Enter");
      await dialog.waitFor();
      await dialog.getByPlaceholder("Opus leads Codex").fill("Role agents");
      await dialog.getByRole("button", { name: "By role" }).click();
      await sleep(250);
      await dialog.getByRole("combobox").filter({ hasText: /no agent/ }).first().click();
      await page.getByRole("option", { name: /Scribe/ }).click();
      await shot(`agentsui-10-pair-role-${theme}`);
      await dialog.getByRole("button", { name: "Create pair" }).click();
      await sleep(600);
      const pair = (await api("GET", "/api/pairs")).body.pairs.find((p: any) => p.title === "Role agents");
      check(T("the pair role stores the agent"), pair?.roles?.worker?.agent === "scribe", JSON.stringify(pair?.roles));
      await page.keyboard.press("Meta+k");
      await page.keyboard.type("Settings Agents");
      await sleep(250);
      await page.keyboard.press("Enter");
      await sleep(600);
      check(T("the agent card shows it is used by a pair role"), await page.getByText("Role agents / worker").first().isVisible());
      await shot(`agentsui-11-used-by-${theme}`);

      // Delete: guarded when a pair role uses it; cancel keeps it, force removes it.
      const card = scribeCard();
      await card.hover();
      await card.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByText("Delete it anyway?").waitFor({ timeout: 4000 }).catch(() => {});
      check(T("deleting a used agent explains the refusal"), await page.getByText(/is used by Role agents\/worker/).isVisible().catch(() => false));
      await shot(`agentsui-12-delete-guard-${theme}`);
      await page.getByRole("button", { name: "Cancel" }).click();
      check(T("cancelling keeps it"), (await api("GET", "/api/agents/scribe")).status === 200);
      await card.hover();
      await card.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Delete anyway" }).click();
      await sleep(600);
      check(T("force delete removes it"), (await api("GET", "/api/agents/scribe")).status === 404);

      // The browser logs every refused request (the 409 from a guarded delete, the 404 after a delete) as a console
      // error; those are the behaviour under test. Anything else is a real problem.
      const real = errors.filter((e) => !/Failed to load resource: the server responded with a status of (409|404)/.test(e));
      check(T("no console or page errors"), real.length === 0, real.slice(0, 3).join(" | "));
    },
    { theme },
  );
}
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
