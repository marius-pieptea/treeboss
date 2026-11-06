import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { interruptAll } from "../src/sessions/manager";
import { db } from "../src/db";
import { makeDir, resetState, settled } from "./helpers";

const TOKEN = "agents-api";
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
  db().exec("DELETE FROM agents");
});

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any };
};

describe("agents API", () => {
  test("CRUD with validation errors as 400s", async () => {
    const c = await call("POST", "/api/agents", { name: "scribe", title: "Scribe", instructions: "Write docs.", skills: [] });
    expect(c.status).toBe(201);
    expect(c.body.agent).toMatchObject({ name: "scribe", skills: [], used_by_pairs: [] });
    expect((await call("POST", "/api/agents", { name: "scribe" })).status).toBe(400);
    expect((await call("POST", "/api/agents", { name: "Bad Name" })).body.error).toContain("lowercase");
    expect((await call("PATCH", "/api/agents/scribe", { description: "docs", skills: null })).body.agent).toMatchObject({ description: "docs", skills: null, instructions: "Write docs." });
    expect((await call("GET", "/api/agents")).body.agents).toHaveLength(1);
    expect((await call("GET", "/api/agents/ghost")).status).toBe(404);
    expect((await call("DELETE", "/api/agents/scribe")).body.removed).toBe(true);
  });

  test("from a role template", async () => {
    const r = await call("POST", "/api/agents", { fromRole: "debugger", name: "bug-hunter" });
    expect(r.status).toBe(201);
    expect(r.body.agent).toMatchObject({ name: "bug-hunter", title: "Debugger" });
    expect(r.body.agent.instructions).toContain("Reproduce the failure first");
  });

  test("an agent used by a pair role cannot be deleted without force", async () => {
    await call("POST", "/api/agents", { name: "tester" });
    await call("POST", "/api/pairs", { title: "P", lead_engine: "fake", roles: { worker: { engine: "fake", agent: "tester" } } });
    expect((await call("GET", "/api/agents/tester")).body.agent.used_by_pairs).toEqual([{ pair: "P", role: "worker" }]);
    const del = await call("DELETE", "/api/agents/tester");
    expect(del.status).toBe(409);
    expect(del.body.error).toContain("P/worker");
    expect((await call("DELETE", "/api/agents/tester?force=1")).body.removed).toBe(true);
  });

  test("sessions start as an agent, with a skills override, and report both", async () => {
    await call("POST", "/api/agents", { name: "pirate", instructions: "Talk like a pirate. ARRR-MARK." });
    const s = await call("POST", "/api/sessions", { prompt: "ECHO_PROMPT ARRR-MARK", engine: "fake", cwd: makeDir(), agent: "pirate" });
    expect(s.status).toBe(201);
    expect(s.body.session).toMatchObject({ agent: "pirate" });
    expect((await settled(s.body.session.id)).last_output).toBe("prompt-has[ARRR-MARK]=yes");
    expect((await call("POST", "/api/sessions", { prompt: "x", engine: "fake", cwd: makeDir(), agent: "ghost" })).status).toBe(400);
    expect((await call("POST", "/api/sessions", { prompt: "x", engine: "fake", cwd: makeDir(), skills: ["ghost"] })).status).toBe(400);
  });
});
