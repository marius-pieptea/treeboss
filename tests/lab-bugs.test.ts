import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { interruptAll, setTurnRunner } from "../src/sessions/manager";
import { BUG_KINDS, createBugFinding, listFindings, parseFinding, patchFinding, readFinding } from "../src/lab/findings";
import { fixFinding, labTurn, listRuns, planSweep } from "../src/lab/sessions";
import { cancelSweep, listSweeps, openFixSweep, pumpSweep, startFixSweep, startSweepDriver, stopSweepDriver } from "../src/lab/sweeps";
import { BUG_KINDS as WEB_KINDS } from "../web/src/features/lab/kinds";
import { PICKABLE_LENSES } from "../src/lab/lenses";
import { makeRepo, resetState } from "./helpers";

const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });

beforeEach(() => {
  resetState();
  setTurnRunner(null);
  listRuns(makeRepo({ "a.txt": "x\n" }));
  listSweeps(makeRepo({ "a.txt": "x\n" }));
  db().exec("DELETE FROM lab_sessions");
  db().exec("DELETE FROM lab_sweeps");
});

let current: { release: () => void } | null = null;
afterEach(async () => {
  current?.release();
  current = null;
  stopSweepDriver();
  await interruptAll();
  setTurnRunner(null);
});

function gate() {
  const waiting: Array<() => void> = [];
  let inFlight = 0;
  let peak = 0;
  setTurnRunner(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((r) => waiting.push(r));
    inFlight--;
    return ok("done");
  });
  const g = { release: () => waiting.splice(0).forEach((r) => r()), inFlight: () => inFlight, peak: () => peak };
  current = g;
  return g;
}

const until = async (cond: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const bug = (dir: string, title: string, url = "http://localhost:3000/x") => createBugFinding(dir, { title, body: "It breaks.\n\nSteps: click.", bug: { url, capture: "ev_1", shot: "desktop", kind: "visual" }, impact: "high", effort: "s" });

describe("bug findings", () => {
  test("the bug fields survive a write and a read, and a bug lens is not pickable", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const f = bug(dir, "Save button dead");
    expect(f).toMatchObject({ lens: "bug", status: "new", problem: null, bug: { url: "http://localhost:3000/x", capture: "ev_1", shot: "desktop", kind: "visual" } });
    expect(readFinding(dir, f.id).bug).toEqual(f.bug);
    expect(fs.readFileSync(path.join(dir, f.path), "utf8")).toMatch(/^url: .*\ncapture: ev_1\nshot: desktop\nkind: visual$/m);
    expect(bug(dir, "Save button dead").id).not.toBe(f.id);
    expect(PICKABLE_LENSES).not.toContain("bug");
  });
  test("a bug without a capture or shot reads back as null and none; other lenses carry no bug", () => {
    const f = parseFinding("lab/findings/b.md", "---\ntitle: T\nlens: bug\nurl: http://x\n---\nb\n");
    expect(f).toMatchObject({ problem: null, bug: { url: "http://x", capture: null, shot: "none", kind: "functional" } });
    expect(parseFinding("lab/findings/c.md", "---\ntitle: T\nlens: ui\nurl: http://x\n---\nb\n").bug).toBeNull();
  });
  test("the web and the server agree on the kinds", () => {
    expect([...WEB_KINDS]).toEqual([...BUG_KINDS]);
  });
  test("an unknown or missing kind reads as functional, a known one is case-insensitive", () => {
    const read = (kind: string) => parseFinding("lab/findings/k.md", `---\ntitle: T\nlens: bug\nurl: http://x\n${kind}---\nb\n`).bug!.kind;
    expect(read("")).toBe("functional");
    expect(read("kind: sparkly"+"\n")).toBe("functional");
    expect(read("kind: Performance"+"\n")).toBe("performance");
  });
  test("a bug file with no url is listed with a problem", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    fs.mkdirSync(path.join(dir, "lab/findings"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lab/findings/nourl.md"), "---\ntitle: T\nlens: bug\n---\nb\n");
    const [f] = listFindings(dir);
    expect(f!.bug).not.toBeNull();
    expect(f!.problem).toMatch(/url/);
  });
  test("runs and sweeps refuse the bug lens", () => {
    const dir = makeRepo({ "src/m/a.ts": "export const a = 1;\n" });
    expect(() => labTurn(dir, "bug", "project")).toThrow(/bug/);
    expect(() => planSweep(dir, "bug", null)).toThrow(/bug/);
  });
  test("a fix stamps the sweep id and names the url and capture for a bug", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const f = bug(dir, "Dead button");
    let prompt = "";
    setTurnRunner(async (o: any) => {
      prompt = String(o.prompt ?? "");
      return ok("done");
    });
    const r = fixFinding(dir, f.id, {}, "sw_test");
    expect(listRuns(dir).find((x) => x.sessionId === r.session.id)).toMatchObject({ sweepId: "sw_test", scope: `fix:${f.id}`, lens: "bug" });
    await until(() => prompt !== "");
    expect(prompt).toContain("reproduce it at http://localhost:3000/x first");
    expect(prompt).toContain("evidence capture ev_1");
    expect(prompt).toContain("This is a visual bug");
    expect(prompt).toContain("following the Steps to reproduce");
    const alone = bug(dir, "Other");
    expect(fixFinding(dir, alone.id).session.id).toBeTruthy();
    expect(listRuns(dir).find((x) => x.scope === `fix:${alone.id}`)!.sweepId).toBeNull();
  });
});

describe("fix sweep", () => {
  test("fixes one at a time, skips a closed finding and continues after a restart", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const [a, b, c, d] = ["One", "Two", "Three", "Four"].map((t) => bug(dir, t));
    const g = gate();
    const r = startFixSweep(dir, [a!.id, b!.id, c!.id, d!.id], { engine: "fake" });
    expect(r.sessions).toHaveLength(1);
    expect(listSweeps(dir)[0]).toMatchObject({ kind: "fix", total: 4, queued: 3, running: 1 });
    expect(openFixSweep(dir)?.id).toBe(r.sweepId);
    patchFinding(dir, b!.id, { status: "dismissed" });
    await until(() => g.inFlight() === 1);
    g.release();
    await until(() => listSweeps(dir)[0]!.running === 0);
    expect(listSweeps(dir)[0]).toMatchObject({ queued: 3, done: 1 });
    startSweepDriver(); // the daemon came back
    for (let i = 0; i < 12; i++) {
      g.release();
      await new Promise((r) => setTimeout(r, 40));
    }
    await until(() => listSweeps(dir)[0]!.queued === 0 && listSweeps(dir)[0]!.running === 0);
    expect(g.peak()).toBe(1);
    const scopes = listRuns(dir).filter((x) => x.sweepId === r.sweepId).map((x) => x.scope).sort();
    expect(scopes).toEqual([`fix:${a!.id}`, `fix:${c!.id}`, `fix:${d!.id}`].sort());
    expect(readFinding(dir, b!.id).fixSession).toBeNull();
    expect(openFixSweep(dir)).toBeNull();
  });
  test("a finding whose fix is still running is not started twice, and cancelling stops the queue", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const [a, b] = ["One", "Two"].map((t) => bug(dir, t));
    const g = gate();
    const first = fixFinding(dir, a!.id, { engine: "fake" });
    await until(() => g.inFlight() === 1);
    const r = startFixSweep(dir, [a!.id, b!.id], { engine: "fake" });
    expect(r.sessions.map((s) => s.id)).not.toContain(first.session.id);
    expect(listRuns(dir).filter((x) => x.scope === `fix:${a!.id}`)).toHaveLength(1);
    const cancelled = cancelSweep(dir, r.sweepId);
    expect(cancelled).toMatchObject({ cancelled: true, queued: 0 });
    expect(pumpSweep(r.sweepId)).toEqual([]);
    expect(openFixSweep(dir)).toBeNull();
  });
});

describe("one fix in flight per project", () => {
  test("Fix now refuses while another fix runs, naming it", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const [a, b] = ["One", "Two"].map((t) => bug(dir, t));
    const g = gate();
    const first = fixFinding(dir, a!.id, { engine: "fake" });
    await until(() => g.inFlight() === 1);
    expect(() => fixFinding(dir, b!.id, { engine: "fake" })).toThrow(new RegExp(`${a!.id}.*${first.session.id}`));
    expect(g.peak()).toBe(1);
    expect(readFinding(dir, b!.id).fixSession).toBeNull();
  });
  test("a new fix-all after Cancel starts nothing while the cancelled sweep's fix still runs, then continues when it ends", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const [a, b] = ["One", "Two"].map((t) => bug(dir, t));
    const g = gate();
    startSweepDriver();
    const first = startFixSweep(dir, [a!.id], { engine: "fake" });
    await until(() => g.inFlight() === 1);
    cancelSweep(dir, first.sweepId);
    const second = startFixSweep(dir, [b!.id], { engine: "fake" });
    expect(second.sessions).toEqual([]);
    expect(g.inFlight()).toBe(1);
    g.release();
    await until(() => listRuns(dir).some((x) => x.sweepId === second.sweepId));
    expect(g.peak()).toBe(1);
  });
  test("a fix-all waits for a Fix now fix and is pumped again when it ends", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const [a, b] = ["One", "Two"].map((t) => bug(dir, t));
    const g = gate();
    startSweepDriver();
    fixFinding(dir, a!.id, { engine: "fake" });
    await until(() => g.inFlight() === 1);
    const sweep = startFixSweep(dir, [b!.id], { engine: "fake" });
    expect(sweep.sessions).toEqual([]);
    g.release();
    await until(() => listRuns(dir).some((x) => x.sweepId === sweep.sweepId));
    expect(g.peak()).toBe(1);
  });
});
