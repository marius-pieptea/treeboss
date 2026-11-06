import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START git-api\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END git-api\n"); });
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { makeRepo, resetState, sh } from "./helpers";

const TOKEN = "git-api-token";
let srv: ReturnType<typeof startServer>;
beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(() => srv.stop());

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/** A workspace opened on a SUBDIRECTORY of a repo: git speaks top-relative paths, the daemon runs in the subdirectory. */
async function subdirWorkspace() {
  resetState();
  const repo = makeRepo({ "pkg/app/a.txt": "1\n2\n3\n", "top.txt": "t\n" });
  const ws = (await call("POST", "/api/workspaces", { path: path.join(repo, "pkg/app") })).body.workspace.id as string;
  return { repo, ws };
}

describe("top-level git routes (subdirectory workspaces)", () => {
  test("status paths are top-relative, and stage/unstage by those paths work from a subdirectory workspace", async () => {
    const { repo, ws } = await subdirWorkspace();
    fs.writeFileSync(path.join(repo, "pkg/app/a.txt"), "1\nTWO\n3\n");
    fs.writeFileSync(path.join(repo, "pkg/app/new.txt"), "n\n");
    const st = (await call("GET", `/api/git/${ws}/status`)).body;
    expect(st.files.map((f: any) => f.path).sort()).toEqual(["pkg/app/a.txt", "pkg/app/new.txt"]);
    expect((await call("GET", `/api/git/${ws}/info`)).body.prefix).toBe("pkg/app/");
    expect((await call("POST", `/api/git/${ws}/t/stage`, { paths: ["pkg/app/a.txt"] })).status).toBe(200);
    expect(sh("git diff --cached --name-only", repo)).toBe("pkg/app/a.txt");
    expect((await call("POST", `/api/git/${ws}/t/unstage`, { paths: ["pkg/app/a.txt"] })).status).toBe(200);
    expect(sh("git diff --cached --name-only", repo)).toBe("");
  });

  test("diff by top-relative path, discard of an untracked file, and applying a hunk patch", async () => {
    const { repo, ws } = await subdirWorkspace();
    fs.writeFileSync(path.join(repo, "pkg/app/a.txt"), "1\nTWO\n3\n");
    const diff = (await call("GET", `/api/git/${ws}/t/diff?path=${encodeURIComponent("pkg/app/a.txt")}`)).body.diff as string;
    expect(diff).toContain("+TWO");
    expect((await call("POST", `/api/git/${ws}/t/apply`, { patch: diff, cached: true })).status).toBe(200);
    expect(sh("git show :pkg/app/a.txt", repo)).toBe("1\nTWO\n3");
    fs.writeFileSync(path.join(repo, "pkg/app/junk.txt"), "x\n");
    expect((await call("POST", `/api/git/${ws}/t/discard`, { paths: ["pkg/app/junk.txt"] })).status).toBe(200);
    expect(fs.existsSync(path.join(repo, "pkg/app/junk.txt"))).toBe(false);
  });

  test("a non-repository is a clear error; bad input is a 400", async () => {
    resetState();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(require("os").tmpdir(), "trb-plain-")));
    const ws = (await call("POST", "/api/workspaces", { path: dir })).body.workspace.id;
    expect((await call("POST", `/api/git/${ws}/t/stage`, { paths: ["x"] })).body.error).toMatch(/Not a git repository/);
    const { ws: ws2 } = await subdirWorkspace();
    expect((await call("POST", `/api/git/${ws2}/t/stage`, {})).status).toBe(400);
  });
});

describe("top-level log", () => {
  test("--all leaves out the internals of a stash, keeps real branches, and filters by path", async () => {
    resetState();
    const repo = makeRepo({ "a.txt": "1\n", "b.txt": "1\n" });
    const ws = (await call("POST", "/api/workspaces", { path: repo })).body.workspace.id;
    sh("git switch -q -c side && echo s > side.txt && git add -A && git -c user.email=t@t -c user.name=t commit -qm 'side work' && git switch -q main", repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
    sh("git stash -q", repo);
    const subjects = async (q: string) => ((await call("GET", `/api/git/${ws}/t/log${q}`)).body.commits as any[]).map((c) => c.subject);
    expect(await subjects("?all=1")).toEqual(expect.arrayContaining(["side work", "init"]));
    expect((await subjects("?all=1")).some((s) => /WIP on|index on/.test(s))).toBe(false);
    expect(await subjects("")).toEqual(["init"]); // current branch only
    expect(await subjects("?all=1&path=side.txt")).toEqual(["side work"]);
    expect(await subjects("?limit=1&skip=1&all=1")).toHaveLength(1);
  });

  test("an empty repository has an empty log", async () => {
    resetState();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(require("os").tmpdir(), "trb-empty-")));
    sh("git init -q -b main .", dir);
    const ws = (await call("POST", "/api/workspaces", { path: dir })).body.workspace.id;
    expect((await call("GET", `/api/git/${ws}/t/log?all=1`)).body.commits).toEqual([]);
  });
});

describe("detach", () => {
  test("checks out a commit without a branch; refuses a non-sha", async () => {
    resetState();
    const repo = makeRepo();
    const ws = (await call("POST", "/api/workspaces", { path: repo })).body.workspace.id;
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
    sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm second", repo);
    const first = sh("git rev-parse HEAD~1", repo);
    expect((await call("POST", `/api/git/${ws}/detach`, { sha: first })).status).toBe(200);
    expect((await call("GET", `/api/git/${ws}/status`)).body).toMatchObject({ detached: true, branch: null });
    expect((await call("POST", `/api/git/${ws}/detach`, { sha: "--help" })).status).toBe(400);
  });
});
