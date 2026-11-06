import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { clearCodegraphCache, codegraphFor, codegraphStatus } from "../src/codegraph/detect";
import { ensureCodegraphIgnored } from "../src/codegraph/gitignore";
import { jobFinished, startCodegraph } from "../src/codegraph/jobs";
import { keepInSyncIdle, scheduleKeepInSync } from "../src/codegraph/autosync";
import { prefsOf, setPrefs, useSetting, workspaceIdFor } from "../src/codegraph/prefs";
import { setSetting } from "../src/settings";
import { startServer } from "../src/daemon/server";
import { Workspaces } from "../src/workspaces";
import { createChild, createLead, merge, close, readLog } from "../src/sessions/manager";
import { makeDir, makeRepo, resetState, settled, sh } from "./helpers";

process.env.TRB_CODEGRAPH_DEBOUNCE_MS = "40";
// These tests stand in for the CLI through PATH: keep the real bundled copy out of the way.
process.env.TRB_CODEGRAPH_BUNDLED = "0";
const oldPath = process.env.PATH;

interface Stub {
  dir: string;
  calls: () => string[];
  setPending: (n: number) => void;
}
/**
 * A `codegraph` stand-in. `status --json` reads status.json (so a test can make the index stale);
 * `sync` appends to calls.log, takes `syncMs`, tracks overlap, and clears the pending changes.
 */
function stub(opts: { pending?: number; syncMs?: number; syncFails?: boolean } = {}): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cg-sync-"));
  const write = (n: number) =>
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ initialized: true, fileCount: 3, nodeCount: 40, edgeCount: 60, lastIndexed: "2026-10-08T00:00:00Z", pendingChanges: { added: n, modified: 0, removed: 0 }, index: { reindexRecommended: false } }));
  write(opts.pending ?? 0);
  const f = path.join(dir, "codegraph");
  const ms = (opts.syncMs ?? 0) / 1000;
  fs.writeFileSync(
    f,
    `#!/bin/sh
D="$(dirname "$0")"
echo "$@" >> "$D/calls.log"
case "$1" in
  --version) echo 1.5.0;;
  status) cat "$D/status.json";;
  init|index) echo "indexing $2"; mkdir -p "$2/.codegraph"; echo "done";;
  sync)
    if [ -e "$D/busy" ]; then echo overlap >> "$D/overlap.log"; fi
    touch "$D/busy"; sleep ${ms}; rm -f "$D/busy"
    ${opts.syncFails ? 'echo "boom: disk on fire" >&2; exit 2' : `echo '{"initialized":true,"fileCount":3,"nodeCount":40,"edgeCount":60,"lastIndexed":"2026-10-08T01:00:00Z","pendingChanges":{"added":0,"modified":0,"removed":0},"index":{"reindexRecommended":false}}' > "$D/status.json"; echo "Synced"`};;
  *) exit 1;;
esac
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}:${oldPath}`;
  return {
    dir,
    calls: () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf-8").trim().split("\n").filter(Boolean) : []),
    setPending: write,
  };
}
const syncCalls = (s: Stub) => s.calls().filter((c) => c.startsWith("sync"));
const overlapped = (s: Stub) => fs.existsSync(path.join(s.dir, "overlap.log"));

beforeEach(() => {
  process.env.PATH = oldPath;
  resetState();
  db_clear();
  clearCodegraphCache();
});
afterAll(() => {
  process.env.PATH = oldPath;
});
function db_clear() {
  const { db } = require("../src/db");
  db().exec("DELETE FROM workspaces;");
}
const spawn = (parent: string, brief: string) => createChild({ caller: { sessionId: parent }, brief });
const indexed = (repo: string) => fs.mkdirSync(path.join(repo, ".codegraph"), { recursive: true });

describe(".gitignore helper", () => {
  const read = (d: string) => fs.readFileSync(path.join(d, ".gitignore"), "utf-8");
  test("no .gitignore: created with the entry", () => {
    const repo = makeRepo();
    expect(ensureCodegraphIgnored(repo)).toEqual({ changed: true, reason: "created" });
    expect(read(repo)).toBe(".codegraph/\n");
  });
  test("appends after existing content and leaves it untouched", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n# keep me\ndist\n");
    expect(ensureCodegraphIgnored(repo).reason).toBe("added");
    expect(read(repo)).toBe("node_modules/\n# keep me\ndist\n.codegraph/\n");
  });
  test("no trailing newline: one is added before the entry", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/");
    ensureCodegraphIgnored(repo);
    expect(read(repo)).toBe("node_modules/\n.codegraph/\n");
  });
  test("CRLF files stay CRLF", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "a\r\nb");
    ensureCodegraphIgnored(repo);
    expect(read(repo)).toBe("a\r\nb\r\n.codegraph/\r\n");
  });
  test.each([".codegraph", ".codegraph/", "/.codegraph/", ".codegraph/*", "  .codegraph/  "])("already ignored as %p: untouched, and idempotent", (line) => {
    const repo = makeRepo();
    const body = `x\r\n${line}\r\ny\r\n`;
    fs.writeFileSync(path.join(repo, ".gitignore"), body);
    expect(ensureCodegraphIgnored(repo)).toEqual({ changed: false, reason: "already-ignored" });
    expect(read(repo)).toBe(body);
  });
  test("an empty file gets the entry; running twice adds it once", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "");
    ensureCodegraphIgnored(repo);
    ensureCodegraphIgnored(repo);
    expect(read(repo)).toBe(".codegraph/\n");
  });
  test("outside a git checkout nothing is written", () => {
    const dir = makeDir();
    expect(ensureCodegraphIgnored(dir)).toEqual({ changed: false, reason: "not-a-git-checkout" });
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  });
});

describe("jobs: which command runs, and what is refused", () => {
  test("init runs `init <dir>`, adds the gitignore entry when asked, and notes it", async () => {
    const s = stub();
    const repo = makeRepo();
    const job = startCodegraph(repo, "init", { gitignore: true });
    const done = await jobFinished(job.id);
    expect(done?.state).toBe("done");
    expect(s.calls().find((c) => c.startsWith("init"))).toBe(`init ${repo}`);
    expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf-8")).toBe(".codegraph/\n");
    expect(done?.note).toMatch(/\.gitignore/);
  });
  test("init without the checkbox leaves .gitignore alone", async () => {
    stub();
    const repo = makeRepo();
    await jobFinished(startCodegraph(repo, "init", { gitignore: false }).id);
    expect(fs.existsSync(path.join(repo, ".gitignore"))).toBe(false);
  });
  test("init on an initialized project re-indexes; sync and index on an uninitialized one are refused", () => {
    stub();
    const repo = makeRepo();
    expect(() => startCodegraph(repo, "sync")).toThrow(/not initialized/i);
    expect(() => startCodegraph(repo, "reindex")).toThrow(/not initialized/i);
    indexed(repo);
    expect(startCodegraph(repo, "init").mode).toBe("reindex");
  });
  test("sync runs `sync <index root>` (from a subdirectory too); reindex runs `index`", async () => {
    const s = stub({ pending: 2 });
    const repo = makeRepo({ "pkg/a.txt": "x" });
    indexed(repo);
    await jobFinished(startCodegraph(path.join(repo, "pkg"), "sync").id);
    await jobFinished(startCodegraph(repo, "reindex").id);
    expect(s.calls().filter((c) => /^(sync|index)/.test(c))).toEqual([`sync ${repo}`, `index ${repo}`]);
  });
  test("a second request for the same root while one runs returns the running job", async () => {
    stub({ syncMs: 400 });
    const repo = makeRepo();
    indexed(repo);
    const a = startCodegraph(repo, "sync");
    const b = startCodegraph(repo, "sync");
    expect(b.id).toBe(a.id);
    await jobFinished(a.id);
  });
  test("a failing sync is a failed job with the CLI's message", async () => {
    stub({ syncFails: true });
    const repo = makeRepo();
    indexed(repo);
    const done = await jobFinished(startCodegraph(repo, "sync").id);
    expect(done?.state).toBe("failed");
    expect(done?.error).toMatch(/boom/);
  });
});

describe("per-workspace preferences", () => {
  test("defaults: follows the global setting; keep in sync is off", () => {
    stub();
    const repo = makeRepo();
    const w = Workspaces.open(repo);
    expect(prefsOf(w.id)).toEqual({ useOverride: null, keepInSync: false });
    expect(workspaceIdFor(path.join(repo, "sub", "deeper"))).toBe(w.id);
    expect(useSetting(repo)).toBe("auto");
    setSetting("codegraph", "off");
    expect(useSetting(repo)).toBe("off");
  });
  test("a workspace override beats the global setting, in both directions, and null returns to following it", () => {
    const repo = makeRepo();
    indexed(repo);
    stub();
    const w = Workspaces.open(repo);
    setSetting("codegraph", "off");
    setPrefs(w.id, { use: true });
    expect(codegraphFor(repo, null)).not.toBeNull();
    setSetting("codegraph", "auto");
    setPrefs(w.id, { use: false });
    expect(codegraphFor(repo, null)).toBeNull();
    expect(codegraphStatus(repo, { fresh: true })).toMatchObject({ setting: "off", useOverride: "off" });
    setPrefs(w.id, { use: null });
    expect(codegraphFor(repo, null)).not.toBeNull();
  });
  test("another workspace is unaffected", () => {
    const a = Workspaces.open(makeRepo());
    const b = Workspaces.open(makeRepo());
    setPrefs(a.id, { keepInSync: true, use: false });
    expect(prefsOf(b.id)).toEqual({ useOverride: null, keepInSync: false });
  });
});

describe("keep in sync", () => {
  const on = (repo: string) => setPrefs(Workspaces.open(repo).id, { keepInSync: true });

  test("enabled + index + changed files: one background sync", async () => {
    const s = stub({ pending: 3 });
    const repo = makeRepo();
    indexed(repo);
    on(repo);
    const lines: string[] = [];
    scheduleKeepInSync(repo, (l) => lines.push(l));
    await keepInSyncIdle();
    expect(syncCalls(s)).toEqual([`sync ${repo}`]);
    expect(lines.join("\n")).toMatch(/index synced \(3 changes\)/);
  });
  test("toggle off (the default): never syncs", async () => {
    const s = stub({ pending: 3 });
    const repo = makeRepo();
    indexed(repo);
    Workspaces.open(repo);
    scheduleKeepInSync(repo);
    await keepInSyncIdle();
    expect(syncCalls(s)).toEqual([]);
  });
  test("toggle on but no index: nothing runs and no .codegraph/ appears", async () => {
    const s = stub({ pending: 3 });
    const repo = makeRepo();
    on(repo);
    scheduleKeepInSync(repo);
    await keepInSyncIdle();
    expect(s.calls().filter((c) => /^(sync|init|index)/.test(c))).toEqual([]);
    expect(fs.existsSync(path.join(repo, ".codegraph"))).toBe(false);
  });
  test("nothing changed on disk: no sync", async () => {
    const s = stub({ pending: 0 });
    const repo = makeRepo();
    indexed(repo);
    on(repo);
    scheduleKeepInSync(repo);
    await keepInSyncIdle();
    expect(syncCalls(s)).toEqual([]);
  });
  test("a burst of requests is debounced into one sync", async () => {
    const s = stub({ pending: 1 });
    const repo = makeRepo();
    indexed(repo);
    on(repo);
    for (let i = 0; i < 5; i++) scheduleKeepInSync(repo);
    await keepInSyncIdle();
    expect(syncCalls(s)).toHaveLength(1);
  });
  test("serialized: a request during a running sync never overlaps it, and runs once more only if files changed again", async () => {
    const s = stub({ pending: 1, syncMs: 500 });
    const repo = makeRepo();
    indexed(repo);
    on(repo);
    scheduleKeepInSync(repo);
    await Bun.sleep(200); // the first sync is running now
    s.setPending(2);
    scheduleKeepInSync(repo);
    await Bun.sleep(150);
    s.setPending(2);
    await keepInSyncIdle();
    expect(overlapped(s)).toBe(false);
    expect(syncCalls(s).length).toBeGreaterThanOrEqual(1);
    expect(syncCalls(s).length).toBeLessThanOrEqual(2);
  });
  test("a failing sync is an info line, not an error, and does not throw", async () => {
    stub({ pending: 1, syncFails: true });
    const repo = makeRepo();
    indexed(repo);
    on(repo);
    const lines: string[] = [];
    scheduleKeepInSync(repo, (l) => lines.push(l));
    await keepInSyncIdle();
    expect(lines.join("\n")).toMatch(/\[codegraph\] sync failed: .*boom/);
  });

  test("after a lead's turn that changed files, the sync happens off the turn and is logged as info", async () => {
    const s = stub({ pending: 0 });
    const repo = makeRepo();
    indexed(repo);
    on(repo);
    const lead = createLead({ prompt: "WRITE touched.txt hi", engine: "fake", cwd: repo });
    await settled(lead.id);
    expect(syncCalls(s)).toEqual([]); // no pending changes on disk yet: nothing to do
    s.setPending(1); // as if the index now sees the file
    const l2 = createLead({ prompt: "SAY ok", engine: "fake", cwd: repo });
    await settled(l2.id);
    await keepInSyncIdle();
    expect(syncCalls(s)).toEqual([`sync ${repo}`]);
    const info = readLog(l2.id).filter((e) => e.kind === "info" && e.text.startsWith("[codegraph]"));
    expect(info.map((e) => e.text).join("\n")).toMatch(/index synced/);
  });
  test("worktree heads do not sync per turn; the merge into the parent's checkout does", async () => {
    const s = stub({ pending: 2 });
    const repo = makeRepo();
    indexed(repo);
    on(repo);
    const lead = createLead({ prompt: "SAY ready", engine: "fake", cwd: repo });
    await settled(lead.id);
    await keepInSyncIdle();
    const before = syncCalls(s).length; // the lead's own turn may have synced; the head must add nothing
    const head = spawn(lead.id, "WRITE child.txt made by child");
    await settled(head.id);
    await keepInSyncIdle();
    expect(syncCalls(s).length).toBe(before);
    s.setPending(1);
    expect(merge({ sessionId: lead.id }, head.id).merged).toBe(true);
    await keepInSyncIdle();
    expect(syncCalls(s).length).toBe(before + 1);
    await close({ sessionId: lead.id }, head.id);
  });
});

describe("api", () => {
  const withServer = async (fn: (call: (m: string, p: string, b?: unknown) => Promise<any>, ws: { id: string }, repo: string) => Promise<void>) => {
    const repo = makeRepo();
    const w = Workspaces.open(repo);
    const server = startServer({ port: 0, token: "tok", onShutdown: () => {} });
    const call = (method: string, p: string, body?: unknown) => fetch(`${server.url}${p}`, { method, headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json() as Promise<any>);
    try {
      await fn(call, w, repo);
    } finally {
      server.stop();
    }
  };
  const finish = async (call: (m: string, p: string) => Promise<any>, id: string) => {
    for (let i = 0; i < 80; i++) {
      const jr = await call("GET", `/api/codegraph/jobs/${id}`);
      const j = jr.job;
      if (!j) throw new Error(`no job ${id}: ${JSON.stringify(jr)}`);
      if (j.state !== "running") return j;
      await Bun.sleep(50);
    }
    throw new Error("job did not finish");
  };

  test("init (gitignore on by default, opt-out honoured), then sync, then full re-index", async () => {
    const s = stub({ pending: 2 });
    await withServer(async (call, w, repo) => {
      expect((await call("POST", `/api/workspaces/${w.id}/codegraph/sync`)).error).toMatch(/not initialized/i);
      const init = await finish(call, (await call("POST", `/api/workspaces/${w.id}/codegraph/init`)).job.id);
      expect(init).toMatchObject({ mode: "init", state: "done" });
      expect(init.note).toMatch(/\.gitignore/);
      expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf-8")).toContain(".codegraph/");
      expect(await finish(call, (await call("POST", `/api/workspaces/${w.id}/codegraph/init`)).job.id)).toMatchObject({ mode: "reindex", state: "done" });
      expect(await finish(call, (await call("POST", `/api/workspaces/${w.id}/codegraph/sync`)).job.id)).toMatchObject({ mode: "sync", state: "done" });
      expect(await finish(call, (await call("POST", `/api/workspaces/${w.id}/codegraph/index`)).job.id)).toMatchObject({ mode: "reindex", state: "done" });
      expect(s.calls().filter((c) => /^(init|sync|index)/.test(c)).map((c) => c.split(" ")[0])).toEqual(["init", "index", "sync", "index"]);
    });
  });
  test("init with gitignore:false leaves .gitignore alone", async () => {
    stub();
    await withServer(async (call, w, repo) => {
      await finish(call, (await call("POST", `/api/workspaces/${w.id}/codegraph/init`, { gitignore: false })).job.id);
      expect(fs.existsSync(path.join(repo, ".gitignore"))).toBe(false);
    });
  });
  test("prefs: use and keep in sync are per workspace and show up in the status", async () => {
    stub();
    await withServer(async (call, w, repo) => {
      indexed(repo);
      const st = (await call("PUT", `/api/workspaces/${w.id}/codegraph/prefs`, { keepInSync: true, use: false })).codegraph;
      expect(st).toMatchObject({ keepInSync: true, setting: "off", useOverride: "off" });
      const back = (await call("PUT", `/api/workspaces/${w.id}/codegraph/prefs`, { use: null })).codegraph;
      expect(back).toMatchObject({ keepInSync: true, setting: "auto", useOverride: null });
      expect((await call("GET", `/api/workspaces/${w.id}/codegraph?fresh=1`)).codegraph.keepInSync).toBe(true);
    });
  });
  test("the install command is offered, never run", async () => {
    process.env.PATH = "/nonexistent";
    clearCodegraphCache();
    await withServer(async (call, w) => {
      const g = await call("GET", "/api/codegraph");
      expect(g.available).toBe(false);
      expect(g.installCommand).toMatch(/install\.sh/);
      const st = (await call("GET", `/api/workspaces/${w.id}/codegraph?fresh=1`)).codegraph;
      expect(st).toMatchObject({ available: false, state: "unavailable" });
      expect(st.installCommand).toBe(g.installCommand);
      expect((await call("POST", `/api/workspaces/${w.id}/codegraph/init`)).error).toMatch(/not available/i);
    });
  });
});
