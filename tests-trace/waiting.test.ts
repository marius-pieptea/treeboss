import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START waiting\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END waiting\n"); });
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { setSetting } from "../src/settings";
import { Hub } from "../src/sessions/hub";
import { createChild, createLead, getSession, interrupt, interruptAll, setTurnRunner, viewSession } from "../src/sessions/manager";
import { executeSubagentTool, executeSubagentToolStep } from "../src/sessions/tools";
import { openWaitCount, waitingOf } from "../src/sessions/waiting";
import { makeRepo, resetState, settled } from "./helpers";

// These tests wait on real sleeping heads across several one-second daemon blocks.
setDefaultTimeout(30_000);

beforeEach(() => {
  resetState();
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

/** A lead whose own turn stays live (so it has a turn to be interrupted), and a repo for its heads. */
function liveLead() {
  return createLead({ prompt: "SLEEP 30000", engine: "fake", cwd: makeRepo() } as any);
}
const head = (parent: string, brief: string, title = "head") => createChild({ caller: { sessionId: parent }, brief, title });

describe("subagent_wait is one model-visible call", () => {
  test("a wait longer than one daemon block chains through `pending`, and a direct caller sees one result", async () => {
    setSetting("wait_max_sec", "1");
    const l = liveLead();
    const c = head(l.id, "SLEEP 2600\nSAY slow done");
    const caller = { sessionId: l.id };

    const t0 = Date.now();
    const s1 = await executeSubagentToolStep("subagent_wait", { ids: [c.id] }, caller);
    expect(s1.pending).toMatch(/^w_/);
    expect(s1.text).toBe("");
    expect(Date.now() - t0).toBeLessThan(2000); // one block, not the whole wait
    expect(openWaitCount()).toBe(1);

    let step = s1;
    let blocks = 1;
    while (step.pending) {
      step = await executeSubagentToolStep("subagent_wait", { ids: [c.id], _resume: step.pending }, caller);
      blocks++;
    }
    expect(blocks).toBeGreaterThanOrEqual(3);
    const out = JSON.parse(step.text);
    expect(out.subagents[0]).toMatchObject({ id: c.id, status: "idle", output: "slow done" });
    expect(out.still_running).toBeUndefined();
    expect(openWaitCount()).toBe(0);

    // A caller with no shim (tests, the in-process surface) runs every block itself and gets the same single result.
    const c2 = head(l.id, "SLEEP 2200\nSAY again");
    const t1 = Date.now();
    const direct = JSON.parse(await executeSubagentTool("subagent_wait", { ids: [c2.id] }, caller));
    expect(Date.now() - t1).toBeGreaterThan(1500);
    expect(direct.subagents[0]).toMatchObject({ status: "idle", output: "again" });
    expect(direct.waited_sec).toBeGreaterThanOrEqual(2);
  });

  test("while it waits the lead's view says who on, across blocks, and it clears on completion", async () => {
    setSetting("wait_max_sec", "1");
    const l = liveLead();
    const c = head(l.id, "SLEEP 2300", "api-head");
    const caller = { sessionId: l.id };
    expect(viewSession(getSession(l.id)!).waiting_on).toBeUndefined();

    const s1 = await executeSubagentToolStep("subagent_wait", { ids: [c.id] }, caller);
    const v1 = viewSession(getSession(l.id)!);
    expect(v1.waiting_on).toEqual([{ id: c.id, name: "api-head" }]);
    const since = v1.waiting_since!;
    expect(Number.isNaN(Date.parse(since))).toBe(false);

    const s2 = await executeSubagentToolStep("subagent_wait", { _resume: s1.pending }, caller);
    expect(s2.pending).toBe(s1.pending);
    expect(viewSession(getSession(l.id)!).waiting_since).toBe(since); // the same wait, not a new one

    await executeSubagentTool("subagent_wait", { ids: [c.id] }, caller);
    expect(viewSession(getSession(l.id)!).waiting_on).toBeUndefined();
    expect(waitingOf(l.id)).toBeNull();
  });

  test("the hub announces a wait starting and ending", async () => {
    setSetting("wait_max_sec", "1");
    const l = liveLead();
    const c = head(l.id, "SLEEP 1500");
    const seen: string[] = [];
    const off = Hub.subscribe((e) => {
      if (e.type === "wait" && e.sessionId === l.id) seen.push(waitingOf(l.id) ? "on" : "off");
    });
    await executeSubagentTool("subagent_wait", { ids: [c.id] }, { sessionId: l.id });
    off();
    expect(seen[0]).toBe("on");
    expect(seen[seen.length - 1]).toBe("off");
  });

  test("mode any returns at the first finisher, mode all waits for the slowest", async () => {
    setSetting("wait_max_sec", "1");
    const l = liveLead();
    const caller = { sessionId: l.id };
    const slow = head(l.id, "SLEEP 4000\nSAY slow", "slow");
    const quick = head(l.id, "SLEEP 600\nSAY quick", "quick");

    const t0 = Date.now();
    const any = JSON.parse(await executeSubagentTool("subagent_wait", { ids: [slow.id, quick.id], mode: "any" }, caller));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(any.subagents.find((s: any) => s.id === quick.id).status).toBe("idle");
    expect(any.still_running).toEqual([slow.id]);
    expect(openWaitCount()).toBe(0);

    const t1 = Date.now();
    const all = JSON.parse(await executeSubagentTool("subagent_wait", { ids: [slow.id, quick.id], mode: "all" }, caller));
    expect(Date.now() - t1).toBeGreaterThan(1500);
    expect(all.still_running).toBeUndefined();
    expect(all.subagents.map((s: any) => s.status)).toEqual(["idle", "idle"]);
  });

  test("the call's own ceiling ends the wait, still running, however many blocks it took", async () => {
    setSetting("wait_max_sec", "1");
    const l = liveLead();
    const c = head(l.id, "SLEEP 15000");
    const caller = { sessionId: l.id };
    const t0 = Date.now();
    const out = JSON.parse(await executeSubagentTool("subagent_wait", { ids: [c.id], timeout_sec: 2 }, caller));
    const took = Date.now() - t0;
    expect(took).toBeGreaterThan(1500);
    expect(took).toBeLessThan(4500);
    expect(out.still_running).toEqual([c.id]);
    expect(out.note).toContain("again");
    expect(openWaitCount()).toBe(0);
  });

  test("wait_total_sec caps a call that asks for more, and an absent timeout uses it", async () => {
    setSetting("wait_max_sec", "1");
    setSetting("wait_total_sec", "2");
    const l = liveLead();
    const c = head(l.id, "SLEEP 15000");
    const caller = { sessionId: l.id };
    for (const args of [{ ids: [c.id] }, { ids: [c.id], timeout_sec: 600 }]) {
      const t0 = Date.now();
      const out = JSON.parse(await executeSubagentTool("subagent_wait", args, caller));
      expect(Date.now() - t0).toBeLessThan(4500);
      expect(out.still_running).toEqual([c.id]);
    }
  });

  test("interrupting the lead ends the wait at once and leaves no wait behind", async () => {
    setSetting("wait_max_sec", "30");
    const l = liveLead();
    const c = head(l.id, "SLEEP 20000");
    const caller = { sessionId: l.id };

    const waiting = executeSubagentTool("subagent_wait", { ids: [c.id] }, caller);
    await Bun.sleep(300);
    expect(waitingOf(l.id)?.waiting_on[0].id).toBe(c.id);
    expect(openWaitCount()).toBe(1);

    const t0 = Date.now();
    await interrupt({ operator: true }, l.id);
    const out = JSON.parse(await waiting);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(out.note).toContain("interrupted");
    expect(out.still_running).toEqual([c.id]);
    expect(openWaitCount()).toBe(0);
    expect(waitingOf(l.id)).toBeNull();
  });

  test("a turn that ends between two blocks drops the wait; resuming it says so", async () => {
    setSetting("wait_max_sec", "1");
    const l = liveLead();
    const c = head(l.id, "SLEEP 20000");
    const caller = { sessionId: l.id };
    const s1 = await executeSubagentToolStep("subagent_wait", { ids: [c.id] }, caller);
    expect(s1.pending).toBeTruthy();
    await interrupt({ operator: true }, l.id);
    await settled(l.id).catch(() => {});
    expect(openWaitCount()).toBe(0);
    const again = await executeSubagentToolStep("subagent_wait", { _resume: s1.pending }, caller);
    expect(again.pending).toBeUndefined();
    expect(again.text).toMatch(/^Error: That wait is no longer open/);
  });

  test("a wait can only be resumed by the session that opened it", async () => {
    setSetting("wait_max_sec", "1");
    const a = liveLead();
    const b = liveLead();
    const c = head(a.id, "SLEEP 20000");
    const s1 = await executeSubagentToolStep("subagent_wait", { ids: [c.id] }, { sessionId: a.id });
    const stolen = await executeSubagentToolStep("subagent_wait", { _resume: s1.pending }, { sessionId: b.id });
    expect(stolen.text).toMatch(/^Error:/);
    expect(openWaitCount()).toBe(1);
  });

  test("a wait with nothing running returns at once and never registers", async () => {
    const l = liveLead();
    const c = head(l.id, "SAY quick");
    await settled(c.id);
    const t0 = Date.now();
    const s = await executeSubagentToolStep("subagent_wait", { ids: [c.id] }, { sessionId: l.id });
    expect(s.pending).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(JSON.parse(s.text).subagents[0].status).toBe("idle");
    expect(openWaitCount()).toBe(0);
  });

  test("refusals stay `Error:` text: another parent's head, an unknown id", async () => {
    const a = liveLead();
    const b = liveLead();
    const c = head(a.id, "SLEEP 5000");
    expect(await executeSubagentTool("subagent_wait", { ids: [c.id] }, { sessionId: b.id })).toMatch(/^Error: .*another parent/);
    expect(await executeSubagentTool("subagent_wait", { ids: ["s_nope"] }, { sessionId: a.id })).toMatch(/^Error: No session/);
    expect(openWaitCount()).toBe(0);
  });
});
