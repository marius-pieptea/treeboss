import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { createLead, getSession, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { setGoal, getGoal } from "../src/sessions/goal";
import { continuationPrompt } from "../src/sessions/handoff";
import { planPreamble } from "../src/sessions/plan";
import { approvedPlanText, answerQuestion, executePlanTool, getPlan, listPlans, planState, readPlan } from "../src/sessions/planq";
import { bodySha, changelogOf, guardPlanPath, newPlanPath, parsePlanText, setMeta } from "../src/sessions/planfile";
import { cleanPlansDir, plansDirOf, setPlansDir } from "../src/sessions/plansdir";
import { listAttached } from "../src/specs/attach";
import { findFeature, guardSpecPath, listFeatures } from "../src/specs/store";
import { CLAUDE_PLAN_TOOLS } from "../src/engines/registry";
import { Workspaces } from "../src/workspaces";
import { db } from "../src/db";
import { makeDir, resetState, settled } from "./helpers";

const TOKEN = "planfile-api";
let srv: ReturnType<typeof startServer>;
beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
  setDaemonContext({ url: srv.url, token: TOKEN });
});
afterAll(async () => {
  await interruptAll();
  setDaemonContext(null);
  srv.stop();
});
beforeEach(() => {
  resetState();
  listPlans("none"); // creates the tables on first use
  db().exec("DELETE FROM plan_questions; DELETE FROM plans;");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any };
};

const STEPS = [
  { title: "Add table", detail: "migrate the schema", files: ["src/db.ts"] },
  { title: "Wire it", detail: "read-through" },
];
const PLAN = { title: "Add a cache", summary: "Use SQLite.", steps: STEPS, risks: ["stale rows"], open_questions: ["TTL?"] };

/** A plan-mode lead in `cwd`, idle, with one answered question so Decisions has content. */
async function planLead(cwd = makeDir(), mode: "plan" | "build" = "plan") {
  const s = createLead({ prompt: "CALL_TOOL plan_ask " + JSON.stringify({ question: "Which store?", options: [{ label: "SQLite", recommended: true }, { label: "Postgres" }] }), engine: "fake", cwd, mode } as any);
  const q = await until(() => planState(s.id).pending);
  answerQuestion(s.id, { question_id: q.id, choice: "SQLite" });
  await settled(s.id);
  return { id: s.id, cwd: getSession(s.id)!.base_cwd };
}

async function until<T>(fn: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 40));
  }
}

const submit = async (id: string, over: Record<string, unknown> = {}) => {
  const r = await executePlanTool("plan_submit", { ...PLAN, ...over }, id);
  if (r.text.startsWith("Error")) throw new Error(r.text);
  return planState(id).plan!;
};
const read = (cwd: string, rel: string) => fs.readFileSync(path.join(cwd, rel), "utf-8");

describe("plan_submit writes a file", () => {
  test("plans/<date>-<slug>.md with front matter, decisions, steps, risks; the plans folder appears only now", async () => {
    const { id, cwd } = await planLead();
    expect(fs.existsSync(path.join(cwd, "plans"))).toBe(false);
    const plan = await submit(id);
    expect(plan.path).toMatch(/^plans\/\d{4}-\d{2}-\d{2}-add-a-cache\.md$/);
    expect(plan).toMatchObject({ depth: "quick", status: "draft", version: 1, feature: null, promoted: null, edited: false, file_missing: false });
    const text = read(cwd, plan.path!);
    const { meta, body } = parsePlanText(text);
    expect(meta).toMatchObject({ title: "Add a cache", session: id, status: "draft", mode: "quick", version: "1" });
    expect(body).toContain("# Add a cache");
    expect(body).toContain("## Decisions\n\n- Which store? SQLite");
    expect(body).toContain("1. **Add table**");
    expect(body).toContain("   Files: `src/db.ts`");
    expect(body).toContain("## Risks");
    expect(body).toContain("## Open questions");
    // The DB row keeps the metadata; the file is what a reader gets.
    expect(readPlan(id).fromFile).toBe(true);
    expect(planState(id).plans).toHaveLength(1);
  });

  test("names do not collide, are slugged, and the folder can be moved per workspace", async () => {
    const a = await planLead();
    const b = createLead({ prompt: "SAY hi", engine: "fake", cwd: a.cwd, mode: "plan" } as any);
    await settled(b.id);
    const p1 = await submit(a.id, { title: "Ça marche: Add *cache* (v2)!" });
    const p2 = await submit(b.id, { title: "Ça marche: Add *cache* (v2)!" });
    expect(p1.path).toMatch(/-ca-marche-add-cache-v2\.md$/);
    expect(p2.path).toBe(p1.path!.replace(/\.md$/, "-2.md"));
    expect(read(a.cwd, p1.path!)).toContain('title: "Ça marche: Add *cache* (v2)!"');

    const ws = Workspaces.open(a.cwd);
    expect(plansDirOf(a.cwd)).toBe("plans");
    expect(setPlansDir(ws.id, "docs/plans")).toBe("docs/plans");
    expect(plansDirOf(a.cwd)).toBe("docs/plans");
    const c = createLead({ prompt: "SAY hi", engine: "fake", cwd: a.cwd, mode: "plan" } as any);
    await settled(c.id);
    expect((await submit(c.id)).path).toMatch(/^docs\/plans\/\d{4}-/);
    expect(setPlansDir(ws.id, null)).toBe("plans");
    expect(() => cleanPlansDir("../escape")).toThrow();
    expect(() => cleanPlansDir("a/.git/b")).toThrow();
  });

  test("path guards: only the plans folder and a feature's plan.md", () => {
    const dir = makeDir();
    expect(guardPlanPath(dir, "plans/x.md")).toBe("plans/x.md");
    expect(guardPlanPath(dir, "specs/001-a/plan.md")).toBe("specs/001-a/plan.md");
    for (const bad of ["../x.md", "plans/../../x.md", "src/a.md", "plans/x.txt", "/etc/passwd", "specs/001-a/spec.md", ""]) expect(() => guardPlanPath(dir, bad)).toThrow();
    expect(newPlanPath(dir, "T", new Date("2026-01-02T00:00:00Z"))).toBe("plans/2026-01-02-t.md");
    // The specs guard lets a plan be attached like a spec.
    expect(guardSpecPath(dir, "plans/x.md")).toBe("plans/x.md");
    expect(() => guardSpecPath(dir, "src/x.md")).toThrow();
  });

  test("the agent is told the daemon writes the file; claude's plan allowlist still has no Write or Edit", () => {
    expect(planPreamble({ tools: true })).toContain("you never write that file");
    expect(planPreamble({ tools: true, depth: "spec" })).toContain("becomes a specification feature");
    expect(planPreamble({ tools: true })).not.toContain("specification feature");
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) expect(CLAUDE_PLAN_TOOLS).not.toContain(t);
  });
});

describe("approval takes the file as it stands", () => {
  test("an edit made in the file before Approve is what is approved, and only the status line is touched", async () => {
    const { id, cwd } = await planLead();
    const plan = await submit(id);
    const edited = read(cwd, plan.path!).replace("Use SQLite.", "Use SQLite, but behind a feature flag.");
    fs.writeFileSync(path.join(cwd, plan.path!), edited);
    const st = planState(id).plan!;
    expect(st.edited).toBe(true);

    const r = await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/approve`, {});
    expect(r.status).toBe(200);
    await settled(id);
    const after = read(cwd, plan.path!);
    expect(after).toBe(setMeta(edited, "status", "approved"));
    expect(parsePlanText(after).meta.status).toBe("approved");
    const row = db().prepare("SELECT approved_sha, snapshot FROM plans WHERE id = ?").get(plan.id) as { approved_sha: string; snapshot: string };
    expect(row.snapshot).toContain("behind a feature flag");
    expect(row.snapshot).toBe(after);
    // The prompt points at the file; the agent reads the edited text from there.
    const last = db().prepare("SELECT prompt FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(id) as { prompt: string };
    expect(last.prompt).toContain(`Implement the approved plan in \`${plan.path}\``);
    expect(last.prompt).not.toContain("behind a feature flag");
    // Attached by reference, so a handoff carries a pointer and not text.
    expect(listAttached(id).find((a) => a.spec_path === plan.path)).toMatchObject({ mode: "ref", purpose: "context", delivered: true });
    expect(approvedPlanText(id)).toContain(plan.path!);
    expect(continuationPrompt(getSession(id)!, "half done")).toContain(plan.path!);
  }, 30_000);

  test("viewer edits are saved through the API, with a stale-editor check", async () => {
    const { id, cwd } = await planLead();
    const plan = await submit(id);
    const f = (await call("GET", `/api/sessions/${id}/plan/file`)).body;
    expect(f).toMatchObject({ path: plan.path, from_file: true });
    const saved = await call("PUT", `/api/sessions/${id}/plan/plans/${plan.id}/file`, { text: f.text.replace("Use SQLite.", "Use SQLite!"), expected_mtime: f.mtime });
    expect(saved.status).toBe(200);
    expect(read(cwd, plan.path!)).toContain("Use SQLite!");
    // A second editor with the old mtime is refused.
    fs.writeFileSync(path.join(cwd, plan.path!), read(cwd, plan.path!) + "\n<!-- other -->\n");
    const stale = await call("PUT", `/api/sessions/${id}/plan/plans/${plan.id}/file`, { text: "x", expected_mtime: f.mtime - 5000 });
    expect(stale.status).toBe(400);
    expect(read(cwd, plan.path!)).toContain("<!-- other -->");
  });

  test("a plan from before plan files still reads, approves with its stored text, and can be given a file", async () => {
    const { id, cwd } = await planLead();
    db().prepare("INSERT INTO plans (id, session_id, version, title, summary, steps_json, risks_json, open_questions_json, status, created_at) VALUES ('pl_old', ?, 1, 'Old plan', 'Legacy.', ?, '[]', '[]', 'draft', ?)").run(id, JSON.stringify(STEPS), new Date().toISOString());
    const st = planState(id).plan!;
    expect(st).toMatchObject({ id: "pl_old", path: null, depth: "quick" });
    const f = (await call("GET", `/api/sessions/${id}/plan/file?plan=pl_old`)).body;
    expect(f).toMatchObject({ path: null, from_file: false });
    expect(f.text).toContain("# Old plan");

    const m = await call("POST", `/api/sessions/${id}/plan/plans/pl_old/materialize`, {});
    expect(m.body.plan.path).toMatch(/^plans\/.*old-plan\.md$/);
    expect(read(cwd, m.body.plan.path)).toContain("1. **Add table**");

    // Back to a legacy row to approve it without a file.
    db().prepare("UPDATE plans SET path = NULL WHERE id = 'pl_old'").run();
    const ok = await call("POST", `/api/sessions/${id}/plan/plans/pl_old/approve`, {});
    expect(ok.status).toBe(200);
    await settled(id);
    const last = db().prepare("SELECT prompt FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(id) as { prompt: string };
    expect(last.prompt).toContain("# Old plan");
    expect(last.prompt).toContain("1. Add table");
    expect(approvedPlanText(id)).toContain("# Old plan");
  }, 30_000);
});

describe("revising in place", () => {
  test("ask for changes supersedes the file, the next plan_submit rewrites it as v2 with a changelog, and v3 keeps the history", async () => {
    const { id, cwd } = await planLead();
    const v1 = await submit(id);
    const r = await call("POST", `/api/sessions/${id}/plan/plans/${v1.id}/request-changes`, { note: "split step 2" });
    expect(r.status).toBe(200);
    await settled(id);
    expect(parsePlanText(read(cwd, v1.path!)).meta.status).toBe("superseded");
    const turn = db().prepare("SELECT prompt FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(id) as { prompt: string };
    expect(turn.prompt).toContain(v1.path!);
    expect(turn.prompt).toContain("version 2");

    const v2 = await submit(id, { steps: [...STEPS, { title: "Split it" }] });
    expect(v2).toMatchObject({ version: 2, path: v1.path, status: "draft" });
    const t2 = read(cwd, v2.path!);
    expect(parsePlanText(t2).meta).toMatchObject({ version: "2", status: "draft" });
    expect(t2).toContain("3. **Split it**");
    expect(changelogOf(t2)).toEqual([expect.stringMatching(/^v2, \d{4}-\d{2}-\d{2}: split step 2$/)]);

    // Re-submitting before deciding is a revision too, and the history is kept.
    const v3 = await submit(id, { title: "Add a cache v3" });
    expect(v3.path).toBe(v1.path);
    expect(changelogOf(read(cwd, v3.path!))).toHaveLength(2);
    expect(listPlans(id).map((p) => p.status)).toEqual(["superseded", "superseded", "draft"]);
    // Only the current draft can be decided.
    expect((await call("POST", `/api/sessions/${id}/plan/plans/${v2.id}/approve`, {})).status).toBe(400);
  }, 30_000);

  test("a revision does not overwrite a spec.md the operator edited since", async () => {
    const { id, cwd } = await planLead();
    await call("PUT", `/api/sessions/${id}/plan/depth`, { depth: "spec" });
    const v1 = await submit(id);
    const feat = findFeature(cwd, v1.feature!)!;
    fs.appendFileSync(path.join(cwd, feat.dir, "spec.md"), "\nMy own requirement.\n");
    await call("POST", `/api/sessions/${id}/plan/plans/${v1.id}/request-changes`, { note: "again" });
    await settled(id);
    const v2 = await submit(id, { summary: "Second take." });
    expect(v2.feature).toBe(v1.feature);
    expect(read(cwd, `${feat.dir}/spec.md`)).toContain("My own requirement.");
    expect(read(cwd, `${feat.dir}/plan.md`)).toContain("Second take.");
  }, 30_000);
});

describe("skip", () => {
  test("leaves plan mode, keeps the plan on file as superseded, and tells the agent to carry on", async () => {
    const { id, cwd } = await planLead();
    const plan = await submit(id);
    const r = await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/skip`, {});
    expect(r.status).toBe(200);
    expect(r.body.session.mode).toBe("build");
    await settled(id);
    expect(getPlan(plan.id)).toMatchObject({ status: "superseded", note: "skipped" });
    expect(parsePlanText(read(cwd, plan.path!)).meta.status).toBe("superseded");
    const last = db().prepare("SELECT prompt FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(id) as { prompt: string };
    expect(last.prompt).toContain("Proceed without the plan");
  }, 30_000);
});

describe("two depths", () => {
  test("promote turns a quick plan into a Spec Kit feature the specs module reads, and marks the plan file", async () => {
    const { id, cwd } = await planLead();
    const plan = await submit(id);
    const r = await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/promote`, {});
    expect(r.status).toBe(200);
    expect(r.body.feature).toMatch(/^001-add-cache|^001-add-a-cache/);
    const f = findFeature(cwd, r.body.feature)!;
    expect(f).toBeTruthy();
    expect(f.files).toMatchObject({ spec: true, plan: true, tasks: false });
    expect(f.status).toBe("planned");
    expect(f.specDraft).toBe(true); // user stories are still the template's: Specify and Clarify stay open
    expect(f.clarifications).toBe(1); // the one open question
    const spec = read(cwd, `${f.dir}/spec.md`);
    expect(spec).toContain("**Input**: Use SQLite.");
    expect(spec).toContain("## Assumptions\n\n- Which store? SQLite");
    expect(spec).toContain("[NEEDS CLARIFICATION: TTL?]");
    const planMd = read(cwd, `${f.dir}/plan.md`);
    expect(parsePlanText(planMd).meta).toMatchObject({ mode: "spec", title: "Add a cache" });
    expect(planMd).toContain("**Spec**: [spec.md](./spec.md)");
    expect(planMd).toContain("## Project Structure");
    expect(planMd).toContain("src/db.ts");
    // The quick plan links to it; promoting twice is refused.
    expect(parsePlanText(read(cwd, plan.path!)).meta.promoted).toBe(f.dir);
    expect(getPlan(plan.id)).toMatchObject({ promoted: f.dir, feature: f.id });
    expect((await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/promote`, {})).status).toBe(400);
    expect(listFeatures(cwd)).toHaveLength(1);
  }, 30_000);

  test("Spec it: plan_submit creates specs/NNN-name/{spec,plan}.md and approving opens it for tasks instead of building", async () => {
    const { id, cwd } = await planLead();
    expect((await call("PUT", `/api/sessions/${id}/plan/depth`, { depth: "bogus" })).status).toBe(400);
    expect((await call("PUT", `/api/sessions/${id}/plan/depth`, { depth: "spec" })).body.depth).toBe("spec");
    expect(planState(id).depth).toBe("spec");
    const plan = await submit(id, { requirements: ["Cache reads", "Expire entries"], success_criteria: ["p95 under 20 ms"] });
    expect(plan.depth).toBe("spec");
    expect(plan.feature).toMatch(/^001-/);
    expect(plan.path).toBe(`specs/${plan.feature}/plan.md`);
    const spec = read(cwd, `specs/${plan.feature}/spec.md`);
    expect(spec).toContain("- **FR-001**: Cache reads");
    expect(spec).toContain("- **FR-002**: Expire entries");
    expect(spec).toContain("- **SC-001**: p95 under 20 ms");
    expect(parsePlanText(read(cwd, plan.path!)).meta.mode).toBe("spec");

    const turnsBefore = (db().prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(id) as { n: number }).n;
    const r = await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/approve`, {});
    expect(r.status).toBe(200);
    expect(r.body.feature).toBe(plan.feature);
    expect(r.body.session.mode).toBe("build");
    // No build turn: the tasks step and Implement come from the Specs view.
    expect((db().prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(id) as { n: number }).n).toBe(turnsBefore);
    expect(listAttached(id).map((a) => a.spec_path)).toContain(`specs/${plan.feature}`);
  }, 30_000);

  test("the Spec it plan is rejected cleanly when the folder cannot be made", async () => {
    const { id, cwd } = await planLead();
    await call("PUT", `/api/sessions/${id}/plan/depth`, { depth: "spec" });
    fs.writeFileSync(path.join(cwd, "specs"), "a file where the folder should be");
    const r = await executePlanTool("plan_submit", PLAN, id);
    expect(r.text).toMatch(/^Error/);
    expect(planState(id).plans).toHaveLength(0);
  });
});

describe("goal and handoff reference the file", () => {
  test("goal follow-up turns point at the approved plan's path instead of repeating it", async () => {
    const { id } = await planLead();
    const plan = await submit(id);
    await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/approve`, {});
    await settled(id);
    setGoal(id, { text: "make the cache work", check: "false", maxTurns: 2 }, { kickoff: true });
    const until2 = Date.now() + 20_000;
    while (Date.now() < until2) {
      const g = getGoal(id);
      if (g && g.status !== "active" && getSession(id)!.status !== "running") break;
      await Bun.sleep(40);
    }
    const prompts = (db().prepare("SELECT prompt FROM turns WHERE session_id = ? ORDER BY seq").all(id) as Array<{ prompt: string }>).map((t) => t.prompt);
    const goalTurn = prompts.find((p) => p.includes("## Goal: turn"));
    expect(goalTurn).toBeTruthy();
    expect(goalTurn).toContain(`The approved plan is in \`${plan.path}\``);
  }, 40_000);

  test("a handoff's approved_plan block is a pointer when the file exists, and the text when it is gone", async () => {
    const { id, cwd } = await planLead();
    const plan = await submit(id);
    await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/approve`, {});
    await settled(id);
    const withFile = continuationPrompt(getSession(id)!, "x");
    expect(withFile).toContain("<approved_plan>");
    expect(withFile).toContain(`\`${plan.path}\``);
    expect(withFile).not.toContain("migrate the schema");
    fs.rmSync(path.join(cwd, plan.path!));
    const gone = continuationPrompt(getSession(id)!, "x");
    expect(gone).toContain("# Add a cache");
    expect(gone).toContain("1. **Add table**");
    expect(planState(id).plan!.file_missing).toBe(true);
    expect(bodySha("x")).toHaveLength(16);
  }, 30_000);
});
