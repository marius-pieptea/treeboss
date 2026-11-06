import fs from "fs";
import path from "path";
import { withUi } from "./ui-harness";

let failures = 0;
const step = (s: string) => console.log(`\n== ${s}`);
const ok = (cond: unknown, what: string) => {
  if (!cond) {
    failures++;
    console.log(`  FAIL ${what}`);
  } else console.log(`  ok   ${what}`);
};

await withUi(async ({ page, shot, repo, url, workspaceId, trb }) => {
  page.setDefaultTimeout(8000);
  try {
  const MOD = "ControlOrMeta";
  const read = (rel: string) => fs.readFileSync(path.join(repo, rel), "utf-8");
  const row = (p: string) => page.locator(`[role="treeitem"][data-path="${p}"]`);
  const editorText = () => page.locator(".cm-content").innerText();
  const tabs = () => page.locator('[role="tablist"]').first().locator('[role="tab"]');

  await page.goto(`${url}/w/${workspaceId}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await page.waitForSelector('[role="treeitem"]');

  step("open a file (preview) then pin it");
  await row("src").click();
  await row("src/greet.ts").waitFor();
  await row("src/greet.ts").click();
  await page.waitForSelector(".cm-content");
  ok((await tabs().first().innerText()).includes("greet.ts"), "tab opened");
  ok(await page.locator('[role="tab"] span.italic').count(), "single click opens an italic preview tab");
  await row("src/greet.ts").dblclick();
  ok((await page.locator('[role="tab"] span.italic').count()) === 0, "double click pins it");
  await shot("files-3-editor-dark");

  step("edit, dirty indicator, save");
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\n// saved by the test");
  await page.waitForSelector("text=modified");
  ok(true, "'modified' badge shows");
  await page.keyboard.press(`${MOD}+s`);
  await page.waitForSelector("text=Saved");
  ok(read("src/greet.ts").includes("// saved by the test"), "file on disk has the edit");
  await page.waitForFunction(() => ![...document.querySelectorAll("span")].some((s) => s.textContent === "modified"));
  ok(true, "modified badge cleared after save");

  step("conflict: file changes on disk while the buffer is dirty");
  await page.keyboard.type("\n// my unsaved line");
  await page.waitForSelector("text=modified");
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(path.join(repo, "src/greet.ts"), "// rewritten by an agent\nexport const x = 1;\n");
  await page.keyboard.press(`${MOD}+s`);
  await page.waitForSelector('[role="alert"]');
  ok((await page.locator('[role="alert"]').innerText()).includes("changed on disk"), "conflict banner appears and the save is held back");
  ok(!read("src/greet.ts").includes("my unsaved line"), "disk untouched by the held-back save");
  await shot("files-4-conflict");
  await page.getByRole("button", { name: "Compare" }).click();
  await page.waitForSelector(".cm-mergeView");
  ok(true, "compare view opens");
  await page.waitForTimeout(500);
  await shot("files-5-compare");
  await page.getByRole("button", { name: "Close comparison" }).click();
  await page.getByRole("button", { name: "Overwrite" }).click();
  await page.waitForSelector("text=Saved");
  ok(read("src/greet.ts").includes("my unsaved line"), "overwrite writes my buffer");

  step("clean buffer follows an agent's edit on disk (via a real turn)");
  const before = await editorText();
  trb("run", "-e", "fake", "WRITE src/greet.ts // agent was here\nSAY done");
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("agent was here"), null, { timeout: 15000 });
  ok(before !== (await editorText()), "editor reloaded silently after the turn ended");
  ok((await page.locator("text=modified").count()) === 0, "and is not marked modified");

  step("unsaved edits survive tab switches and closing the tab");
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\n// keep me");
  await row("src/server.ts").dblclick();
  await page.waitForSelector("text=server.ts");
  await page.waitForTimeout(300);
  ok((await tabs().count()) === 2, "two tabs");
  await tabs().filter({ hasText: "greet.ts" }).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("keep me"));
  ok(true, "edit still there after switching back");
  ok((await page.locator("text=Restored your unsaved changes").count()) === 0, "a plain tab switch does not claim to have restored anything");
  await tabs().filter({ hasText: "greet.ts" }).getByRole("button", { name: /Close/ }).click();
  await page.waitForSelector("text=Discard changes to greet.ts?");
  ok(true, "closing a dirty tab asks first");
  await shot("files-4b-discard");
  await page.getByRole("button", { name: "Cancel" }).click();
  ok((await tabs().filter({ hasText: "greet.ts" }).count()) === 1, "Cancel keeps the tab");
  await tabs().filter({ hasText: "greet.ts" }).getByRole("button", { name: /Close/ }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.waitForTimeout(300);
  await row("src/greet.ts").dblclick();
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(300);
  ok(!(await editorText()).includes("keep me"), "discarding really drops the unsaved edit");

  step("explorer: create a file with a nested path");
  await page.getByRole("button", { name: "New file", exact: true }).first().click();
  await page.getByLabel("Name").fill("feature/thing.ts");
  await page.getByLabel("Name").press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-path="src/feature/thing.ts"]'));
  ok(fs.existsSync(path.join(repo, "src/feature/thing.ts")), "created on disk, folders included");
  ok((await tabs().filter({ hasText: "thing.ts" }).count()) === 1, "and opened in a tab");

  step("explorer: invalid names are refused with a reason");
  await page.getByRole("button", { name: "New file", exact: true }).first().click();
  await page.getByLabel("Name").fill("thing.ts");
  await page.waitForSelector("text=already exists");
  ok(true, "clash shown inline");
  await page.waitForTimeout(450);
  const border = await page.getByLabel("Name").evaluate((el) => getComputedStyle(el).borderTopColor);
  const red = await page.evaluate(() => { const d = document.createElement("div"); d.style.color = "var(--red)"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  ok(border === red, `an invalid name turns the box red (${border} vs ${red})`);
  await shot("files-6-invalid-name");
  await page.getByLabel("Name").press("Escape");

  step("explorer: rename keeps the open tab (F2)");
  await row("src/feature/thing.ts").click();
  await page.keyboard.press("F2");
  await page.getByLabel("Name").fill("renamed.ts");
  await page.getByLabel("Name").press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-path="src/feature/renamed.ts"]'));
  ok(fs.existsSync(path.join(repo, "src/feature/renamed.ts")) && !fs.existsSync(path.join(repo, "src/feature/thing.ts")), "renamed on disk");
  await page.waitForTimeout(300);
  ok((await tabs().filter({ hasText: "renamed.ts" }).count()) === 1 && (await tabs().filter({ hasText: "thing.ts" }).count()) === 0, "the tab followed the file");

  step("explorer: duplicate and delete (with confirmation)");
  await row("src/feature/renamed.ts").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await page.waitForFunction(() => document.querySelector('[data-path="src/feature/renamed copy.ts"]'));
  ok(fs.existsSync(path.join(repo, "src/feature/renamed copy.ts")), "duplicate exists");
  await row("src/feature/renamed copy.ts").click();
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-path="src/feature/renamed copy.ts"]'));
  ok(!fs.existsSync(path.join(repo, "src/feature/renamed copy.ts")), "deleted from disk");

  step("explorer: drag and drop moves a file into a folder");
  await row("styles").click();
  await row("src/utils").click();
  await page.waitForSelector('[data-path="src/utils/math.ts"]');
  await row("src/version.ts").dragTo(row("src/utils"));
  await page.waitForFunction(() => document.querySelector('[data-path="src/utils/version.ts"]'));
  ok(fs.existsSync(path.join(repo, "src/utils/version.ts")) && !fs.existsSync(path.join(repo, "src/version.ts")), "moved on disk");
  await shot("files-7-explorer-ops");

  step("search");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Search query").fill("greet");
  await page.waitForSelector('[role="treeitem"] mark');
  const resultText = await page.locator('[aria-label="Search results"]').innerText();
  ok(resultText.includes("greet") && /result/.test(await page.locator("text=/\\d+ results? in/").first().innerText()), "results with counts appear");
  await shot("files-8-search");
  await page.locator('[aria-label="Search results"] [role="treeitem"][data-row="1"]').click();
  await page.waitForSelector(".cm-content");
  ok(true, "clicking a match opens the file");
  await page.waitForTimeout(500);
  ok(await page.evaluate(() => !document.querySelector(".cm-editor")?.contains(document.activeElement)), "a click on a result leaves focus in the results");
  await page.getByLabel("Files to include").fill("styles/**");
  await page.waitForFunction(() => /No results/.test(document.body.innerText));
  ok(true, "include glob narrows the results");
  await page.getByLabel("Files to include").fill("");
  await page.getByLabel("Search query").fill("(");
  await page.getByRole("button", { name: "Use regular expression" }).click();
  await page.waitForSelector("text=/Unterminated|Invalid|unmatched/i");
  ok(true, "bad regex is reported");
  await page.getByRole("button", { name: "Use regular expression" }).click();

  step("go to line via search result, then keyboard nav");
  await page.getByLabel("Search query").fill("trimmed");
  await page.waitForSelector('[role="treeitem"] mark');
  await page.getByLabel("Search query").press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  ok(/Ln \d+/.test(await page.locator("text=/Ln \\d+, Col \\d+/").innerText()), "status strip shows the cursor");

  step("quick open (Cmd-P) with :line");
  await page.keyboard.press(`${MOD}+p`);
  await page.getByPlaceholder(/Go to file/).fill("mat:2");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  ok((await page.locator("text=/Ln 2, Col/").count()) === 1, "opened math.ts at line 2");

  step("markdown preview");
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await row("README.md").dblclick();
  await page.getByRole("button", { name: "Preview" }).click();
  await page.waitForSelector(".markdown h1");
  ok((await page.locator(".markdown h1").innerText()) === "demo-app", "markdown renders");
  await shot("files-9-markdown");
  await page.getByRole("button", { name: "Source", exact: true }).click();

  step("images, binary, too large");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(repo, "pixel.png"), png);
  fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
  fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(2 * 1024 * 1024 + 10));
  await page.getByRole("button", { name: "Refresh" }).click();
  await row("pixel.png").dblclick();
  await page.waitForSelector("img[alt='pixel.png']");
  ok(true, "image preview");
  await row("blob.bin").dblclick();
  await page.waitForSelector("text=This is a binary file.");
  ok(true, "binary card");
  await row("big.txt").dblclick();
  await page.waitForSelector("text=larger than the 2 MB");
  ok(true, "too-large card");
  await shot("files-10-binary-card");

  step("external change while dirty -> banner, not a silent overwrite");
  await row("src/greet.ts").dblclick();
  await page.waitForSelector(".cm-content");
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\n// dirty edit");
  await page.waitForTimeout(1700); // past the query's staleTime, so a refocus refetches
  fs.writeFileSync(path.join(repo, "src/greet.ts"), "// somebody else\n");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await page.waitForSelector("text=changed on disk while you have unsaved edits");
  ok(true, "banner offered, buffer untouched");
  ok((await editorText()).includes("dirty edit"), "my edit is still in the editor");
  await page.getByRole("button", { name: "Keep mine" }).click();
  await page.keyboard.press(`${MOD}+s`);
  await page.waitForSelector("text=Saved");
  ok(read("src/greet.ts").includes("dirty edit"), "after Keep mine, save goes through without a conflict");

  step("file deleted on disk while open");
  await page.waitForTimeout(1700);
  fs.rmSync(path.join(repo, "src/greet.ts"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await page.waitForSelector("text=was deleted on disk");
  ok(true, "deleted banner");
  await page.keyboard.type(" // back");
  await page.keyboard.press(`${MOD}+s`);
  await page.waitForFunction(() => !document.body.innerText.includes("was deleted on disk"));
  ok(fs.existsSync(path.join(repo, "src/greet.ts")), "saving recreates it");

  step("palette: Save all and Revert file");
  await row("src/server.ts").dblclick();
  await page.waitForSelector(".cm-content");
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\n// server edit");
  await tabs().filter({ hasText: "greet.ts" }).first().click({ force: true });
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\n// greet edit 2");
  await page.keyboard.press(`${MOD}+k`);
  await page.getByPlaceholder("Type a command…").fill("save all");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  ok(read("src/server.ts").includes("server edit") && read("src/greet.ts").includes("greet edit 2"), "Save all wrote both files (one of them not on screen)");
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\n// to be reverted");
  await page.keyboard.press(`${MOD}+k`);
  await page.getByPlaceholder("Type a command…").fill("revert file");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".cm-content")?.textContent?.includes("to be reverted"));
  ok(true, "Revert file asks, then reloads from disk");

  step("explorer: keyboard navigation and Search in folder");
  await row("src").click();
  await page.keyboard.press("ArrowDown");
  const selectedAfter = await page.locator('[role="treeitem"][aria-selected="true"]').getAttribute("data-path");
  ok(!!selectedAfter && selectedAfter !== "src", `ArrowDown moved the selection to ${selectedAfter}`);
  await row("src").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Search in folder" }).click();
  await page.waitForSelector('[aria-label="Search query"]');
  ok((await page.getByLabel("Files to include").inputValue()) === "src/**", "Search in folder pre-fills the include glob");
  await page.getByRole("button", { name: "Explorer", exact: true }).click();

  step("a big tree stays cheap (12,000 files)");
  const bulk = path.join(repo, "bulk");
  fs.mkdirSync(bulk);
  for (let i = 0; i < 12000; i++) fs.writeFileSync(path.join(bulk, `file-${String(i).padStart(5, "0")}.txt`), "x");
  await page.getByRole("button", { name: "Refresh" }).click();
  await row("bulk").waitFor();
  const t0 = Date.now();
  await row("bulk").click();
  await row("bulk/file-00000.txt").waitFor();
  ok(Date.now() - t0 < 4000, `expanded a 12k-entry folder in ${Date.now() - t0}ms`);
  const rendered = await page.locator('[role="treeitem"]').count();
  ok(rendered < 80, `only ${rendered} rows in the DOM`);
  await page.locator('[role="tree"][aria-label="Files"]').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForSelector("text=Showing the first 5,000 entries");
  ok(true, "scrolling to the end of the (capped) listing renders its last rows and the notice");
  await page.waitForTimeout(200);
  await shot("files-10b-big-tree");
  fs.rmSync(bulk, { recursive: true });
  await page.getByRole("button", { name: "Refresh" }).click();

  step("light theme");
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("trb.ui.v1") ?? "{}");
    raw.state = { ...(raw.state ?? {}), theme: "light" };
    localStorage.setItem("trb.ui.v1", JSON.stringify(raw));
    localStorage.setItem("trb.theme", "light");
  });
  await page.reload();
  await page.waitForSelector(".cm-content, [role=tree]");
  await tabs().filter({ hasText: "math.ts" }).first().click();
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(600);
  ok(!(await page.evaluate(() => document.documentElement.classList.contains("dark"))), "light theme applied");
  await shot("files-11-light");

  step("files commands are in the palette");
  await page.keyboard.press(`${MOD}+k`);
  await page.getByPlaceholder("Type a command…").fill("new file");
  ok(await page.getByText("New file…").count(), "New file…");
  await page.getByPlaceholder("Type a command…").fill("find in files");
  ok(await page.getByText("Find in files").count(), "Find in files");
  await page.keyboard.press("Escape");

  } catch (e) {
    await shot("files-fail");
    throw e;
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
});
process.exit(failures ? 1 : 0);
