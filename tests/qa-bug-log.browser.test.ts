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
  db().exec("DELETE FROM qa_jobs; DELETE FROM qa_pipelines");
  setSetting("agent_browser", "on");
  setTurnRunner(async () => ok("ready"));
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
  resetSetting("agent_browser");
});

const FEATURES = "# Features\n## Cart\nid: cart\nwhere: /cart\nThe cart.\n## Invite\nid: invite\nwhere: /team\nInvites.\n";

/** A lead session that works for a job of `stage` over `units`, the way jobs.ts registers it before the first turn. */
async function job(dir: string, stage: string, units: string[]): Promise<string> {
  fs.mkdirSync(path.join(dir, "lab"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lab/features.md"), FEATURES);
  const lead = (await settled(createLead({ prompt: "ready", cwd: dir }).id)).id;
  const now = Date.now();
  db().prepare("INSERT INTO qa_pipelines (id, root_dir, config, control, units, created_at) VALUES ('qap_b', ?, '{}', '{\"kind\":\"running\",\"stage\":\"test\"}', NULL, ?)").run(realOf(dir), now);
  db().prepare("INSERT INTO qa_jobs (id, pipeline_id, root_dir, stage, units, session_id, sigs, started_at) VALUES ('qaj_b', 'qap_b', ?, ?, ?, ?, '{}', ?)").run(realOf(dir), stage, JSON.stringify(units), lead, now);
  return lead;
}

async function openCart(session: string) {
  const { executeBrowserTool } = await import("../src/browser/tools");
  await executeBrowserTool("browser_navigate", { url: base + "/cart?coupon=SAVE10" }, { sessionId: session });
}

t("bug_log in a test job files the bug under the job's feature with the page's screenshot and console, and refuses a duplicate", async () => {
  const dir = makeDir();
  const id = await job(dir, "test", ["cart"]);

  // Before any page is open there is nothing to log from.
  expect((await executeQaTool("bug_log", { title: "x", steps: [], actual: "y" }, id)).text).toContain("not on a page of the app");

  await openCart(id);
  const r = await executeQaTool("bug_log", { title: "Cart total ignores the discount code", kind: "logic", steps: ["1. Open /cart", "Apply SAVE10"], expected: "37.80", actual: "Still 42.00" }, id);
  expect(r.text).toMatch(/^Logged bug-cart-total-ignores-the-discount-code "Cart total ignores the discount code"\./);
  expect(r.text).not.toContain("unconfirmed");
  expect(r.text).toContain('Pass bug: "bug-cart-total-ignores-the-discount-code" to qa_record.');

  const f = listFindings(dir).find((x) => x.lens === "bug")!;
  expect(f.bug).toMatchObject({ shot: "agent", kind: "logic", by: "agent", feature: "cart", url: `${base}/cart?coupon=[redacted]` });
  expect(f.body).toContain("1. Open /cart\n2. Apply SAVE10");
  expect(f.body).toContain("discount service failed: 500");
  expect(f.body).toContain("Found by a QA agent in the test job qaj_b (session " + id + ")");
  const files = fs.readdirSync(evidenceDir(f.bug!.capture!));
  expect(files).toContain("screenshot.png");
  expect(files).toContain("console.txt");
  expect(fs.readFileSync(path.join(evidenceDir(f.bug!.capture!), "screenshot.png")).subarray(1, 4).toString()).toBe("PNG");

  const again = await executeQaTool("bug_log", { title: "Discount code ignored by the cart total", steps: [], actual: "42.00" }, id);
  expect(again.text).toContain(`Not logged: this looks like the open bug ${f.id}`);
  const forced = await executeQaTool("bug_log", { title: "Discount code ignored by the cart total", steps: [], actual: "42.00", new: true, screenshot: false }, id);
  expect(forced.text).toMatch(/^Logged /);
  expect(listFindings(dir).filter((x) => x.lens === "bug")).toHaveLength(2);

  expect((await executeQaTool("bug_log", { title: "x", steps: [], actual: "y" }, "s_nobody")).text).toContain("is for QA map, plan and test jobs");
}, 60_000);

t("a job over several features needs the feature named, and only one of its own", async () => {
  const dir = makeDir();
  const id = await job(dir, "plan", ["cart", "invite"]);
  await openCart(id);
  const bad = { title: "Cart total wrong", steps: [], actual: "42.00" };
  expect((await executeQaTool("bug_log", bad, id)).text).toContain("covers 2 features: pass feature");
  expect((await executeQaTool("bug_log", { ...bad, feature: "checkout" }, id)).text).toContain("feature must be one of cart, invite");
  expect(listFindings(dir).filter((x) => x.lens === "bug")).toHaveLength(0);
  expect((await executeQaTool("bug_log", { ...bad, feature: "invite", screenshot: false }, id)).text).toMatch(/^Logged /);
  expect(listFindings(dir).find((x) => x.lens === "bug")!.bug?.feature).toBe("invite");
}, 60_000);

t("a head of the lead can log for the lead's job, and a map job takes an optional feature that must exist", async () => {
  const dir = makeDir();
  const lead = await job(dir, "plan", ["cart", "invite"]);
  db().prepare("INSERT INTO sessions (id, title, parent_id, root_id, depth, engine, status, cwd, base_cwd, isolation) SELECT 's_head', 'h', id, id, 1, engine, 'idle', cwd, base_cwd, 'none' FROM sessions WHERE id = ?").run(lead);
  await openCart("s_head");
  const r = await executeQaTool("bug_log", { title: "Cart total wrong", steps: [], actual: "42.00", feature: "cart", screenshot: false }, "s_head");
  expect(r.text).toMatch(/^Logged /);
  const f = listFindings(dir).find((x) => x.lens === "bug")!;
  expect(f.bug?.feature).toBe("cart");
  expect(f.body).toContain("(session s_head)");

  db().prepare("UPDATE qa_jobs SET stage = 'map', units = '[\"map\"]'").run();
  const none = await executeQaTool("bug_log", { title: "Menu overlaps the logo", steps: [], actual: "overlap", screenshot: false }, lead);
  expect(none.text).toMatch(/^Logged /);
  expect(listFindings(dir).find((x) => x.title === "Menu overlaps the logo")!.bug?.feature).toBeNull();
  expect((await executeQaTool("bug_log", { title: "Another one", steps: [], actual: "x", feature: "ghost", screenshot: false }, lead)).text).toContain('no feature "ghost"');
}, 60_000);

t("a fix job's session has no bug_log", async () => {
  const dir = makeDir();
  const id = await job(dir, "fix", ["bug-a"]);
  expect((await executeQaTool("bug_log", { title: "x", steps: [], actual: "y" }, id)).text).toContain("is for QA map, plan and test jobs");
});
