import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { interruptAll, setTurnRunner } from "../src/sessions/manager";
import { compareFindings, evidencePath, listFindings, parseFinding, patchFinding, payoff, priorFindingsBlock, readFinding, removeFinding } from "../src/lab/findings";
import { checkScope, discoverModules, estimateScope, findingToRoadmap, findingToSpec, finishRun, fixFinding, labPrompt, labTurn, listRuns, markRoadmapShipped, planSweep, record, startLab } from "../src/lab/sessions";
import { cancelSweep, listSweeps, pumpSweep, startSweep, startSweepDriver, stopSweepDriver } from "../src/lab/sweeps";
import { readRoadmap, updateRoadmapItem } from "../src/roadmap/store";
import { catalog, setPractices } from "../src/practices/store";
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
    expect(block).toMatch(/Dismissed[\s\S]*- Not wanted — web\/src\/search\/Box.tsx:84/);
    const prompt = labPrompt(dir, "perf", "project");
    expect(prompt).toContain("Not wanted");
    expect(prompt).toContain("Measure first");
    expect(prompt).toContain("only files you create or edit are under `lab/findings/`");
  });
});

describe("security and ux lenses", () => {
  test("security covers authentication, authorization and keeps secrets out of findings", () => {
    const prompt = labPrompt(project(), "security", "project");
    expect(prompt).toMatch(/Authentication:/);
    expect(prompt).toMatch(/Authorization:/);
    expect(prompt).toMatch(/never a real secret/);
    expect(prompt).not.toContain("DESIGN.md");
  });
  test("ux reads the design contract and leaves visual polish to ui", () => {
    const prompt = labPrompt(project(), "ux", "project");
    expect(prompt).toContain("Read DESIGN.md");
    expect(prompt).toContain("belong to the UI pass");
  });
  test("review hands security to its own pass, and both new lenses are accepted", () => {
    expect(labPrompt(project(), "review", "project")).toContain("Security weaknesses have their own pass");
    expect(() => labTurn(project(), "security", null)).not.toThrow();
    expect(() => labTurn(project(), "ux", null)).not.toThrow();
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
    expect(listSweeps(dir)[0]!.lastError).toMatch(/src\/m2/);
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
    expect(st.data.modules).toBeUndefined();
    expect((await call("/modules")).data.modules.length).toBeGreaterThan(0);

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

describe("the stack in every pass", () => {
  test("a lens pass names the detected stack and the file that decided it", () => {
    const dir = makeRepo({ "package.json": JSON.stringify({ dependencies: { next: "15" } }), "app/page.tsx": "export default function P() { return null; }\n" });
    const prompt = labTurn(dir, "security", "project").prompt;
    expect(prompt).toContain("What the files say this project is (detected, not typed by the operator):\nDetected stack: nextjs.");
    expect(prompt).toContain("- package.json depends on next");
    expect(prompt).toContain("Where to look: ");
  });

  test("the checklist lens is not offered in the picker, and its tokens are not lens runs", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    expect(() => labTurn(dir, "checklist", "project")).toThrow(/Checklist passes start from the Checklists panel/);
    expect(() => startLab(dir, "checklist", "checklist:seo:title-length")).toThrow(/answers for a workspace/);
  });
});

/** A turn that stays running for a while: a fix in progress. Short, so the test cleanup does not wait long. */
const slowTurn = () => setTurnRunner(() => new Promise<TurnResult>((resolve) => setTimeout(() => resolve(ok("done")), 1500)));

describe("findings: reading and flagging", () => {
  test("a backslash cannot climb out of the project, in either slash style", () => {
    expect(evidencePath("..\\..\\etc\\passwd:1")).toBeNull();
    expect(evidencePath("src\\..\\..\\x.ts:3")).toBeNull();
    expect(evidencePath("src\\a.ts:3")).toBe("src\\a.ts");
    expect(evidencePath("src/../../x.ts:3")).toBeNull();
  });

  test("a value the parser cannot read falls back, and the file says so in problem; a valid value in another case is fine", () => {
    const f = parseFinding("lab/findings/x.md", "---\ntitle: T\nimpact: huge\neffort: s\nstatus: new\nlens: nope\n---\nbody\n");
    expect(f.impact).toBe("medium");
    expect(f.problem).toMatch(/impact "huge" is not one of high, medium, low/);
    expect(f.problem).toMatch(/lens "nope" is not one of/);
    expect(parseFinding("lab/findings/y.md", "---\ntitle: T\nimpact: Low\n---\n").problem).toBeNull();
  });

  test("a file too big to read is listed with a problem, not dropped", () => {
    const dir = project();
    put(dir, "big", `---\ntitle: Big\n---\n${"x".repeat(210_000)}`);
    const big = listFindings(dir).find((f) => f.id === "big")!;
    expect(big.problem).toMatch(/over the 200 KB limit, so it is not read/);
    expect(big.status).toBe("new");
  });

  test("evidence whose line changed since the run that cited it shows as drifted", () => {
    const dir = project();
    record(dir, "s_drift", "perf", "src/alpha", null);
    put(dir, "w1", "---\ntitle: Alpha\nlens: perf\nscope: src/alpha\nimpact: low\neffort: s\nstatus: new\nevidence:\n  - src/alpha/a.ts:1\n---\nBody.\n");
    finishRun("s_drift");
    expect(readFinding(dir, "w1").evidenceHashes["src/alpha/a.ts:1"]).toMatch(/^[0-9a-f]{8}$/);
    expect(listFindings(dir).find((f) => f.id === "w1")!.drifted).toEqual([]);
    const file = path.join(dir, "src/alpha/a.ts");
    fs.writeFileSync(file, "export const z = 9;\n" + fs.readFileSync(file, "utf8").split("\n").slice(1).join("\n"));
    expect(listFindings(dir).find((f) => f.id === "w1")!.drifted).toEqual(["src/alpha/a.ts:1"]);
  });
});

describe("the prior findings block", () => {
  test("every dismissed finding is listed by title and evidence, not only the first 60", () => {
    const dir = project();
    for (let i = 0; i < 70; i++) put(dir, `d${i}`, finding({ title: `Dismissed idea ${i}`, status: "dismissed" }));
    const block = priorFindingsBlock(dir);
    expect(block).toContain("- Dismissed idea 0 — web/src/search/Box.tsx:84");
    expect(block).toContain("- Dismissed idea 69 — web/src/search/Box.tsx:84");
    expect(block).toContain("A repeat matches a title or an evidence path");
  });

  test("past the budget, the oldest are counted, not listed", () => {
    const dir = project();
    for (let i = 0; i < 200; i++) put(dir, `d${i}`, finding({ title: `A dismissed idea with a fairly long title number ${i}`, status: "dismissed" }));
    expect(priorFindingsBlock(dir)).toMatch(/…and \d+ older, not listed\./);
  });
});

describe("lifecycle, stamping and restores", () => {
  test("a finding whose roadmap item is done becomes shipped", () => {
    const dir = project();
    put(dir, "s1", finding());
    const r = findingToRoadmap(dir, "s1");
    const item = readRoadmap(dir).lanes.flatMap((l) => l.items).find((i) => i.id === r.itemId)!;
    expect(markRoadmapShipped(dir)).toEqual([]);
    updateRoadmapItem(dir, item.key, { done: true });
    expect(markRoadmapShipped(dir)).toEqual(["s1"]);
    expect(readFinding(dir, "s1").status).toBe("shipped");
  });

  test("a run stamps the findings it wrote with its session", () => {
    const dir = project();
    record(dir, "s_stamp", "perf", "project", null);
    put(dir, "w2", finding());
    finishRun("s_stamp");
    expect(readFinding(dir, "w2")).toMatchObject({ session: "s_stamp" });
  });

  test("a run that rewrites a dismissed finding as new has its status restored, with a note", () => {
    const dir = project();
    put(dir, "d1", finding({ status: "dismissed" }));
    record(dir, "s_over", "perf", "project", null);
    put(dir, "d1", finding({ status: "new" }));
    finishRun("s_over");
    const f = readFinding(dir, "d1");
    expect(f.status).toBe("dismissed");
    expect(f.body).toContain("Lab note: this run rewrote the finding as new");
  });

  test("a second spec is refused, and a second fix is refused while the first runs", () => {
    const dir = project();
    put(dir, "f9", finding());
    slowTurn();
    const first = fixFinding(dir, "f9");
    expect(() => fixFinding(dir, "f9")).toThrow(/already running/);
    expect(readFinding(dir, "f9")).toMatchObject({ status: "accepted", fixSession: first.session.id });
    patchFinding(dir, "f9", { spec: "specs/106-search" });
    expect(() => findingToSpec(dir, "f9")).toThrow(/already has a spec: specs\/106-search/);
  });

  test("a fix whose turn ends without shipped stays accepted, with one note", () => {
    const dir = project();
    put(dir, "f10", finding());
    slowTurn();
    const r = fixFinding(dir, "f10");
    finishRun(r.session.id);
    finishRun(r.session.id);
    const f = readFinding(dir, "f10");
    expect(f.status).toBe("accepted");
    expect(f.body.split("ended its turn without marking this finding shipped").length - 1).toBe(1);
  });
});

describe("the review lens and practices", () => {
  test("the review lens carries the enabled practice packs and their rules; other lenses do not", () => {
    const dir = project();
    const ws = Workspaces.open(dir).id;
    setPractices(ws, { enabled: ["kiss"] });
    const pack = catalog().find((p) => p.id === "kiss")!;
    const review = labPrompt(dir, "review", "project");
    expect(review).toContain("Practice packs enabled for this workspace");
    expect(review).toContain(`${pack.title}:`);
    expect(review).toContain(`  - ${pack.rules[0]}`);
    expect(labPrompt(dir, "perf", "project")).not.toContain("Practice packs enabled");
  });

  test("the features lens names the open roadmap items, and the security lens names SECURITY.md", () => {
    const dir = project();
    put(dir, "s2", finding());
    findingToRoadmap(dir, "s2");
    fs.writeFileSync(path.join(dir, "SECURITY.md"), "Accepted: local-only tokens.\n");
    expect(labPrompt(dir, "features", "project")).toContain("Open roadmap items (already planned");
    expect(labPrompt(dir, "security", "project")).toContain("SECURITY.md (what the project already accepts as a risk");
    expect(labPrompt(dir, "security", "project")).toContain("Accepted: local-only tokens.");
  });

  test("the prompt tells a pass to dedupe by evidence as well as title, and never to overwrite a file", () => {
    const p = labPrompt(project(), "dx", "project");
    expect(p).toContain("matches one listed, even under another id");
    expect(p).toContain("choose another id: never overwrite a file you did not write in this pass");
  });
});

describe("the summary and the modules endpoint", () => {
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());

  test("the badge reads a summary; modules come from their own endpoint; a bad limit is a 400", async () => {
    const dir = project();
    const root = Workspaces.open(dir).id;
    put(dir, "a1", finding());
    const call = async (p: string) => {
      const res = await fetch(`${srv.url}/api/lab/${root}${p}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      return { status: res.status, data: await res.json() };
    };
    expect((await call("/summary")).data).toEqual({ open: 1, bugs: 0, total: 1, running: 0 });
    expect((await call("")).data.modules).toBeUndefined();
    expect((await call("/modules")).data.modules.length).toBeGreaterThan(0);
    expect((await call("/sweep?lens=perf&limit=abc")).status).toBe(400);
    expect((await call("/sweep?lens=perf&limit=0")).status).toBe(400);
  });
});
