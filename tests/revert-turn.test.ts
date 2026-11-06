import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import { revertLastTurn } from "../src/checkpoints/revert";
import { listCheckpoints } from "../src/checkpoints/store";
import type { TurnResult } from "../src/engines/runner";
import { close, createLead, getSession, interruptAll, send, setTurnRunner } from "../src/sessions/manager";
import { makeRepo, resetState, settled, sh } from "./helpers";

const result = (output = "ok"): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" });
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf-8").replace(/\r\n/g, "\n");
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

/** A scripted agent: the nth turn runs `steps[n-1]` in the session's directory. */
function script(steps: Array<(cwd: string) => void>) {
  let n = 0;
  setTurnRunner(async (o) => {
    steps[Math.min(n, steps.length - 1)](o.cwd);
    n++;
    return result(`turn ${n}`);
  });
}

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

describe("revert the last turn", () => {
  test("refused without filesOnly, before any file is touched; with it, the files go back to before the last turn", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    script([(cwd) => write(cwd, "a.txt", "two\n"), (cwd) => write(cwd, "a.txt", "three\n")]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo });
    await settled(s.id);
    send({ operator: true }, s.id, "more");
    await settled(s.id);

    expect(() => revertLastTurn(s.id)).toThrow(/not supported by the fake engine.*filesOnly/s);
    expect(read(repo, "a.txt")).toBe("three\n");

    const r = revertLastTurn(s.id, { filesOnly: true });
    expect(r.turn).toBe(2);
    expect(read(repo, "a.txt")).toBe("two\n");
  });

  test("refused while the head is working, and nothing is touched", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    script([(cwd) => write(cwd, "a.txt", "two\n")]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo });
    await settled(s.id);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const busy = new Promise<void>((r) => (started = r));
    setTurnRunner(async (o) => {
      write(o.cwd, "a.txt", "busy\n");
      started();
      await gate;
      return result();
    });
    send({ operator: true }, s.id, "again");
    try {
      await busy;
      expect(getSession(s.id)!.status).toBe("running");
      expect(() => revertLastTurn(s.id, { filesOnly: true })).toThrow(/still working|is working/);
      expect(read(repo, "a.txt")).toBe("busy\n");
    } finally {
      release();
      await settled(s.id);
    }
  });

  test("over HTTP: the route refuses without filesOnly (400, says why), and reverts with it", async () => {
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

      const refused = await call("POST", `/api/sessions/${s.id}/revert-turn`, {});
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain("not supported");
      expect(read(repo, "a.txt")).toBe("three\n");

      const ok = await call("POST", `/api/sessions/${s.id}/revert-turn`, { filesOnly: true });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ turn: 2, restored: 1 });
      expect(read(repo, "a.txt")).toBe("two\n");
    } finally {
      server.stop();
    }
  });
});

describe("closing a head drops its checkpoints", () => {
  test("refs and rows are removed; the operator's repository keeps its branches and HEAD", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    script([(cwd) => write(cwd, "a.txt", "two\n")]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo });
    await settled(s.id);
    expect(listCheckpoints(s.id).length).toBeGreaterThan(0);
    const head = sh("git rev-parse HEAD", repo);
    const branches = sh("git branch --format='%(refname)'", repo);

    await close({ operator: true }, s.id);

    expect(listCheckpoints(s.id)).toEqual([]);
    expect(sh(`git for-each-ref --format='%(refname)' refs/trb/checkpoints/${s.id}`, repo)).toBe("");
    expect(db().prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE session_id = ?").get(s.id)).toEqual({ n: 0 });
    expect(sh("git rev-parse HEAD", repo)).toBe(head);
    expect(sh("git branch --format='%(refname)'", repo)).toBe(branches);
  });

  test("a closed head cannot be reverted, and says why", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    script([(cwd) => write(cwd, "a.txt", "two\n")]);
    const s = createLead({ prompt: "go", engine: "fake", cwd: repo });
    await settled(s.id);
    await close({ operator: true }, s.id);
    expect(() => revertLastTurn(s.id, { filesOnly: true })).toThrow(/closed/);
  });
});
