import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START sessions-api\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END sessions-api\n"); });
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import { setDaemonContext } from "../src/sessions/context";
import { getSession, interruptAll } from "../src/sessions/manager";
import { makeDir, makeRepo, resetState } from "./helpers";

const TOKEN = "sessions-api-token";
let srv: ReturnType<typeof startServer>;

beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
  setDaemonContext({ url: srv.url, token: TOKEN });
});
afterAll(() => {
  setDaemonContext(null);
  srv.stop();
});
afterEach(async () => {
  await interruptAll();
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

async function started(prompt: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = (await call("POST", "/api/sessions", { prompt, engine: "fake", cwd: makeDir(), ...extra })).body.session.id as string;
  for (let i = 0; i < 100; i++) {
    if (getSession(id)!.status !== "running") break;
    await Bun.sleep(50);
  }
  return id;
}

describe("rename", () => {
  test("changes the title, collapsing whitespace and capping the length", async () => {
    resetState();
    const id = await started("SAY hi");
    expect((await call("PATCH", `/api/sessions/${id}`, { title: "  Fix   the\n login bug " })).body).toMatchObject({ ok: true, title: "Fix the login bug" });
    expect(getSession(id)!.title).toBe("Fix the login bug");
    await call("PATCH", `/api/sessions/${id}`, { title: "x".repeat(300) });
    expect(getSession(id)!.title.length).toBe(100);
  });

  test("an empty title or an unknown session is refused", async () => {
    resetState();
    const id = await started("SAY hi");
    expect((await call("PATCH", `/api/sessions/${id}`, { title: "   " })).status).toBe(400);
    expect((await call("PATCH", "/api/sessions/s_ghost", { title: "x" })).status).toBe(404);
  });
});

describe("times", () => {
  test("every session has created and updated timestamps", async () => {
    resetState();
    const id = await started("SAY hi");
    const t = (await call("GET", "/api/session-times")).body.times;
    expect(t[id].created_at).toMatch(/^\d{4}-\d\d-\d\d /);
    expect(t[id].updated_at).toBeTruthy();
  });
});

describe("delete", () => {
  test("only a closed session can be deleted; its turns and log go with it", async () => {
    resetState();
    const id = await started("SAY hi");
    const open = await call("DELETE", `/api/sessions/${id}`);
    expect(open.status).toBe(409);
    expect(open.body.error).toContain("Close it before deleting");
    expect(getSession(id)).not.toBeNull();

    await call("POST", `/api/sessions/${id}/close`);
    expect((db().prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(id) as any).n).toBeGreaterThan(0);
    expect((await call("DELETE", `/api/sessions/${id}`)).body).toEqual({ deleted: 1 });
    expect(getSession(id)).toBeNull();
    expect((db().prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(id) as any).n).toBe(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(id) as any).n).toBe(0);
    expect((await call("DELETE", `/api/sessions/${id}`)).status).toBe(404);
  });

  test("a running session is never deleted", async () => {
    resetState();
    const id = (await call("POST", "/api/sessions", { prompt: "SLEEP 4000", engine: "fake", cwd: makeDir() })).body.session.id;
    expect((await call("DELETE", `/api/sessions/${id}`)).status).toBe(409);
    expect(getSession(id)!.status).toBe("running");
  });

  test("deleting a closed lead removes its closed heads too; a lead with a live head is refused", async () => {
    resetState();
    const repo = makeRepo();
    const lead = await started("SAY lead", { cwd: repo });
    const head = (await call("POST", `/api/sessions/${lead}/spawn`, { brief: "SLEEP 4000", engine: "fake" })).body.session.id;
    // The lead is idle but its head is working: closing the lead closes the head; deleting before that is refused.
    expect((await call("DELETE", `/api/sessions/${lead}`)).status).toBe(409);
    await call("POST", `/api/sessions/${lead}/close`);
    expect(getSession(head)!.status).toBe("closed");
    expect((await call("DELETE", `/api/sessions/${lead}`)).body).toEqual({ deleted: 2 });
    expect(getSession(head)).toBeNull();
  });
});
