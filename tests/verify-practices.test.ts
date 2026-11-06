import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { getGoal } from "../src/sessions/goal";
import { createLead, getSession, interruptAll, readLog, setTurnRunner, viewSession } from "../src/sessions/manager";
import type { TurnResult } from "../src/engines/runner";
import { fixPrompt, PRACTICES_STEP, practicesStep } from "../src/verify/loop";
import { getSessionRow, listRuns, setConfig, type VerifyRun } from "../src/verify/store";
import { effectivePacks, practicesOf, resetBuiltin, saveBuiltin, catalog, setPractices } from "../src/practices/store";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState } from "./helpers";

const result = (output = "ok"): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" });

/** A file with an escape hatch: strict-types flags the `as any`. */
const FEATURE = 'export const pick = JSON.parse("{}") as any;\n';
/** A presentational component that runs a query: smart-dumb-components flags the hook on line 2. */
const CARD = 'export function Card() {\n  const r = useQuery({ queryKey: ["x"] });\n  return null;\n}\n';
const PACKS = ["strict-types", "smart-dumb-components"];
const PASS = [{ name: "check", cmd: "true" }];

beforeEach(() => {
  resetState();
  getSessionRow("-"); // makes sure the verify tables exist
  getGoal("-");
  practicesOf("w_none"); // makes sure the practice table exists
  db().exec("DELETE FROM verify_config; DELETE FROM session_verify; DELETE FROM verify_runs; DELETE FROM session_goals; DELETE FROM practice_settings");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
  // The catalog lives in the shared test home: leave every built-in as it shipped.
  for (const p of catalog()) if (!p.custom && p.modified) resetBuiltin(p.id);
});

/**
 * Waits until the loop is over: the session idle, and verification reported for its latest turn. With verify off there is
 * no run to report, so the state "off" is the answer (a turn with no practice findings leaves it so).
 */
async function over(id: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  let stable = 0;
  for (;;) {
    const s = getSession(id)!;
    const v = viewSession(s, { withOutput: false }).verify;
    const reported = v && (v.state === "off" || (v.last?.turn_id === s.last_turn_id && (v.state === "passed" || v.state === "failed")));
    if (s.status !== "running" && reported) {
      if (++stable >= 3) return { s, v: v! };
    } else stable = 0;
    if (Date.now() > until) throw new Error(`still ${s.status}, verify ${v?.state} after ${timeoutMs}ms`);
    await Bun.sleep(50);
  }
}

/** A git workspace with the packs on and verify running one passing command. The first turn writes the two files; later turns write nothing. */
function workspace(enforce: "off" | "warn" | "fix", opts: { verify?: boolean; packs?: string[] } = {}) {
  const dir = makeRepo({ "src/base.ts": "export const a = 1;\n" });
  const id = Workspaces.open(dir).id;
  setPractices(id, { enabled: opts.packs ?? PACKS, enforce });
  setConfig(dir, { enabled: opts.verify ?? true, commands: PASS, max_retries: 2 });
  const prompts: string[] = [];
  setTurnRunner(async (o) => {
    prompts.push(o.prompt);
    if (prompts.length === 1) {
      fs.mkdirSync(path.join(o.cwd, "src/components"), { recursive: true });
      fs.writeFileSync(path.join(o.cwd, "src/feature.ts"), FEATURE);
      fs.writeFileSync(path.join(o.cwd, "src/components/Card.tsx"), CARD);
    }
    return result("Done.");
  });
  return { dir, id, prompts };
}

/** The Practices result of every failed run, newest first. */
const failedPractices = (runs: VerifyRun[]) => runs.filter((r) => r.state === "failed").flatMap((r) => r.results.filter((x) => x.name === PRACTICES_STEP));

describe("the practice step of a verify run", () => {
  test("the fix prompt names each finding under Practices with its pack, and keeps command failures in their own sections", () => {
    const results = [
      { name: "test", cmd: "bun test", exit: 1, ok: false, duration_ms: 1, timed_out: false, output: "boom" },
      { name: PRACTICES_STEP, cmd: "practice checks (fix)", exit: 1, ok: false, duration_ms: 0, timed_out: false, output: "[strict-types] src/feature.ts:1 uses an escape hatch" },
    ];
    const both = fixPrompt(results, 1, 2);
    expect(both).toContain("### test: `bun test` exited 1");
    expect(both).toContain("### Practices");
    expect(both).toContain("- [strict-types] src/feature.ts:1 uses an escape hatch");
    expect(both.indexOf("### Practices")).toBeGreaterThan(both.indexOf("### test:"));

    const practicesOnly = fixPrompt([results[1]!], 1, 2);
    expect(practicesOnly).toContain("### Practices");
    expect(practicesOnly).not.toContain("These project checks ran");
  });

  test("a folder in no registered workspace has no practice step", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const s = { id: "s_none", cwd: dir, base_cwd: dir } as Parameters<typeof practicesStep>[0];
    expect(await practicesStep(s, "t_none")).toBeNull();
  });
});

describe("practices in a normal session, end to end", () => {
  test("fix mode: the verify step reports both findings and sends them back as a fix turn; the fix turn passes", async () => {
    const { dir, id, prompts } = workspace("fix");
    const s = createLead({ prompt: "add a feature", engine: "fake", cwd: dir });
    const { v } = await over(s.id);

    // Two turns: the change, and the fix that the findings sent back.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("## Verification failed after your last turn (automatic fix 1 of 2)");
    expect(prompts[1]).toContain("### Practices");
    expect(prompts[1]).toContain("- [strict-types] src/feature.ts:1");
    expect(prompts[1]).toContain("- [smart-dumb-components] src/components/Card.tsx:2");

    // The failed run carries both findings, labelled by pack, as the Practices result.
    const [practices] = failedPractices(listRuns(s.id));
    expect(practices).toMatchObject({ name: PRACTICES_STEP, ok: false });
    expect(practices!.output).toContain("[strict-types] src/feature.ts:1");
    expect(practices!.output).toContain("[smart-dumb-components] src/components/Card.tsx:2");

    // The fix turn changed nothing, so the practices are clean and the session ends verified.
    expect(v.state).toBe("passed");
    expect(getSession(s.id)!.status).toBe("idle");
  });

  test("warn mode: the same findings are reported in the run, and no fix turn is sent", async () => {
    const { dir, prompts } = workspace("warn");
    const s = createLead({ prompt: "add a feature", engine: "fake", cwd: dir });
    const { v } = await over(s.id);

    expect(prompts).toHaveLength(1);
    expect(v.state).toBe("passed");
    const run = listRuns(s.id)[0]!;
    const practices = run.results.find((r) => r.name === PRACTICES_STEP);
    expect(practices).toMatchObject({ ok: true });
    expect(practices!.output).toContain("[strict-types] src/feature.ts:1");
    expect(practices!.output).toContain("[smart-dumb-components] src/components/Card.tsx:2");
    expect(readLog(s.id).map((e) => e.text).join("\n")).toContain("reported and not sent back (warn)");
  });

  test("off: no practice step runs, and the turn passes", async () => {
    const { dir, prompts } = workspace("off");
    const s = createLead({ prompt: "add a feature", engine: "fake", cwd: dir });
    await over(s.id);
    expect(prompts).toHaveLength(1);
    for (const r of listRuns(s.id)) expect(r.results.some((x) => x.name === PRACTICES_STEP)).toBe(false);
  });

  test("with verify itself off, the practices still run and still send a fix turn", async () => {
    const { dir, prompts } = workspace("fix", { verify: false });
    const s = createLead({ prompt: "add a feature", engine: "fake", cwd: dir });
    await over(s.id);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("- [strict-types] src/feature.ts:1");
    expect(prompts[1]).not.toContain("These project checks ran");
  });

  test("treeboss mode: the gate runs the packs and the verify step does not run them again", async () => {
    const dir = makeRepo({ "src/base.ts": "export const a = 1;\n" });
    const id = Workspaces.open(dir).id;
    setPractices(id, { enabled: ["strict-types"], enforce: "fix" });
    setConfig(dir, { enabled: true, commands: PASS, max_retries: 2 });
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      o.onLog?.("TREEBOSS_TIER: tweak");
      if (prompts.length === 1) fs.writeFileSync(path.join(o.cwd, "src/feature.ts"), FEATURE);
      return result("Done.");
    });
    const s = createLead({ prompt: "add a feature", engine: "fake", cwd: dir, treeboss: true });
    await over(s.id);

    // One fix turn from the gate (labelled by the gate's header), and no Practices section from verify.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("## Treeboss gate:");
    expect(prompts[1]).toContain("[strict-types] src/feature.ts:1");
    expect(prompts[1]).not.toContain("### Practices");
    for (const r of listRuns(s.id)) expect(r.results.some((x) => x.name === PRACTICES_STEP)).toBe(false);
  });
});

describe("the AGENTS.md block follows the effective rules", () => {
  test("it lists the enabled packs' rules, and drops a rule switched off here", () => {
    const dir = makeRepo({ "src/base.ts": "export const a = 1;\n" });
    const id = Workspaces.open(dir).id;
    setPractices(id, { enabled: ["strict-types"] });
    const agents = () => fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(agents()).toContain("## Practice packs");
    expect(agents()).toContain("- No `any` and no `as any`; use `unknown` and narrow it.");

    const rule = "No non-null assertion `!`; narrow with a check or handle the missing case.";
    setPractices(id, { off: { "strict-types": { rules: [rule], checks: [] } } });
    expect(agents()).not.toContain(rule);
    expect(agents()).toContain("- No `any` and no `as any`; use `unknown` and narrow it.");
    expect(effectivePacks(id)[0]!.rules).not.toContain(rule);
  });

  test("an edit to a built-in pack reaches the block of every workspace that has it on, and reset brings the shipped rules back", () => {
    const dir = makeRepo({ "src/base.ts": "export const a = 1;\n" });
    const id = Workspaces.open(dir).id;
    setPractices(id, { enabled: ["strict-types"] });
    const agents = () => fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");

    const shipped = catalog().find((p) => p.id === "strict-types")!;
    saveBuiltin("strict-types", { title: shipped.title, summary: shipped.summary, appliesTo: shipped.appliesTo, rules: ["Say no to any; the edit is ours."], skills: [], checks: shipped.checks ?? [] });
    expect(agents()).toContain("- Say no to any; the edit is ours.");
    expect(agents()).not.toContain("No `any` and no `as any`");
    expect(catalog().find((p) => p.id === "strict-types")).toMatchObject({ modified: true });

    resetBuiltin("strict-types");
    expect(agents()).toContain("- No `any` and no `as any`; use `unknown` and narrow it.");
    expect(catalog().find((p) => p.id === "strict-types")).toMatchObject({ modified: false });
  });
});
