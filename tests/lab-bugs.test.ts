import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { interruptAll, setTurnRunner } from "../src/sessions/manager";
import { BUG_KINDS, createBugFinding, FEATURE_ID, listFindings, parseFinding, patchFinding, readFinding, writeFinding } from "../src/lab/findings";
import { fixFinding, labTurn, listRuns, planSweep, realOf } from "../src/lab/sessions";
import { cancelSweep, listSweeps, pumpSweep, stopSweepDriver } from "../src/lab/sweeps";
import { resetLabTables } from "../src/lab/tables";
import { BUG_KINDS as WEB_KINDS } from "../web/src/features/lab/kinds";
import { PICKABLE_LENSES } from "../src/lab/lenses";
import { setSetting } from "../src/settings";
import { makeRepo, resetState } from "./helpers";

const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });

beforeEach(() => {
  resetState();
  setSetting("min_free_memory_mb", "0");
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

const uiFinding = (dir: string, id: string) => writeFinding(dir, id, { title: `Finding ${id}`, lens: "ui", scope: "web", impact: "high", effort: "s", status: "new", evidence: [] }, "It is off.");

const bug = (dir: string, title: string, url = "http://localhost:3000/x", feature: string | null = null) => createBugFinding(dir, { title, body: "It breaks.\n\nSteps: click.", bug: { url, capture: "ev_1", shot: "desktop", kind: "visual", feature }, impact: "high", effort: "s" });

describe("bug findings", () => {
  test("the bug fields survive a write and a read, and a bug lens is not pickable", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const f = bug(dir, "Save button dead");
    expect(f).toMatchObject({ lens: "bug", status: "new", problem: null, bug: { url: "http://localhost:3000/x", capture: "ev_1", shot: "desktop", kind: "visual", feature: null } });
    expect(readFinding(dir, f.id).bug).toEqual(f.bug);
    expect(fs.readFileSync(path.join(dir, f.path), "utf8")).toMatch(/^url: .*\ncapture: ev_1\nshot: desktop\nkind: visual$/m);
    expect(bug(dir, "Save button dead").id).not.toBe(f.id);
    expect(PICKABLE_LENSES).not.toContain("bug");
  });
  test("a bug without a capture or shot reads back as null and none; other lenses carry no bug", () => {
    const f = parseFinding("lab/findings/b.md", "---\ntitle: T\nlens: bug\nurl: http://x\n---\nb\n");
    expect(f).toMatchObject({ problem: null, bug: { url: "http://x", capture: null, shot: "none", kind: "functional", feature: null } });
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
  test("a feature round-trips through a write, a read and a patch; null removes it", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const f = bug(dir, "Cart total wrong", "http://localhost:3000/cart", "checkout");
    expect(f.bug?.feature).toBe("checkout");
    expect(fs.readFileSync(path.join(dir, f.path), "utf8")).toMatch(/^feature: checkout$/m);
    expect(readFinding(dir, f.id).bug?.feature).toBe("checkout");
    expect(patchFinding(dir, f.id, { feature: "cart" }).bug?.feature).toBe("cart");
    const cleared = patchFinding(dir, f.id, { feature: null });
    expect(cleared.bug?.feature).toBeNull();
    expect(fs.readFileSync(path.join(dir, f.path), "utf8")).not.toMatch(/^feature:/m);
    const none = bug(dir, "No feature");
    expect(fs.readFileSync(path.join(dir, none.path), "utf8")).not.toMatch(/^feature:/m);
  });
  test("a feature that is not a feature id reads as none and flags the file; a patch refuses it", () => {
    const read = (v: string) => parseFinding("lab/findings/b.md", `---\ntitle: T\nlens: bug\nurl: http://x\nfeature: ${v}\n---\nb\n`);
    expect(read("Not An Id")).toMatchObject({ bug: { feature: null }, problem: expect.stringMatching(/feature/) });
    expect(read("a".repeat(61))).toMatchObject({ bug: { feature: null }, problem: expect.stringMatching(/feature/) });
    expect(read("cart-2")).toMatchObject({ bug: { feature: "cart-2" }, problem: null });
    const dir = makeRepo({ "a.txt": "x\n" });
    const f = bug(dir, "Dead button");
    expect(() => patchFinding(dir, f.id, { feature: "Bad Id" })).toThrow(/feature/);
    expect(() => patchFinding(dir, f.id, { feature: "" })).toThrow(/feature/);
    expect(readFinding(dir, f.id).bug?.feature).toBeNull();
    expect(FEATURE_ID.test("cart")).toBe(true);
    expect(FEATURE_ID.test("-cart")).toBe(false);
  });
  test("a feature on a finding that is not a bug is refused", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const f = uiFinding(dir, "f1");
    expect(() => patchFinding(dir, f.id, { feature: "cart" })).toThrow(/bug/);
    expect(patchFinding(dir, f.id, { feature: null }).status).toBe("new");
  });
  test("found_by: agent is kept, and a confirmed line is ignored on read and dropped on the next write", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const f = writeFinding(dir, "bug-a", { title: "Total wrong", lens: "bug", scope: "http://localhost:3000/cart", impact: "medium", effort: "s", status: "new", evidence: [], bug: { url: "http://localhost:3000/cart", capture: null, shot: "agent", kind: "logic", by: "agent", feature: null } }, "x");
    expect(f.bug).toEqual({ url: "http://localhost:3000/cart", capture: null, shot: "agent", kind: "logic", by: "agent", feature: null });
    expect(fs.readFileSync(path.join(dir, f.path), "utf8")).toMatch(/^found_by: agent$/m);
    expect(fs.readFileSync(path.join(dir, f.path), "utf8")).not.toMatch(/confirmed/);
    const abs = path.join(dir, f.path);
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace("found_by: agent", "found_by: agent\nconfirmed: false"));
    const old = readFinding(dir, f.id);
    expect(old).toMatchObject({ problem: null, bug: { by: "agent" } });
    expect(old.bug).not.toHaveProperty("confirmed");
    patchFinding(dir, f.id, { status: "accepted" });
    expect(fs.readFileSync(abs, "utf8")).not.toMatch(/confirmed/);
    expect(fs.readFileSync(abs, "utf8")).toMatch(/^found_by: agent$/m);
  });
  test("a fix for a bug is refused and starts nothing; the bug is left as it was", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const f = bug(dir, "Dead button");
    let started = 0;
    setTurnRunner(async () => (started++, ok("done")));
    expect(() => fixFinding(dir, f.id, { engine: "fake" })).toThrow("Bugs are fixed from the QA view.");
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toBe(0);
    expect(listRuns(dir)).toEqual([]);
    expect(readFinding(dir, f.id)).toMatchObject({ status: "new", fixSession: null });
  });
});

describe("fix of a finding that is not a bug", () => {
  test("a fix stamps the sweep id and the finding's own lens, and links the session", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const f = uiFinding(dir, "f1");
    setTurnRunner(async () => ok("done"));
    const r = fixFinding(dir, f.id, { engine: "fake" }, "sw_test");
    expect(listRuns(dir).find((x) => x.sessionId === r.session.id)).toMatchObject({ sweepId: "sw_test", scope: `fix:${f.id}`, lens: "ui" });
    expect(r.finding).toMatchObject({ status: "accepted", fixSession: r.session.id });
  });
  test("one fix in flight per project: the second refuses, naming the first", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const [a, b] = [uiFinding(dir, "f1"), uiFinding(dir, "f2")];
    const g = gate();
    const first = fixFinding(dir, a!.id, { engine: "fake" });
    await until(() => g.inFlight() === 1);
    expect(() => fixFinding(dir, b!.id, { engine: "fake" })).toThrow(new RegExp(`${a!.id}.*${first.session.id}`));
    expect(g.peak()).toBe(1);
    expect(readFinding(dir, b!.id).fixSession).toBeNull();
  });
});

describe("sweeps no longer have a fix kind", () => {
  test("open fix-kind sweep rows are cancelled when the tables are upgraded, and run sweeps are left alone", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    listSweeps(dir);
    const insert = (id: string, kind: string, cancelled: number) =>
      db().prepare("INSERT INTO lab_sweeps (id, root_dir, lens, kind, opts, pending, total, parallel, cancelled) VALUES (?, ?, 'bug', ?, '{}', '[\"bug-a\"]', 1, 1, ?)").run(id, realOf(dir), kind, cancelled);
    insert("sw_fix_open", "fix", 0);
    insert("sw_fix_done", "fix", 1);
    insert("sw_run_open", "run", 0);
    resetLabTables();
    const rows = listSweeps(dir);
    expect(rows.find((s) => s.id === "sw_fix_open")).toMatchObject({ cancelled: true, queued: 0 });
    expect(rows.find((s) => s.id === "sw_fix_done")).toMatchObject({ cancelled: true });
    expect(rows.find((s) => s.id === "sw_run_open")).toMatchObject({ cancelled: false, queued: 1 });
    expect(pumpSweep("sw_fix_open")).toEqual([]);
    expect(cancelSweep(dir, "sw_run_open")).toMatchObject({ cancelled: true });
  });
});
