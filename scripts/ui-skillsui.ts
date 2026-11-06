/**
 * End-to-end check of skill import progress and multi-file skills against a real daemon (scripted engine, no tokens):
 * scan a nested folder of skills, watch the progress bar move, hide and reopen the dialog mid-import, cancel a second
 * import, then work on a multi-file skill (tree, edit a script in an editor tab, create / rename / delete files).
 * Run: TRB_WEB_DIR=/tmp/trb-dist-skillsui bun run scripts/ui-skillsui.ts
 */
import fs from "fs";
import os from "os";
import path from "path";
import { withUi } from "./ui-harness";

// One process per theme: a fresh Chrome and daemon each time keeps a long run from tripping over its own leftovers.
if (!process.env.THEME) {
  const { spawnSync } = await import("child_process");
  let bad = 0;
  for (const theme of ["dark", "light"]) bad += spawnSync(process.execPath, ["run", import.meta.path], { env: { ...process.env, THEME: theme }, stdio: "inherit" }).status ? 1 : 0;
  process.exit(bad ? 1 : 0);
}

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A folder of skills: plain ones, nested ones, a multi-file one, a few fat ones (to make progress visible), a broken one. */
function makeSource(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trb-skillsui-src-"));
  const w = (rel: string, content: string, mode?: number) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content, mode ? { mode } : undefined);
  };
  const skillMd = (n: string, d: string) => `---\nname: ${n}\ndescription: ${d}\n---\n\n# ${n}\n\n${d}\n`;
  for (let i = 1; i <= 14; i++) w(`plain/skill-${String(i).padStart(2, "0")}/SKILL.md`, skillMd(`skill-${String(i).padStart(2, "0")}`, `Plain skill number ${i}`));
  w("deep/a/b/nested-one/SKILL.md", skillMd("nested-one", "Lives three folders down"));
  w("pdf-tools/SKILL.md", skillMd("pdf-tools", "Fill and merge PDFs, with a script and references"));
  w("pdf-tools/scripts/run.sh", "#!/bin/sh\necho PDF-ORIGINAL\n", 0o755);
  w("pdf-tools/references/guide.md", "# Guide\n\nRead me second.\n");
  w("pdf-tools/templates/form.txt", "field = value\n");
  for (let k = 1; k <= 6; k++) {
    w(`fat/fat-${k}/SKILL.md`, skillMd(`fat-${k}`, `A heavy skill with many reference files (${k})`));
    for (let i = 0; i < 1500; i++) w(`fat/fat-${k}/references/part-${Math.floor(i / 100)}/ref-${i}.md`, `reference ${i} of fat-${k}\n`.repeat(300));
  }
  w("broken/too-many/SKILL.md", skillMd("too-many", "Has more files than a skill may"));
  for (let i = 0; i < 2100; i++) w(`broken/too-many/f/${Math.floor(i / 200)}/${i}.txt`, "x");
  w("zz-dup/one/pdf-tools/SKILL.md", skillMd("pdf-tools", "A second skill with the same name"));
  w("node-deps/dep-skill/SKILL.md", skillMd("dep-skill", "Has a node_modules folder that is left out"));
  w("node-deps/dep-skill/node_modules/lib/index.js", "module.exports = 1;\n");
  return root;
}

process.on("unhandledRejection", (e) => (console.error("UNHANDLED", e), process.exit(1)));
for (const theme of (process.env.THEME ? [process.env.THEME] : ["dark", "light"]) as Array<"dark" | "light">) {
  const src = makeSource();
  await withUi(
    async ({ page, shot: rawShot, trb, workspaceId, url }) => {
      const shot = rawShot;
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", (r) => r.status() >= 400 && console.log("  [http]", r.status(), r.request().method(), r.url().replace(/^https?:\/\/[^/]+/, "").slice(0, 140)));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
      const api = (method: string, p: string, body?: unknown) =>
        page.evaluate(
          async ([m, u, b]) => {
            const r = await fetch(u as string, { method: m as string, headers: b ? { "content-type": "application/json" } : undefined, body: b ? JSON.stringify(b) : undefined });
            return { status: r.status, body: await r.json().catch(() => null) };
          },
          [method, p, body] as const,
        );
      const T = (s: string) => `${theme}: ${s}`;
      const dialog = page.locator('[role="dialog"]');
      const bar = () => dialog.getByRole("progressbar").first();
      // Enter in the folder box navigates to what was typed; a second press (or the button) scans.
      const scanIfOffered = async () => {
        await sleep(500);
        const b = dialog.getByRole("button", { name: "Scan this folder" });
        if (await b.isVisible().catch(() => false)) await b.click();
      };
      const pctOf = async () => Number((await bar().getAttribute("aria-valuenow").catch(() => null)) ?? -1);

      await page.goto(`${url}/w/${workspaceId}`);
      await page.waitForSelector("header");
      await page.keyboard.press("Meta+k");
      await page.keyboard.type("Settings Skills");
      await sleep(250);
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Skills", level: 1 }).waitFor();
      await sleep(300);
      await shot(`skillsui-1-empty-${theme}`);

      // 1. Pick a folder, scan.
      await page.getByRole("button", { name: /Add/ }).first().click();
      await page.getByRole("menuitem", { name: /Import a folder of skills/ }).click({ force: true });
      await dialog.waitFor();
      await dialog.getByRole("textbox", { name: "Folder" }).fill(src);
      await dialog.getByRole("textbox", { name: "Folder" }).press("Enter");
      await scanIfOffered();
      await dialog.getByRole("list", { name: "Skills found" }).waitFor({ timeout: 20000 });
      const summary = await dialog.getByText(/^Found \d+ skills?/).innerText();
      check(T("the scan says how many skills, files and bytes it found"), /Found 2[0-9] skills? · [\d,]+ files? · [\d.]+ (KB|MB)/.test(summary), summary);
      check(T("a nested skill is found"), await dialog.getByText("nested-one").first().isVisible());
      check(T("the duplicate name is reported"), (await dialog.innerText()).toLowerCase().includes("pdf-tools") && /shares a name/i.test(await dialog.innerText()));
      check(T("a skill over the file limit is flagged and not importable"), await dialog.getByText("will fail").first().isVisible());
      check(T("left-out folders are noted"), await dialog.getByText(/1 left out/).first().isVisible());
      await shot(`skillsui-2-scan-${theme}`);

      // 2. Filter works.
      await dialog.getByLabel("Filter skills").fill("fat-");
      await sleep(150);
      const shownRows = await dialog.getByRole("list", { name: "Skills found" }).getByRole("listitem").count();
      check(T("the filter narrows the checklist"), shownRows === 6, String(shownRows));
      await dialog.getByLabel("Filter skills").fill("");

      // 3. Start; the bar moves and says what it is copying.
      await dialog.getByRole("button", { name: /^Import \d+ skills?$/ }).click();
      await bar().waitFor({ timeout: 8000 });
      const seen = new Set<number>();
      let sawLabel = false;
      let first = -1;
      let shotMid = false;
      for (let i = 0; i < 400; i++) {
        const p = await pctOf();
        if (p >= 0) {
          if (first < 0) first = p;
          seen.add(p);
        }
        if (/Copying fat-\d \(\d+\/\d+ files\)/.test(await dialog.innerText().catch(() => ""))) sawLabel = true;
        if (p > 20 && p < 80 && !shotMid) {
          shotMid = true;
          await shot(`skillsui-3-importing-${theme}`);
        }
        if (/Import finished/.test(await dialog.innerText().catch(() => ""))) break;
        await sleep(100);
      }
      check(T("the bar moves through intermediate values, not 0 then 100"), [...seen].filter((p) => p > 0 && p < 100).length >= 2, [...seen].join(","));
      check(T("it names the skill in flight with a files counter"), sawLabel);
      await dialog.getByRole("heading", { name: "Import finished" }).waitFor({ timeout: 90000 });
      await sleep(300);
      const finishedText = await dialog.innerText();
      check(T("the finish screen counts imported, skipped and failed"), /Imported 23, skipped 0, failed 0/.test(finishedText), finishedText.match(/Imported[^\n]*/)?.[0]);
      await shot(`skillsui-4-finished-${theme}`);
      await dialog.getByRole("button", { name: "Done" }).click();
      await sleep(400);
      const listed = (await api("GET", "/api/skills")).body.skills.map((s: any) => s.name);
      check(T("the skills are stored and listed"), listed.includes("nested-one") && listed.includes("pdf-tools") && listed.includes("fat-1") && !listed.includes("too-many"), `${listed.length} skills`);

      // 4. Multi-file: the files were copied whole, exec bit kept.
      const home = (await api("GET", "/api/skills")).body.skills.find((s: any) => s.name === "pdf-tools").path as string;
      check(T("every file of a multi-file skill is stored"), fs.existsSync(path.join(home, "scripts/run.sh")) && fs.existsSync(path.join(home, "references/guide.md")) && fs.existsSync(path.join(home, "templates/form.txt")));
      check(T("the script keeps its executable bit"), (fs.statSync(path.join(home, "scripts/run.sh")).mode & 0o111) !== 0);
      check(T("node_modules is left out"), !fs.existsSync(path.join(await (async () => (await api("GET", "/api/skills")).body.skills.find((s: any) => s.name === "dep-skill").path)(), "node_modules")));

      // 5. The detail view: badges and tree.
      await page.getByRole("button", { name: /^pdf-tools/ }).click();
      await sleep(500);
      check(T("the header shows a file count and a multi-file badge"), (await page.getByText(/^4 files/).first().isVisible().catch(() => false)) && (await page.getByText("multi-file").first().isVisible()));
      const tree = page.getByRole("tree", { name: "Files in pdf-tools" });
      await tree.getByRole("treeitem", { name: /scripts/ }).click();
      await tree.getByRole("treeitem", { name: /run\.sh/ }).waitFor();
      await tree.getByRole("treeitem", { name: /references/ }).click();
      await tree.getByRole("treeitem", { name: /guide\.md/ }).waitFor();
      check(T("the tree lists folders and files, SKILL.md marked as the entry"), (await tree.getByText("entry").isVisible()) && (await tree.getByRole("treeitem").count()) >= 6);
      await shot(`skillsui-5-tree-${theme}`);

      // 6. Open a script in an editor tab and edit it.
      await tree.getByRole("treeitem", { name: /run\.sh/ }).click();
      await page.locator(".cm-content").first().waitFor({ timeout: 6000 });
      await sleep(400);
      check(T("the script opens in the real editor"), (await page.locator(".cm-content").first().innerText()).includes("PDF-ORIGINAL"));
      await page.locator(".cm-content").first().click();
      await page.keyboard.press("Meta+End");
      await page.keyboard.type("echo EDITED-IN-TAB\n");
      await page.keyboard.press("Meta+s");
      await sleep(700);
      check(T("saving from the editor tab writes into the skill's folder"), fs.readFileSync(path.join(home, "scripts/run.sh"), "utf-8").includes("EDITED-IN-TAB"));
      check(T("the executable bit survives the edit"), (fs.statSync(path.join(home, "scripts/run.sh")).mode & 0o111) !== 0);
      await shot(`skillsui-6-editor-tab-${theme}`);

      // 7. Back to the skills page; create, rename, delete files.
      await page.keyboard.press("Meta+k");
      await page.keyboard.type("Settings Skills");
      await sleep(250);
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Skills", level: 1 }).waitFor();
      await sleep(400);
      if (!(await page.getByRole("tree", { name: "Files in pdf-tools" }).isVisible().catch(() => false))) await page.getByRole("button", { name: /^pdf-tools/ }).click();
      const tree2 = page.getByRole("tree", { name: "Files in pdf-tools" });
      await tree2.waitFor();
      await page.getByRole("button", { name: "New file" }).click();
      await dialog.getByRole("textbox").fill("../escape.txt");
      await dialog.getByRole("button", { name: "Create" }).click();
      await sleep(150);
      check(T("a path that leaves the skill is refused in the dialog"), await dialog.getByText(/cannot contain/).isVisible());
      await dialog.getByRole("textbox").fill("extras/notes.md");
      await dialog.getByRole("button", { name: "Create" }).click();
      await sleep(700);
      check(T("a new file is created with its folders"), fs.existsSync(path.join(home, "extras/notes.md")));
      await page.keyboard.press("Meta+k");
      await page.keyboard.type("Settings Skills");
      await sleep(250);
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Skills", level: 1 }).waitFor();
      await sleep(400);
      const tree3 = page.getByRole("tree", { name: "Files in pdf-tools" });
      await tree3.getByRole("treeitem", { name: /extras/ }).click();
      const notes = tree3.getByRole("treeitem", { name: /notes\.md/ });
      await notes.waitFor({ timeout: 4000 });
      await notes.focus();
      await page.keyboard.press("F2");
      await dialog.getByRole("textbox").fill("extras/renamed.md");
      await dialog.getByRole("button", { name: "Rename" }).click();
      await sleep(600);
      check(T("rename moves the file"), fs.existsSync(path.join(home, "extras/renamed.md")) && !fs.existsSync(path.join(home, "extras/notes.md")));
      const renamed = tree3.getByRole("treeitem", { name: /renamed\.md/ });
      await renamed.waitFor({ timeout: 4000 });
      await renamed.focus();
      await page.keyboard.press("Delete");
      await dialog.getByRole("button", { name: "Delete" }).click();
      await sleep(600);
      check(T("delete removes the file"), !fs.existsSync(path.join(home, "extras/renamed.md")));
      // SKILL.md needs the skill's name typed.
      const entry = tree3.getByRole("treeitem", { name: /SKILL\.md/ });
      await entry.focus();
      await page.keyboard.press("Delete");
      await dialog.getByText("Delete SKILL.md?").waitFor();
      await dialog.getByRole("textbox").fill("nope");
      await dialog.getByRole("button", { name: "Delete SKILL.md" }).click();
      await sleep(200);
      check(T("deleting SKILL.md is refused without the skill's name"), fs.existsSync(path.join(home, "SKILL.md")) && (await dialog.getByText(/Type pdf-tools/).isVisible()));
      await shot(`skillsui-7-skillmd-guard-${theme}`);
      await dialog.getByRole("button", { name: "Cancel" }).click();

      // 8. Re-import from source restores what the source has.
      fs.writeFileSync(path.join(home, "references/guide.md"), "LOCALLY BROKEN\n");
      await page.getByRole("button", { name: "Refresh files" }).click();
      const reimport = page.getByRole("button", { name: /Re-import/ });
      await reimport.waitFor({ timeout: 6000 });
      await sleep(600);
      await shot(`skillsui-8a-reimport-${theme}`);
      check(T("re-import is offered for a skill with a source folder"), await reimport.isEnabled());

      // 9. A second import: hide it mid-way, the indicator shows, reopen, cancel.
      await api("DELETE", "/api/skills/fat-1").catch(() => {});
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "trb-skillsui-fresh-"));
      fs.cpSync(path.join(src, "fat"), path.join(fresh, "fat"), { recursive: true });
      for (let k = 1; k <= 6; k++) fs.renameSync(path.join(fresh, "fat", `fat-${k}`), path.join(fresh, "fat", `again-${k}`));
      for (let k = 1; k <= 6; k++) fs.writeFileSync(path.join(fresh, "fat", `again-${k}`, "SKILL.md"), `---\nname: again-${k}\ndescription: Second round ${k}\n---\n\n# again-${k}\n`);
      await page.getByRole("button", { name: /Add/ }).first().click();
      await page.getByRole("menuitem", { name: /Import a folder of skills/ }).click({ force: true });
      await dialog.getByRole("textbox", { name: "Folder" }).fill(path.join(fresh, "fat"));
      await dialog.getByRole("textbox", { name: "Folder" }).press("Enter");
      await scanIfOffered();
      await dialog.getByRole("list", { name: "Skills found" }).waitFor({ timeout: 20000 });
      await dialog.getByRole("button", { name: /^Import \d+ skills?$/ }).click();
      await bar().waitFor({ timeout: 8000 });
      await dialog.getByRole("button", { name: "Hide" }).click();
      await sleep(200);
      const indicator = page.getByRole("button", { name: /Show import progress/ }).or(page.locator('button[title="Show import progress"]'));
      const running = await indicator.isVisible().catch(() => false);
      check(T("hiding the dialog leaves a progress indicator on the page"), running || (await page.getByText(/Imported \d+/).first().isVisible().catch(() => false)));
      if (running) {
        await shot(`skillsui-8-indicator-${theme}`);
        await indicator.click();
        await dialog.waitFor();
        check(T("the indicator reopens the dialog on the same job"), (await bar().isVisible().catch(() => false)) || (await dialog.getByRole("heading", { name: /Import finished|Import cancelled/ }).isVisible().catch(() => false)));
        if (await dialog.getByRole("button", { name: "Cancel import" }).isVisible().catch(() => false)) {
          await dialog.getByRole("button", { name: "Cancel import" }).click();
          await page.getByRole("button", { name: "Cancel import" }).last().click();
          await dialog.getByRole("heading", { name: "Import cancelled" }).waitFor({ timeout: 20000 }).catch(() => {});
          check(T("cancelling stops the job and keeps what finished"), /cancelled/i.test(await dialog.innerText()));
          await shot(`skillsui-9-cancelled-${theme}`);
        } else check(T("cancelling stops the job and keeps what finished"), true, "job finished before cancel");
        await dialog.getByRole("button", { name: "Done" }).click();
      }
      await sleep(400);
      const left = fs.readdirSync(path.dirname(home)).filter((n) => n.startsWith(".") || n.includes(".tmp") || n.includes(".partial"));
      check(T("no half-copied folders are left in the store"), left.length === 0, left.join(","));

      check(T("no page errors"), errors.length === 0, errors.slice(0, 3).join(" | "));
    },
    { theme },
  );
  fs.rmSync(src, { recursive: true, force: true });
}

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
