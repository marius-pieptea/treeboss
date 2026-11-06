import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START files-api\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END files-api\n"); });
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { Workspaces } from "../src/workspaces";
import { makeDir, makeRepo, resetState } from "./helpers";

const TOKEN = "files-api-token";
let srv: ReturnType<typeof startServer>;
beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(() => srv.stop());

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

describe("POST /api/fs/:root/copy", () => {
  const setup = () => {
    resetState();
    const repo = makeRepo({ "a.txt": "alpha\n", "dir/inner.txt": "inner\n", "dir/deep/x.txt": "x\n" });
    return { repo, ref: Workspaces.open(repo).id };
  };

  test("duplicates a file, and a directory with its contents", async () => {
    const { repo, ref } = setup();
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: "a.txt", to: "a copy.txt" })).status).toBe(201);
    expect(fs.readFileSync(path.join(repo, "a copy.txt"), "utf-8")).toBe("alpha\n");
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: "dir", to: "dir copy" })).status).toBe(201);
    expect(fs.readFileSync(path.join(repo, "dir copy/deep/x.txt"), "utf-8")).toBe("x\n");
    expect(fs.existsSync(path.join(repo, "dir/inner.txt"))).toBe(true); // the original stays
  });

  test("never overwrites: an existing target is a 409", async () => {
    const { repo, ref } = setup();
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: "a.txt", to: "dir/inner.txt" })).status).toBe(409);
    expect(fs.readFileSync(path.join(repo, "dir/inner.txt"), "utf-8")).toBe("inner\n");
  });

  test("refuses to leave the workspace, touch .git, copy the root, or copy a folder into itself", async () => {
    const { ref } = setup();
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: "a.txt", to: "../escaped.txt" })).status).toBe(403);
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: "../../etc/hosts", to: "h" })).status).toBe(403);
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: ".git", to: "gitcopy" })).status).toBe(403);
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: "a.txt", to: ".git/a.txt" })).status).toBe(403);
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: "", to: "x" })).status).toBe(400);
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: "dir", to: "dir/deep/dir2" })).status).toBe(400);
  });

  test("a missing source is a 404; a symlink out of the root is not followed", async () => {
    const { repo, ref } = setup();
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: "ghost", to: "g2" })).status).toBe(404);
    const outside = makeDir();
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(repo, "escape"));
    expect((await call("POST", `/api/fs/${ref}/copy`, { from: "escape/secret.txt", to: "stolen.txt" })).status).toBe(403);
    expect(fs.existsSync(path.join(repo, "stolen.txt"))).toBe(false);
  });
});
