import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { createLead, getSession, interruptAll, recoverOnStartup, setTurnRunner, type TurnRunner } from "../src/sessions/manager";
import { pruneCommandReceipts } from "../src/sessions/receipts";
import { executeSubagentTool, subagentToolDefs } from "../src/sessions/tools";
import { makeDir, makeRepo, resetState, settled } from "./helpers";

/**
 * A turn that succeeds at once, so these tests do not depend on the scripted engine. A brief that asks for
 * WRITE m.txt also writes that file in the turn's cwd, which a worktree subagent then commits and can merge.
 */
const scripted: TurnRunner = async (opts) => {
  if (opts.prompt.includes("WRITE m.txt")) fs.writeFileSync(path.join(opts.cwd, "m.txt"), "merged\n");
  return { success: true, output: "ok", sessionId: null, resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" };
};

beforeEach(() => {
  resetState();
  db().exec("DELETE FROM command_receipts");
  setTurnRunner(scripted);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

const lead = (prompt: string, cwd = makeDir()) => createLead({ prompt, engine: "fake", cwd });
const receipts = () => (db().prepare("SELECT COUNT(*) AS n FROM command_receipts").get() as { n: number }).n;
const childrenOf = (id: string) => (db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_id = ?").get(id) as { n: number }).n;
const turnsOf = (id: string) => (db().prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(id) as { n: number }).n;

describe("subagent tools with a command_id", () => {
  test("the tool definitions advertise command_id on create, send and merge", () => {
    const defs = Object.fromEntries(subagentToolDefs().map((d) => [d.name, d]));
    for (const name of ["subagent_create", "subagent_send", "subagent_merge"]) {
      expect(defs[name].inputSchema.properties).toHaveProperty("command_id");
      expect(defs[name].description).toContain("command_id");
    }
    expect(defs.subagent_wait.inputSchema.properties).not.toHaveProperty("command_id");
  });

  test("a retried subagent_create returns the first head and opens no second one", async () => {
    const l = await settled(lead("SAY ready").id);
    const caller = { sessionId: l.id };
    const first = await executeSubagentTool("subagent_create", { brief: "SAY one", command_id: "cmd-create-1" }, caller);
    const again = await executeSubagentTool("subagent_create", { brief: "SAY one", command_id: "cmd-create-1" }, caller);
    expect(again).toBe(first);
    expect(childrenOf(l.id)).toBe(1);
    expect(receipts()).toBe(1);
    await settled(JSON.parse(first).id);
  });

  test("a retried subagent_send does not start a second turn", async () => {
    const l = await settled(lead("SAY ready").id);
    const caller = { sessionId: l.id };
    const c = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SAY one" }, caller));
    await settled(c.id);
    const before = turnsOf(c.id);
    const first = await executeSubagentTool("subagent_send", { id: c.id, message: "SAY two", command_id: "cmd-send-1" }, caller);
    await settled(c.id);
    const again = await executeSubagentTool("subagent_send", { id: c.id, message: "SAY two", command_id: "cmd-send-1" }, caller);
    expect(again).toBe(first);
    expect(turnsOf(c.id)).toBe(before + 1);
    expect(getSession(c.id)!.status).toBe("idle");
  });

  test("a retried subagent_merge returns the first result and applies nothing twice", async () => {
    const repo = makeRepo();
    const l = await settled(lead("SAY ready", repo).id);
    const caller = { sessionId: l.id };
    const c = JSON.parse(await executeSubagentTool("subagent_create", { brief: "WRITE m.txt merged\nSAY wrote" }, caller));
    await settled(c.id);
    const first = await executeSubagentTool("subagent_merge", { id: c.id, command_id: "cmd-merge-1" }, caller);
    expect(JSON.parse(first)).toMatchObject({ merged: true });
    const again = await executeSubagentTool("subagent_merge", { id: c.id, command_id: "cmd-merge-1" }, caller);
    expect(again).toBe(first);
    expect(receipts()).toBe(1);
  });

  test("a merge that applied nothing is not receipted, so a retry looks again", async () => {
    const repo = makeRepo();
    const l = await settled(lead("SAY ready", repo).id);
    const caller = { sessionId: l.id };
    const c = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SAY no edits" }, caller));
    await settled(c.id);
    const res = await executeSubagentTool("subagent_merge", { id: c.id, command_id: "cmd-merge-empty" }, caller);
    expect(JSON.parse(res)).toMatchObject({ merged: false });
    expect(receipts()).toBe(0);
  });

  test("a refusal is not receipted: the same command_id works once the cause is fixed", async () => {
    const l = await settled(lead("SAY ready").id);
    const caller = { sessionId: l.id };
    expect(await executeSubagentTool("subagent_create", { brief: "", command_id: "cmd-refused" }, caller)).toMatch(/^Error: brief is required/);
    expect(receipts()).toBe(0);
    const ok = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SAY fixed", command_id: "cmd-refused" }, caller));
    expect(ok).toMatchObject({ status: "running", depth: 1 });
    expect(childrenOf(l.id)).toBe(1);
    await settled(ok.id);
  });

  test("the same command_id from two different sessions is two different calls", async () => {
    const a = await settled(lead("SAY a").id);
    const b = await settled(lead("SAY b").id);
    const ca = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SAY x", command_id: "shared-id" }, { sessionId: a.id }));
    const cb = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SAY x", command_id: "shared-id" }, { sessionId: b.id }));
    expect(cb.id).not.toBe(ca.id);
    expect(receipts()).toBe(2);
    await settled(ca.id);
    await settled(cb.id);
  });

  test("calls without a command_id are never receipted", async () => {
    const l = await settled(lead("SAY ready").id);
    const caller = { sessionId: l.id };
    const x = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SAY x" }, caller));
    const y = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SAY x" }, caller));
    expect(x.id).not.toBe(y.id);
    expect(receipts()).toBe(0);
    await settled(x.id);
    await settled(y.id);
  });

});

describe("receipt retention", () => {
  test("pruneCommandReceipts deletes receipts older than 7 days and keeps the rest", () => {
    const insert = db().prepare("INSERT INTO command_receipts (command_id, tool, session_id, result_json, created_at) VALUES (?, ?, ?, '{}', ?)");
    insert.run("old", "subagent_create", "s_x", "2020-01-01 00:00:00");
    insert.run("edge-old", "subagent_create", "s_x", "2026-10-10 23:59:00");
    insert.run("fresh", "subagent_create", "s_x", "2026-10-12 12:00:00");
    const pruned = pruneCommandReceipts(new Date("2026-10-18T10:00:00Z"));
    expect(pruned).toBe(2);
    expect(db().prepare("SELECT command_id FROM command_receipts").all()).toEqual([{ command_id: "fresh" }]);
  });

  test("daemon startup (recoverOnStartup) prunes old receipts", () => {
    db().exec("INSERT INTO command_receipts (command_id, tool, session_id, result_json, created_at) VALUES ('ancient', 'subagent_send', 's_y', '{}', '2000-01-01 00:00:00')");
    recoverOnStartup();
    expect((db().prepare("SELECT COUNT(*) AS n FROM command_receipts WHERE command_id = 'ancient'").get() as { n: number }).n).toBe(0);
  });
});
