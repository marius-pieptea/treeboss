import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { Workspaces } from "../src/workspaces";
import { workspaceActivity } from "../src/daemon/routes/workspaces";
import { makeDir, resetState } from "./helpers";

beforeEach(() => resetState());

/** A session in `cwd` whose last turn ended with `turn` at `finished` (null: still running). */
function session(id: string, cwd: string, o: { status: string; turn: string; finished: string | null; depth?: number }): void {
  db()
    .prepare("INSERT INTO sessions (id, title, root_id, depth, engine, cwd, base_cwd, status, last_turn_id) VALUES (?, ?, ?, ?, 'claude', ?, ?, ?, ?)")
    .run(id, id, id, o.depth ?? 0, cwd, cwd, o.status, `t_${id}`);
  db().prepare("INSERT INTO turns (id, session_id, seq, prompt, status, finished_at) VALUES (?, ?, 1, 'go', ?, ?)").run(`t_${id}`, id, o.turn, o.finished);
}

const setSeen = (id: string, at: string) => db().prepare("UPDATE workspaces SET seen_at = ? WHERE id = ?").run(at, id);

describe("recent order", () => {
  test("switching to a workspace puts it first, even twice within one second", () => {
    const a = Workspaces.open(makeDir());
    const b = Workspaces.open(makeDir());
    const c = Workspaces.open(makeDir());
    // Well under a second apart (20 ms: the Windows clock ticks every ~15.6 ms), faster than a person flicks through the switcher.
    const touch = (id: string) => (Bun.sleepSync(20), Workspaces.touch(id));
    touch(a.id);
    touch(c.id);
    touch(b.id);
    // resetState keeps the workspaces other files registered: look at these three only.
    const mine = new Set([a.id, b.id, c.id]);
    expect(Workspaces.list().map((w) => w.id).filter((id) => mine.has(id))).toEqual([b.id, c.id, a.id]);
    touch(a.id);
    expect(Workspaces.list()[0]!.id).toBe(a.id);
  });

  test("marking a workspace seen leaves the order alone", () => {
    const a = Workspaces.open(makeDir());
    const b = Workspaces.open(makeDir());
    Bun.sleepSync(20);
    Workspaces.touch(b.id);
    Bun.sleepSync(20);
    Workspaces.markSeen(a.id);
    expect(Workspaces.list()[0]!.id).toBe(b.id);
  });
});

describe("done, not seen", () => {
  test("a lead that completed after the workspace was last seen counts; seeing it clears it", () => {
    const dir = makeDir();
    const w = Workspaces.open(dir);
    setSeen(w.id, "2026-01-01 00:00:00");
    session("s_done", dir, { status: "idle", turn: "completed", finished: "2026-01-02 00:00:00" });
    session("s_old", dir, { status: "idle", turn: "completed", finished: "2025-12-31 00:00:00" });
    expect(workspaceActivity()[w.id]).toEqual({ running: 0, failed: 0, done: 1 });
    Workspaces.markSeen(w.id);
    expect(workspaceActivity()[w.id]).toBeUndefined();
  });

  test("running, cancelled, failed and head sessions are not 'done'", () => {
    const dir = makeDir();
    const w = Workspaces.open(dir);
    setSeen(w.id, "2026-01-01 00:00:00");
    session("s_run", dir, { status: "running", turn: "running", finished: null });
    session("s_cancel", dir, { status: "idle", turn: "cancelled", finished: "2026-01-02 00:00:00" });
    session("s_fail", dir, { status: "failed", turn: "failed", finished: "2026-01-02 00:00:00" });
    session("s_head", dir, { status: "idle", turn: "completed", finished: "2026-01-02 00:00:00", depth: 1 });
    expect(workspaceActivity()[w.id]).toEqual({ running: 1, failed: 1, done: 0 });
  });

  test("each workspace is judged by its own seen mark", () => {
    const a = makeDir();
    const b = makeDir();
    const wa = Workspaces.open(a);
    const wb = Workspaces.open(b);
    setSeen(wa.id, "2026-01-01 00:00:00");
    setSeen(wb.id, "2026-03-01 00:00:00");
    session("s_a", a, { status: "idle", turn: "completed", finished: "2026-02-01 00:00:00" });
    session("s_b", b, { status: "idle", turn: "completed", finished: "2026-02-01 00:00:00" });
    const act = workspaceActivity();
    expect(act[wa.id]?.done).toBe(1);
    expect(act[wb.id]).toBeUndefined();
  });

  test("closed sessions are never 'done'", () => {
    const dir = makeDir();
    const w = Workspaces.open(dir);
    setSeen(w.id, "2026-01-01 00:00:00");
    session("s_closed", dir, { status: "closed", turn: "completed", finished: "2026-01-02 00:00:00" });
    expect(workspaceActivity()[w.id]).toBeUndefined();
  });
});
