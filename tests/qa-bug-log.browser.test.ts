import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { findChrome } from "../src/browser/chrome";
import { shutdownBrowsers } from "../src/browser/manager";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { evidenceDir } from "../src/evidence/store";
import { listFindings } from "../src/lab/findings";
import { realOf } from "../src/lab/tables";
import { executeQaTool } from "../src/qa/tools";
import { createLead, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { resetSetting, setSetting } from "../src/settings";
import { makeDir, resetState, settled } from "./helpers";

const chrome = findChrome({ fresh: true });
if (!chrome) console.warn("[qa bug_log tests] SKIPPED: no Chrome found (set TRB_CHROME to run them)");
const t = chrome ? test : test.skip;

const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });

let site: ReturnType<typeof Bun.serve>;
let base: string;
beforeAll(() => {
  site = Bun.serve({
    port: 0,
    fetch: () => new Response(`<!doctype html><title>Cart</title><h1>Total: 42.00</h1><script>console.error("discount service failed: 500")</script>`, { headers: { "content-type": "text/html" } }),
  });
  base = `http://localhost:${site.port}`;
});
afterAll(async () => {
  site.stop(true);
  await shutdownBrowsers();
});
beforeEach(() => {
  resetState();
  db().exec("DELETE FROM qa_sessions");
  setSetting("agent_browser", "on");
  setTurnRunner(async () => ok("ready"));
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
  resetSetting("agent_browser");
});

t("bug_log files an unconfirmed agent bug with the page's screenshot and console, and refuses a duplicate", async () => {
  const dir = makeDir();
  const id = (await settled(createLead({ prompt: "ready", cwd: dir }).id)).id;
  db().prepare("INSERT INTO qa_sessions (session_id, root_dir, plan, kind, problem, proposals_sig, run_id, batch_id) VALUES (?, ?, 'cart', 'explore', NULL, NULL, NULL, NULL)").run(id, realOf(dir));

  // Before any page is open there is nothing to log from.
  expect((await executeQaTool("bug_log", { title: "x", steps: [], actual: "y" }, id)).text).toContain("not on a page of the app");

  const { executeBrowserTool } = await import("../src/browser/tools");
  await executeBrowserTool("browser_navigate", { url: base + "/cart?coupon=SAVE10" }, { sessionId: id });
  const r = await executeQaTool("bug_log", { title: "Cart total ignores the discount code", kind: "logic", steps: ["1. Open /cart", "Apply SAVE10"], expected: "37.80", actual: "Still 42.00" }, id);
  expect(r.text).toMatch(/^Logged bug-cart-total-ignores-the-discount-code "Cart total ignores the discount code", unconfirmed/);

  const f = listFindings(dir).find((x) => x.lens === "bug")!;
  expect(f.bug).toMatchObject({ shot: "agent", kind: "logic", by: "agent", confirmed: false, url: `${base}/cart?coupon=[redacted]` });
  expect(f.body).toContain("1. Open /cart\n2. Apply SAVE10");
  expect(f.body).toContain("discount service failed: 500");
  expect(f.body).toContain("Found by a QA agent in an exploration of plan \"cart\"");
  const files = fs.readdirSync(evidenceDir(f.bug!.capture!));
  expect(files).toContain("screenshot.png");
  expect(files).toContain("console.txt");
  expect(fs.readFileSync(path.join(evidenceDir(f.bug!.capture!), "screenshot.png")).subarray(1, 4).toString()).toBe("PNG");

  const again = await executeQaTool("bug_log", { title: "Discount code ignored by the cart total", steps: [], actual: "42.00" }, id);
  expect(again.text).toContain(`Not logged: this looks like the open bug ${f.id}`);
  const forced = await executeQaTool("bug_log", { title: "Discount code ignored by the cart total", steps: [], actual: "42.00", new: true, screenshot: false }, id);
  expect(forced.text).toMatch(/^Logged /);
  expect(listFindings(dir).filter((x) => x.lens === "bug")).toHaveLength(2);

  // A session that is not a QA session cannot log.
  expect((await executeQaTool("bug_log", { title: "x", steps: [], actual: "y" }, "s_nobody")).text).toContain("is for QA sessions");
}, 60_000);
