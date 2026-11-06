import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { getEngine } from "../src/engines/registry";
import { finalizingOf } from "../src/sessions/finalize";
import { createLead, getSession, interruptAll, recoverOnStartup, send, setTurnRunner, viewSession } from "../src/sessions/manager";
import type { TurnResult } from "../src/engines/runner";
import { makeRepo, resetState, settled, sh } from "./helpers";

const result = (output = "ok"): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" });
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf-8").replace(/\r\n/g, "\n");
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

beforeEach(() => {
  resetState();
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

describe("finalization of a head after its turn", () => {
  test("a finished worktree turn is recorded at once, then finalized with its diff and head", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    setTurnRunner(async (o) => {
      write(o.cwd, "a.txt", "two\n");
      write(o.cwd, "b.txt", "new\n");
      return result();
    });
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo, isolate: true });
    await settled(s.id);
    // settled() also waits for the finalization that follows the turn's end (see wait in manager.ts).
    const turn = db().prepare("SELECT status, finished_at FROM turns WHERE session_id = ?").get(s.id) as { status: string; finished_at: string | null };
    expect(turn).toMatchObject({ status: "completed" });
    expect(turn.finished_at).not.toBeNull();
    expect(getSession(s.id)!.status).toBe("idle");

    const done = getSession(s.id)!;
    expect(done.finalized_at).not.toBeNull();
    const view = viewSession(done, { withOutput: false });
    expect(view.finalized).toBe(true);
    expect(view.changes).toEqual({ files: 2, insertions: 2, deletions: 1 });
    // The turn's commit is on the head's own branch, and the operator's checkout is untouched.
    expect(done.head_sha).toBe(sh("git rev-parse HEAD", done.worktree_root!));
    expect(done.head_sha).not.toBe(done.base_sha);
    expect(sh("git status --porcelain", repo)).toBe("");
  });

  test("a turn with no changes finalizes with no changes", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    setTurnRunner(async () => result("just talking"));
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo, isolate: true });
    await settled(s.id);
    const done = getSession(s.id)!;
    expect(done.finalized_at).not.toBeNull();
    expect(viewSession(done, { withOutput: false })).toMatchObject({ finalized: true, changes: null });
  });

  test("a head whose finalization has not run is not finalized; one from before finalization existed is", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    setTurnRunner(async () => result());
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo, isolate: true });
    await settled(s.id);
    // What a turn in progress looks like: the record was reset when it started and nothing has finalized it.
    db().prepare("UPDATE sessions SET finalized_at = NULL, changes_json = NULL WHERE id = ?").run(s.id);
    expect(viewSession(getSession(s.id)!, { withOutput: false }).finalized).toBe(false);
    // A session from before finalization existed: finalized, diff measured live.
    db().prepare("UPDATE sessions SET finalized_at = CURRENT_TIMESTAMP WHERE id = ?").run(s.id);
    expect(viewSession(getSession(s.id)!, { withOutput: false }).finalized).toBe(true);
  });

  test("a follow-up waits for the previous turn's finalization and then starts from it", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    const prompts: string[] = [];
    let n = 0;
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      n++;
      write(o.cwd, "a.txt", `turn ${n}\n`);
      return result();
    });
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo, isolate: true });
    await settled(s.id);
    send({ operator: true }, s.id, "again");
    await settled(s.id);
    const done = getSession(s.id)!;
    expect(n).toBe(2);
    expect(done.turns).toBe(2);
    expect(viewSession(done, { withOutput: false }).finalized).toBe(true);
  });

  test("the engine table has no conversation rollback yet: every engine is false", () => {
    for (const id of ["claude", "codex", "cursor", "opencode", "agy", "grok", "fake"]) {
      expect(getEngine(id)?.conversationRollback ?? false).toBe(false);
    }
  });
});

describe("startup recovery finishes a head whose finalization never ran", () => {
  test("its uncommitted work is committed as wip, its diff is recorded, and the worktree is kept", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    setTurnRunner(async (o) => {
      write(o.cwd, "a.txt", "two\n");
      return result();
    });
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo, isolate: true });
    await settled(s.id);
    const cwd = getSession(s.id)!.cwd;
    // What a daemon that died during finalization leaves: the turn ended, nothing was recorded after it, and the
    // turn's last edit was never committed.
    db().prepare("UPDATE sessions SET finalized_at = NULL, changes_json = NULL, head_sha = NULL WHERE id = ?").run(s.id);
    write(cwd, "b.txt", "later\n");

    const r = recoverOnStartup();
    expect(r.finalized).toBe(1);
    await finalizingOf(s.id);

    const done = getSession(s.id)!;
    expect(done.finalized_at).not.toBeNull();
    expect(viewSession(done, { withOutput: false })).toMatchObject({ finalized: true, changes: { files: 2, insertions: 2, deletions: 1 } });
    expect(done.head_sha).toBe(sh("git rev-parse HEAD", cwd));
    expect(sh("git ls-tree -r --name-only HEAD", cwd)).toContain("b.txt");
    expect(sh("git status --porcelain", cwd)).toBe("");
    expect(fs.existsSync(cwd)).toBe(true);
    // A second start has nothing left to finish.
    expect(recoverOnStartup().finalized).toBe(0);
  });
});
