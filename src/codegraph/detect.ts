/**
 * CodeGraph: find the binary, find a project's index, report its state.
 *
 * Indexing is the operator's call: nothing here ever builds an index. A project counts as indexed
 * only when a `.codegraph/` directory already exists at its root or above it.
 */
import fs from "fs";
import path from "path";
import { getSetting } from "../settings";
import { keepInSyncFor, prefsOf, useSetting, workspaceIdFor } from "./prefs";

export type CodegraphSource = "override" | "bundled" | "path";

export interface CodegraphStatus {
  /** A codegraph executable resolved (override, bundled with the app, or on PATH). */
  available: boolean;
  version: string | null;
  /** Which executable is in use: the `codegraph_bin` setting, the copy shipped with the app, or PATH. */
  source: CodegraphSource | null;
  /** The directory holding `.codegraph/`, or null when the project has none. */
  root: string | null;
  /** incomplete: a `.codegraph/` exists but its last run never finished (killed init) or it cannot be read. */
  state: "none" | "indexed" | "stale" | "incomplete" | "unavailable";
  /** The index was built by an older extractor: sync cannot refresh it, a full re-index can. */
  reindexRecommended: boolean;
  /** The CodeGraph version that built the index, when it says. */
  builtWith: string | null;
  /** Why the state is what it is, when that is not obvious (a broken index, a bad `codegraph_bin`). */
  note: string | null;
  files: number;
  symbols: number;
  edges: number;
  lastIndexed: string | null;
  pendingChanges: number;
  /** Whether sessions here get the tools: the workspace's override, else the global `codegraph` setting. */
  setting: "auto" | "off";
  /** The workspace's own choice, or null when it follows the global setting. */
  useOverride: "auto" | "off" | null;
  /** Sync the index in the background after turns that changed files (off until the workspace turns it on). */
  keepInSync: boolean;
  /** Shown when the binary is missing; copied, never run. */
  installCommand: string;
}

export const CODEGRAPH_INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh";

export interface ResolvedCodegraph {
  bin: string;
  source: CodegraphSource;
  /** Set when `codegraph_bin` is configured but unusable and another source was taken instead. */
  note: string | null;
}

let bundledMemo: string | null | undefined;

/**
 * The copy that ships with the app (the `@colbymchenry/codegraph` dependency's per-platform bundle).
 * Its launcher is a plain shell script that execs the bundled runtime, so unlike the package's own
 * `npm-shim.js` it needs no `node` on PATH. Null when the platform package is not installed.
 */
export function bundledCodegraph(): string | null {
  if (bundledMemo !== undefined) return bundledMemo;
  bundledMemo = null;
  try {
    if (process.platform === "win32") return bundledMemo;
    const pkgJson = Bun.resolveSync("@colbymchenry/codegraph/package.json", import.meta.dir);
    const dir = fs.realpathSync(path.dirname(pkgJson));
    const bin = Bun.resolveSync(`@colbymchenry/codegraph-${process.platform}-${process.arch}/bin/codegraph`, dir);
    fs.accessSync(bin, fs.constants.X_OK);
    bundledMemo = bin;
  } catch {}
  return bundledMemo;
}

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Setting override, then the bundled copy, then PATH. `TRB_CODEGRAPH_BUNDLED=0` skips the bundled copy (tests that stub PATH). */
export function resolveCodegraph(): ResolvedCodegraph | null {
  let note: string | null = null;
  const override = String(getSetting("codegraph_bin") ?? "").trim();
  if (override) {
    if (executable(override)) return { bin: override, source: "override", note: null };
    note = `codegraph_bin is set to ${override}, which is not an executable file. Using another copy.`;
  }
  if (process.env.TRB_CODEGRAPH_BUNDLED !== "0") {
    const b = bundledCodegraph();
    if (b) return { bin: b, source: "bundled", note };
  }
  const onPath = Bun.which("codegraph", { PATH: process.env.PATH });
  return onPath ? { bin: onPath, source: "path", note } : null;
}

export function codegraphBinary(): string | null {
  return resolveCodegraph()?.bin ?? null;
}

/** The nearest directory at or above `dir` that holds a `.codegraph/` index. */
export function findIndexRoot(dir: string): string | null {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      if (fs.statSync(path.join(cur, ".codegraph")).isDirectory()) return cur;
    } catch {}
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

export function codegraphSetting(): "auto" | "off" {
  return getSetting("codegraph") === "off" ? "off" : "auto";
}

const TTL_MS = 5_000;
const cache = new Map<string, { at: number; value: CodegraphStatus }>();
let versionCache: { bin: string; version: string | null } | null = null;

export function clearCodegraphCache(): void {
  cache.clear();
  versionCache = null;
}

function versionOf(bin: string): string | null {
  if (versionCache?.bin === bin) return versionCache.version;
  const r = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  return rememberVersion(bin, r.exitCode, r.stdout.toString());
}

async function versionOfAsync(bin: string): Promise<string | null> {
  if (versionCache?.bin === bin) return versionCache.version;
  const r = await runCli([bin, "--version"], 10_000);
  return rememberVersion(bin, r.exitCode, r.stdout);
}

function rememberVersion(bin: string, exitCode: number | null, stdout: string): string | null {
  const out = exitCode === 0 ? stdout.trim().split("\n")[0] || null : null;
  versionCache = { bin, version: out };
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** What one CLI run returned. `exitCode` is null when it was killed (the timeout). */
interface CliRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(cmd: string[], timeoutMs: number): Promise<CliRun> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true, timeout: timeoutMs });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exitCode: p.signalCode ? null : exitCode, stdout, stderr };
  } catch (e: any) {
    return { exitCode: 1, stdout: "", stderr: String(e?.message ?? e) };
  }
}

const STATUS_TIMEOUT_MS = 10_000;

interface StatusPlan {
  key: string;
  bin: string | null;
  root: string | null;
  base: CodegraphStatus;
}

function planStatus(key: string, version: (bin: string) => string | null): StatusPlan {
  const resolved = resolveCodegraph();
  const bin = resolved?.bin ?? null;
  const root = findIndexRoot(key);
  const prefs = prefsOf(workspaceIdFor(key));
  const base: CodegraphStatus = { available: !!bin, version: bin ? version(bin) : null, source: resolved?.source ?? null, root, state: bin ? "none" : "unavailable", reindexRecommended: false, builtWith: null, note: resolved?.note ?? null, files: 0, symbols: 0, edges: 0, lastIndexed: null, pendingChanges: 0, setting: useSetting(key), useOverride: prefs.useOverride, keepInSync: prefs.keepInSync, installCommand: CODEGRAPH_INSTALL_COMMAND };
  return { key, bin, root, base };
}

/** The status `codegraph status --json` describes, or `base` marked indexed when the CLI did not answer in time. */
function statusFrom(base: CodegraphStatus, r: CliRun): CodegraphStatus {
  // The CLI did not answer in time: do not call a healthy index broken.
  if (r.exitCode === null) return { ...base, state: "indexed" };
  if (r.exitCode !== 0) {
    const err = (r.stderr || r.stdout).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim().split("\n")[0];
    return { ...base, state: "incomplete", note: err ? `The index could not be read: ${err}` : "The index could not be read." };
  }
  try {
    const j = JSON.parse(r.stdout);
    if (j.initialized === false) return { ...base, root: null, state: "none" };
    const p = j.pendingChanges ?? {};
    const pending = num(p.added) + num(p.modified) + num(p.removed);
    const idx = j.index ?? {};
    // `index.state` is "complete" once a run finished; anything else is a run that was killed midway.
    const unfinished = typeof idx.state === "string" && idx.state !== "complete";
    const reindex = idx.reindexRecommended === true;
    return {
      ...base,
      state: unfinished ? "incomplete" : pending > 0 || reindex ? "stale" : "indexed",
      reindexRecommended: reindex,
      builtWith: typeof idx.builtWithVersion === "string" ? idx.builtWithVersion : null,
      note: unfinished ? "The last index run never finished (it was interrupted). Re-index to rebuild it." : base.note,
      files: num(j.fileCount),
      symbols: num(j.nodeCount),
      edges: num(j.edgeCount),
      lastIndexed: typeof j.lastIndexed === "string" ? j.lastIndexed : null,
      pendingChanges: pending,
    };
  } catch {
    return { ...base, state: "indexed" };
  }
}

/** Index roots an index/sync job is writing to right now. */
const busyRoots = new Set<string>();

/**
 * Mark an index root as being written by a job. While it is, status answers from the last reading
 * instead of running `codegraph status`: that opens the same database, and the running indexer then
 * fails with "store worker: database is locked".
 */
export function setIndexBusy(root: string, busy: boolean): void {
  if (busy) busyRoots.add(path.resolve(root));
  else busyRoots.delete(path.resolve(root));
}

function cached(key: string, fresh: boolean | undefined): CodegraphStatus | null {
  const hit = cache.get(key);
  return !fresh && hit && Date.now() - hit.at < TTL_MS ? hit.value : null;
}

/** The last status seen for `key` (or a placeholder) when its index is being written, else null. */
function whileBusy(key: string): CodegraphStatus | null {
  if (busyRoots.size === 0) return null;
  const root = findIndexRoot(key);
  if (!root || !busyRoots.has(root)) return null;
  const last = cache.get(key)?.value;
  if (last) return last;
  return { ...planStatus(key, versionOf).base, state: "incomplete", note: "An index job is running on this project." };
}

/**
 * Index state for the project at `dir`, synchronously. Blocks for the CLI's run (about a second), so only the
 * `trb` CLI uses it; the daemon calls `codegraphStatusAsync`.
 */
export function codegraphStatus(dir: string, opts: { fresh?: boolean } = {}): CodegraphStatus {
  const key = path.resolve(dir);
  const hit = cached(key, opts.fresh) ?? whileBusy(key);
  if (hit) return hit;
  const plan = planStatus(key, versionOf);
  let value = plan.base;
  if (plan.bin && plan.root) {
    const r = Bun.spawnSync([plan.bin, "status", "--json", plan.root], { stdout: "pipe", stderr: "pipe", timeout: STATUS_TIMEOUT_MS, windowsHide: true });
    value = statusFrom(plan.base, { exitCode: r.exitCode === null || r.signalCode ? null : r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() });
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

const inflight = new Map<string, Promise<CodegraphStatus>>();

/** Index state for the project at `dir`, without blocking the daemon. Cached for a few seconds (the UI polls it); concurrent asks share one CLI run. */
export function codegraphStatusAsync(dir: string, opts: { fresh?: boolean } = {}): Promise<CodegraphStatus> {
  const key = path.resolve(dir);
  const hit = cached(key, opts.fresh) ?? whileBusy(key);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const resolved = resolveCodegraph();
    if (resolved?.bin) await versionOfAsync(resolved.bin);
    const plan = planStatus(key, versionOf);
    const value = plan.bin && plan.root ? statusFrom(plan.base, await runCli([plan.bin, "status", "--json", plan.root], STATUS_TIMEOUT_MS)) : plan.base;
    cache.set(key, { at: Date.now(), value });
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * The index a session should use, or null: needs the binary, the setting on, an existing index, and
 * (when an agent restricts its MCP servers) "codegraph" on its allow-list. Worktree heads pass their
 * base directory: a worktree has no `.codegraph/` of its own, the main checkout's index is the one.
 */
export function codegraphFor(baseDir: string, allowed: string[] | null | undefined): { root: string; bin: string } | null {
  if (useSetting(baseDir) === "off") return null;
  if (allowed && !allowed.includes("codegraph")) return null;
  const bin = codegraphBinary();
  if (!bin) return null;
  const root = findIndexRoot(baseDir);
  return root ? { root, bin } : null;
}

export { keepInSyncFor };

export const CODEGRAPH_HINT = "CodeGraph is available: prefer the codegraph_explore tool (and codegraph_node for one symbol or file) over grep and file-by-file reads when locating or understanding code.";
