/**
 * The CodeGraph item, end to end in a real browser against the CLI that ships with the app, on a
 * LARGE throwaway repo: nothing happens until a click; the panel shows an estimate, live progress,
 * survives a reload mid-job, cancels cleanly, reports the result, syncs, toggles, removes the index,
 * and recovers an init that the daemon's restart interrupted. Then a CLI that fails, a start that is
 * refused, and the no-binary state.
 *   bun run scripts/ui-codegraph.ts [dark|light]     shots: /tmp/trb-shots/cg3-<theme>-*.png
 */
import fs from "fs";
import os from "os";
import path from "path";
import { withUi } from "./ui-harness";

const theme = (process.argv[2] === "light" ? "light" : "dark") as "dark" | "light";
let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  [${theme}] ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failed++;
};

/** A port that is free right now, so a daemon restart keeps the page's origin. */
async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port!;
  s.stop(true);
  return p;
}

const FILES = 12_000;
process.env.TRB_CODEGRAPH_LARGE_FILES = "10000";
process.env.TRB_PORT = String(await freePort());
const sweepRepos: string[] = [];

await withUi(
  async ({ page, shot: rawShot, workspaceId, url, repo, trb }) => {
    sweepRepos.push(path.dirname(repo));
    const shot = async (n: string) => (await page.waitForTimeout(450), rawShot(n)); // let popovers and fades finish
    const btn = page.locator("[data-codegraph-button]");
    const panel = page.locator("[data-codegraph-panel]");
    const dot = page.locator("[data-codegraph-dot]");
    const state = () => page.evaluate(async (w) => await (await fetch(`/api/workspaces/${w}/codegraph?fresh=1`)).json(), workspaceId);
    const status = async () => (await state()).codegraph;
    const open = async () => {
      if (!(await panel.count())) await btn.click();
      await panel.waitFor();
    };
    const close = async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
    };
    const progress = () => page.locator("[data-codegraph-progress]");
    const waitProgress = (min = 3) => page.waitForFunction((m) => Number(document.querySelector("[data-codegraph-progress]")?.getAttribute("aria-valuenow") ?? 0) >= m, min, { timeout: 60_000 });
    await page.evaluate(() => localStorage.setItem("trb.composer.v1", JSON.stringify({ engine: "fake", model: "", effort: "", pairId: "", worktree: false })));

    // A repo big enough that indexing takes a while.
    for (let i = 0; i < FILES; i++) {
      const dir = `${repo}/gen/m${i % 60}`;
      if (i < 60) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/f${i}.ts`, Array.from({ length: 14 }, (_, j) => `export function fn${i}_${j}(a: number) { return a + ${j}; }`).join("\n") + `\nexport class C${i} { m() { return fn${i}_0(1); } }\n`);
    }
    await page.goto(`${url}/w/${workspaceId}`);
    await btn.waitFor({ timeout: 10_000 });

    // 1. One labelled item with a grey dot; opening the project and the panel create nothing.
    check("the status bar says just 'CodeGraph' with a grey dot", ((await btn.textContent()) ?? "").trim() === "CodeGraph" && (await dot.getAttribute("data-state")) === "none");
    check("opening the project created no .codegraph/", !fs.existsSync(`${repo}/.codegraph`));
    await btn.click();
    await panel.waitFor();
    await page.waitForFunction(() => /About\s+[\d,]+\s+source files/.test(document.querySelector("[data-codegraph-estimate]")?.textContent ?? ""), null, { timeout: 15_000 });
    const est = (await page.locator("[data-codegraph-estimate]").textContent()) ?? "";
    check("the panel counts the files before anything runs", /About\s+12,\d{3}\s+source files/.test(est), est);
    check("a large project is warned about", /large project/i.test((await page.locator("[data-codegraph-warning]").textContent()) ?? ""));
    check("the gitignore box is on by default", (await page.getByRole("checkbox", { name: /gitignore/i }).getAttribute("aria-checked")) === "true");
    const src = ((await page.locator("[data-codegraph-source]").textContent()) ?? "").trim();
    check("the panel names the bundled copy and its version", /^bundled v\d/.test(src), src);
    await shot(`cg3-${theme}-1-confirm`);
    await close();
    check("dismissing the panel created nothing", !fs.existsSync(`${repo}/.codegraph`));

    // 2. Start: live progress, a percentage, elapsed time and a Cancel button, in the panel and on the item.
    await btn.click();
    await page.locator("[data-codegraph-init]").click();
    await progress().waitFor({ timeout: 15_000 });
    await waitProgress(5);
    check("a progress bar with a percentage appears", Number(await progress().getAttribute("aria-valuenow")) >= 5);
    check("the item shows a spinner and the percentage", (await dot.getAttribute("data-state")) === "running" && /\d+%/.test((await btn.textContent()) ?? ""));
    check("elapsed time and the phase are shown", /\d+s/.test((await page.locator("[data-codegraph-elapsed]").textContent()) ?? "") && /Indexing: (Scanning|Parsing|Resolving|Linking)/.test((await page.locator("[data-codegraph-job]").textContent()) ?? ""));
    check("Cancel is offered while running", (await page.locator("[data-codegraph-cancel]").count()) === 1);
    await shot(`cg3-${theme}-2-progress`);

    // 3. Reload mid-job: the page re-attaches to the job the daemon is still running.
    await page.reload();
    await btn.waitFor();
    check("after a reload the item still shows the running job", (await dot.getAttribute("data-state")) === "running");
    await open();
    await progress().waitFor({ timeout: 15_000 });
    check("and the panel shows its progress again", (await progress().count()) === 1);
    await shot(`cg3-${theme}-3-reattached`);

    // 4. Cancel: the process dies and the .codegraph/ this job made is removed.
    await page.locator("[data-codegraph-cancel]").click();
    await page.locator("[data-codegraph-job][data-state=cancelled]").waitFor({ timeout: 20_000 });
    check("cancel ends the job as 'Cancelled'", /Cancelled/.test((await page.locator("[data-codegraph-job]").textContent()) ?? ""));
    check("the partial .codegraph/ is gone", !fs.existsSync(`${repo}/.codegraph`));
    check("nothing else was touched (no .gitignore entry)", !fs.existsSync(`${repo}/.gitignore`) || !/\.codegraph/.test(fs.readFileSync(`${repo}/.gitignore`, "utf-8")));
    await shot(`cg3-${theme}-4-cancelled`);
    await page.locator("[data-codegraph-dismiss]").click();

    // 5. Run it to the end: the result line persists until dismissed, even across a reload.
    await page.locator("[data-codegraph-init]").click();
    await progress().waitFor({ timeout: 15_000 });
    await page.locator("[data-codegraph-job][data-state=done]").waitFor({ timeout: 180_000 });
    const result = ((await page.locator("[data-codegraph-result]").textContent()) ?? "").trim();
    check("the result says how many files and symbols, and how long", /^Indexed 12,\d{3} files, \d+k symbols in \d+(s|m \d+s)$/.test(result), result);
    check("the .gitignore note is shown", /\.gitignore/.test((await page.locator("[data-codegraph-job]").textContent()) ?? ""));
    check(".codegraph/ exists and the entry is in .gitignore", fs.existsSync(`${repo}/.codegraph`) && /^\.codegraph\/$/m.test(fs.readFileSync(`${repo}/.gitignore`, "utf-8")));
    check("the dot turns green", (await dot.getAttribute("data-state")) === "indexed");
    await shot(`cg3-${theme}-5-result`);
    await page.reload();
    await btn.waitFor();
    await open();
    await page.locator("[data-codegraph-result]").waitFor({ timeout: 10_000 });
    check("the result is still there after a reload", /Indexed/.test((await page.locator("[data-codegraph-result]").textContent()) ?? ""));
    await page.locator("[data-codegraph-dismiss]").click();
    await page.waitForFunction(() => !document.querySelector("[data-codegraph-job]"), null, { timeout: 5000 });
    check("Dismiss clears it for good (the daemon forgets it too)", (await state()).job === null);

    // 6. The panel holds the state, Sync, the switches and the rest.
    const counts = (await page.locator("[data-codegraph-counts]").textContent()) ?? "";
    check("counts and last-indexed time are shown", /symbols.*files.*Last indexed/.test(counts), counts);
    check("Sync is the primary action, with a full re-index below it", (await page.locator("[data-codegraph-sync]").count()) === 1 && (await page.locator("[data-codegraph-reindex]").count()) === 1);
    await shot(`cg3-${theme}-6-indexed`);
    await close();
    fs.writeFileSync(`${repo}/src/extra.ts`, "export const extra = () => 42;\n");
    await page.reload();
    await page.waitForSelector("[data-codegraph-stale]", { timeout: 30_000 });
    check("changed files turn the dot amber with a pending count", /\d/.test((await btn.textContent()) ?? "") && (await dot.getAttribute("data-state")) === "stale");
    await open();
    await page.locator("[data-codegraph-sync]").click();
    await page.locator("[data-codegraph-job][data-state=done]").waitFor({ timeout: 60_000 });
    const syncResult = (await page.locator("[data-codegraph-result]").textContent()) ?? "";
    check("sync reports what it did", /Synced/i.test(syncResult), syncResult);
    await shot(`cg3-${theme}-7-synced`);
    await page.locator("[data-codegraph-dismiss]").click();
    check("the pending count is gone after sync", (await status()).pendingChanges === 0);

    // 7. The per-workspace switches live in the panel.
    await page.getByRole("switch", { name: /Use CodeGraph in sessions/ }).click();
    await page.waitForFunction(async (w) => (await (await fetch(`/api/workspaces/${w}/codegraph?fresh=1`)).json()).codegraph.useOverride === "off", workspaceId, { timeout: 20_000 });
    check("'Use in sessions' off is kept per workspace", (await status()).useOverride === "off");
    await page.getByRole("switch", { name: /Use CodeGraph in sessions/ }).click();
    await page.waitForFunction(async (w) => (await (await fetch(`/api/workspaces/${w}/codegraph?fresh=1`)).json()).codegraph.setting === "auto", workspaceId, { timeout: 20_000 });
    check("and back on restores it", (await status()).setting === "auto");
    check("the composer carries no passive graph badge", (await page.locator("[data-codegraph-badge]").count()) === 0);
    await page.getByRole("switch", { name: /Keep the CodeGraph index in sync/ }).click();
    await page.waitForFunction(async (w) => (await (await fetch(`/api/workspaces/${w}/codegraph?fresh=1`)).json()).codegraph.keepInSync === true, workspaceId, { timeout: 15_000 });
    check("keep in sync turns on for this workspace", true);
    await close();
    const r = trb("run", "-e", "fake", "WRITE src/synced-by-turn.ts export const t = 1;");
    check("a scripted turn wrote a file", r.code === 0, r.stderr.slice(0, 120));
    let pending = -1;
    for (let i = 0; i < 40 && pending !== 0; i++) {
      await page.waitForTimeout(750);
      pending = (await status()).pendingChanges;
      if (i > 3 && pending === 0) break;
    }
    check("the index caught up after the turn on its own", pending === 0);

    // 8. Remove the index: confirm first, then it is gone and the item goes back to grey.
    await open();
    await page.locator("[data-codegraph-uninit]").click();
    check("removing asks first and says nothing is lost but the index", /Your code is not touched/.test((await page.locator("[data-codegraph-uninit-confirm]").textContent()) ?? ""));
    await shot(`cg3-${theme}-8-remove`);
    await page.locator("[data-codegraph-uninit-yes]").click();
    await page.waitForFunction(() => document.querySelector("[data-codegraph-dot]")?.getAttribute("data-state") === "none", null, { timeout: 20_000 });
    check(".codegraph/ is removed and the dot is grey again", !fs.existsSync(`${repo}/.codegraph`));
    await close();

    // 9. The daemon restarts in the middle of an init: the partial index is detected and can be resumed.
    await open();
    await page.locator("[data-codegraph-init]").click();
    await progress().waitFor({ timeout: 15_000 });
    await waitProgress(8);
    const rs = trb("daemon", "restart");
    check("the daemon restarted mid-job", rs.code === 0, rs.stderr.slice(0, 160));
    await page.reload();
    await btn.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector("[data-codegraph-dot]")?.getAttribute("data-state") !== "running", null, { timeout: 30_000 });
    await open();
    await page.locator("[data-codegraph-resume]").waitFor({ timeout: 20_000 });
    const st = await status();
    check("the leftover .codegraph/ reads as incomplete, not indexed", st.state === "incomplete", st.state);
    check("the dot is amber and the panel offers 'Resume'", (await dot.getAttribute("data-state")) === "incomplete" && /Resume/.test((await page.locator("[data-codegraph-resume]").textContent()) ?? ""));
    await shot(`cg3-${theme}-9-incomplete`);
    await page.locator("[data-codegraph-resume]").click();
    await page.locator("[data-codegraph-job][data-state=done]").waitFor({ timeout: 180_000 });
    check("resuming finishes the index", (await status()).state === "indexed");
    await close();
  },
  { theme },
);

// 10. A CLI that fails: the real error, a Copy log button, and a retry. And a start the daemon refuses.
const keepPath = process.env.PATH;
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cg-ui-stub-"));
fs.writeFileSync(path.join(stubDir, "codegraph"), `#!/bin/sh\ncase "$1" in\n  --version) echo 1.6.2;;\n  status) echo '{"initialized":false}';;\n  init|index|sync) echo "Scanning files..."; echo "Error: out of memory while parsing src/huge.ts" >&2; exit 3;;\n  *) exit 1;;\nesac\n`, { mode: 0o755 });
process.env.PATH = `${stubDir}:${keepPath}`;
process.env.TRB_CODEGRAPH_BUNDLED = "0";
await withUi(
  async ({ page, shot: rawShot, workspaceId, url, repo }) => {
    sweepRepos.push(path.dirname(repo));
    const shot = async (n: string) => (await page.waitForTimeout(450), rawShot(n));
    const btn = page.locator("[data-codegraph-button]");
    await page.goto(`${url}/w/${workspaceId}`);
    await btn.waitFor({ timeout: 10_000 });
    await btn.click();
    await page.locator("[data-codegraph-init]").click();
    await page.locator("[data-codegraph-job][data-state=failed]").waitFor({ timeout: 30_000 });
    const err = (await page.locator("[data-codegraph-error]").textContent()) ?? "";
    check("a failing CLI shows its real error in the panel", /out of memory while parsing src\/huge\.ts/.test(err), err);
    check("the dot turns red", (await page.locator("[data-codegraph-dot]").getAttribute("data-state")) === "failed");
    check("Copy log and Dismiss are offered, and Initialize can be retried", (await page.locator("[data-codegraph-copylog]").count()) === 1 && (await page.locator("[data-codegraph-init]").count()) === 1);
    await shot(`cg3-${theme}-10-failed`);
    await page.locator("[data-codegraph-dismiss]").click();

    // An empty .codegraph/ folder (what an interrupted init leaves) is not an index: Initialize starts again, and the
    // real error shows again rather than "already initialized".
    fs.mkdirSync(`${repo}/.codegraph`);
    await page.locator("[data-codegraph-init]").click();
    await page.locator("[data-codegraph-job][data-state=failed]").waitFor({ timeout: 30_000 });
    const again = (await page.locator("[data-codegraph-error]").textContent()) ?? "";
    check("an empty .codegraph/ folder does not block Initialize (it runs again and reports the CLI's error)", /out of memory while parsing src\/huge\.ts/.test(again) && !/already initialized/i.test(again), again);
    await shot(`cg3-${theme}-11-refused`);
  },
  { theme },
);

// 11. Nothing resolves: the panel offers the install command to copy and never runs it.
const bunDir = path.dirname(Bun.which("bun") ?? "/usr/local/bin/bun");
process.env.PATH = `${bunDir}:/usr/bin:/bin:/usr/sbin:/sbin`;
await withUi(
  async ({ page, shot: rawShot, workspaceId, url }) => {
    const shot = async (n: string) => (await page.waitForTimeout(450), rawShot(n));
    await page.goto(`${url}/w/${workspaceId}`);
    const btn = page.locator("[data-codegraph-button]");
    await btn.waitFor({ timeout: 10_000 });
    check("without any binary the item is still just 'CodeGraph', dot grey", ((await btn.textContent()) ?? "").trim() === "CodeGraph" && (await page.locator("[data-codegraph-dot]").getAttribute("data-state")) === "unavailable");
    await btn.click();
    const cmd = page.locator("[data-codegraph-install]");
    await cmd.waitFor();
    check("the install command is shown for copying", /install\.sh/.test((await cmd.textContent()) ?? ""));
    await shot(`cg3-${theme}-12-install`);
  },
  { theme },
);
process.env.PATH = keepPath;
for (const d of sweepRepos) fs.rmSync(d, { recursive: true, force: true });
fs.rmSync(stubDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
