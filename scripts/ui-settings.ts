/**
 * End-to-end check of the settings pages in real Chrome against a real daemon.
 *   TRB_WEB_DIR=/tmp/trb-dist-settings bun run scripts/ui-settings.ts
 * Screenshots: /tmp/trb-shots/settings-*.png
 */
import fs from "fs";
import path from "path";
import { withUi } from "./ui-harness";

const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok  ${msg}`);
};

await withUi(async ({ page, shot, url, workspaceId, repo }) => {
  const json = (p: string) => page.evaluate((u) => fetch(u).then((r) => r.json()), p);
  const go = async (pageName: string) => {
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: new RegExp(pageName, "i") }).click();
    await page.waitForTimeout(250);
  };

  await page.goto(`${url}/w/${workspaceId}`);
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.waitForTimeout(300);
  await shot("settings-0-sidebar");

  /* ------------------------------------------------------------ pairs */
  await go("Hydra pairs");
  await shot("settings-1-pairs-empty");
  await page.getByText("Claude leads Codex").first().click();
  await page.waitForTimeout(400);
  ok((await json("/api/pairs")).pairs.length === 1, "recipe creates a pair");
  await shot("settings-1-pairs-recipe");

  await page.getByRole("button", { name: "New pair" }).click();
  await page.getByPlaceholder("Opus leads Codex").fill("Fast and cheap");
  await page.getByRole("button", { name: "By role" }).click();
  // Switching to "by role" seeds a worker role from the heads config; add a reviewer from the library.
  await page.getByRole("button", { name: /Add role/ }).click();
  await page.getByRole("menuitem", { name: /Reviewer/ }).click();
  await page.waitForTimeout(250);
  await shot("settings-1-pair-editor-roles");
  await page.getByRole("button", { name: "Create pair" }).click();
  await page.waitForTimeout(500);
  const pairs = (await json("/api/pairs")).pairs;
  const mine = pairs.find((p: any) => p.title === "Fast and cheap");
  ok(mine && mine.mode === "roles" && Object.keys(mine.roles).sort().join() === "reviewer,worker", "roles pair saved with both roles");
  ok(mine.heads_engine === null, "a roles pair carries no heads config");
  await shot("settings-1-pairs-list");

  // Validation: a roles pair with no roles.
  await page.getByRole("button", { name: "New pair" }).click();
  await page.getByPlaceholder("Opus leads Codex").fill("Broken");
  await page.getByRole("button", { name: "By role" }).click();
  await page.getByRole("button", { name: "Remove role worker" }).click();
  await page.getByRole("button", { name: "Create pair" }).click();
  await page.waitForTimeout(200);
  ok(await page.getByText(/at least one role/i).isVisible(), "validation explains a roles pair needs a role");
  await shot("settings-1-pair-validation");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  // Edit then delete.
  await page.getByText("Fast and cheap").locator("xpath=ancestor::div[contains(@class,'group')][1]").hover();
  await page.getByRole("button", { name: "Edit" }).first().click();
  const title = page.locator('input[value="Fast and cheap"]');
  await title.fill("Fast and cheap v2");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(500);
  ok((await json("/api/pairs")).pairs.some((p: any) => p.title === "Fast and cheap v2"), "edit saves the new title");
  await page.getByText("Fast and cheap v2").locator("xpath=ancestor::div[contains(@class,'group')][1]").hover();
  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  await page.waitForTimeout(500);
  ok((await json("/api/pairs")).pairs.every((p: any) => p.title !== "Fast and cheap v2"), "delete removes the pair");

  /* -------------------------------------------------------------- mcp */
  await go("MCP servers");
  await shot("settings-2-mcp-empty");
  await page.getByRole("button", { name: "Add server" }).click();
  await page.getByText("Paste JSON").click();
  await page.getByRole("textbox", { name: "Paste a server definition" }).fill(JSON.stringify({ mcpServers: { shim: { command: "bun", args: ["run", MAIN, "mcp-serve"], env: { API_KEY: "secret-123" } }, broken: { command: "bash", args: ["-c", "echo 'cannot connect to db' >&2; exit 2"] } } }));
  await page.waitForTimeout(300);
  await shot("settings-2-mcp-paste");
  await page.getByRole("button", { name: /Add 2 servers/ }).click();
  await page.waitForTimeout(600);
  ok((await json("/api/mcp")).servers.length === 2, "paste adds both servers");
  await page.getByRole("button", { name: "Test shim" }).click();
  await page.waitForSelector("text=Connected", { timeout: 20000 });
  ok(await page.getByText("subagent_create").first().isVisible(), "test lists the server's tools");
  await page.getByRole("button", { name: "Test broken" }).click();
  await page.waitForSelector("text=exited with code 2", { timeout: 20000 });
  await shot("settings-2-mcp-tested");

  await page.getByText("Show environment").click();
  ok(!(await page.getByText("secret-123").isVisible().catch(() => false)), "secrets are masked by default");
  await page.getByRole("button", { name: "Reveal" }).first().click();
  ok(await page.getByText("secret-123").isVisible(), "reveal shows the value");

  await page.locator("div.group", { hasText: "shim" }).first().hover();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.waitForTimeout(250);
  await shot("settings-2-mcp-edit");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(250);
  await page.getByRole("switch", { name: "broken enabled" }).click();
  await page.waitForTimeout(300);
  ok((await json("/api/mcp")).servers.find((s: any) => s.name === "broken").enabled === false, "toggle disables a server");
  await page.locator("div.group", { hasText: "broken" }).first().hover();
  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.waitForTimeout(400);
  ok((await json("/api/mcp")).servers.length === 1, "delete removes a server");

  // Import from another file: preview first, then import.
  const mcpFile = path.join(repo, ".mcp.json");
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer abc" } }, shim: { command: "x" }, "bad name": { command: "x" } } }));
  await page.getByRole("button", { name: "Import" }).click();
  await page.getByRole("menuitem", { name: /another file/ }).click();
  await page.getByRole("textbox", { name: "File path" }).fill(mcpFile);
  await page.waitForSelector("text=skip: exists", { timeout: 10000 });
  await shot("settings-2-mcp-import");
  ok(await page.getByText("not a valid server").isVisible(), "import preview flags an invalid entry");
  await page.getByRole("button", { name: /^Import 1$/ }).click();
  await page.waitForTimeout(600);
  ok((await json("/api/mcp")).servers.some((s: any) => s.name === "docs" && s.transport === "http"), "import adds the new http server");
  ok((await json("/api/mcp")).servers.find((s: any) => s.name === "shim").command === "bun", "import leaves an existing server alone");

  /* ----------------------------------------------------------- skills */
  await go("Skills");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: /New skill/ }).click();
  await page.getByPlaceholder("deploy-checklist").fill("release-notes");
  await page.getByPlaceholder("Use when preparing a production release").fill("Use when writing release notes");
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(400);
  await shot("settings-3-skills");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+End");
  await page.keyboard.type("\n## Steps\n\n1. Group changes by area\n2. Write one line each\n");
  await page.waitForTimeout(200);
  ok(await page.getByText("unsaved").isVisible(), "an edit shows the unsaved marker");
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(600);
  const f = await json("/api/skills/release-notes/file");
  ok(f.content.includes("Group changes by area"), "Cmd-S in the editor writes SKILL.md");
  ok(!(await page.getByText("unsaved").isVisible().catch(() => false)), "the marker clears after saving");
  await page.getByText("Preview", { exact: true }).click();
  await page.waitForTimeout(300);
  await shot("settings-3-skills-preview");

  /* ----------------------------------------------------------- engines */
  await go("Engines");
  await page.waitForSelector("text=Checks", { timeout: 20000 });
  await page.waitForTimeout(300);
  await shot("settings-4-engines", { fullPage: false });
  await page.getByRole("button", { name: /Re-run checks/ }).click();
  await page.waitForTimeout(1500);
  ok(await page.getByText("trb MCP shim answers").isVisible(), "doctor reports the MCP shim");

  /* ------------------------------------------------------------ config */
  await go("Daemon settings");
  await page.waitForTimeout(300);
  await shot("settings-5-config");
  const depth = page.getByLabel("Nesting depth");
  await depth.fill("9");
  await depth.press("Enter");
  await page.waitForTimeout(300);
  ok(await page.getByText("At most 6.").isVisible(), "an out-of-range value is rejected inline");
  await depth.fill("3");
  await depth.press("Enter");
  await page.waitForTimeout(500);
  ok((await json("/api/config")).settings.find((s: any) => s.key === "max_depth").value === 3, "a valid value is saved");
  ok(await page.getByText("modified").first().isVisible(), "a changed setting is marked modified");
  await shot("settings-5-config-modified");
  await page.getByRole("button", { name: "Reset to default" }).first().click();
  await page.waitForTimeout(500);
  ok((await json("/api/config")).settings.find((s: any) => s.key === "max_depth").value === 2, "reset restores the default");

  /* ------------------------------------------------------------- light */
  await page.getByRole("button", { name: "Light theme" }).click();
  await page.waitForTimeout(300);
  for (const [name, label] of [["pairs", "Hydra pairs"], ["mcp", "MCP servers"], ["skills", "Skills"], ["engines", "Engines"], ["config", "Daemon settings"]] as const) {
    await go(label);
    await page.waitForTimeout(700);
    await shot(`settings-light-${name}`);
  }

  // Command palette entry works with no settings page open.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Add MCP");
  await page.waitForTimeout(250);
  ok(await page.getByText("Add MCP server…").isVisible(), "the palette offers Add MCP server…");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  ok(await page.getByRole("dialog").getByText("Add MCP server").isVisible(), "…and it opens the dialog");
}, { theme: "dark" });
console.log("settings UI checks passed");
