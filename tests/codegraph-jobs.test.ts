import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { bundledCodegraph, clearCodegraphCache, codegraphStatus, codegraphStatusAsync, resolveCodegraph } from "../src/codegraph/detect";
import { estimateIndexSize } from "../src/codegraph/estimate";
import { cancelCodegraphJob, dismissCodegraphJob, emptyProgress, jobFinished, latestJobFor, parseProgress, startCodegraph, stopAllCodegraphJobs } from "../src/codegraph/jobs";
import { resetSetting, setSetting } from "../src/settings";
import { startServer } from "../src/daemon/server";
import { Workspaces } from "../src/workspaces";
import { makeDir, makeRepo, resetState, sh } from "./helpers";
import { dotState, elapsed, sourceLabel } from "../web/src/features/codegraph/logic";

// The job and status tests stand in for the CLI through PATH; the resolution tests turn the bundled copy back on.
process.env.TRB_CODEGRAPH_BUNDLED = "0";
const oldPath = process.env.PATH;

/** A `codegraph` that prints what the real one prints on a terminal, then does what `mode` says. */
function stub(mode: "ok" | "fail" | "hang" | "slow" = "ok", status?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cg-jobs-"));
  const st = JSON.stringify({ initialized: true, version: "1.6.2", fileCount: 1204, nodeCount: 18200, edgeCount: 30000, lastIndexed: "2026-10-08T00:00:00Z", pendingChanges: { added: 0, modified: 0, removed: 0 }, index: { state: "complete", reindexRecommended: false }, ...status });
  fs.writeFileSync(path.join(dir, "status.json"), st);
  const body = {
    ok: `printf 'Scanning files... 1,204 found\\n'; printf 'Parsing code  ####  40%%\\r'; printf 'Parsing code  ####  100%%\\n'; printf 'Parsing code - done\\n'; mkdir -p "$2/.codegraph"; printf 'Resolving refs  ####  50%%\\n'; echo "Indexed 1,204 files"`,
    fail: `printf 'Scanning files...\\n'; mkdir -p "$2/.codegraph"; echo "Error: out of memory while parsing" >&2; exit 3`,
    hang: `printf 'Scanning files...\\n'; mkdir -p "$2/.codegraph"; printf 'Parsing code  ##  20%%\\n'; sleep 30`,
    slow: `printf 'Scanning files...\\n'; mkdir -p "$2/.codegraph"; sleep 30`,
  }[mode];
  fs.writeFileSync(path.join(dir, "codegraph"), `#!/bin/sh\nD="$(dirname "$0")"\ncase "$1" in\n  --version) echo 1.6.2;;\n  status) echo x >> "$D/status.calls"; cat "$D/status.json";;\n  init|index|sync) ${body};;\n  uninit) rm -rf "$3/.codegraph";;\n  *) exit 1;;\nesac\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  return dir;
}

beforeEach(() => {
  process.env.PATH = oldPath;
  process.env.TRB_CODEGRAPH_BUNDLED = "0";
  resetState();
  resetSetting("codegraph_bin");
  resetSetting("codegraph_timeout_min");
  clearCodegraphCache();
});
afterAll(() => {
  process.env.PATH = oldPath;
});

describe("progress parsing", () => {
  const feed = (...lines: string[]) => {
    const p = emptyProgress();
    const redraw = lines.map((l) => parseProgress(l, p));
    return { p, redraw };
  };
  test("terminal lines: phase, percent, scan count, and phase lines kept out of the log", () => {
    const { p, redraw } = feed("│  ◆ Scanning files — 2,817 found", "│  ✢ Parsing code  █████░░░░░░░░░░░░░░░░░░░░  44%");
    expect(p).toMatchObject({ phase: "Parsing code", step: 2, percent: 44, detail: null });
    expect(p.overall).toBeGreaterThan(30);
    expect(p.overall).toBeLessThan(50);
    expect(redraw).toEqual([true, true]);
  });
  test("the scan count shows while scanning and goes when the phase changes", () => {
    const p = emptyProgress();
    parseProgress("◆ Scanning files — 2,817 found", p);
    expect(p.detail).toBe("2,817 found");
    parseProgress("· Parsing code  ░░░  0%", p);
    expect(p.detail).toBeNull();
  });
  test("piped output (bare phase names) still gives a phase and no fake percentage", () => {
    const { p } = feed("Scanning files...", "Parsing code...", "Resolving refs...");
    expect(p).toMatchObject({ phase: "Resolving refs", step: 3, percent: null });
    expect(p.overall).toBeGreaterThan(60);
  });
  test("overall never goes backwards, and a done line completes its phase", () => {
    const p = emptyProgress();
    parseProgress("Parsing code  ██  80%", p);
    const at = p.overall!;
    parseProgress("Parsing code  ██  20%", p);
    expect(p.overall).toBe(at);
    parseProgress("◆ Parsing code — done", p);
    expect(p.percent).toBe(100);
    expect(p.overall).toBeGreaterThan(at);
  });
  test("an unknown phase is shown without a percentage; other lines are not progress", () => {
    const p = emptyProgress();
    expect(parseProgress("Compacting database...", p)).toBe(true);
    expect(p).toMatchObject({ phase: "Compacting database", percent: null });
    expect(parseProgress("Indexed 1,204 files", emptyProgress())).toBe(false);
  });
});

describe("estimate", () => {
  const put = (root: string, rel: string, n = 1) => {
    for (let i = 0; i < n; i++) {
      const f = path.join(root, rel.replace("*", String(i)));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "export const a = 1;\n");
    }
  };
  test("a git checkout counts source files and leaves out what CodeGraph skips", () => {
    const repo = makeRepo({ "src/a.ts": "x", "src/b.py": "y", "README.md": "# hi" });
    put(repo, "node_modules/p/x*.js", 5);
    put(repo, "dist/o*.js", 5);
    put(repo, ".next/c*.js", 5);
    sh("git add -A -f && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm more", repo);
    const e = estimateIndexSize(repo);
    expect(e).toMatchObject({ files: 2, method: "git", capped: false, warning: null });
  });
  test("a plain directory is walked, skipping dependency and dot directories", () => {
    const dir = makeDir();
    put(dir, "src/a*.ts", 3);
    put(dir, "node_modules/x/y*.js", 9);
    put(dir, ".cache/z*.js", 9);
    expect(estimateIndexSize(dir)).toMatchObject({ files: 3, method: "walk", capped: false });
  });
  test("vendored-looking directories CodeGraph does not skip are named in a warning", () => {
    const repo = makeRepo({ "src/a.ts": "x" });
    put(repo, "third_party/lib/f*.ts", 250);
    put(repo, "deps/d*.ts", 20);
    const e = estimateIndexSize(repo);
    expect(e.vendored).toEqual([{ dir: "third_party", files: 250 }]);
    expect(e.warning).toMatch(/third_party\/ \(250 files\)/);
    expect(e.warning).not.toMatch(/deps/);
  });
  test("a large project gets a time warning", () => {
    process.env.TRB_CODEGRAPH_LARGE_FILES = "5";
    try {
      const dir = makeDir();
      put(dir, "src/a*.ts", 8);
      expect(estimateIndexSize(dir).warning).toMatch(/large project.*about 8 files/i);
    } finally {
      delete process.env.TRB_CODEGRAPH_LARGE_FILES;
    }
  });
});

describe("resolution", () => {
  test("the bundled copy ships with the app, runs without node on PATH, and is the version package.json pins", () => {
    const bin = bundledCodegraph();
    expect(bin).toBeTruthy();
    const pinned = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf-8")).dependencies["@colbymchenry/codegraph"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    const r = Bun.spawnSync([bin!, "--version"], { env: { PATH: "/usr/bin:/bin" } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe(pinned);
  });
  test("order: setting override, then bundled, then PATH", () => {
    const onPath = stub();
    process.env.TRB_CODEGRAPH_BUNDLED = "1";
    expect(resolveCodegraph()?.source).toBe("bundled");
    process.env.TRB_CODEGRAPH_BUNDLED = "0";
    expect(resolveCodegraph()).toMatchObject({ source: "path", bin: path.join(onPath, "codegraph") });
    const custom = stub();
    setSetting("codegraph_bin", path.join(custom, "codegraph"));
    process.env.TRB_CODEGRAPH_BUNDLED = "1";
    expect(resolveCodegraph()).toMatchObject({ source: "override", bin: path.join(custom, "codegraph") });
  });
  test("a bad override is reported and the next source is used", () => {
    stub();
    setSetting("codegraph_bin", "/nope/codegraph");
    const r = resolveCodegraph()!;
    expect(r.source).toBe("path");
    expect(r.note).toMatch(/not an executable/);
    const st = codegraphStatus(makeRepo(), { fresh: true });
    expect(st).toMatchObject({ available: true, source: "path" });
    expect(st.note).toMatch(/codegraph_bin/);
  });
  test("nothing resolves: unavailable", () => {
    process.env.PATH = "/nonexistent";
    expect(resolveCodegraph()).toBeNull();
    expect(codegraphStatus(makeRepo(), { fresh: true })).toMatchObject({ available: false, source: null, state: "unavailable" });
  });
  test("the bundled copy reads status of a real index (no stub)", () => {
    process.env.TRB_CODEGRAPH_BUNDLED = "1";
    const repo = makeRepo({ "src/a.ts": "export function a() { return 1 }\n" });
    expect(codegraphStatus(repo, { fresh: true })).toMatchObject({ source: "bundled", state: "none" });
  });
});

describe("status states", () => {
  const indexedRepo = () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".codegraph"));
    return repo;
  };
  test("an index whose last run never finished is incomplete", () => {
    stub("ok", { index: { state: "indexing", reindexRecommended: true, builtWithVersion: null } });
    const st = codegraphStatus(indexedRepo(), { fresh: true });
    expect(st.state).toBe("incomplete");
    expect(st.note).toMatch(/never finished/i);
  });
  test("built by an older version: stale with reindexRecommended and the version that built it", () => {
    stub("ok", { index: { state: "complete", reindexRecommended: true, builtWithVersion: "1.5.0" } });
    expect(codegraphStatus(indexedRepo(), { fresh: true })).toMatchObject({ state: "stale", reindexRecommended: true, builtWith: "1.5.0", pendingChanges: 0 });
  });
  test("a .codegraph the CLI cannot read is incomplete, with the CLI's words", () => {
    const dir = stub();
    fs.writeFileSync(path.join(dir, "codegraph"), `#!/bin/sh\ncase "$1" in --version) echo 1.6.2;; status) echo "database disk image is malformed" >&2; exit 1;; esac\n`, { mode: 0o755 });
    const st = codegraphStatus(indexedRepo(), { fresh: true });
    expect(st.state).toBe("incomplete");
    expect(st.note).toMatch(/malformed/);
  });
  test("a healthy index is indexed", () => {
    stub();
    expect(codegraphStatus(indexedRepo(), { fresh: true })).toMatchObject({ state: "indexed", reindexRecommended: false, files: 1204 });
  });
});

describe("jobs", () => {
  test("init: progress is parsed, the result is summarised, and the job persists until dismissed", async () => {
    stub("ok");
    const repo = makeRepo();
    const job = startCodegraph(repo, "init", { gitignore: true });
    expect(job.createdRoot).toBe(true);
    expect(latestJobFor(repo)?.id).toBe(job.id);
    const done = (await jobFinished(job.id))!;
    expect(done.state).toBe("done");
    expect(done.progress.phase).toBeTruthy();
    expect(done.progress.overall).toBe(100);
    expect(done.summary).toMatch(/^Indexed 1,204 files, 18k symbols in \d+s$/);
    expect(done.note).toMatch(/gitignore/);
    expect(done.log.join("\n")).not.toMatch(/█|%/);
    expect(latestJobFor(repo)?.id).toBe(job.id); // still there for a reloaded page
    dismissCodegraphJob(job.id);
    expect(latestJobFor(repo)).toBeNull();
  });
  test("a failing CLI shows its own error, keeps the log, and does not delete the partial index", async () => {
    stub("fail");
    const repo = makeRepo();
    const job = startCodegraph(repo, "init", { gitignore: false });
    const done = (await jobFinished(job.id))!;
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/out of memory while parsing/);
    expect(fs.existsSync(path.join(repo, ".codegraph"))).toBe(true);
  });
  test("cancel kills the process and removes a .codegraph this init created", async () => {
    stub("hang");
    const repo = makeRepo();
    const job = startCodegraph(repo, "init", { gitignore: true });
    await Bun.sleep(400);
    expect(fs.existsSync(path.join(repo, ".codegraph"))).toBe(true);
    const done = (await cancelCodegraphJob(job.id))!;
    expect(done.state).toBe("cancelled");
    expect(done.note).toMatch(/partial \.codegraph\/ was removed/);
    expect(fs.existsSync(path.join(repo, ".codegraph"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".gitignore"))).toBe(false); // an unfinished init touches nothing else
  });
  test("cancelling a re-index keeps the existing index and says it may be incomplete", async () => {
    stub("hang");
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".codegraph"));
    const job = startCodegraph(repo, "reindex");
    expect(job.createdRoot).toBe(false);
    await Bun.sleep(300);
    const done = (await cancelCodegraphJob(job.id))!;
    expect(done.state).toBe("cancelled");
    expect(done.note).toMatch(/may be incomplete/);
    expect(fs.existsSync(path.join(repo, ".codegraph"))).toBe(true);
  });
  test("status does not open the index while a job writes it (the indexer would hit 'database is locked')", async () => {
    const bin = stub("hang");
    const calls = () => (fs.existsSync(path.join(bin, "status.calls")) ? fs.readFileSync(path.join(bin, "status.calls"), "utf8").split("\n").filter(Boolean).length : 0);
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".codegraph"));
    expect((await codegraphStatusAsync(repo, { fresh: true })).files).toBe(1204);
    const before = calls();
    const job = startCodegraph(repo, "reindex");
    const during = await Promise.all([codegraphStatusAsync(repo, { fresh: true }), codegraphStatusAsync(path.join(repo, "src"), { fresh: true })]);
    expect(during[0].files).toBe(1204); // the last reading, not a CLI run
    expect(during[1].state).toBe("incomplete"); // never read before: a placeholder
    expect(codegraphStatus(repo, { fresh: true }).files).toBe(1204);
    expect(calls()).toBe(before);
    await cancelCodegraphJob(job.id);
    await codegraphStatusAsync(repo, { fresh: true });
    expect(calls()).toBe(before + 1);
  });
  test("the time limit stops the job with a message that names the setting", async () => {
    stub("slow");
    const repo = makeRepo();
    const job = startCodegraph(repo, "init", { timeoutMs: 400 });
    const done = (await jobFinished(job.id))!;
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/time limit.*codegraph_timeout_min/s);
  });
  test("the default limit comes from the codegraph_timeout_min setting (0 = none)", () => {
    stub("slow");
    setSetting("codegraph_timeout_min", "7");
    const a = startCodegraph(makeRepo(), "init");
    expect(a.timeoutMs).toBe(7 * 60_000);
    setSetting("codegraph_timeout_min", "0");
    const b = startCodegraph(makeRepo(), "init");
    expect(b.timeoutMs).toBe(0);
    return Promise.all([cancelCodegraphJob(a.id), cancelCodegraphJob(b.id)]).then(() => {});
  });
  test("daemon shutdown ends running jobs cleanly and leaves the partial index to be detected", async () => {
    stub("hang", { index: { state: "indexing", reindexRecommended: true } });
    const repo = makeRepo();
    const job = startCodegraph(repo, "init");
    await Bun.sleep(300);
    await stopAllCodegraphJobs();
    const done = (await jobFinished(job.id))!;
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/daemon stopped/i);
    expect(fs.existsSync(path.join(repo, ".codegraph"))).toBe(true);
    expect(codegraphStatus(repo, { fresh: true }).state).toBe("incomplete");
  });
  test("a second request for the same index returns the running job", async () => {
    stub("hang");
    const repo = makeRepo();
    const a = startCodegraph(repo, "init");
    const b = startCodegraph(repo, "init");
    expect(b.id).toBe(a.id);
    await cancelCodegraphJob(a.id);
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

  test("status carries the running job (a reloaded page re-attaches), then the finished one until dismissed", async () => {
    stub("ok");
    await withServer(async (call, w) => {
      const started = (await call("POST", `/api/workspaces/${w.id}/codegraph/init`)).job;
      const mid = await call("GET", `/api/workspaces/${w.id}/codegraph?fresh=1`);
      expect(mid.job?.id).toBe(started.id);
      await jobFinished(started.id);
      const after = await call("GET", `/api/workspaces/${w.id}/codegraph?fresh=1`);
      expect(after.job).toMatchObject({ id: started.id, state: "done" });
      expect(after.codegraph.state).toBe("indexed");
      await call("POST", `/api/codegraph/jobs/${started.id}/dismiss`);
      expect((await call("GET", `/api/workspaces/${w.id}/codegraph?fresh=1`)).job).toBeNull();
    });
  });
  test("an empty .codegraph folder (an interrupted init) is not an index: init proceeds", async () => {
    stub("ok", { initialized: false });
    await withServer(async (call, w, repo) => {
      fs.mkdirSync(path.join(repo, ".codegraph"));
      const r = await call("POST", `/api/workspaces/${w.id}/codegraph/init`);
      expect(r.error).toBeUndefined();
      expect(r.job.mode).toBe("init");
    });
  });
  test("sync on a project with no index comes back as a readable 400", async () => {
    stub("ok");
    await withServer(async (call, w) => {
      expect((await call("POST", `/api/workspaces/${w.id}/codegraph/sync`)).error).toMatch(/not initialized/i);
    });
  });
  test("cancel over the API", async () => {
    stub("hang");
    await withServer(async (call, w, repo) => {
      const job = (await call("POST", `/api/workspaces/${w.id}/codegraph/init`)).job;
      await Bun.sleep(300);
      expect((await call("POST", `/api/codegraph/jobs/${job.id}/cancel`)).job.state).toBe("cancelled");
      expect(fs.existsSync(path.join(repo, ".codegraph"))).toBe(false);
      expect((await call("POST", `/api/codegraph/jobs/cg_nope/cancel`)).error).toMatch(/no such/i);
    });
  });
  test("estimate endpoint", async () => {
    stub("ok");
    await withServer(async (call, w) => {
      expect((await call("GET", `/api/workspaces/${w.id}/codegraph/estimate`)).estimate).toMatchObject({ method: "git", capped: false });
    });
  });
  test("uninit needs an explicit confirm, refuses while a job runs, then removes the index", async () => {
    stub("ok");
    await withServer(async (call, w, repo) => {
      fs.mkdirSync(path.join(repo, ".codegraph"));
      expect((await call("POST", `/api/workspaces/${w.id}/codegraph/uninit`, {})).error).toMatch(/confirm/);
      expect(fs.existsSync(path.join(repo, ".codegraph"))).toBe(true);
      const r = await call("POST", `/api/workspaces/${w.id}/codegraph/uninit`, { confirm: true });
      expect(r.codegraph.state).toBe("none");
      expect(fs.existsSync(path.join(repo, ".codegraph"))).toBe(false);
      expect((await call("POST", `/api/workspaces/${w.id}/codegraph/uninit`, { confirm: true })).error).toMatch(/not initialized/i);
    });
  });
  test("a resume of an interrupted init is a re-index of the existing directory", async () => {
    stub("ok", { index: { state: "indexing", reindexRecommended: true } });
    await withServer(async (call, w, repo) => {
      fs.mkdirSync(path.join(repo, ".codegraph"));
      expect((await call("GET", `/api/workspaces/${w.id}/codegraph?fresh=1`)).codegraph.state).toBe("incomplete");
      const job = (await call("POST", `/api/workspaces/${w.id}/codegraph/index`)).job;
      expect(job).toMatchObject({ mode: "reindex", createdRoot: false });
      await jobFinished(job.id);
    });
  });
});

describe("panel logic", () => {
  test("the dot: a running job wins, then a failed one, then the index state", () => {
    const st = (state: any) => ({ state, available: state !== "unavailable" });
    expect(dotState(st("indexed"), { state: "running" })).toBe("running");
    expect(dotState(st("indexed"), { state: "failed" })).toBe("failed");
    expect(dotState(st("indexed"), { state: "done" })).toBe("indexed");
    expect(dotState(st("none"), null)).toBe("none");
    expect(dotState(st("stale"), null)).toBe("stale");
    expect(dotState(st("incomplete"), null)).toBe("incomplete");
    expect(dotState(st("unavailable"), null)).toBe("unavailable");
  });
  test("elapsed and source labels", () => {
    expect(elapsed("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:42Z"))).toBe("42s");
    expect(elapsed("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:03:05Z"))).toBe("3m 05s");
    expect(sourceLabel({ available: true, source: "bundled", version: "1.6.2" })).toBe("bundled v1.6.2");
    expect(sourceLabel({ available: true, source: "path", version: "v1.5.0" })).toBe("from PATH v1.5.0");
    expect(sourceLabel({ available: true, source: "override", version: null })).toBe("custom path");
    expect(sourceLabel({ available: false, source: null, version: null })).toBe("not installed");
  });
});
