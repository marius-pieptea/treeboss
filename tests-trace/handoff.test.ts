import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START handoff\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END handoff\n"); });
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import { runTurn, type RunTurnOptions } from "../src/engines/runner";
import { setDaemonContext } from "../src/sessions/context";
import { SUMMARY_PROMPT, continuationPrompt, handoff, handoffInto, summarize, transcriptSummary } from "../src/sessions/handoff";
import { createLead, getSession, interruptAll, send, setTurnRunner } from "../src/sessions/manager";
import { makeRepo, resetState, settled, sh } from "./helpers";

const MODEL_SUMMARY = `## Goal\nShip the greeting change.\n\n## Decisions\nTrim the name first.\n\n## Files touched\nsrc/greet.ts\n\n## Current state\nTests pass.\n\n## Open tasks\nDocument it.\n\n## Gotchas\nNone.`;
const asked: RunTurnOptions[] = [];
/** The real scripted engine for ordinary turns; a canned answer for the summarizer turn. */
const withSummarizer = (reply: string | null) =>
  setTurnRunner(async (o) => {
    if (o.prompt === SUMMARY_PROMPT) {
      asked.push(o);
      if (reply === null) return { success: false, output: "boom", sessionId: null, resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 1, stderr: "" };
      return { success: true, output: reply, sessionId: o.resumeId ?? null, resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" };
    }
    return runTurn(o);
  });

afterEach(async () => {
  setTurnRunner(null);
  asked.length = 0;
  await interruptAll();
});

async function lead(prompt: string, extra: Partial<Parameters<typeof createLead>[0]> = {}) {
  const repo = makeRepo({ "src/greet.ts": "export const a = 1;\n" });
  const s = createLead({ prompt, engine: "fake", cwd: repo, ...extra });
  return { repo, s: await settled(s.id) };
}

describe("transcript summary", () => {
  test("carries the first ask, later requests, changed files and the last answers", async () => {
    resetState();
    const { s, repo } = await lead("Make greet trim names\nWRITE src/greet.ts export const a = 2;\nSAY first answer");
    send({ operator: true }, s.id, "Also handle empty input\nSAY second answer");
    await settled(s.id);
    const text = transcriptSummary(getSession(s.id)!);
    expect(text).toContain("## Goal\nMake greet trim names");
    expect(text).toContain("Also handle empty input");
    expect(text).toContain("src/greet.ts");
    expect(text).toContain("second answer");
    expect(repo).toBeTruthy();
  });

  test("names the branch when the work is unmerged in a worktree", async () => {
    resetState();
    const { s } = await lead("WRITE src/new.ts hi\nSAY ok", { isolate: true });
    expect(transcriptSummary(getSession(s.id)!)).toContain(`\`${getSession(s.id)!.branch}\``);
  });
});

describe("summarize", () => {
  test("asks the idle session itself, resumed, without tools, and leaves its transcript alone", async () => {
    resetState();
    withSummarizer(MODEL_SUMMARY);
    const { s } = await lead("SAY done");
    const turnsBefore = db().prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(s.id) as { n: number };
    const r = await summarize(s.id);
    expect(r).toMatchObject({ method: "model", summary: MODEL_SUMMARY });
    expect(asked).toHaveLength(1);
    expect(asked[0].resumeId).toBe(getSession(s.id)!.cli_session_id);
    expect(asked[0].cwd).toBe(s.cwd);
    expect(asked[0].prompt).toContain("under 600 words");
    expect((db().prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(s.id) as { n: number }).n).toBe(turnsBefore.n);
  });

  test("falls back to the transcript when the model turn fails, and says why", async () => {
    resetState();
    withSummarizer(null);
    const { s } = await lead("Do the thing\nSAY done");
    const r = await summarize(s.id);
    expect(r.method).toBe("transcript");
    expect(r.note).toMatch(/could not summarize/);
    expect(r.summary).toContain("Do the thing");
  });

  test("uses the transcript for a busy session, without disturbing it", async () => {
    resetState();
    withSummarizer(MODEL_SUMMARY);
    const repo = makeRepo();
    const s = createLead({ prompt: "SAY start\nSLEEP 1500\nSAY end", engine: "fake", cwd: repo });
    const r = await summarize(s.id);
    expect(r).toMatchObject({ method: "transcript" });
    expect(r.note).toMatch(/still working/);
    expect(asked).toHaveLength(0);
    await settled(s.id);
  });

  test("uses the transcript when asked not to use the model", async () => {
    resetState();
    withSummarizer(MODEL_SUMMARY);
    const { s } = await lead("SAY done");
    expect((await summarize(s.id, { useModel: false })).method).toBe("transcript");
    expect(asked).toHaveLength(0);
  });
});

describe("handoff", () => {
  test("starts a new lead in the same directory with the summary as its first prompt, linked back", async () => {
    resetState();
    withSummarizer(MODEL_SUMMARY);
    const { s } = await lead("Build it\nSAY built");
    const r = await handoff(s.id, { instructions: "Write the docs.\nECHO_PROMPT Ship the greeting change" });
    const next = await settled(r.session.id);
    expect(next.id).not.toBe(s.id);
    expect(next.base_cwd).toBe(s.base_cwd);
    expect(next.handoff_from).toBe(s.id);
    expect(next.title).toBe(`Continue: ${s.title}`);
    expect(next.cli_session_id).not.toBe(s.cli_session_id); // a new conversation, not a resume
    const firstPrompt = (db().prepare("SELECT prompt FROM turns WHERE session_id = ? ORDER BY seq LIMIT 1").get(next.id) as { prompt: string }).prompt;
    expect(firstPrompt).toContain("<handoff_summary>");
    expect(firstPrompt).toContain("Ship the greeting change");
    expect(firstPrompt).toContain("Write the docs.");
    expect(next.last_output).toContain("prompt-has[Ship the greeting change]=yes");
    expect(handoffInto(next.id)).toMatchObject({ from_session: s.id, method: "model" });
  });

  test("the old session is untouched", async () => {
    resetState();
    withSummarizer(MODEL_SUMMARY);
    const { s } = await lead("SAY done");
    await settled((await handoff(s.id)).session.id);
    const after = getSession(s.id)!;
    expect(after.status).toBe("idle");
    expect(after.turns).toBe(s.turns);
    expect(after.cli_session_id).toBe(s.cli_session_id);
  });

  test("an edited summary is used as given, with no model call", async () => {
    resetState();
    withSummarizer(MODEL_SUMMARY);
    const { s } = await lead("SAY done");
    const r = await handoff(s.id, { summary: "My own briefing: do X.\nECHO_PROMPT My own briefing" });
    expect(r.method).toBe("edited");
    expect(asked).toHaveLength(0);
    expect((await settled(r.session.id)).last_output).toContain("=yes");
  });

  test("an explicit model is honored; otherwise the old session model is kept", async () => {
    resetState();
    withSummarizer(MODEL_SUMMARY);
    const { s } = await lead("SAY done", { model: "fake-big" });
    const same = await handoff(s.id, { summary: "x".repeat(100) });
    expect(same.session.model).toBe("fake-big");
    const other = await handoff(s.id, { summary: "x".repeat(100), engine: "fake", model: "fake-small" });
    expect(other.session.model).toBe("fake-small");
    await settled(same.session.id);
    await settled(other.session.id);
  });

  test("only a lead can be handed off, and a missing session is an error", async () => {
    resetState();
    await expect(handoff("s_nope")).rejects.toThrow(/No session/);
  });

  test("the continuation prompt defaults to the open tasks", () => {
    const text = continuationPrompt({ id: "s_1", title: "T" } as any, "## Goal\nx");
    expect(text).toContain("start with its open tasks");
    expect(text).toContain('("T", s_1)');
  });
});

describe("HTTP", () => {
  const TOKEN = "handoff-token";
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
    setDaemonContext({ url: srv.url, token: TOKEN });
  });
  afterAll(() => {
    setDaemonContext(null);
    srv.stop();
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  test("preview returns the summary and starts nothing; POST starts it; GET shows the lineage", async () => {
    resetState();
    withSummarizer(MODEL_SUMMARY);
    const { s } = await lead("SAY done");
    const before = (db().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    const prev = await call("POST", `/api/sessions/${s.id}/handoff`, { preview: true });
    expect(prev.body).toMatchObject({ method: "model", summary: MODEL_SUMMARY });
    expect((db().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(before);

    const go = await call("POST", `/api/sessions/${s.id}/handoff`, { summary: prev.body.summary, instructions: "Continue." });
    expect(go.status).toBe(201);
    expect(go.body.session.handoff_from).toBe(s.id);
    await settled(go.body.session.id);
    const lineage = await call("GET", `/api/sessions/${go.body.session.id}/handoff`);
    expect(lineage.body.handoff).toMatchObject({ from_session: s.id });
    expect((await call("GET", `/api/sessions/${s.id}/handoff`)).body.handoff).toBeNull();
  });

  test("compact is refused for an engine without /compact, and unknown sessions 404", async () => {
    resetState();
    const { s } = await lead("SAY done");
    db().prepare("UPDATE sessions SET engine = 'codex' WHERE id = ?").run(s.id);
    expect((await call("POST", `/api/sessions/${s.id}/compact`)).status).toBe(400);
    expect((await call("POST", "/api/sessions/s_nope/compact")).status).toBe(404);
    expect((await call("POST", "/api/sessions/s_nope/handoff", {})).status).toBe(404);
  });

  test("compact on a claude-style session sends /compact", async () => {
    resetState();
    const { s } = await lead("SAY ok\nUSAGE 150000");
    const r = await call("POST", `/api/sessions/${s.id}/compact`);
    expect(r.status).toBe(200);
    const done = await settled(s.id);
    expect(done.compactions).toBe(1);
  });
});
