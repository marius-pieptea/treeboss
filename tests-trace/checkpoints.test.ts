import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START checkpoints\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END checkpoints\n"); });
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import { checkpointBefore, checkpointOfTurn, listCheckpoints, prune, takeCheckpoint } from "../src/checkpoints/store";
import { forkSession, rewindSession } from "../src/checkpoints/fork";
import type { TurnResult } from "../src/engines/runner";
import { createLead, getSession, interruptAll, send, setTurnRunner } from "../src/sessions/manager";
import { makeDir, makeRepo, resetState, settled, sh } from "./helpers";

const result = (output = "ok"): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", });
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf-8");
const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const turnIds = (id: string) => (db().prepare("SELECT id FROM turns WHERE session_id = ? ORDER BY seq").all(id) as Array<{ id: string }>).map((t) => t.id);

beforeEach(() => {
  resetState();
  listCheckpoints("-"); // makes sure the tables exist
  db().exec("DELETE FROM checkpoints; DELETE FROM rewind_notices");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

/** A scripted agent: the nth turn runs `steps[n-1]` in the session's directory. */
function script(steps: Array<(cwd: string, prompt: string) => void>, prompts: string[] = []) {
  let n = 0;
  setTurnRunner(async (o) => {
    prompts.push(o.prompt);
    steps[Math.min(n, steps.length - 1)](o.cwd, o.prompt);
    n++;
    return result(`turn ${n}`);
  });
}

describe("checkpoints in a plain workspace", () => {
  test("a checkpoint per turn, plus a base, and nothing of the operator's is touched", async () => {
    const repo = makeRepo({ "a.txt": "one\n", ".gitignore": "ignored.log\n" });
    const before = { branches: sh("git branch -a", repo), stash: sh("git stash list", repo), head: sh("git rev-parse HEAD", repo) };
    write(repo, "ignored.log", "noise");
    script([(cwd) => write(cwd, "a.txt", "two\n"), (cwd) => write(cwd, "b.txt", "new\n")]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo });
    await settled(s.id);
    send({ operator: true }, s.id, "again");
    await settled(s.id);

    const cps = listCheckpoints(s.id);
    expect(cps.map((c) => c.kind)).toEqual(["base", "turn", "turn"]);
    expect(cps[1].changed).toBe(1);
    expect(cps[2].changed).toBe(1);
    // Hidden refs only.
    expect(sh("git for-each-ref --format='%(refname)' refs/trb/checkpoints", repo).split("\n")).toHaveLength(3);
    expect(sh("git branch -a", repo)).toBe(before.branches);
    expect(sh("git stash list", repo)).toBe(before.stash);
    expect(sh("git rev-parse HEAD", repo)).toBe(before.head);
    // The real index is untouched: nothing is staged, and the agent's edits are still just working-tree changes.
    expect(sh("git diff --cached --name-only", repo)).toBe("");
    expect(sh("git status --porcelain", repo)).toContain("?? b.txt");
    // Ignored files are not in a snapshot.
    expect(sh(`git ls-tree -r --name-only ${cps[2].commit_sha}`, repo)).not.toContain("ignored.log");
    expect(sh(`git ls-tree -r --name-only ${cps[2].commit_sha}`, repo)).toContain("b.txt");
  });

  test("rewind to before a turn restores modified, deleted and untracked files, and can be undone", async () => {
    const repo = makeRepo({ "a.txt": "one\n", "keep.txt": "keep\n", "gone.txt": "will be deleted\n" });
    const prompts: string[] = [];
    script(
      [
        (cwd) => write(cwd, "a.txt", "turn1\n"),
        (cwd) => {
          write(cwd, "a.txt", "turn2\n");
          write(cwd, "new/deep/file.txt", "untracked\n");
          fs.rmSync(path.join(cwd, "gone.txt"));
        },
        () => {},
      ],
      prompts,
    );
    const s = createLead({ prompt: "one", engine: "fake", cwd: repo });
    await settled(s.id);
    send({ operator: true }, s.id, "two");
    await settled(s.id);
    const [t1, t2] = turnIds(s.id);
    expect(read(repo, "a.txt")).toBe("turn2\n");
    expect(exists(repo, "gone.txt")).toBe(false);

    const head = sh("git rev-parse HEAD", repo);
    const r = rewindSession(s.id, t2);
    expect(r.turn).toBe(2);
    expect(read(repo, "a.txt")).toBe("turn1\n");
    expect(read(repo, "gone.txt")).toBe("will be deleted\n");
    expect(exists(repo, "new/deep/file.txt")).toBe(false);
    expect(exists(repo, "new")).toBe(false); // the empty directories it left go too
    expect(read(repo, "keep.txt")).toBe("keep\n");
    // Files only: HEAD and the real index did not move.
    expect(sh("git rev-parse HEAD", repo)).toBe(head);
    expect(sh("git diff --cached --name-only", repo)).toBe("");

    // The state it replaced was saved, so the rewind is itself reversible.
    const undo = listCheckpoints(s.id).find((c) => c.kind === "undo")!;
    expect(undo).toBeTruthy();
    expect(sh(`git show ${undo.commit_sha}:a.txt`, repo)).toBe("turn2");
    expect(sh(`git show ${undo.commit_sha}:new/deep/file.txt`, repo)).toBe("untracked");

    // The agent is told, once, in its next prompt.
    send({ operator: true }, s.id, "continue");
    await settled(s.id);
    expect(prompts[2]).toContain("were rewound to how they were before your turn 2");
    expect(prompts[2]).toContain("continue");
    send({ operator: true }, s.id, "and again");
    await settled(s.id);
    expect(prompts[3]).not.toContain("rewound");

    // Rewinding turn 1 goes back to the very start.
    rewindSession(s.id, t1);
    expect(read(repo, "a.txt")).toBe("one\n");
  });

  test("the first turn can be rewound (the base checkpoint), including its untracked files", async () => {
    const repo = makeRepo();
    write(repo, "wip.txt", "operator's own uncommitted file\n");
    script([(cwd) => {
      write(cwd, "a.txt", "agent\n");
      write(cwd, "made.txt", "by the agent\n");
    }]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo });
    await settled(s.id);
    rewindSession(s.id, turnIds(s.id)[0]);
    expect(read(repo, "a.txt")).toBe("one\n");
    expect(exists(repo, "made.txt")).toBe(false);
    expect(read(repo, "wip.txt")).toBe("operator's own uncommitted file\n");
  });

  test("files outside the session's own subdirectory are never touched", async () => {
    const repo = makeRepo({ "pkg/a.txt": "one\n", "other/o.txt": "other\n" });
    const sub = path.join(repo, "pkg");
    script([(cwd) => write(cwd, "a.txt", "changed\n"), () => {}]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: sub });
    await settled(s.id);
    write(repo, "other/o.txt", "edited by the operator meanwhile\n");
    rewindSession(s.id, turnIds(s.id)[0]);
    expect(read(repo, "pkg/a.txt")).toBe("one\n");
    expect(read(repo, "other/o.txt")).toBe("edited by the operator meanwhile\n");
  });

  test("rewind is refused while a turn is running, and for a session that is not in a git repository", async () => {
    const repo = makeRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    setTurnRunner(async () => {
      if (n++ === 1) await gate;
      return result();
    });
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo });
    await settled(s.id);
    send({ operator: true }, s.id, "slow");
    expect(() => rewindSession(s.id, turnIds(s.id)[0])).toThrow(/working/);
    release();
    await settled(s.id);

    setTurnRunner(async () => result());
    const plain = createLead({ prompt: "go", engine: "fake", cwd: makeDir() });
    await settled(plain.id);
    expect(listCheckpoints(plain.id)).toHaveLength(0);
    expect(() => rewindSession(plain.id, turnIds(plain.id)[0])).toThrow(/no checkpoint/);
  });

  test("node_modules (a linked symlink included) is never captured or rewound", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    fs.mkdirSync(path.join(repo, "node_modules/dep"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules/dep/index.js"), "x");
    script([(cwd) => write(cwd, "a.txt", "two\n")]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo });
    await settled(s.id);
    const cp = listCheckpoints(s.id).at(-1)!;
    expect(sh(`git ls-tree -r --name-only ${cp.commit_sha}`, repo)).not.toContain("node_modules");
    rewindSession(s.id, turnIds(s.id)[0]);
    expect(exists(repo, "node_modules/dep/index.js")).toBe(true);
  });

  test("a repository with no commits yet still checkpoints", async () => {
    const dir = makeDir();
    sh("git init -q -b main .", dir);
    script([(cwd) => write(cwd, "first.txt", "hello\n"), (cwd) => write(cwd, "first.txt", "changed\n")]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: dir });
    await settled(s.id);
    send({ operator: true }, s.id, "more");
    await settled(s.id);
    expect(listCheckpoints(s.id).map((c) => c.kind)).toEqual(["base", "turn", "turn"]);
    rewindSession(s.id, turnIds(s.id)[1]);
    expect(read(dir, "first.txt")).toBe("hello\n");
  });

  test("checkpointBefore, and pruning only touches this session's own refs", async () => {
    const repo = makeRepo();
    script([(cwd) => write(cwd, "x.txt", "1")]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo });
    await settled(s.id);
    for (let i = 0; i < 3; i++) {
      send({ operator: true }, s.id, `more ${i}`);
      await settled(s.id);
    }
    expect(checkpointBefore(s.id, 1)!.kind).toBe("base");
    expect(checkpointBefore(s.id, 3)!.seq).toBe(2);
    sh("git update-ref refs/trb/checkpoints/someone-else/t1 HEAD", repo);
    sh("git update-ref refs/heads/precious HEAD", repo);
    expect(prune(s.id, 2)).toBeGreaterThan(0);
    const refs = sh("git for-each-ref --format='%(refname)'", repo);
    expect(refs).toContain("refs/trb/checkpoints/someone-else/t1");
    expect(refs).toContain("refs/heads/precious");
    expect(refs).toContain(`refs/trb/checkpoints/${s.id}/base`);
  });
});

describe("over HTTP", () => {
  test("list, rewind and fork", async () => {
    const server = startServer({ port: 0, token: "tk" });
    try {
      const call = async (method: string, p: string, body?: unknown) => {
        const res = await fetch(`${server.url}${p}`, { method, headers: { authorization: "Bearer tk", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as any };
      };
      const repo = makeRepo({ "a.txt": "one\n" });
      script([(cwd) => write(cwd, "a.txt", "two\n"), (cwd) => write(cwd, "a.txt", "three\n")]);
      const s = createLead({ prompt: "go", engine: "fake", cwd: repo });
      await settled(s.id);
      send({ operator: true }, s.id, "more");
      await settled(s.id);

      const list = await call("GET", `/api/sessions/${s.id}/checkpoints`);
      expect(list.body.checkpoints.map((c: any) => c.kind)).toEqual(["base", "turn", "turn"]);
      expect(list.body.turns).toHaveLength(2);
      expect(list.body.can_rewind).toBe(true);

      const [t1, t2] = list.body.turns.map((t: any) => t.id);
      const rw = await call("POST", `/api/sessions/${s.id}/turns/${t2}/rewind`, {});
      expect(rw.status).toBe(200);
      expect(rw.body).toMatchObject({ turn: 2, restored: 1 });
      expect(read(repo, "a.txt")).toBe("two\n");
      expect((await call("POST", `/api/sessions/${s.id}/turns/t_nope/rewind`, {})).status).toBe(400);

      const fk = await call("POST", `/api/sessions/${s.id}/turns/${t1}/fork`, { instructions: "differently" });
      expect(fk.status).toBe(201);
      expect(fk.body.from_turn).toBe(1);
      expect(fk.body.session.isolation).toBe("worktree");
      await settled(fk.body.session.id);
      expect((await call("POST", `/api/sessions/s_nope/turns/${t1}/fork`, {})).status).toBe(404);
    } finally {
      server.stop();
    }
  });
});

describe("checkpoints in an isolated worktree", () => {
  test("rewinds inside the worktree, leaves the operator's checkout alone", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    script([(cwd) => write(cwd, "a.txt", "w1\n"), (cwd) => {
      write(cwd, "a.txt", "w2\n");
      write(cwd, "extra.txt", "x\n");
    }]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo, isolate: true });
    await settled(s.id);
    send({ operator: true }, s.id, "two");
    await settled(s.id);
    const wt = getSession(s.id)!;
    expect(wt.isolation).toBe("worktree");
    expect(listCheckpoints(s.id).map((c) => c.kind)).toEqual(["base", "turn", "turn"]);

    rewindSession(s.id, turnIds(s.id)[1]);
    expect(read(wt.cwd, "a.txt")).toBe("w1\n");
    expect(exists(wt.cwd, "extra.txt")).toBe(false);
    expect(read(repo, "a.txt")).toBe("one\n"); // the operator's checkout never changed
    expect(sh("git status --porcelain", repo)).toBe("");
  });

  test("fork starts a new isolated session at the end of the chosen turn, briefed with the conversation up to it", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    const prompts: string[] = [];
    script([(cwd) => write(cwd, "a.txt", "after-turn-1\n"), (cwd) => write(cwd, "a.txt", "after-turn-2\n"), () => {}], prompts);
    const s = createLead({ prompt: "first ask", engine: "fake", cwd: repo, isolate: true });
    await settled(s.id);
    send({ operator: true }, s.id, "second ask");
    await settled(s.id);
    const [t1, t2] = turnIds(s.id);

    const f = forkSession(s.id, t1, { instructions: "try the other way" });
    await settled(f.session.id);
    const forked = getSession(f.session.id)!;
    expect(forked.id).not.toBe(s.id);
    expect(forked.isolation).toBe("worktree");
    expect(forked.handoff_from).toBe(s.id);
    expect(read(forked.cwd, "a.txt")).toBe("after-turn-1\n");
    expect(forked.base_sha).toBe(checkpointOfTurn(s.id, t1)!.commit_sha);
    const brief = prompts[2];
    expect(brief).toContain("first ask");
    expect(brief).not.toContain("second ask");
    expect(brief).toContain("try the other way");
    // The original is untouched.
    expect(read(getSession(s.id)!.cwd, "a.txt")).toBe("after-turn-2\n");
    expect(() => forkSession(s.id, "t_missing")).toThrow(/no turn/);
    expect(t2).toBeTruthy();
  });
});
