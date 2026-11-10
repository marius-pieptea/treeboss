import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { db } from "../src/db";
import { groupProcessCount, groupProcesses, type GroupProcess } from "../src/proctree";
import { setSetting } from "../src/settings";
import { close, createChild, createLead, getSession, interruptAll, readLog, reapIdle, recoverOnStartup, send, setTurnRunner, type TurnRunner } from "../src/sessions/manager";
import { endTurnGroup, mcpTree } from "../src/sessions/leftovers";
import { parseVmStat, setMemoryReader } from "../src/sessions/memory";
import { makeDir, resetState, settled } from "./helpers";

const posix = process.platform !== "win32";

// The pids of the process groups a turn left behind, killed after each test whatever the test did.
const groups: number[] = [];

// Turns end at once without an engine, so the logic tests run wherever the suite does (the scripted fake engine is a bash script).
// The memory guard reads the real machine unless a test says otherwise: plenty, here.
beforeEach(() => {
  resetState();
  setTurnRunner(async () => OK);
  setMemoryReader(() => 1_000_000);
});

afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
  setMemoryReader(null);
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
});

const lead = (prompt: string, over: Record<string, unknown> = {}) => createLead({ prompt, engine: "fake", cwd: makeDir(), ...over } as any);

const OK = { success: true, output: "started", sessionId: null, resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" };

/** A turn whose engine starts a background group (as a dev server does) and returns before it exits. `gate` holds the turn open. */
function leavingBackground(gate?: Promise<void>): TurnRunner {
  return async (opts) => {
    const child = spawn("sh", ["-c", "sleep 60 & sleep 60"], { detached: true, stdio: "ignore" });
    child.unref();
    groups.push(child.pid!);
    opts.onSpawn?.(child.pid!);
    if (gate) await gate;
    return OK;
  };
}

/** Poll until `check` holds, up to `ms`. */
async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

/** Make a session's last turn look as if it ended `hours` ago. */
function backdateTurns(sessionId: string, hours: number): void {
  db().prepare(`UPDATE turns SET finished_at = datetime('now', ?) WHERE session_id = ?`).run(`-${hours} hours`, sessionId);
}

describe("leftover process groups", () => {
  test("a group that is already gone is forgotten, and the session stays open", async () => {
    const s = await settled((await lead("SAY done")).id);
    // A group id no process holds: what a daemon finds after the processes were killed by hand.
    db().prepare("INSERT INTO turn_groups (turn_id, session_id, pgid) VALUES (?, ?, ?)").run("t_gone", s.id, 2147483646);
    backdateTurns(s.id, 48);
    reapIdle();
    expect(getSession(s.id)!.status).toBe("idle");
    expect(db().prepare("SELECT COUNT(*) AS n FROM turn_groups WHERE session_id = ?").get(s.id)).toEqual({ n: 0 });
  });

  test.skipIf(!posix)("the group a turn leaves is remembered and stopped when the session is closed", async () => {
    setTurnRunner(leavingBackground());
    const s0 = await lead("start the dev server");
    await settled(s0.id);
    const pid = groups[groups.length - 1];
    expect(groupProcessCount(pid)).toBeGreaterThan(0);
    expect(readLog(s0.id).some((l) => /background process\(es\) still running from this turn/.test(l.text))).toBe(true);

    await close({ operator: true }, s0.id);
    expect(await until(() => groupProcessCount(pid) === 0)).toBe(true);
    expect(getSession(s0.id)!.status).toBe("closed");
    expect(readLog(s0.id).some((l) => /stopped \d+ background process\(es\) in 1 group\(s\)/.test(l.text))).toBe(true);
  });

  test.skipIf(!posix)("the reaper stops an idle session's leftovers after leftover_reap_hours, and does not close it", async () => {
    setTurnRunner(leavingBackground());
    const s = await settled((await lead("start a watcher")).id);
    const pid = groups[groups.length - 1];

    reapIdle();
    expect(groupProcessCount(pid)).toBeGreaterThan(0); // the last turn is recent: nothing is reaped yet

    backdateTurns(s.id, 25);
    reapIdle();
    expect(await until(() => groupProcessCount(pid) === 0)).toBe(true);
    expect(getSession(s.id)!.status).toBe("idle");
  });

  test.skipIf(!posix)("leftover_reap_hours 0 never reaps by age", async () => {
    setTurnRunner(leavingBackground());
    const s = await settled((await lead("start a watcher")).id);
    const pid = groups[groups.length - 1];
    setSetting("leftover_reap_hours", "0");
    backdateTurns(s.id, 500);
    reapIdle();
    expect(groupProcessCount(pid)).toBeGreaterThan(0);
  });

  test.skipIf(!posix)("the group of a turn still running is never reaped", async () => {
    let release!: () => void;
    setTurnRunner(leavingBackground(new Promise<void>((r) => (release = r))));
    const s0 = await lead("a long turn");
    expect(await until(() => groups.length > 0)).toBe(true);
    const pid = groups[groups.length - 1];

    backdateTurns(s0.id, 500); // irrelevant to a live turn: its own group must still be left alone
    reapIdle();
    expect(groupProcessCount(pid)).toBeGreaterThan(0);

    release();
    await settled(s0.id);
    expect(groupProcessCount(pid)).toBeGreaterThan(0);
    await close({ operator: true }, s0.id);
    expect(await until(() => groupProcessCount(pid) === 0)).toBe(true);
  });

  test.skipIf(!posix)("a session closed while its group was still running has that group stopped when the turn ends", async () => {
    let release!: () => void;
    setTurnRunner(leavingBackground(new Promise<void>((r) => (release = r))));
    const s0 = await lead("a long turn");
    expect(await until(() => groups.length > 0)).toBe(true);
    const pid = groups[groups.length - 1];

    // The turn ignores the interrupt and holds for the 5 s interrupt wait, so the close happens while it is still live.
    await close({ operator: true }, s0.id);
    expect(groupProcessCount(pid)).toBeGreaterThan(0);
    release();
    expect(await until(() => groupProcessCount(pid) === 0)).toBe(true);
    expect(getSession(s0.id)!.status).toBe("closed");
  }, 20_000);

  test.skipIf(!posix)("a group of a session closed before the daemon started is stopped at startup", async () => {
    setTurnRunner(leavingBackground());
    const s = await settled((await lead("start a server")).id);
    const pid = groups[groups.length - 1];
    // Closed by a daemon that died before it reaped the group.
    db().prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(s.id);

    recoverOnStartup();
    expect(await until(() => groupProcessCount(pid) === 0)).toBe(true);
  });
});

describe("lead auto-close (lead_idle_close_hours)", () => {
  test("off by default: an idle lead is left open however long it has been idle", async () => {
    const s = await settled((await lead("SAY hi")).id);
    db().prepare("UPDATE sessions SET updated_at = datetime('now', '-500 hours') WHERE id = ?").run(s.id);
    reapIdle();
    expect(getSession(s.id)!.status).toBe("idle");
  });

  test("when set, closes an idle lead past the limit, and keeps a pinned one", async () => {
    const idle = await settled((await lead("SAY one")).id);
    const pinned = await settled((await lead("SAY two")).id);
    db().prepare("UPDATE sessions SET pinned_at = CURRENT_TIMESTAMP WHERE id = ?").run(pinned.id);
    for (const s of [idle, pinned]) db().prepare("UPDATE sessions SET updated_at = datetime('now', '-10 hours') WHERE id = ?").run(s.id);
    const fresh = await settled((await lead("SAY three")).id);

    setSetting("lead_idle_close_hours", "6");
    reapIdle();
    expect(getSession(idle.id)!.status).toBe("closed");
    expect(getSession(pinned.id)!.status).toBe("idle");
    expect(getSession(fresh.id)!.status).toBe("idle");
  });

  test("a lead within the limit is kept", async () => {
    const s = await settled((await lead("SAY four")).id);
    db().prepare("UPDATE sessions SET updated_at = datetime('now', '-2 hours') WHERE id = ?").run(s.id);
    setSetting("lead_idle_close_hours", "6");
    reapIdle();
    expect(getSession(s.id)!.status).toBe("idle");
  });
});

describe("MCP servers left in a turn's group", () => {
  const server = { type: "stdio" as const, command: "sh", args: ["-c", "sleep 60; :", "mcp-marker-trbtest"], env: {} };

  test("the matcher finds a turn's MCP server and what it started, and nothing else", () => {
    const procs: GroupProcess[] = [
      { pid: 10, ppid: 1, args: "claude -p --mcp-config /tmp/x.json" },
      { pid: 11, ppid: 10, args: "/usr/bin/bun /repo/src/cli.ts mcp-serve" },
      { pid: 12, ppid: 11, args: "node helper.js" },
      { pid: 13, ppid: 10, args: "sleep 61" },
    ];
    const mcp = { trb: { type: "stdio" as const, command: "/usr/bin/bun", args: ["/repo/src/cli.ts", "mcp-serve"] }, remote: { type: "http" as const, url: "http://x" } };
    expect(mcpTree(procs, mcp, 10).map((p) => p.pid).sort()).toEqual([11, 12]);
    expect(mcpTree(procs, {}, 10)).toEqual([]);
  });

  test.skipIf(!posix)("at turn end the MCP servers are stopped, the dev server stays, and the record is kept for it", async () => {
    const s = await settled((await lead("SAY hi")).id);
    // The engine (group leader) starts an MCP server and a dev server, as a turn does.
    const leader = spawn("sh", ["-c", 'M=mcp-marker; sh -c "sleep 60; :" "$M-trbtest" & sleep 61 & wait'], { detached: true, stdio: "ignore" });
    leader.unref();
    groups.push(leader.pid!);
    const turnId = "t_mcp_test";
    db().prepare("INSERT INTO turn_groups (turn_id, session_id, pgid) VALUES (?, ?, ?)").run(turnId, s.id, leader.pid!);
    expect(await until(() => (groupProcesses(leader.pid!) ?? []).length >= 4)).toBe(true);
    // The MCP server (marked) and the sleep it runs (bash runs a command list without exec, so it keeps the bare command line).
    const mcpPids = (groupProcesses(leader.pid!) ?? []).filter((p) => p.args.includes("mcp-marker-trbtest") || p.args === "sleep 60").map((p) => p.pid);
    expect(mcpPids.length).toBe(2);

    const r = endTurnGroup(turnId, { trb: server });
    expect(r.mcpStopped).toBe(2);
    expect(r.left).toBeGreaterThanOrEqual(2); // the engine stand-in and the dev server
    expect(await until(() => mcpPids.every((pid) => groupProcesses(leader.pid!)?.every((p) => p.pid !== pid) ?? true))).toBe(true);
    expect(db().prepare("SELECT COUNT(*) AS n FROM turn_groups WHERE turn_id = ?").get(turnId)).toEqual({ n: 1 });

    // Still reaped later by the normal rule (the session is closed here).
    await close({ operator: true }, s.id);
    expect(await until(() => groupProcessCount(leader.pid!) === 0)).toBe(true);
  });

  test.skipIf(!posix)("a turn whose group holds only its MCP servers ends with no record", async () => {
    const s = await settled((await lead("SAY hi")).id);
    // The engine exits at once, leaving its MCP server behind in the group.
    const leader = spawn("sh", ["-c", 'M=mcp-marker; sh -c "sleep 60; :" "$M-trbtest" & exit 0'], { detached: true, stdio: "ignore" });
    leader.unref();
    groups.push(leader.pid!);
    db().prepare("INSERT INTO turn_groups (turn_id, session_id, pgid) VALUES (?, ?, ?)").run("t_only_mcp", s.id, leader.pid!);
    expect(await until(() => (groupProcesses(leader.pid!) ?? []).some((p) => p.args.includes("mcp-marker-trbtest")) && !(groupProcesses(leader.pid!) ?? []).some((p) => p.pid === leader.pid))).toBe(true);
    endTurnGroup("t_only_mcp", { trb: server });
    expect(db().prepare("SELECT COUNT(*) AS n FROM turn_groups WHERE turn_id = ?").get("t_only_mcp")).toEqual({ n: 0 });
  });
});

describe("minimum free memory (min_free_memory_mb)", () => {
  // Measured on a 48 GB Mac with no memory pressure: under 1 GB free, about 20 GB inactive.
  const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   50000.
Pages active:                                1187121.
Pages inactive:                              1280000.
Pages speculative:                            10000.
Pages throttled:                                   0.
Pages wired down:                             202615.
Pages purgeable:                               4000.
"Translation faults":                      252981521.
`;

  test("macOS: available counts the inactive, speculative and purgeable pages the kernel hands back, not just free ones", () => {
    expect(parseVmStat(VM_STAT)).toBe(((50000 + 1280000 + 10000 + 4000) * 16384) / (1024 * 1024));
    expect(parseVmStat(VM_STAT)!).toBeGreaterThan(20000);
  });

  test("macOS: unreadable vm_stat output gives null, so the reader falls back", () => {
    expect(parseVmStat("")).toBeNull();
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\n")).toBeNull();
  });

  test("the refusal names the setting and the exact command that changes it", () => {
    setMemoryReader(() => 800);
    expect(() => lead("SAY hi")).toThrow(/trb config set min_free_memory_mb <MB>/);
  });

  test("default 1500: a lead is refused when less is available, and nothing is created", () => {
    setMemoryReader(() => 800);
    expect(() => lead("SAY hi")).toThrow(/only 800 MB free, under min_free_memory_mb \(1500\)/);
    expect(db().prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  test("0 turns the guard off", async () => {
    setMemoryReader(() => 10);
    setSetting("min_free_memory_mb", "0");
    const s = await settled((await lead("SAY hi")).id);
    expect(s.status).toBe("idle");
  });

  test("enough memory lets a lead start", async () => {
    setMemoryReader(() => 4000);
    expect((await settled((await lead("SAY hi")).id)).status).toBe("idle");
  });

  test("a subagent launch and a follow-up are refused the same way, and the lead's existing sessions are kept", async () => {
    setMemoryReader(() => 4000);
    const parent = await settled((await lead("SAY hi")).id);
    setMemoryReader(() => 900);
    expect(() => createChild({ caller: { operator: true }, parentId: parent.id, brief: "do a thing" })).toThrow(/only 900 MB free/);
    expect(() => send({ operator: true }, parent.id, "again")).toThrow(/only 900 MB free/);
    expect(getSession(parent.id)!.status).toBe("idle");
    expect(db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE depth > 0").get()).toEqual({ n: 0 });
    setMemoryReader(() => 4000);
    expect(createChild({ caller: { operator: true }, parentId: parent.id, brief: "do a thing" }).parent_id).toBe(parent.id);
  });
});
