/**
 * End-to-end check of the git UI: drives the real panels in Chrome against a real daemon and a real repo,
 * and asserts on what git itself reports afterwards (never on what the UI claims).
 *
 *   TRB_WEB_DIR=/tmp/trb-dist-git bun run scripts/ui-git.ts
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Page } from "playwright-core";
import { withUi } from "./ui-harness";

const sh = (cwd: string, cmd: string) => {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};
const ID = "git -c user.email=dev@example.com -c user.name=Dev -c commit.gpgsign=false";
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${extra}`}`);
  if (!ok) failures++;
};
const settle = (page: Page, ms = 450) => page.waitForTimeout(ms);
const changes = (page: Page) => page.locator('[role="tree"][aria-label="Changes"]');
const staged = (page: Page) => page.locator('[role="tree"][aria-label="Staged changes"]');

await withUi(async ({ page, shot, repo, url, workspaceId }) => {
  await page.goto(`${url}/w/${workspaceId}`);
  await page.locator(`nav [aria-label="Source control"]`).click();
  await page.waitForSelector('[aria-label="Source control"]');
  await settle(page);

  /* ---- 1. status ---- */
  check("lists the working-tree changes", (await changes(page).locator("[data-path]").count()) === 2);
  await shot("git-1-sidebar");

  /* ---- 2. diff, hunk stage ---- */
  await changes(page).locator('[data-path="src/greet.ts"]').click();
  await page.waitForSelector("[data-hunk]");
  check("opens a diff tab", (await page.locator('[role="tab"][data-active="true"]').innerText()).includes("greet.ts"));
  await shot("git-2-diff");
  await page.getByRole("button", { name: /Stage hunk/ }).click();
  await settle(page, 700);
  check("stage hunk -> git has it staged", sh(repo, "git diff --cached --name-only") === "src/greet.ts");
  check("it moved to Staged changes", (await staged(page).locator('[data-path="src/greet.ts"]').count()) === 1);
  await shot("git-3-staged");

  /* ---- 3. line-level: stage part of utils file ---- */
  fs.writeFileSync(path.join(repo, "src/utils/math.ts"), `export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\nexport const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);\nexport const max = (xs: number[]) => Math.max(...xs);\nexport const min = (xs: number[]) => Math.min(...xs);\n`);
  await settle(page, 6000); // the shell polls status every 5s
  await changes(page).locator('[data-path="src/utils/math.ts"]').click();
  await page.waitForSelector("[data-hunk]");
  await page.locator('[data-line="0:2"]').locator("span").nth(1).click(); // select the `max` line
  await page.getByRole("button", { name: /Stage lines/ }).click();
  await settle(page, 700);
  check("stage one line -> only that line is staged", sh(repo, "git diff --cached -U0 src/utils/math.ts").includes("+export const max") && !sh(repo, "git diff --cached -U0 src/utils/math.ts").includes("+export const min"));
  await shot("git-4-lines");

  /* ---- 4. commit ---- */
  await page.getByLabel("Commit message").fill("Trim names and add max");
  await page.getByRole("button", { name: /^Commit \d+ file/ }).click();
  await settle(page, 900);
  check("commit lands in git with the message", sh(repo, "git log -1 --format=%s") === "Trim names and add max");
  check("unselected line stays as a working change", sh(repo, "git status --short").includes("src/utils/math.ts"));
  await shot("git-5-committed");

  /* ---- 5. branches ---- */
  await page.locator('button[aria-label^="Branch main"]').click();
  await page.getByPlaceholder("Switch branch or create one…").fill("feature/ui-test");
  await page.getByText("Create branch", { exact: false }).first().click();
  await settle(page, 900);
  check("create branch switches to it", sh(repo, "git branch --show-current") === "feature/ui-test");
  await page.locator('button[aria-label^="Branch feature/ui-test"]').click();
  await page.getByRole("listbox", { name: "Branches" }).waitFor();
  await settle(page, 500);
  await shot("git-6-branches");
  await page.getByRole("option", { name: /^main/ }).click();
  await settle(page, 900);
  check("switch back to main", sh(repo, "git branch --show-current") === "main");

  /* ---- 6. merge conflict ---- */
  sh(repo, `git checkout -q -- . && git clean -fdq && ${ID} checkout -q -b clash && printf 'export const sum = () => 0;\\n' > src/utils/math.ts && ${ID} commit -qam 'clash edit' && git checkout -q main && printf 'export const sum = () => 42;\\n' > src/utils/math.ts && ${ID} commit -qam 'main edit'`);
  await settle(page, 6000);
  await page.locator('button[aria-label^="Branch main"]').click();
  await page.getByPlaceholder("Switch branch or create one…").fill("clash");
  await page.getByRole("option", { name: /clash/ }).hover();
  await page.getByRole("button", { name: /Merge clash into main/ }).click();
  await settle(page, 1200);
  check("conflicted merge shows the conflicts section", (await page.getByText("Merge conflicts").count()) > 0);
  check("and the operation banner", (await page.getByText("in progress").count()) > 0);
  console.log("status.operation =", await page.evaluate(async (id) => (await (await fetch(`/api/git/${id}/status`)).json()).operation, workspaceId), sh(repo, "ls .git | grep MERGE_HEAD || echo none"));
  await shot("git-7-conflict");
  await page.getByRole("button", { name: "Theirs", exact: true }).first().click();
  await settle(page, 900);
  check("resolving a conflict stages the file", sh(repo, "git status --short").includes("M  src/utils/math.ts") || sh(repo, "git status --short").includes("MM src/utils/math.ts"));
  await page.getByLabel("Commit message").fill("Merge clash");
  await page.getByRole("button", { name: /^Commit/ }).first().click();
  await settle(page, 1000);
  check("the merge commit has two parents", sh(repo, "git log -1 --format=%p").split(" ").length === 2);
  await shot("git-8-merged");

  /* ---- 7. remote: publish, then fetch + pull ---- */
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "trb-bare-")) + "/remote.git";
  sh(repo, `git init -q --bare -b main ${bare} && git remote add origin ${bare}`);
  await settle(page, 6000);
  await page.getByRole("button", { name: "Publish branch to origin" }).click();
  await settle(page, 1500);
  check("publish pushes and sets the upstream", sh(repo, "git rev-parse --abbrev-ref @{u}") === "origin/main");
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "trb-other-"));
  sh(other, `git clone -q ${bare} . && echo remote > remote.txt && git add -A && ${ID} commit -qm 'remote change' && git push -q origin main`);
  await page.getByRole("button", { name: "Fetch from all remotes" }).click();
  await settle(page, 1500);
  check("fetch shows the incoming commit count", (await page.getByRole("button", { name: /Pull 1 commit/ }).count()) === 1);
  await page.getByRole("button", { name: /Pull 1 commit/ }).click();
  await settle(page, 1500);
  check("pull brings it in", fs.existsSync(path.join(repo, "remote.txt")));

  /* ---- 8. history graph, commit tab ---- */
  await shot("git-9-graph");
  await page.locator('[role="listitem"]').first().click();
  await page.waitForSelector("[data-commit-tab]");
  await settle(page, 600);
  check("history row opens a commit tab", (await page.locator("[data-commit-tab]").count()) === 1);
  await shot("git-10-commit");

  /* ---- 9. light theme ---- */
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
  });
  await settle(page, 400);
  await shot("git-11-light");

  await settle(page, 300);
}, { theme: "dark" });

/* ================= part 2: discard, stash, amend, keyboard, worktrees, init, split view ================= */
await withUi(async ({ page, shot, repo, url, workspaceId, trb }) => {
  await page.goto(`${url}/w/${workspaceId}`);
  await page.locator(`nav [aria-label="Source control"]`).click();
  await page.waitForSelector('[aria-label="Source control"]');
  await settle(page);

  /* discard (confirm dialog) */
  const row = changes(page).locator('[data-path="src/utils/strings.ts"]');
  await row.hover();
  await row.getByRole("button", { name: "Delete file" }).click();
  await page.getByRole("button", { name: "Delete file" }).last().click(); // the dialog's confirm
  await settle(page, 800);
  check("deleting an untracked file removes it from disk", !fs.existsSync(path.join(repo, "src/utils/strings.ts")));

  /* stash via the section header, then pop */
  await page.getByRole("button", { name: "Stash changes…" }).click();
  await page.getByPlaceholder("WIP: pagination").fill("half-done greeting");
  await page.getByRole("button", { name: "Stash", exact: true }).click();
  await settle(page, 1000);
  check("stash saved the change and cleaned the tree", sh(repo, "git stash list").includes("half-done greeting") && sh(repo, "git status --short") === "");
  await shot("git-12-stash");
  const stashRow = page.getByText("half-done greeting").first();
  await stashRow.hover();
  await page.getByRole("button", { name: /Pop/ }).click();
  await settle(page, 1000);
  check("pop brings the change back", sh(repo, "git status --short").includes("src/greet.ts") && sh(repo, "git stash list") === "");

  /* stage via keyboard on the row (Space), then commit with Cmd/Ctrl+Enter */
  await changes(page).locator('[data-path="src/greet.ts"]').focus();
  await page.keyboard.press("Space");
  await staged(page).locator('[data-path="src/greet.ts"]').waitFor();
  check("space on a row stages it", sh(repo, "git diff --cached --name-only") === "src/greet.ts");
  await page.getByLabel("Commit message").fill("Trim greeting names");
  await page.keyboard.press("Control+Enter");
  await settle(page, 1200);
  check("Ctrl+Enter commits", sh(repo, "git log -1 --format=%s") === "Trim greeting names");

  /* amend: message is loaded, edited, and the commit count stays */
  const count = sh(repo, "git rev-list --count HEAD");
  await page.getByLabel("Amend the last commit").click();
  await settle(page, 600);
  check("amend loads the last message", (await page.getByLabel("Commit message").inputValue()) === "Trim greeting names");
  await page.getByLabel("Commit message").fill("Trim names in greet()");
  await page.getByRole("button", { name: "Amend commit" }).click();
  await settle(page, 1200);
  check("amend rewrites the commit in place", sh(repo, "git log -1 --format=%s") === "Trim names in greet()" && sh(repo, "git rev-list --count HEAD") === count);

  /* line-level discard, hunk stage, and line-level unstage on a two-hunk file */
  sh(repo, `seq 1 60 | sed 's/^/line /' > big.txt && git add -A && ${ID} commit -qm 'add big.txt' && sed -i.bak -e 's/^line 5$/CHANGED 5/' -e 's/^line 50$/CHANGED 50/' big.txt && rm big.txt.bak`);
  await settle(page, 6000);
  await changes(page).locator('[data-path="big.txt"]').click();
  await page.waitForSelector("[data-hunk='1']");
  await page.locator('[data-line="0:3"]').locator("span").nth(0).click(); // `-line 5`
  await page.locator('[data-line="0:4"]').locator("span").nth(1).click({ modifiers: ["Shift"] }); // shift-click extends to `+CHANGED 5`
  await page.locator("[data-hunk='0']").getByRole("button", { name: "Discard", exact: true }).click();
  await page.getByRole("button", { name: "Discard lines" }).click();
  await settle(page, 900);
  const big = fs.readFileSync(path.join(repo, "big.txt"), "utf-8");
  check("discarding selected lines reverts only those", big.includes("\nline 5\n") && big.includes("CHANGED 50"));
  await page.getByRole("button", { name: "Stage hunk" }).first().click();
  await settle(page, 900);
  check("stage hunk stages the remaining change", sh(repo, "git diff --cached big.txt").includes("+CHANGED 50"));
  await staged(page).locator('[data-path="big.txt"]').click();
  await page.waitForSelector("[data-hunk='0']");
  await page.locator('[data-line="0:4"]').locator("span").nth(1).click();
  await page.getByRole("button", { name: "Unstage lines" }).click();
  await settle(page, 900);
  const cached = sh(repo, "git diff --cached -U0 big.txt");
  check("unstaging the added line leaves the deletion staged", cached.includes("-line 50") && !cached.includes("+CHANGED 50"));
  sh(repo, "git checkout -q -- big.txt && git reset -q && git checkout -q -- .");

  /* hooks: a failing pre-commit hook surfaces its output */
  fs.writeFileSync(path.join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\necho 'lint failed: no semicolons' >&2\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(repo, "src/hooked.ts"), "export {};\n");
  await settle(page, 6000);
  await changes(page).locator('[data-path="src/hooked.ts"]').hover();
  await changes(page).locator('[data-path="src/hooked.ts"]').getByRole("button", { name: "Stage" }).click();
  await staged(page).locator('[data-path="src/hooked.ts"]').waitFor();
  await page.getByLabel("Commit message").fill("blocked by hook");
  await page.keyboard.press("Control+Enter");
  await settle(page, 1200);
  check("a failing hook's output reaches the toast", (await page.getByText("lint failed").count()) > 0);
  await shot("git-13-hook-error");
  fs.rmSync(path.join(repo, ".git/hooks/pre-commit"));

  /* worktrees of agents show up */
  trb("run", "-e", "fake", "-w", "-d", "WRITE agent.txt from an agent\nSAY ok");
  await settle(page, 7000);
  check("a head's worktree is listed", (await page.getByText("Worktrees").count()) > 0);

  /* split diff view */
  await changes(page).locator('[data-path="src/hooked.ts"], [data-path="src/utils/math.ts"]').first().click().catch(() => {});
  await page.locator('[role="tree"][aria-label="Staged changes"] [data-path]').first().click();
  await page.waitForSelector("[data-hunk]");
  await page.getByRole("button", { name: /^$/ }).first().isVisible().catch(() => {});
  await page.locator("button:has(svg.lucide-columns-2)").click();
  await settle(page, 400);
  await shot("git-14-split");
  check("split mode renders two columns", (await page.locator("[data-line]").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)) === 4);

  /* command palette lists git commands */
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("push");
  await settle(page, 300);
  check("the palette offers Push", (await page.getByRole("option", { name: /Push/ }).count()) > 0);
  await shot("git-15-palette");
  await page.keyboard.press("Escape");
});

/* ================= part 3: a folder that is not a repository ================= */
await withUi(async ({ page, shot, url, trb }) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "trb-plain-"));
  const out = trb("ui", plain, "--no-open").stdout;
  const ws = /\/w\/(w_[A-Za-z0-9]+)/.exec(out)![1];
  await page.goto(`${url}/w/${ws}`);
  await page.locator(`nav [aria-label="Source control"]`).click();
  await page.getByRole("button", { name: "Initialize repository" }).click();
  await settle(page, 1500);
  check("Initialize repository creates a repo", fs.existsSync(path.join(plain, ".git")));
  await page.getByLabel("Commit message").waitFor();
  check("and the panel becomes a normal source-control view", (await page.getByText("Not a git repository").count()) === 0);
  await shot("git-16-init");
}, { theme: "dark" });

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
