import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { findChrome } from "../src/browser/chrome";
import { Database } from "bun:sqlite";
import { db, migrate } from "../src/db";
import type { RunTurnOptions, TurnResult } from "../src/engines/runner";
import { HydraPairs } from "../src/hydra/pairs";
import { createBugFinding, patchFinding, readFinding } from "../src/lab/findings";
import { runningFix } from "../src/lab/sessions";
import { continuePipeline, deletePlan, featureDetail, qaBoard, runReply, startPipeline, startQaDriver, stopPipeline, stopQaDriver, tickProject } from "../src/qa/jobs";
import { QaConflict, QaNotFound } from "../src/qa/plan";
import { jobOfSession } from "../src/qa/registry";
import { runsOfSession, setOutcome } from "../src/qa/runs";
import type { Job, PipelineRequest, PipelineView, StageSettings } from "../src/qa/types";
import { createLead, getSession, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { resetSetting, setSetting } from "../src/settings";
import { makeDir, makeRepo, resetState } from "./helpers";

setDefaultTimeout(60_000);

const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what = "condition", ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

interface Turn { session: string; prompt: string; cwd: string }
let dir: string;
let turns: Turn[];
let work: (t: Turn) => void | Promise<void>;
let hold: Set<string> | "all" | null;
const gates = new Map<string, () => void>();
const opened = new Set<string>();

const planText = (title: string) => `---\ntitle: ${title}\n---\nIntro.\n## Steps\n1. Open it\n   path: /x\n   expect: It opens\n2. Do it\n   expect: It is done\n`;
const FEATURES = "# Features\n## Alpha\nid: a\nwhere: /a\nThe A.\n## Beta\nid: b\nwhere: /b\nThe B.\n## Gamma\nid: c\nwhere: /c\nThe C.\n";
const putFeatures = (text = FEATURES) => {
  fs.mkdirSync(path.join(dir, "lab"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lab/features.md"), text);
};
const putPlan = (id: string, text = planText(id)) => {
  fs.mkdirSync(path.join(dir, "lab/qa"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lab/qa", `${id}.md`), text);
};
const bug = (title: string, o: { url?: string; feature?: string | null } = {}) =>
  createBugFinding(dir, { title, body: "Steps to reproduce\n1. Do it", bug: { url: o.url ?? "http://localhost:3000/a", capture: null, shot: "none", kind: "functional", feature: o.feature ?? null }, impact: "medium", effort: "s" });

function goodWork(t: Turn): void {
  const j = jobOfSession(t.session);
  if (!j) return;
  if (j.stage === "map") fs.appendFileSync(path.join(dir, "lab/features.md"), "\n## Delta\nid: delta\nwhere: /d\nThe D.\n");
  if (j.stage === "plan") for (const u of j.units) putPlan(u);
  if (j.stage === "test") for (const r of runsOfSession(t.session)) for (const s of r.steps) setOutcome(r.id as never, s.id as never, { state: "pass", at: 1, note: "ok" });
  if (j.stage === "fix") for (const u of j.units) patchFinding(dir, u, { status: "shipped" });
}

beforeEach(() => {
  resetState();
  db().exec("DELETE FROM qa_runs; DELETE FROM qa_jobs; DELETE FROM qa_pipelines");
  process.env.TRB_CHROME = process.execPath;
  findChrome({ fresh: true });
  setSetting("agent_browser", "on");
  dir = makeDir();
  putFeatures();
  turns = [];
  work = goodWork;
  hold = null;
  setTurnRunner(async (o: RunTurnOptions) => {
    const session = o.key.slice(0, o.key.indexOf("-"));
    const t = { session, prompt: o.prompt, cwd: o.cwd };
    turns.push(t);
    if ((hold === "all" || hold?.has(session)) && !opened.has(session)) await new Promise<void>((r) => gates.set(session, r));
    await work(t);
    return ok("done");
  });
  startQaDriver();
});
afterEach(async () => {
  stopQaDriver();
  for (const open of gates.values()) open();
  gates.clear();
  opened.clear();
  await interruptAll();
  setTurnRunner(null);
  resetSetting("agent_browser");
});

const request = (stages: StageSettings, o: Partial<PipelineRequest> = {}): PipelineRequest => ({ stages, scope: { kind: "all" }, pace: "auto", driver: { kind: "agent" }, ...o });
const view = (): PipelineView => qaBoard(dir).pipeline!;
const ended = () => view().control.kind === "ended";
const release = (...sessions: string[]) => {
  for (const s of sessions) {
    opened.add(s);
    gates.get(s)?.();
  }
};
const releaseAll = () => {
  hold = null;
  for (const open of gates.values()) open();
};
async function run(body: PipelineRequest): Promise<PipelineView> {
  startPipeline(dir, body);
  await until(ended, "the pipeline to end");
  return view();
}
const pairOf = (o: { max?: number } = {}) => HydraPairs.create({ title: "P", lead_engine: "claude", lead_model: "pair-model", lead_effort: "high", ...(o.max ? { max_heads: o.max } : {}) });

describe("start, continue and stop", () => {
  test("a start launches the first stage's jobs; a second start is refused; a held pipeline is superseded", async () => {
    hold = "all";
    const v = startPipeline(dir, request({ plan: { batching: "each" }, test: { batching: "each" } }, { pace: "step" }));
    expect(v.control).toEqual({ kind: "running", stage: "plan" });
    expect(v.jobs.map((j) => j.units)).toEqual([["a"], ["b"], ["c"]]);
    expect(v.jobs.every((j) => j.sessionId && j.state === "running" && !j.pair)).toBe(true);
    expect(v.stages.find((s) => s.stage === "plan")).toMatchObject({ state: "current", done: 0, total: 3 });
    expect(() => startPipeline(dir, request({ plan: { batching: "each" } }))).toThrow(QaConflict);
    expect(() => startPipeline(dir, request({ plan: { batching: "each" } }))).toThrow("A QA pipeline is already running in this project. Stop it or wait for it.");

    hold = null;
    release(...v.jobs.map((j) => j.sessionId!));
    await until(() => view().control.kind === "held", "the pipeline to hold");
    expect(view().control).toEqual({ kind: "held", after: "plan", next: "test" });
    expect(view().stages.map((s) => s.state)).toEqual(["skipped", "done", "held", "skipped"]);

    const next = startPipeline(dir, request({ map: {} }));
    expect(next.id).not.toBe(v.id);
    const old = db().prepare("SELECT control FROM qa_pipelines WHERE id = ?").get(v.id) as { control: string };
    expect(JSON.parse(old.control)).toMatchObject({ kind: "ended", reason: "superseded" });
  });

  test("continue moves a held pipeline on with fresh units; anything else is a 409", async () => {
    const v = startPipeline(dir, request({ plan: { batching: "each" }, test: { batching: "each" } }, { pace: "step" }));
    expect(() => continuePipeline(dir, v.id)).toThrow("The pipeline is not waiting to continue.");
    await until(() => view().control.kind === "held");
    expect(view().stages.find((s) => s.stage === "plan")).toMatchObject({ state: "done", done: 3, total: 3 });
    const c = continuePipeline(dir, v.id);
    expect(c.control).toEqual({ kind: "running", stage: "test" });
    expect(c.jobs.filter((j) => j.stage === "test").map((j) => j.units)).toEqual([["a"]]);
    expect(() => continuePipeline(dir, "qap_nope")).toThrow(QaNotFound);
    await until(ended);
    expect(view().control).toMatchObject({ kind: "ended", reason: "done" });
    expect(() => continuePipeline(dir, v.id)).toThrow(QaConflict);
  });

  test("stop lets the running job finish, launches nothing new, and ends as stopped; stopping again changes nothing", async () => {
    putPlan("a");
    putPlan("b");
    hold = "all";
    const v = startPipeline(dir, request({ test: { batching: "each" } }));
    expect(v.jobs).toHaveLength(1);
    const s = stopPipeline(dir, v.id);
    expect(s.control).toEqual({ kind: "stopping", stage: "test" });
    expect(stopPipeline(dir, v.id).control.kind).toBe("stopping");
    release(v.jobs[0]!.sessionId!);
    await until(ended);
    expect(view().control).toMatchObject({ kind: "ended", reason: "stopped" });
    expect(view().jobs).toHaveLength(1);
    const after = view().control;
    expect(stopPipeline(dir, v.id).control).toEqual(after);
  });

  test("stopping a held pipeline ends it at once", async () => {
    const v = startPipeline(dir, request({ plan: { batching: "each" }, test: { batching: "each" } }, { pace: "step" }));
    await until(() => view().control.kind === "held");
    expect(stopPipeline(dir, v.id).control).toMatchObject({ kind: "ended", reason: "stopped" });
    expect(() => stopPipeline(dir, "qap_nope")).toThrow(QaNotFound);
  });

  test("a pipeline that starts with a stage that has no units ends at once, with that stage 0/0", async () => {
    const v = startPipeline(dir, request({ test: { batching: "each" } }));
    expect(v.control).toMatchObject({ kind: "ended", reason: "done" });
    expect(v.stages.find((s) => s.stage === "test")).toMatchObject({ done: 0, total: 0 });
    expect(turns).toHaveLength(0);
  });

  test("the config is validated and the agent browser is required for map, plan and test", () => {
    expect(() => startPipeline(dir, { stages: {}, scope: { kind: "all" }, pace: "auto", driver: { kind: "agent" } })).toThrow("Pick at least one stage.");
    setSetting("agent_browser", "off");
    expect(() => startPipeline(dir, request({ map: {} }))).toThrow("trb config set agent_browser on");
    expect(db().prepare("SELECT COUNT(*) AS n FROM qa_pipelines").get()).toEqual({ n: 0 });
    bug("Only fixing");
    expect(startPipeline(dir, request({ fix: { batching: "each" } })).control.kind).toBe("running");
  });
});

describe("scheduling", () => {
  test("racing ticks and repeated turn-end events launch a unit once", async () => {
    putPlan("a");
    putPlan("b");
    putPlan("c");
    hold = "all";
    const v = startPipeline(dir, request({ test: { batching: "each" } }));
    tickProject(dir);
    tickProject(dir);
    await Promise.all([Promise.resolve().then(() => tickProject(dir)), Promise.resolve().then(() => tickProject(dir))]);
    expect(view().jobs).toHaveLength(1);
    await until(() => turns.length === 1);
    await sleep(50);
    expect(turns).toHaveLength(1);
    expect(db().prepare("SELECT COUNT(*) AS n FROM qa_runs").get()).toEqual({ n: 1 });
    hold = null;
    release(v.jobs[0]!.sessionId!);
    await until(ended);
    expect(view().jobs.map((j) => j.units)).toEqual([["a"], ["b"], ["c"]]);
    expect(new Set(turns.map((t) => t.session)).size).toBe(3);
  });

  test("a restart resumes where the pipeline was and does not launch a covered unit again", async () => {
    putPlan("a");
    putPlan("b");
    stopQaDriver();
    const v = startPipeline(dir, request({ test: { batching: "each" } }));
    await until(() => turns.length === 1);
    await sleep(50);
    expect(view().jobs).toHaveLength(1);
    expect(view().jobs[0]!.state).toBe("running");

    tickProject(dir);
    tickProject(dir);
    expect(view().jobs).toHaveLength(1);

    startQaDriver();
    await until(ended);
    expect(view().jobs.map((j) => [j.units, j.state])).toEqual([[["a"], "settled"], [["b"], "settled"]]);
    expect(turns).toHaveLength(2);
    expect(view().id).toBe(v.id);
  });

  test("a job whose lead is still working is not settled, and the pipeline waits for it", async () => {
    putPlan("a");
    hold = "all";
    const v = startPipeline(dir, request({ test: { batching: "each" } }));
    await sleep(100);
    tickProject(dir);
    expect(view().jobs[0]!.state).toBe("running");
    expect(view().control.kind).toBe("running");
    release(v.jobs[0]!.sessionId!);
    await until(ended);
  });

  test("plan each opens three at a time and tops up as they finish", async () => {
    putFeatures(FEATURES + "## Delta\nid: d\nwhere: /d\nThe D.\n## Epsilon\nid: e\nwhere: /e\nThe E.\n");
    hold = "all";
    const v = startPipeline(dir, request({ plan: { batching: "each" } }));
    expect(v.jobs.map((j) => j.units[0])).toEqual(["a", "b", "c"]);
    release(v.jobs[0]!.sessionId!);
    await until(() => view().jobs.length === 4);
    expect(view().jobs[3]!.units).toEqual(["d"]);
    releaseAll();
    await until(() => view().jobs.length === 5);
    releaseAll();
    await until(ended);
  });

  test("together puts every unit in one job", async () => {
    const v = await run(request({ plan: { batching: "together" } }));
    expect(v.jobs).toHaveLength(1);
    expect(v.jobs[0]!.units).toEqual(["a", "b", "c"]);
    expect(v.jobs[0]!.problem).toBeNull();
    expect(v.stages.find((s) => s.stage === "plan")).toMatchObject({ done: 3, total: 3 });
  });

  test("a launch that throws is recorded on its job, removes its runs and is never retried; the pipeline goes on", async () => {
    putPlan("a");
    putPlan("b");
    const pair = pairOf();
    const v = startPipeline(dir, request({ test: { batching: "each" } }, { driver: { kind: "pair", pairId: pair.id } }));
    expect(v.jobs[0]).toMatchObject({ units: ["a"], state: "running" });
    HydraPairs.remove(pair.id);
    await until(ended);
    const jobs = view().jobs;
    expect(jobs.map((j) => [j.units[0], j.state, j.error])).toEqual([["a", "settled", null], ["b", "settled", expect.stringContaining("No Hydra pair")]]);
    expect(jobs[1]).toMatchObject({ sessionId: null, pair: false });
    expect(view().stages.find((s) => s.stage === "test")).toMatchObject({ done: 2, total: 2, problems: 1 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM qa_runs WHERE plan = 'b'").get()).toEqual({ n: 0 });
    tickProject(dir);
    expect(view().jobs).toHaveLength(2);
  });

  test("turning the browser off between jobs makes the next launch an error job, not a crash", async () => {
    putPlan("a");
    putPlan("b");
    hold = "all";
    const v = startPipeline(dir, request({ test: { batching: "each" } }));
    setSetting("agent_browser", "off");
    release(v.jobs[0]!.sessionId!);
    await until(ended);
    expect(view().jobs[1]).toMatchObject({ units: ["b"], sessionId: null, error: expect.stringContaining("agent browser is off") });
  });
});

describe("the artifact check", () => {
  type Case = { name: string; stages: StageSettings; scope?: PipelineRequest["scope"]; before?: () => void; work?: (t: Turn) => void; problem: string | null };
  const clean = (t: Turn) => goodWork(t);
  const cases: Case[] = [
    { name: "map: no file", stages: { map: {} }, before: () => fs.rmSync(path.join(dir, "lab/features.md")), work: () => {}, problem: "The agent did not write lab/features.md." },
    { name: "map: unchanged", stages: { map: {} }, work: () => {}, problem: "The agent did not change lab/features.md." },
    { name: "map: no features", stages: { map: {} }, work: () => putFeatures("# Features\nnothing\n"), problem: 'lab/features.md lists no features: each starts with "## ".' },
    { name: "map: a parse problem", stages: { map: {} }, work: () => putFeatures("## X\nid: Not Valid\n"), problem: '"X" has the id "Not Valid": use lowercase letters, digits and dashes.' },
    { name: "map: written", stages: { map: {} }, work: clean, problem: null },
    { name: "plan: no file", stages: { plan: { batching: "each" } }, scope: { kind: "features", ids: ["a"] }, work: () => {}, problem: "a: no plan written." },
    { name: "plan: unreadable", stages: { plan: { batching: "each" } }, scope: { kind: "features", ids: ["a"] }, work: () => putPlan("a", "junk"), problem: "a: the file must start with a --- front matter block" },
    { name: "plan: no steps", stages: { plan: { batching: "each" } }, scope: { kind: "features", ids: ["a"] }, work: () => putPlan("a", "---\ntitle: A\n---\n## Steps\n"), problem: "a: the plan has no steps." },
    { name: "plan: unchanged", stages: { plan: { batching: "each" } }, scope: { kind: "features", ids: ["a"] }, before: () => putPlan("a"), work: () => {}, problem: "a: the plan was not changed." },
    { name: "plan: revised", stages: { plan: { batching: "each" } }, scope: { kind: "features", ids: ["a"] }, before: () => putPlan("a"), work: () => putPlan("a", planText("A, revised")), problem: null },
    { name: "plan together: a problem per unit", stages: { plan: { batching: "together" } }, work: () => putPlan("b"), problem: "a: no plan written.; c: no plan written." },
    { name: "test: steps left", stages: { test: { batching: "each" } }, scope: { kind: "features", ids: ["a"] }, before: () => putPlan("a"), work: (t) => { const r = runsOfSession(t.session)[0]!; setOutcome(r.id as never, r.steps[0]!.id as never, { state: "pass", at: 1, note: "" }); }, problem: "a: 1 of 2 steps not recorded." },
    { name: "test: all recorded", stages: { test: { batching: "each" } }, scope: { kind: "features", ids: ["a"] }, before: () => putPlan("a"), work: clean, problem: null },
    { name: "test together: the unrecorded flow is named", stages: { test: { batching: "together" } }, scope: { kind: "features", ids: ["a", "b"] }, before: () => { putPlan("a"); putPlan("b"); }, work: (t) => { for (const r of runsOfSession(t.session).filter((x) => x.feature === "a")) for (const s of r.steps) setOutcome(r.id as never, s.id as never, { state: "skip", at: 1, note: "n/a" }); }, problem: "b: 2 of 2 steps not recorded." },
    { name: "fix: still open", stages: { fix: { batching: "each" } }, before: () => bug("Open one"), work: () => {}, problem: "bug-open-one: still open." },
    { name: "fix: shipped", stages: { fix: { batching: "each" } }, before: () => bug("Open one"), work: clean, problem: null },
    { name: "fix: dismissed", stages: { fix: { batching: "each" } }, before: () => bug("Open one"), work: (t) => { for (const u of jobOfSession(t.session)!.units) patchFinding(dir, u, { status: "dismissed" }); }, problem: null },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      c.before?.();
      work = c.work ?? goodWork;
      const v = await run(request(c.stages, c.scope ? { scope: c.scope } : {}));
      expect(v.jobs).toHaveLength(1);
      expect(v.jobs[0]!.problem).toBe(c.problem);
      expect(v.stages.find((s) => s.stage === (Object.keys(c.stages)[0] as never))!.problems).toBe(c.problem ? 1 : 0);
    });
  }
});

describe("pairs", () => {
  test("map, plan and fix lead a Hydra pair with its head cap; test is a plain session on the lead's engine, model and effort", async () => {
    const pair = pairOf({ max: 3 });
    putPlan("a");
    bug("Pair bug");
    for (const [stages, scope] of [[{ map: {} }, undefined], [{ plan: { batching: "each" } }, { kind: "features", ids: ["a"] }], [{ fix: { batching: "each" } }, undefined]] as const) {
      const v = await run(request(stages as StageSettings, { driver: { kind: "pair", pairId: pair.id }, ...(scope ? { scope: scope as unknown as PipelineRequest["scope"] } : {}) }));
      const s = getSession(v.jobs[0]!.sessionId!)!;
      expect(s.pair_id).toBe(pair.id);
      expect(v.jobs[0]!.pair).toBe(true);
      expect(turns.find((t) => t.session === s.id)!.prompt).toContain("You lead a Hydra pair.");
      expect(turns.find((t) => t.session === s.id)!.prompt).toContain("at most 3");
    }
    const test = await run(request({ test: { batching: "each" } }, { driver: { kind: "pair", pairId: pair.id }, scope: { kind: "features", ids: ["a"] } }));
    const lead = getSession(test.jobs[0]!.sessionId!)!;
    expect(lead.pair_id).toBeNull();
    expect([lead.engine, lead.model, lead.effort]).toEqual(["claude", "pair-model", "high"]);
    expect(test.jobs[0]!.pair).toBe(false);
    expect(turns.find((t) => t.session === lead.id)!.prompt).not.toContain("Hydra pair");
  });

  test("an agent driver's engine, model and effort are used for the lead", async () => {
    putPlan("a");
    const v = await run(request({ test: { batching: "each" } }, { driver: { kind: "agent", model: "my-model", effort: "low" }, scope: { kind: "features", ids: ["a"] } }));
    const s = getSession(v.jobs[0]!.sessionId!)!;
    expect([s.model, s.effort, s.cwd, s.isolation]).toEqual(["my-model", "low", dir, "none"]);
  });
});

describe("fix", () => {
  test("a fix job accepts its bugs and takes them as its fix session, which Lab sees as the running fix", async () => {
    const a = bug("Alpha bug", { url: "http://localhost:3000/zzz" });
    hold = "all";
    const v = startPipeline(dir, request({ fix: { batching: "each" } }));
    const session = v.jobs[0]!.sessionId!;
    const f = readFinding(dir, a.id);
    expect([f.status, f.fixSession]).toEqual(["accepted", session]);
    expect(runningFix(dir)).toEqual({ findingId: a.id, sessionId: session });
    expect(qaBoard(dir).bugsWithoutFeature.find((b) => b.id === a.id)).toMatchObject({ state: "fixing", fixSession: session });
    release(session);
    await until(ended);
    expect(readFinding(dir, a.id).status).toBe("shipped");
    expect(view().jobs[0]!.problem).toBeNull();
  });

  test("fix each runs one bug at a time in id order; together fixes them in one job", async () => {
    bug("Zed bug");
    bug("Alpha bug");
    const each = await run(request({ fix: { batching: "each" } }));
    expect(each.jobs.map((j) => j.units)).toEqual([["bug-alpha-bug"], ["bug-zed-bug"]]);
    const a = bug("Beta bug");
    const c = bug("Gamma bug");
    const together = await run(request({ fix: { batching: "together" } }));
    expect(together.jobs.map((j) => j.units)).toEqual([[a.id, c.id]]);
  });

  test("a feature scope takes the bugs of those features, found by their stored feature or their page", async () => {
    const stored = bug("Stored", { url: "http://localhost:3000/elsewhere", feature: "a" });
    const byUrl = bug("By url", { url: "http://localhost:3000/a/deep" });
    bug("Other", { url: "http://localhost:3000/b" });
    bug("Nowhere", { url: "http://localhost:3000/zzz" });
    const v = await run(request({ fix: { batching: "together" } }, { scope: { kind: "features", ids: ["a"] } }));
    expect(v.jobs[0]!.units).toEqual([byUrl.id, stored.id].sort());
  });

  test("a bugs scope fixes the named bugs that are still open", async () => {
    const a = bug("Alpha bug");
    const b = bug("Beta bug");
    patchFinding(dir, b.id, { status: "shipped" });
    const v = await run(request({ fix: { batching: "each" } }, { scope: { kind: "bugs", ids: [a.id, b.id, "bug-gone"] } }));
    expect(v.jobs.map((j) => j.units)).toEqual([[a.id]]);
  });

  test("a fix lock held by a Lab fix keeps the pipeline waiting, and releasing it lets the fix launch", async () => {
    const lab = bug("Lab bug");
    const mine = bug("Mine");
    hold = "all";
    const labSession = createLead({ prompt: "fix it", cwd: dir, isolate: false }).id;
    patchFinding(dir, lab.id, { status: "accepted", fix_session: labSession });
    await until(() => getSession(labSession)!.status === "running");
    expect(runningFix(dir)?.sessionId).toBe(labSession);

    startPipeline(dir, request({ fix: { batching: "each" } }, { scope: { kind: "bugs", ids: [mine.id] } }));
    tickProject(dir);
    expect(view().jobs).toHaveLength(0);
    expect(readFinding(dir, mine.id).status).toBe("new");

    hold = null;
    release(labSession);
    await until(() => view().jobs.length === 1, "the fix to launch");
    await until(ended);
    expect(readFinding(dir, mine.id).status).toBe("shipped");
  });
});

describe("merging heads", () => {
  function head(lead: string, o: { status?: string } = {}) {
    const repo = makeRepo({ "a.txt": "one\n" });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo }).toString().trim();
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "head-branch");
    fs.writeFileSync(path.join(repo, "b.txt"), "two\n");
    git("add", "-A");
    git("commit", "-qm", "head work");
    const tip = git("rev-parse", "HEAD");
    const id = `s_head${Math.random().toString(36).slice(2, 8)}`;
    db()
      .prepare("INSERT INTO sessions (id, title, parent_id, root_id, depth, engine, status, cwd, base_cwd, isolation, worktree_root, worktree_git_root, branch, base_sha, head_sha) VALUES (?, 'h', ?, ?, 1, 'claude', ?, ?, ?, 'worktree', ?, ?, 'head-branch', ?, ?)")
      .run(id, lead, lead, o.status ?? "idle", repo, repo, repo, repo, base, tip);
    return { id, tip };
  }
  const nudges = () => turns.filter((t) => t.prompt.includes("finished with commits that are not merged"));

  test("a lead whose head left commits unmerged is nudged once; the job settles after the nudge turn, merged or not", async () => {
    bug("Pair bug");
    const pair = pairOf();
    let made: { id: string; tip: string } | null = null;
    work = (t) => {
      const j = jobOfSession(t.session)!;
      if (nudges().length === 0 && !t.prompt.includes("finished with commits")) {
        made = head(t.session);
        for (const u of j.units) patchFinding(dir, u, { status: "shipped" });
      } else db().prepare("UPDATE sessions SET merged_at = CURRENT_TIMESTAMP, merged_sha = ? WHERE id = ?").run(made!.tip, made!.id);
    };
    const v = startPipeline(dir, request({ fix: { batching: "each" } }, { driver: { kind: "pair", pairId: pair.id } }));
    await until(ended);
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]!.prompt).toContain(`Your heads ${made!.id} finished with commits that are not merged.`);
    expect(nudges()[0]!.session).toBe(v.jobs[0]!.sessionId!);
    expect(view().jobs[0]).toMatchObject({ state: "settled", problem: null });
  });

  test("a head still unmerged after the nudge is a problem, and the lead is not nudged a second time", async () => {
    bug("Pair bug");
    const pair = pairOf();
    let made = false;
    work = (t) => {
      if (!made) {
        made = true;
        head(t.session);
      }
      for (const u of jobOfSession(t.session)!.units) patchFinding(dir, u, { status: "shipped" });
    };
    await run(request({ fix: { batching: "each" } }, { driver: { kind: "pair", pairId: pair.id } }));
    expect(nudges()).toHaveLength(1);
    expect(view().jobs[0]!.problem).toMatch(/^heads not merged: s_head\w+\.$/);
  });

  test("a crashed head does not stall settling and is not nudged", async () => {
    bug("Pair bug");
    const pair = pairOf();
    let made = false;
    work = (t) => {
      if (!made) {
        made = true;
        head(t.session, { status: "failed" });
      }
      for (const u of jobOfSession(t.session)!.units) patchFinding(dir, u, { status: "shipped" });
    };
    await run(request({ fix: { batching: "each" } }, { driver: { kind: "pair", pairId: pair.id } }));
    expect(nudges()).toHaveLength(0);
    expect(view().jobs[0]).toMatchObject({ state: "settled", problem: null });
  });

  test("a job is merging while the nudge turn runs", async () => {
    bug("Pair bug");
    const pair = pairOf();
    let first = true;
    work = async (t) => {
      if (first) {
        first = false;
        head(t.session);
        for (const u of jobOfSession(t.session)!.units) patchFinding(dir, u, { status: "shipped" });
        return;
      }
      hold = null;
      await until(() => view().jobs[0]!.state === "merging", "the job to show merging");
    };
    await run(request({ fix: { batching: "each" } }, { driver: { kind: "pair", pairId: pair.id } }));
    expect(nudges()).toHaveLength(1);
  });
});

describe("the board", () => {
  const MAP = "# Features\n## Checkout\nid: checkout\nwhere: /cart, /checkout\nPays.\n## Invite\nid: invite\nwhere: /team\nInvites.\n## Discount\nid: discount\nparent: checkout\nwhere: /cart/discount\nA code.\n## Lonely\nid: lonely\n";

  test("features come parent first with their children, each with its plan, last run and bugs", () => {
    putFeatures(MAP);
    putPlan("checkout");
    putPlan("invite", "junk");
    putPlan("old-flow");
    const board0 = qaBoard(dir);
    expect(board0.features.map((f) => [f.id, f.depth, f.parent])).toEqual([["checkout", 0, null], ["discount", 1, "checkout"], ["invite", 0, null], ["lonely", 0, null]]);
    expect(board0.features.map((f) => f.plan.kind)).toEqual(["ready", "missing", "broken", "missing"]);
    expect(board0.features[0]!.plan).toMatchObject({ kind: "ready", steps: 2 });
    expect(board0.features[2]!.plan).toMatchObject({ kind: "broken", problem: expect.stringContaining("front matter") });
    expect(board0.plansWithoutFeature).toEqual([{ slug: "old-flow", title: "old-flow", steps: 2, problem: null, path: "lab/qa/old-flow.md" }]);
    expect(board0.map).toMatchObject({ exists: true, problem: null, activity: { kind: "idle" } });
    expect(board0.browser).toBe(true);
    expect(board0.pipeline).toBeNull();
    expect(board0.features.every((f) => f.test.kind === "never")).toBe(true);
  });

  test("bugs sit under their stored feature, else the feature their page matches, else with the unsorted; their state is derived", () => {
    putFeatures(MAP);
    const stored = bug("Stored", { url: "http://localhost:3000/nowhere", feature: "invite" });
    const url = bug("By url", { url: "http://localhost:3000/cart/discount/extra" });
    const gone = bug("Stale feature", { url: "http://localhost:3000/team", feature: "ghost" });
    const none = bug("Nowhere", { url: "http://localhost:3000/zzz" });
    const shipped = bug("Done", { feature: "checkout", url: "http://localhost:3000/cart" });
    patchFinding(dir, shipped.id, { status: "shipped" });
    const open = bug("Open one", { feature: "checkout", url: "http://localhost:3000/cart" });
    patchFinding(dir, open.id, { status: "accepted" });
    const b = qaBoard(dir);
    const of = (id: string) => b.features.find((f) => f.id === id)!;
    expect(of("invite").bugs.map((x) => [x.id, x.featureSource]).sort()).toEqual([[gone.id, "url"], [stored.id, "stored"]].sort());
    expect(of("discount").bugs.map((x) => [x.id, x.featureSource])).toEqual([[url.id, "url"]]);
    expect(b.bugsWithoutFeature.map((x) => x.id)).toEqual([none.id]);
    expect(of("checkout").bugs.map((x) => [x.id, x.state])).toEqual([[open.id, "needs-check"], [shipped.id, "fixed"]]);
    expect(b.bugsWithoutFeature[0]).toMatchObject({ state: "open", byAgent: false, shot: "none", feature: null, featureSource: null, kind: "functional", impact: "medium" });
  });

  test("activity: working, queued and a problem, from the pipeline's jobs", async () => {
    putFeatures(FEATURES + "## Delta\nid: d\nwhere: /d\nThe D.\n");
    hold = "all";
    work = () => {};
    startPipeline(dir, request({ plan: { batching: "each" } }));
    const b = qaBoard(dir);
    expect(b.features.map((f) => f.activity.plan.kind)).toEqual(["working", "working", "working", "queued"]);
    expect(b.features[0]!.activity.plan).toMatchObject({ kind: "working", sessionId: view().jobs[0]!.sessionId, pair: false });
    expect(b.features[0]!.activity.test.kind).toBe("idle");
    releaseAll();
    await until(() => view().jobs.length === 4);
    releaseAll();
    await until(ended);
    const done = qaBoard(dir);
    expect(done.features.map((f) => f.activity.plan)).toEqual(["a", "b", "c", "d"].map((id) => ({ kind: "problem", text: `${id}: no plan written.`, sessionId: expect.any(String) })));
    expect(done.pipeline!.stages.find((s) => s.stage === "plan")).toMatchObject({ done: 4, total: 4, problems: 4 });
  });

  test("a feature's detail has its plan with each step's last result, its runs and its last run", async () => {
    putPlan("a");
    await run(request({ test: { batching: "each" } }, { scope: { kind: "features", ids: ["a"] } }));
    const d = featureDetail(dir, "a");
    expect(d.feature).toMatchObject({ id: "a", plan: { kind: "ready", steps: 2 }, test: { kind: "ran", run: { feature: "a", finished: true, counts: { pass: 2, pending: 0 } } } });
    expect(d.plan).toMatchObject({ title: "a", intro: "Intro.", path: "lab/qa/a.md", problem: null });
    expect(d.plan!.steps.map((s) => [s.action, s.path, s.last])).toEqual([["Open it", "/x", "pass"], ["Do it", null, "pass"]]);
    expect(d.runs).toHaveLength(1);
    expect(d.lastRun!.id).toBe(d.runs[0]!.id);
    expect(featureDetail(dir, "b")).toMatchObject({ plan: null, runs: [], lastRun: null });
    expect(() => featureDetail(dir, "nope")).toThrow('No feature "nope"');
  });

  test("a run is read by id for its own project only", async () => {
    putPlan("a");
    await run(request({ test: { batching: "each" } }, { scope: { kind: "features", ids: ["a"] } }));
    const id = featureDetail(dir, "a").runs[0]!.id;
    expect(runReply(dir, id).summary.id).toBe(id);
    expect(runReply(dir, id).run.steps).toHaveLength(2);
    expect(() => runReply(makeDir(), id)).toThrow(QaNotFound);
    expect(() => runReply(dir, "qa_nope")).toThrow(QaNotFound);
    expect(() => runReply(dir, "nonsense")).toThrow("is not a run id");
  });

  test("a plan cannot be deleted while a job works on it", async () => {
    putPlan("a");
    hold = "all";
    const v = startPipeline(dir, request({ test: { batching: "each" } }, { scope: { kind: "features", ids: ["a"] } }));
    expect(() => deletePlan(dir, "a")).toThrow(QaConflict);
    expect(() => deletePlan(dir, "a")).toThrow('A job is working on "a". Wait for it.');
    release(v.jobs[0]!.sessionId!);
    await until(ended);
    deletePlan(dir, "a");
    expect(fs.existsSync(path.join(dir, "lab/qa/a.md"))).toBe(false);
    expect(() => deletePlan(dir, "a")).toThrow(QaNotFound);
  });

  test("the pipeline shown is the open one, else the newest ended", async () => {
    const first = startPipeline(dir, request({ test: { batching: "each" } }));
    expect(first.control.kind).toBe("ended");
    expect(qaBoard(dir).pipeline!.id).toBe(first.id);
    putPlan("a");
    hold = "all";
    const second = startPipeline(dir, request({ test: { batching: "each" } }));
    expect(qaBoard(dir).pipeline!.id).toBe(second.id);
    release(second.jobs[0]!.sessionId!);
    await until(ended);
    const jobs: Job[] = [];
    expect(jobs).toEqual([]);
  });
});

describe("the database migration", () => {
  test("an old database gains the pipeline tables and the run's session, and loses qa_sessions and qa_batches, idempotently", () => {
    const conn = new Database(":memory:");
    conn.exec(`CREATE TABLE qa_runs (id TEXT PRIMARY KEY, root_dir TEXT NOT NULL, plan TEXT NOT NULL, started_at INTEGER NOT NULL, steps TEXT NOT NULL)`);
    conn.exec(`CREATE TABLE qa_sessions (session_id TEXT PRIMARY KEY, root_dir TEXT NOT NULL, plan TEXT NOT NULL, kind TEXT NOT NULL, problem TEXT, run_id TEXT, batch_id TEXT)`);
    conn.exec(`CREATE TABLE qa_batches (id TEXT PRIMARY KEY, root_dir TEXT NOT NULL)`);
    conn.exec("INSERT INTO qa_runs VALUES ('qa_1', '/r', 'cart', 1, '[]'), ('qa_2', '/r', 'cart', 2, '[]')");
    conn.exec("INSERT INTO qa_sessions VALUES ('s_walker', '/r', 'cart', 'run', NULL, 'qa_1', NULL), ('s_map', '/r', '@features', 'map', NULL, NULL, NULL)");
    migrate(conn);
    migrate(conn);
    const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["qa_runs", "qa_pipelines", "qa_jobs"]));
    expect(tables).not.toContain("qa_sessions");
    expect(tables).not.toContain("qa_batches");
    expect(conn.prepare("SELECT id, session_id FROM qa_runs ORDER BY id").all()).toEqual([{ id: "qa_1", session_id: "s_walker" }, { id: "qa_2", session_id: null }]);
    conn.close();
  });
});
