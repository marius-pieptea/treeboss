import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import { makeDir, resetState } from "./helpers";

const TOKEN = "session-pins-token";
let srv: ReturnType<typeof startServer>;
beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(() => srv.stop());
beforeEach(() => resetState());

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/** Insert a lead directly: the list only reads rows, so the CLI engine is not needed. */
function lead(id: string, cwd: string, o: { created?: string; updated?: string; status?: string; pinned?: string } = {}): void {
  db().prepare("INSERT INTO sessions (id, title, root_id, engine, cwd, base_cwd, status, created_at, updated_at, pinned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, id, id, "claude", cwd, cwd, o.status ?? "idle", o.created ?? "2026-10-01 10:00:00", o.updated ?? o.created ?? "2026-10-01 10:00:00", o.pinned ?? null);
}

describe("sessions list order", () => {
  test("most recently updated first, not most recently started", async () => {
    const dir = makeDir();
    const ws = (await call("POST", "/api/workspaces", { path: dir })).body.workspace.id as string;
    lead("s_old_busy", dir, { created: "2026-10-01 09:00:00", updated: "2026-10-05 12:00:00" });
    lead("s_new_idle", dir, { created: "2026-10-03 09:00:00", updated: "2026-10-03 09:00:00" });
    lead("s_newest", dir, { created: "2026-10-04 09:00:00", updated: "2026-10-04 09:00:00" });
    const ids = (await call("GET", `/api/workspaces/${ws}/sessions`)).body.sessions.map((s: any) => s.id);
    expect(ids).toEqual(["s_old_busy", "s_newest", "s_new_idle"]);
  });
});

describe("sessions list is filtered before it is limited", () => {
  test("a busy neighbour cannot push this workspace's sessions out of the window", async () => {
    const root = makeDir();
    const mine = path.join(root, "mine");
    const busy = path.join(root, "busy");
    for (const d of [mine, busy]) fs.mkdirSync(d);
    const ws = (await call("POST", "/api/workspaces", { path: mine })).body.workspace.id as string;
    await call("POST", "/api/workspaces", { path: busy });
    lead("s_mine", mine, { created: "2020-01-01 00:00:00" });
    // 250 newer sessions in the other workspace: more than the 200 the route returns.
    for (let i = 0; i < 250; i++) lead(`s_busy_${i}`, busy, { created: `2026-10-02 00:00:${String(i % 60).padStart(2, "0")}` });
    const ids = (await call("GET", `/api/workspaces/${ws}/sessions`)).body.sessions.map((s: any) => s.id);
    expect(ids).toEqual(["s_mine"]);
  });

  test("a nested workspace keeps its own sessions out of its parent's list", async () => {
    const root = makeDir();
    const parent = path.join(root, "app");
    const nested = path.join(parent, "pkg");
    fs.mkdirSync(nested, { recursive: true });
    const pws = (await call("POST", "/api/workspaces", { path: parent })).body.workspace.id as string;
    await call("POST", "/api/workspaces", { path: nested });
    lead("s_parent", parent);
    lead("s_nested", nested);
    lead("s_deeper", path.join(nested, "src"));
    const ids = (await call("GET", `/api/workspaces/${pws}/sessions`)).body.sessions.map((s: any) => s.id);
    expect(ids).toEqual(["s_parent"]);
  });
});

describe("closed sessions are paged, not listed", () => {
  test("the default list leaves them out; closed=only pages them with a total, honours q, and skips pinned ones", async () => {
    const dir = makeDir();
    const ws = (await call("POST", "/api/workspaces", { path: dir })).body.workspace.id as string;
    lead("s_open", dir, { updated: "2026-10-09 00:00:00" });
    for (let i = 0; i < 5; i++) lead(`s_done_${i}`, dir, { status: "closed", updated: `2026-10-01 00:00:0${i}` });
    lead("s_done_pinned", dir, { status: "closed", pinned: "2026-10-02 00:00:00" });
    db().prepare("UPDATE sessions SET title = 'Fix 100%_login' WHERE id = 's_done_2'").run();

    expect((await call("GET", `/api/workspaces/${ws}/sessions`)).body.sessions.map((s: any) => s.id)).toEqual(["s_open"]);

    const first = (await call("GET", `/api/workspaces/${ws}/sessions?closed=only&limit=2`)).body;
    expect(first.total).toBe(5);
    expect(first.sessions.map((s: any) => s.id)).toEqual(["s_done_4", "s_done_3"]);
    expect(first.sessions[0].updated_at).toBe("2026-10-01 00:00:04");
    const second = (await call("GET", `/api/workspaces/${ws}/sessions?closed=only&limit=2&offset=2`)).body;
    expect(second.sessions.map((s: any) => s.id)).toEqual(["s_done_2", "s_done_1"]);

    // LIKE wildcards in the filter are literal.
    const found = (await call("GET", `/api/workspaces/${ws}/sessions?closed=only&q=${encodeURIComponent("100%_")}`)).body;
    expect(found).toMatchObject({ total: 1 });
    expect(found.sessions.map((s: any) => s.id)).toEqual(["s_done_2"]);
  });
});

describe("pinned sessions", () => {
  test("pin and unpin through PATCH; the pinned list spans workspaces and names each one", async () => {
    const a = makeDir();
    const b = makeDir();
    const wa = (await call("POST", "/api/workspaces", { path: a, name: "Alpha" })).body.workspace.id as string;
    await call("POST", "/api/workspaces", { path: b, name: "Beta" });
    lead("s_a", a);
    lead("s_b", b);
    expect((await call("PATCH", "/api/sessions/s_b", { pinned: true })).body.pinned).toBe(true);
    expect((await call("PATCH", "/api/sessions/s_a", { pinned: true })).body.pinned).toBe(true);
    const pinned = (await call("GET", "/api/sessions/pinned")).body.sessions as any[];
    expect(pinned.map((s) => s.id).sort()).toEqual(["s_a", "s_b"]);
    expect(pinned.find((s) => s.id === "s_b")).toMatchObject({ pinned: true, workspace_id: expect.any(String), workspace_name: "Beta" });
    expect(pinned.find((s) => s.id === "s_a").workspace_id).toBe(wa);
    expect((await call("PATCH", "/api/sessions/s_b", { pinned: false })).body.pinned).toBe(false);
    expect((await call("GET", "/api/sessions/pinned")).body.sessions.map((s: any) => s.id)).toEqual(["s_a"]);
  });

  test("a pinned session is still listed in its workspace, flagged pinned", async () => {
    const a = makeDir();
    const wa = (await call("POST", "/api/workspaces", { path: a })).body.workspace.id as string;
    lead("s_a", a);
    await call("PATCH", "/api/sessions/s_a", { pinned: true });
    const [s] = (await call("GET", `/api/workspaces/${wa}/sessions`)).body.sessions;
    expect(s).toMatchObject({ id: "s_a", pinned: true });
  });

  test("PATCH needs a title or a pinned flag, and an empty title is refused", async () => {
    const a = makeDir();
    await call("POST", "/api/workspaces", { path: a });
    lead("s_a", a);
    expect((await call("PATCH", "/api/sessions/s_a", {})).status).toBe(400);
    expect((await call("PATCH", "/api/sessions/s_a", { title: "   " })).status).toBe(400);
    expect((await call("PATCH", "/api/sessions/s_a", { title: "Renamed" })).body.title).toBe("Renamed");
  });
});
