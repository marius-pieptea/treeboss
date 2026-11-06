import fs from "fs";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { createLead, getSession, interrupt, interruptAll, readLog, setTurnRunner } from "../src/sessions/manager";
import { continuationPrompt } from "../src/sessions/handoff";
import { planPreamble } from "../src/sessions/plan";
import { answerQuestion, approvedPlanText, cancelPendingQuestions, executePlanTool, listQuestions, planState, recoverPlanQuestions } from "../src/sessions/planq";
import { selfInvocation } from "../src/self";
import { db } from "../src/db";
import { makeDir, resetState, settled } from "./helpers";

const TOKEN = "planq-api";
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
  listQuestions("none"); // creates the tables on first use
  db().exec("DELETE FROM plan_questions; DELETE FROM plans;");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  delete process.env.TRB_PLAN_WAIT_MS;
});

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any };
};

async function until<T>(fn: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 40));
  }
}

const ask = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    question: "Which store?",
    options: [
      { label: "SQLite", description: "one file", recommended: true, reason: "already in the repo" },
      { label: "Postgres", description: "a server" },
    ],
    ...over,
  });
const PLAN = JSON.stringify({
  title: "Add a cache",
  summary: "Use SQLite.",
  steps: [
    { title: "Add table", detail: "migrate", files: ["src/db.ts"] },
    { title: "Wire it", detail: "read-through" },
  ],
  risks: ["stale rows"],
});
const planLead = (prompt: string) => createLead({ prompt, engine: "fake", cwd: makeDir(), mode: "plan" } as any);

describe("plan_ask through the real shim", () => {
  test("blocks until the operator answers, then hands the choice back to the agent", async () => {
    const s = planLead(`CALL_TOOL plan_ask ${ask()}\nCALL_TOOL plan_submit ${PLAN}`);
    const q = await until(() => planState(s.id).pending);
    expect(q).toMatchObject({ seq: 1, question: "Which store?", status: "pending", allow_custom: true, multi: false });
    expect(q.options[0]).toMatchObject({ label: "SQLite", recommended: true, reason: "already in the repo" });
    // Still blocked: the turn has not ended.
    expect(getSession(s.id)!.status).toBe("running");

    const r = await call("POST", `/api/sessions/${s.id}/plan/answer`, { question_id: q.id, choice: "Postgres" });
    expect(r.status).toBe(200);
    expect(r.body.question).toMatchObject({ status: "answered", answer: { choices: ["Postgres"], skipped: false } });

    const done = await settled(s.id);
    const log = readLog(s.id).map((l) => l.text).join("\n");
    expect(log).toContain("User chose: Postgres");
    const st = planState(s.id);
    expect(st.plan).toMatchObject({ version: 1, title: "Add a cache", status: "draft" });
    expect(st.plan!.steps[0]).toMatchObject({ title: "Add table", files: ["src/db.ts"] });
    expect(st.plan!.risks).toEqual(["stale rows"]);
    expect(done.last_output).toContain("Plan v1 saved to plans/");
  }, 30_000);

  test("a written answer and a skip each come back as text the agent can act on", async () => {
    const s = planLead(`CALL_TOOL plan_ask ${ask()}\nCALL_TOOL plan_ask ${ask({ question: "Second?" })}`);
    const q1 = await until(() => planState(s.id).pending);
    answerQuestion(s.id, { question_id: q1.id, custom: "  Use the existing KV  " });
    const q2 = await until(() => {
      const p = planState(s.id).pending;
      return p && p.id !== q1.id ? p : null;
    });
    expect(q2.seq).toBe(2);
    answerQuestion(s.id, { question_id: q2.id, skip: true });
    await settled(s.id);
    const log = readLog(s.id).map((l) => l.text).join("\n");
    expect(log).toContain("User wrote: Use the existing KV");
    expect(log).toContain("The user skipped this question");
    expect(listQuestions(s.id).map((q) => q.answer?.skipped)).toEqual([false, true]);
  }, 30_000);

  test("survives the daemon's wait window: the shim asks again for the same question", async () => {
    process.env.TRB_PLAN_WAIT_MS = "250";
    const s = planLead(`CALL_TOOL plan_ask ${ask()}`);
    const q = await until(() => planState(s.id).pending);
    await new Promise((r) => setTimeout(r, 1100)); // four windows
    expect(getSession(s.id)!.status).toBe("running");
    expect(listQuestions(s.id)).toHaveLength(1); // re-polling did not ask a second question
    answerQuestion(s.id, { question_id: q.id, choice: "SQLite" });
    await settled(s.id);
    expect(readLog(s.id).map((l) => l.text).join("\n")).toContain("User chose: SQLite");
  }, 30_000);

  test("an interrupt cancels the open question, and the log says so", async () => {
    const s = planLead(`CALL_TOOL plan_ask ${ask()}`);
    const q = await until(() => planState(s.id).pending);
    await interrupt({ operator: true }, s.id);
    const after = await until(() => (listQuestions(s.id)[0].status !== "pending" ? listQuestions(s.id)[0] : null));
    expect(after.id).toBe(q.id);
    expect(after.status).toBe("cancelled");
    expect(after.answer?.note).toMatch(/interrupted/);
    expect(planState(s.id).pending).toBeNull();
    expect(readLog(s.id).some((l) => l.text.includes("[plan] question cancelled"))).toBe(true);
  }, 30_000);
});

describe("question validation and lifecycle", () => {
  const idle = async () => {
    const s = createLead({ prompt: "SAY hi", engine: "fake", cwd: makeDir(), mode: "plan" } as any);
    return settled(s.id);
  };

  test("options must be 2 to 6, labels unique, and one recommendation survives", async () => {
    const s = await idle();
    const bad = async (args: any) => (await executePlanTool("plan_ask", args, s.id)).text;
    expect(await bad({ question: "q", options: [{ label: "only" }] })).toMatch(/^Error: give 2 to 6 options/);
    expect(await bad({ question: "q", options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })) })).toMatch(/^Error: give 2 to 6/);
    expect(await bad({ question: "q", options: [{ label: "a" }, { label: "a" }] })).toMatch(/share the label/);
    expect(await bad({ question: "", options: [{ label: "a" }, { label: "b" }] })).toMatch(/question is required/);
    expect(await bad({ question: "q", options: "nope" })).toMatch(/^Error: options must be a list/);
    expect(listQuestions(s.id)).toHaveLength(0);

    process.env.TRB_PLAN_WAIT_MS = "50";
    const r = await executePlanTool("plan_ask", { question: "q", options: [{ label: "a", recommended: true, reason: "x" }, { label: "b", recommended: true, reason: "y" }, "c"] }, s.id);
    expect(r.pending).toBeTruthy();
    expect(listQuestions(s.id)[0].options.filter((o) => o.recommended)).toHaveLength(1);
    // One at a time.
    expect((await executePlanTool("plan_ask", JSON.parse(ask()), s.id)).text).toMatch(/still waiting/);
  });

  test("outside plan mode the tools refuse instead of waiting forever", async () => {
    const s = await settled(createLead({ prompt: "SAY hi", engine: "fake", cwd: makeDir() }).id);
    expect((await executePlanTool("plan_ask", JSON.parse(ask()), s.id)).text).toMatch(/^Error: plan mode is off/);
    expect((await executePlanTool("plan_submit", JSON.parse(PLAN), s.id)).text).toMatch(/^Error: plan mode is off/);
  });

  test("answers are checked: unknown option, empty, answered twice, free text when disallowed", async () => {
    const s = await idle();
    process.env.TRB_PLAN_WAIT_MS = "50";
    const r = await executePlanTool("plan_ask", JSON.parse(ask({ allow_custom: false })), s.id);
    const id = r.pending!;
    expect(() => answerQuestion(s.id, { question_id: id, choice: "Mongo" })).toThrow(/not one of the options/);
    expect(() => answerQuestion(s.id, { question_id: id })).toThrow(/Pick an option/);
    expect(() => answerQuestion(s.id, { question_id: id, custom: "mine" })).toThrow(/does not take a written answer/);
    expect(() => answerQuestion(s.id, { question_id: id, choices: ["SQLite", "Postgres"] })).toThrow(/takes one choice/);
    answerQuestion(s.id, { question_id: id, choice: "SQLite" });
    expect(() => answerQuestion(s.id, { question_id: id, choice: "SQLite" })).toThrow(/already answered/);
  });

  test("multi-choice questions take several options", async () => {
    const s = await idle();
    process.env.TRB_PLAN_WAIT_MS = "50";
    const r = await executePlanTool("plan_ask", JSON.parse(ask({ multi: true })), s.id);
    const q = answerQuestion(s.id, { question_id: r.pending!, choices: ["SQLite", "Postgres"] });
    expect(q.answer?.choices).toEqual(["SQLite", "Postgres"]);
    expect((await executePlanTool("plan_ask", { _resume: r.pending }, s.id)).text).toBe("User chose: SQLite; Postgres");
  });

  test("a daemon restart cancels every question still pending", async () => {
    const s = await idle();
    process.env.TRB_PLAN_WAIT_MS = "50";
    await executePlanTool("plan_ask", JSON.parse(ask()), s.id);
    expect(recoverPlanQuestions()).toBe(1);
    expect(listQuestions(s.id)[0]).toMatchObject({ status: "cancelled", answer: { note: "the daemon restarted" } });
    expect(cancelPendingQuestions(s.id, "again")).toBe(0);
    // Rejoining a cancelled question tells the agent plainly instead of waiting.
    expect((await executePlanTool("plan_ask", { _resume: listQuestions(s.id)[0].id }, s.id)).text).toMatch(/^Error: the question was cancelled/);
  });
});

describe("plans: approve, edit, send back", () => {
  async function withPlan(prompt = `CALL_TOOL plan_ask ${ask()}\nCALL_TOOL plan_submit ${PLAN}`) {
    const s = planLead(prompt);
    if (prompt.includes("plan_ask")) {
      const q = await until(() => planState(s.id).pending);
      answerQuestion(s.id, { question_id: q.id, choice: "SQLite" });
    }
    await settled(s.id);
    return { id: s.id, plan: planState(s.id).plan! };
  }

  test("approving flips to build and sends the plan, with the decisions, as the next turn", async () => {
    const { id, plan } = await withPlan();
    const r = await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/approve`, {});
    expect(r.status).toBe(200);
    expect(r.body.session.mode).toBe("build");
    expect(r.body.plan.status).toBe("approved");
    await settled(id);
    const turns = db().prepare("SELECT prompt FROM turns WHERE session_id = ? ORDER BY seq").all(id) as Array<{ prompt: string }>;
    expect(turns).toHaveLength(2);
    expect(turns[1].prompt).toContain("Implement the approved plan in `plans/");
    expect(turns[1].prompt).toContain("1. Add table");
    // The plan itself is the file: the prompt points at it instead of pasting it.
    const file = fs.readFileSync(path.join(getSession(id)!.base_cwd, plan.path!), "utf-8");
    expect(file).toContain("Files: `src/db.ts`");
    expect(turns[1].prompt).toContain("Which store? SQLite");
    expect(planState(id).plan).toMatchObject({ status: "approved" });
    expect((await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/approve`, {})).body.error).toMatch(/already approved/);
  }, 30_000);

  test("edits made in the UI are what gets built", async () => {
    const { id, plan } = await withPlan();
    const steps = [{ title: "Only this", detail: "do it", files: ["a.ts"] }];
    const r = await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/approve`, { edits: { title: "Slim", steps } });
    expect(r.body.plan).toMatchObject({ title: "Slim", status: "approved", steps });
    await settled(id);
    const last = db().prepare("SELECT prompt FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(id) as { prompt: string };
    expect(last.prompt).toContain("Plan: Slim");
    expect(fs.readFileSync(path.join(getSession(id)!.base_cwd, r.body.plan.path), "utf-8")).toContain("# Slim");
    expect(last.prompt).not.toContain("Add table");
    expect((await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/approve`, { edits: { steps: [] } })).status).toBe(400);
  }, 30_000);

  test("asking for changes keeps plan mode, supersedes the draft, and sends the note", async () => {
    const { id, plan } = await withPlan(`CALL_TOOL plan_submit ${PLAN}`);
    expect((await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/request-changes`, { note: "  " })).status).toBe(400);
    const r = await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/request-changes`, { note: "split step two" });
    expect(r.status).toBe(200);
    expect(r.body.plan).toMatchObject({ status: "superseded", note: "split step two" });
    expect(r.body.session.mode).toBe("plan");
    await settled(id);
    const last = db().prepare("SELECT prompt FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(id) as { prompt: string };
    expect(last.prompt).toContain("split step two");
    expect(last.prompt).toContain("plan_submit");
    expect(planState(id).plan).toBeNull();
  }, 30_000);

  test("a newer plan replaces an undecided one, and only the newest can be approved", async () => {
    const { id, plan: v1 } = await withPlan(`CALL_TOOL plan_submit ${PLAN}`);
    const r = await executePlanTool("plan_submit", { ...JSON.parse(PLAN), title: "Second try" }, id);
    expect(r.text).toContain("Plan v2 saved to plans/");
    const st = planState(id);
    expect(st.plans.map((p) => [p.version, p.status])).toEqual([[1, "superseded"], [2, "draft"]]);
    expect(st.plan?.title).toBe("Second try");
    expect((await call("POST", `/api/sessions/${id}/plan/plans/${v1.id}/approve`, {})).body.error).toMatch(/already superseded/);
  }, 30_000);

  test("steps are validated", async () => {
    const s = await settled(planLead("SAY hi").id);
    expect((await executePlanTool("plan_submit", { title: "x", steps: [] }, s.id)).text).toMatch(/non-empty/);
    expect((await executePlanTool("plan_submit", { title: "x", steps: [{ detail: "no title" }] }, s.id)).text).toMatch(/step 1 needs a title/);
    expect((await executePlanTool("plan_submit", { title: "", steps: [{ title: "a" }] }, s.id)).text).toMatch(/title is required/);
    expect(planState(s.id).plans).toHaveLength(0);
  });

  test("the approved plan rides along in a handoff", async () => {
    const { id, plan } = await withPlan(`CALL_TOOL plan_submit ${PLAN}`);
    expect(approvedPlanText(id)).toBeNull();
    await call("POST", `/api/sessions/${id}/plan/plans/${plan.id}/approve`, {});
    await settled(id);
    expect(approvedPlanText(id)).toContain("plans/");
    expect(approvedPlanText(id)).toContain("Add a cache");
    const prompt = continuationPrompt(getSession(id)!, "did half of it");
    expect(prompt).toContain("<approved_plan>");
    expect(prompt).toContain("1. Add table");
  }, 30_000);
});

describe("plan API", () => {
  test("state, 404s and the CLI-friendly shape", async () => {
    const s = await settled(planLead("SAY hi").id);
    const st = (await call("GET", `/api/sessions/${s.id}/plan-state`)).body;
    expect(st).toMatchObject({ mode: "plan", questions: [], pending: null, plan: null, plans: [] });
    expect((await call("GET", "/api/sessions/s_nope/plan-state")).status).toBe(404);
    expect((await call("POST", `/api/sessions/${s.id}/plan/answer`, { skip: true })).status).toBe(400);
    expect((await call("POST", `/api/sessions/${s.id}/plan/plans/pl_nope/approve`, {})).status).toBe(400);
  });
});

describe("what the agent is told and given", () => {
  test("the questionnaire preamble names both tools; the fallback is plain text", () => {
    const withTools = planPreamble({ tools: true });
    expect(withTools).toContain("plan_ask");
    expect(withTools).toContain("plan_submit");
    expect(withTools).toMatch(/ONE question per call/);
    expect(withTools).toMatch(/read-only/);
    const plain = planPreamble();
    expect(plain).not.toContain("plan_ask");
    expect(plain).toMatch(/one message, numbered/);
  });

  test("a plan-mode turn is told to use the tools when a daemon is behind it", async () => {
    const s = await settled(createLead({ prompt: "ECHO_PROMPT plan_submit", engine: "fake", cwd: makeDir(), mode: "plan" } as any).id);
    expect(s.last_output).toBe("prompt-has[plan_submit]=yes");
  });

  const listTools = async (env: Record<string, string>) => {
    const self = selfInvocation();
    const child = Bun.spawn([self.command, ...self.args, "mcp-serve"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, TRB_URL: srv.url, TRB_TOKEN: TOKEN, TRB_SESSION: "s_x", ...env } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    child.stdin.flush();
    const reader = child.stdout.getReader();
    let buf = "";
    while (!buf.includes("\n")) buf += new TextDecoder().decode((await reader.read()).value);
    child.kill();
    return (JSON.parse(buf.split("\n")[0]).result.tools as Array<{ name: string }>).map((t) => t.name);
  };

  test("the shim lists the plan tools only in plan mode, and can hide the subagent tools", async () => {
    const off = await listTools({ TRB_PLAN: "0" });
    expect(off).toContain("subagent_create");
    expect(off).not.toContain("plan_ask");
    const on = await listTools({ TRB_PLAN: "1", TRB_SUBAGENTS: "1" });
    expect(on).toEqual(expect.arrayContaining(["subagent_create", "plan_ask", "plan_submit"]));
    const planOnly = await listTools({ TRB_PLAN: "1", TRB_SUBAGENTS: "0" });
    expect(planOnly).toEqual(["plan_ask", "plan_submit"]);
  });

  test("claude: with the questionnaire wired, plan mode is an allowlist (its own plan mode refuses MCP tools); without it, the plain plan mode", async () => {
    const { ENGINES, CLAUDE_PLAN_TOOLS } = await import("../src/engines/registry");
    const trb = { type: "stdio" as const, command: "trb", args: ["mcp-serve"], env: { TRB_PLAN: "1" } };
    const wired = ENGINES.claude.build({ key: "k", prompt: "x", cwd: "/tmp", mcp: { trb }, timeoutSec: 60, mode: "plan" }, "claude").args;
    expect(wired).toEqual(expect.arrayContaining(["--allowedTools", ...CLAUDE_PLAN_TOOLS]));
    expect(wired).not.toContain("--permission-mode");
    expect(wired).not.toContain("--dangerously-skip-permissions");
    expect(CLAUDE_PLAN_TOOLS).not.toContain("Bash");
    expect(CLAUDE_PLAN_TOOLS.some((t) => /^(Edit|Write|MultiEdit|NotebookEdit)/.test(t))).toBe(false);
    const bare = ENGINES.claude.build({ key: "k", prompt: "x", cwd: "/tmp", mcp: {}, timeoutSec: 60, mode: "plan" }, "claude").args;
    expect(bare).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
    expect(bare).not.toContain("--allowedTools");
    const build = ENGINES.claude.build({ key: "k", prompt: "x", cwd: "/tmp", mcp: { trb }, timeoutSec: 60, mode: "build" }, "claude").args;
    expect(build).not.toContain("--allowedTools");
    expect(build).toContain("--dangerously-skip-permissions");
  });

  test("codex gets a day-long tool timeout for trb", async () => {
    const { ENGINES } = await import("../src/engines/registry");
    const codex = ENGINES.codex.build({ key: "k", prompt: "x", cwd: "/tmp", mcp: { trb: { type: "stdio", command: "trb", args: ["mcp-serve"], env: {} } }, timeoutSec: 60, mode: "plan" }, "codex").args;
    expect(codex).toContain("mcp_servers.trb.tool_timeout_sec=86400");
  });
});
