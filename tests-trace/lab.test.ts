import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START lab\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END lab\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { interruptAll, setTurnRunner } from "../src/sessions/manager";
import { compareFindings, evidencePath, listFindings, parseFinding, patchFinding, payoff, priorFindingsBlock, readFinding, removeFinding } from "../src/lab/findings";
import { checkScope, discoverModules, estimateScope, findingToRoadmap, labPrompt, listRuns, planSweep, startLab } from "../src/lab/sessions";
import { cancelSweep, listSweeps, pumpSweep, startSweep, startSweepDriver, stopSweepDriver } from "../src/lab/sweeps";
import { readRoadmap } from "../src/roadmap/store";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState, settled } from "./helpers";

const TOKEN = "lab-test-token";
const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });

beforeEach(() => {
  resetState();
  setTurnRunner(null);
  listRuns(makeRepo({ "a.txt": "x\n" })); // makes sure lab_sessions exists
  listSweeps(makeRepo({ "a.txt": "x\n" })); // and lab_sweeps
  db().exec("DELETE FROM lab_sessions");
  db().exec("DELETE FROM lab_sweeps");
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

const finding = (o: Record<string, string> = {}, body = "Why it matters.\n\nFirst step: do it.") =>
  `---\n${Object.entries({ title: "Debounce search", lens: "perf", scope: "web/src/search", impact: "high", effort: "s", status: "new", ...o })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\nevidence:\n  - web/src/search/Box.tsx:84\n---\n${body}\n`;

function project() {
  return makeRepo({
    "README.md": "# demo\n",
    "src/alpha/a.ts": "export const a = 1;\n".repeat(50),
    "src/beta/b.ts": "export const b = 2;\n",
    "src/beta/c.ts": "export const c = 3;\n",
    "src/empty/readme.txt": "no source\n",
    "web/src/features/chat/Chat.tsx": "export const Chat = 1;\n".repeat(10),
    "node_modules/x/index.js": "module.exports = 1;\n".repeat(1000),
  });
}

const put = (dir: string, id: string, text: string) => {
  fs.mkdirSync(path.join(dir, "lab/findings"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lab/findings", `${id}.md`), text);
};

describe("findings", () => {
  test("parse a finding file", () => {
    const f = parseFinding("lab/findings/search-debounce.md", finding(), 5);
    expect(f).toMatchObject({ id: "search-debounce", title: "Debounce search", lens: "perf", impact: "high", effort: "s", status: "new", evidence: ["web/src/search/Box.tsx:84"], problem: null });
    expect(f.summary).toBe("Why it matters.");
  });
  test("bad values fall back instead of failing, and a missing title is flagged", () => {
    const f = parseFinding("lab/findings/x.md", "---\nimpact: huge\nstatus: later\nlens: nonsense\n---\nbody\n");
    expect(f).toMatchObject({ title: "x", impact: "medium", effort: "m", status: "new", lens: null });
    expect(f.problem).toContain("title");
    expect(parseFinding("lab/findings/y.md", "no front matter").problem).toContain("title");
    expect(parseFinding("lab/findings/z.md", "---\ntitle: [unclosed\n---\nb").problem).toContain("does not parse");
  });
  test("a list is empty when the folder is missing, and sorted by payoff with closed ones last", () => {
    const dir = project();
    expect(listFindings(dir)).toEqual([]);
    put(dir, "big-hard", finding({ title: "Big hard", impact: "high", effort: "l" }));
    put(dir, "small-easy", finding({ title: "Small easy", impact: "medium", effort: "s" }));
    put(dir, "dismissed-one", finding({ title: "Dismissed", impact: "high", effort: "s", status: "dismissed" }));
    expect(listFindings(dir).map((f) => f.id)).toEqual(["small-easy", "big-hard", "dismissed-one"]);
    expect(payoff({ impact: "high", effort: "s" })).toBeGreaterThan(payoff({ impact: "high", effort: "l" }));
    const a = parseFinding("lab/findings/a.md", finding(), 1);
    const b = parseFinding("lab/findings/b.md", finding(), 2);
    expect(compareFindings(a, b)).toBeGreaterThan(0); // newer first on a tie
  });
  test("patching changes only the keys asked for and keeps the rest of the file", () => {
    const dir = project();
    put(dir, "f1", finding({}, "Body stays.\n"));
    const before = fs.readFileSync(path.join(dir, "lab/findings/f1.md"), "utf8");
    const f = patchFinding(dir, "f1", { status: "dismissed" });
    expect(f.status).toBe("dismissed");
    const after = fs.readFileSync(path.join(dir, "lab/findings/f1.md"), "utf8");
    expect(after).toBe(before.replace("status: new", "status: dismissed"));
    expect(patchFinding(dir, "f1", { roadmap: "r1" }).roadmap).toBe("r1");
    expect(patchFinding(dir, "f1", { roadmap: null }).roadmap).toBeNull();
    expect(() => patchFinding(dir, "f1", { status: "bogus" as any })).toThrow(/Status/);
  });
  test("ids cannot leave the findings folder", () => {
    const dir = project();
    for (const id of ["../x", "a/b", "..", ".hidden", ""]) expect(() => readFinding(dir, id)).toThrow();
    expect(() => readFinding(dir, "missing")).toThrow(/no finding/);
    put(dir, "gone", finding());
    removeFinding(dir, "gone");
    expect(listFindings(dir)).toEqual([]);
  });
  test("earlier findings are named in the next prompt, dismissed ones as off limits", () => {
    const dir = project();
    put(dir, "open-one", finding({ title: "Open one" }));
    put(dir, "no-thanks", finding({ title: "Not wanted", status: "dismissed" }));
    const block = priorFindingsBlock(dir);
    expect(block).toContain("open-one: Open one");
    expect(block).toMatch(/Dismissed[\s\S]*no-thanks: Not wanted/);
    const prompt = labPrompt(dir, "perf", "project");
    expect(prompt).toContain("Not wanted");
    expect(prompt).toContain("Measure first");
    expect(prompt).toContain("only files you create or edit are under `lab/findings/`");
  });
});

describe("evidence and run guard", () => {
  test("evidence that points at a file that is gone is reported, prose is not", () => {
    const dir = project();
    put(dir, "f", finding({}, "b").replace("  - web/src/search/Box.tsx:84", "  - src/alpha/a.ts:3\n  - src/alpha/deleted.ts:9\n  - bundle is 2.1 MB"));
    expect(readFinding(dir, "f").missing).toEqual(["src/alpha/deleted.ts:9"]);
    expect(evidencePath("../../etc/passwd:1")).toBeNull();
    expect(evidencePath("src/a.ts#L12")).toBe("src/a.ts");
  });

  test("a run that edits code outside lab/ is flagged, one that only writes findings is not", async () => {
    const dir = project();
    startSweepDriver();
    try {
      setTurnRunner(async () => {
        fs.mkdirSync(path.join(dir, "lab/findings"), { recursive: true });
        fs.writeFileSync(path.join(dir, "lab/findings/ok.md"), finding());
        return ok("done");
      });
      const clean = startLab(dir, "dx", "src/alpha", { engine: "fake" });
      await settled(clean.id);
      await new Promise((r) => setTimeout(r, 50));
      setTurnRunner(async () => {
        fs.writeFileSync(path.join(dir, "src/alpha/a.ts"), "export const a = 2;\n");
        return ok("done");
      });
      const dirty = startLab(dir, "dx", "src/alpha", { engine: "fake" });
      await settled(dirty.id);
      await new Promise((r) => setTimeout(r, 50));
      const runs = new Map(listRuns(dir).map((r) => [r.sessionId, r.touched]));
      expect(runs.get(clean.id)).toEqual([]);
      expect(runs.get(dirty.id)).toEqual(["src/alpha/a.ts"]);
    } finally {
      stopSweepDriver();
    }
  });
});

describe("scope and modules", () => {
  test("a scope is the project, the diff or a path inside it", () => {
    const dir = project();
    expect(checkScope(dir, "")).toBe("project");
    expect(checkScope(dir, ".")).toBe("project");
    expect(checkScope(dir, "diff")).toBe("diff");
    expect(checkScope(dir, "./src/alpha/")).toBe("src/alpha");
    expect(() => checkScope(dir, "../etc")).toThrow(/outside/);
    expect(() => checkScope(dir, "/etc")).toThrow(/outside/);
    expect(() => checkScope(dir, "src/nope")).toThrow(/does not exist/);
  });
  test("modules skip dependencies and folders without source, biggest first", () => {
    const dir = project();
    const mods = discoverModules(dir);
    expect(new Set(mods.map((m) => m.path))).toEqual(new Set(["src/alpha", "web/src/features/chat", "src/beta"]));
    expect(mods[0]!.path).toBe("src/alpha");
    expect(mods.map((m) => m.path)).not.toContain("src/empty");
    expect(mods.find((m) => m.path === "src/beta")).toMatchObject({ files: 2 });
    expect(mods[0]!.tokens).toBeGreaterThanOrEqual(mods[mods.length - 1]!.tokens);
    expect(estimateScope(dir, "project").files).toBe(5); // node_modules is skipped
  });
  test("the diff scope sees uncommitted changes", () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, "src/alpha/new.ts"), "export const n = 1;\n");
    expect(estimateScope(dir, "diff").files).toBe(1);
    expect(labPrompt(dir, "review", "diff")).toContain("src/alpha/new.ts");
  });
  test("a sweep plan caps the modules, says what it left out, and refuses an empty project", () => {
    const dir = project();
    const plan = planSweep(dir, "perf", null, 2);
    expect(plan.modules).toHaveLength(2);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.tokens).toBe(plan.modules.reduce((n, m) => n + m.tokens, 0));
    expect(planSweep(dir, "perf", ["src/beta"]).modules.map((m) => m.path)).toEqual(["src/beta"]);
    expect(() => planSweep(dir, "nonsense", null)).toThrow(/Unknown lens/);
    expect(() => planSweep(makeRepo({ "a.txt": "x\n" }), "perf", null)).toThrow(/no modules/);
  });
});

describe("runs", () => {
  test("a run is a build session in the project, recorded with its lens and scope", async () => {
    const dir = project();
    let seen = "";
    setTurnRunner(async (o) => {
      seen = o.prompt;
      return ok("done");
    });
    const s = startLab(dir, "ui", "src/alpha", { note: "empty states", engine: "fake" });
    await settled(s.id);
    expect(seen).toContain("Lab pass: ui");
    expect(seen).toContain("DESIGN.md");
    expect(seen).toContain("empty states");
    expect(listRuns(dir)).toMatchObject([{ sessionId: s.id, lens: "ui", scope: "src/alpha", sweepId: null }]);
    expect(() => startLab(dir, "bogus", null)).toThrow(/Unknown lens/);
  });
  test("a sweep starts one session per module under one sweep id", async () => {
    const dir = project();
    setTurnRunner(async () => ok("done"));
    const r = startSweep(dir, "dx", ["src/alpha", "src/beta"], { engine: "fake" });
    expect(r.sessions).toHaveLength(2);
    await Promise.all(r.sessions.map((s) => settled(s.id)));
    const runs = listRuns(dir);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((x) => x.sweepId))).toEqual(new Set([r.sweepId]));
    expect(runs.map((x) => x.scope).sort()).toEqual(["src/alpha", "src/beta"]);
  });
});

describe("tables from an earlier version", () => {
  test("a lab_sessions table without the newer columns is upgraded in place, keeping its rows", async () => {
    const dir = project();
    const real = fs.realpathSync(dir);
    // The first version of the table, as an existing install has it.
    db().exec("DROP TABLE IF EXISTS lab_sessions");
    db().exec("CREATE TABLE lab_sessions (session_id TEXT PRIMARY KEY, root_dir TEXT NOT NULL, lens TEXT NOT NULL, scope TEXT NOT NULL, sweep_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
    db().prepare("INSERT INTO lab_sessions (session_id, root_dir, lens, scope) VALUES ('s_old', ?, 'perf', 'src/alpha')").run(real);
    // tables() ran once already in this process; run the upgrade again as a fresh daemon would.
    const { resetLabTables } = await import("../src/lab/sessions");
    resetLabTables();
    expect(listRuns(dir)).toMatchObject([{ sessionId: "s_old", lens: "perf", touched: [] }]);
  });
});

describe("sweep queue", () => {
  const five = () => makeRepo(Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`src/m${n}/a.ts`, `export const m${n} = 1;\n`])));
  /** A runner that holds every turn until released, and counts how many are in flight. */
  let current: { release: () => void } | null = null;
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

  afterEach(() => {
    current?.release(); // nothing may stay held, or interruptAll waits for it
    current = null;
    stopSweepDriver();
  });

  test("only `parallel` run at once, the rest start as those stop, and every module is covered", async () => {
    const dir = five();
    const g = gate();
    startSweepDriver();
    const r = startSweep(dir, "dx", null, { engine: "fake", parallel: 2 });
    expect(r.sessions).toHaveLength(2);
    expect(listSweeps(dir)[0]).toMatchObject({ total: 5, queued: 3, running: 2, done: 0 });
    for (let i = 0; i < 6; i++) {
      await until(() => g.inFlight() > 0 || listSweeps(dir)[0]!.done === 5);
      g.release();
      await new Promise((r) => setTimeout(r, 50));
    }
    await until(() => listSweeps(dir)[0]!.done === 5);
    expect(g.peak()).toBeLessThanOrEqual(2);
    expect(listSweeps(dir)[0]).toMatchObject({ queued: 0, running: 0, done: 5, failed: 0 });
    expect(new Set(listRuns(dir).map((x) => x.scope)).size).toBe(5);
  });

  test("cancelling stops new modules from starting", async () => {
    const dir = five();
    const g = gate();
    startSweepDriver();
    const r = startSweep(dir, "dx", null, { engine: "fake", parallel: 1 });
    expect(cancelSweep(dir, r.sweepId)).toMatchObject({ cancelled: true, queued: 0 });
    await until(() => g.inFlight() === 1);
    g.release();
    await until(() => listSweeps(dir)[0]!.running === 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(listRuns(dir)).toHaveLength(1);
    expect(pumpSweep(r.sweepId)).toEqual([]);
  });

  test("the queue survives a restart: a new driver continues what was left", async () => {
    const dir = five();
    const g = gate();
    const r = startSweep(dir, "dx", null, { engine: "fake", parallel: 1 }); // no driver: nothing follows the first
    await until(() => g.inFlight() === 1);
    g.release();
    await until(() => listSweeps(dir)[0]!.running === 0);
    expect(listSweeps(dir)[0]).toMatchObject({ queued: 4, done: 1 });
    startSweepDriver(); // the daemon came back
    await until(() => listSweeps(dir)[0]!.done >= 2 || g.inFlight() > 0);
    for (let i = 0; i < 8; i++) {
      g.release();
      await new Promise((r) => setTimeout(r, 50));
    }
    await until(() => listSweeps(dir)[0]!.done === 5);
    expect(r.sweepId).toBe(listSweeps(dir)[0]!.id);
  });

  test("a module that vanished is skipped and counted, not fatal", async () => {
    const dir = five();
    setTurnRunner(async () => ok("done"));
    startSweepDriver();
    const r = startSweep(dir, "dx", ["src/m1", "src/m2", "src/m3"], { engine: "fake", parallel: 1 });
    fs.rmSync(path.join(dir, "src/m2"), { recursive: true });
    await until(() => listSweeps(dir)[0]!.done === 2);
    expect(listSweeps(dir)[0]).toMatchObject({ failed: 1, queued: 0 });
    expect(r.sessions).toHaveLength(1);
  });
});

describe("hand-off to the roadmap", () => {
  test("a finding becomes an item in Next, tagged, linked both ways, and sending it twice adds nothing", () => {
    const dir = project();
    put(dir, "search-debounce", finding());
    const r = findingToRoadmap(dir, "search-debounce");
    expect(r.finding).toMatchObject({ status: "accepted", roadmap: r.itemId });
    const rm = readRoadmap(dir);
    expect(rm.exists).toBe(true);
    const next = rm.lanes.find((l) => l.name === "Next")!;
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({ id: r.itemId, title: "Debounce search", tags: ["lab", "perf"] });
    expect(next.items[0]!.description).toContain("lab/findings/search-debounce.md");
    const again = findingToRoadmap(dir, "search-debounce");
    expect(again.itemId).toBe(r.itemId);
    expect(readRoadmap(dir).lanes.flatMap((l) => l.items)).toHaveLength(1);
  });
  test("a lane that does not exist is refused", () => {
    const dir = project();
    put(dir, "f", finding());
    expect(() => findingToRoadmap(dir, "f", "Nowhere")).toThrow(/no lane/);
  });
});

describe("HTTP", () => {
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());

  test("state, patch, roadmap and a run over the API", async () => {
    const dir = project();
    const root = Workspaces.open(dir).id;
    put(dir, "f1", finding());
    setTurnRunner(async () => ok("done"));
    const call = async (p: string, method = "GET", body?: unknown) => {
      const res = await fetch(`${srv.url}/api/lab/${root}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null };
    };
    expect((await fetch(`${srv.url}/api/lab/${root}`)).status).toBe(401);

    const st = await call("");
    expect(st.data.findings).toHaveLength(1);
    expect(st.data.open).toBe(1);
    expect(st.data.lenses.map((l: any) => l.id)).toContain("perf");
    expect(st.data.modules.length).toBeGreaterThan(0);

    const rm = await call("/findings/f1/roadmap", "POST", {});
    expect(rm.data.finding.status).toBe("accepted");
    expect(rm.data.itemId).toBeTruthy();

    expect((await call("/findings/f1", "PATCH", { status: "dismissed" })).data.finding.status).toBe("dismissed");
    expect((await call("/findings/f1", "PATCH", { status: "bogus" })).status).toBe(400);
    expect((await call("/findings/nope", "PATCH", { status: "new" })).status).toBe(400);

    expect((await call("/sweep?lens=perf&limit=1")).data.plan.modules).toHaveLength(1);

    const run = await call("/run", "POST", { lens: "perf", scope: "src/beta", engine: "fake" });
    expect(run.status).toBe(201);
    await settled(run.data.session.id);
    expect((await call("")).data.runs).toHaveLength(1);
    expect((await call("/run", "POST", { lens: "perf", scope: "../x" })).status).toBe(400);
  });
});
