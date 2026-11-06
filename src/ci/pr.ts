/**
 * Pull requests through the GitHub CLI (`gh`), signed in as the operator. Every call is an argv array run with
 * Bun.spawn, never a shell. `gh` is found on PATH; a missing or signed-out `gh` is a PrError (412) with the fix
 * in the message.
 *
 * A session with its own worktree branch can be turned into a PR (`sessionToPr`): the branch is pushed, and the
 * PR's title and body come from the session. The PRs a session opened are kept in `session_prs`, and `refreshPr`
 * brings their state and checks up to date.
 */
import fs from "fs";
import { db } from "../db";
import { getSession, type SessionRecord } from "../sessions/manager";
import { parseShortstat } from "../sessions/finalize";
import { git } from "../git/worktree";
import { owningWorkspace, resolveRoot } from "../workspaces";
import { sleep, UserError } from "../util";

export class PrError extends UserError {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type ChecksState = "none" | "pending" | "passing" | "failing";
export type MergeMethod = "squash" | "merge" | "rebase";

export interface CheckRun {
  name: string;
  /** pass, fail, pending, skipping or cancel: what gh rolls each run up to. */
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  state: string;
  link: string | null;
  workflow: string | null;
}

export interface PrSummary {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  head: string;
  base: string;
  updatedAt: string | null;
}

export interface PrDetail extends PrSummary {
  mergeState: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface SessionPrRow {
  workspaceId: string;
  number: number;
  sessionId: string | null;
  url: string;
  state: string;
  checksState: ChecksState;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* The runner                                                                 */
/* -------------------------------------------------------------------------- */

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `gh` with these args in `cwd`. Returns null when `gh` is not installed. Replaceable in tests. */
export type GhRunner = (args: string[], cwd: string, stdin?: string) => Promise<GhResult | null>;

/** `gh` never prompts and never checks for its own updates. */
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
const GH_TIMEOUT_MS = 120_000;

const spawnGh: GhRunner = async (args, cwd, stdin) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["gh", ...args], {
      cwd,
      env: { ...process.env, ...GH_ENV },
      stdin: stdin === undefined ? "ignore" : new Response(stdin),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (e: any) {
    if (e?.code === "ENOENT" || /not found|ENOENT/i.test(String(e?.message))) return null;
    throw e;
  }
  const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

let runGh: GhRunner = spawnGh;
/** Swap the runner (tests), or pass null to restore the real `gh`. */
export function setGhRunner(fn: GhRunner | null): void {
  runGh = fn ?? spawnGh;
}

const NOT_INSTALLED = "The GitHub CLI (gh) was not found. Install it from https://cli.github.com and run `gh auth login`.";
const NOT_SIGNED_IN = "The GitHub CLI is not signed in. Run `gh auth login` in a terminal, then try again.";
const SIGNED_OUT = /gh auth login|not logged (in|into)|authentication required|HTTP 401/i;

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";

/** One gh call. A missing or signed-out gh is a 412 with the fix in the message; other failures are returned to the caller. */
async function gh(cwd: string, args: string[], stdin?: string): Promise<GhResult> {
  const r = await runGh(args, cwd, stdin);
  if (!r) throw new PrError(NOT_INSTALLED, 412);
  if (r.code !== 0 && SIGNED_OUT.test(r.stderr)) throw new PrError(NOT_SIGNED_IN, 412);
  return r;
}

function must(r: GhResult, what: string): GhResult {
  if (r.code !== 0) throw new PrError(firstLine(r.stderr) || `${what} failed (exit ${r.code}).`, 400);
  return r;
}

/** Whether `gh` is installed and signed in, and as whom. */
export async function prReady(root: string): Promise<{ installed: boolean; user: string | null }> {
  const r = await runGh(["auth", "status"], root);
  if (!r) return { installed: false, user: null };
  if (r.code !== 0) return { installed: true, user: null };
  return { installed: true, user: /account (\S+)/.exec(r.stdout + r.stderr)?.[1] ?? "signed in" };
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

const PR_STATE: Record<string, PrSummary["state"]> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };
const PR_SUMMARY_FIELDS = "number,title,url,state,isDraft,headRefName,baseRefName,updatedAt";

function summaryOf(j: any): PrSummary {
  return {
    number: Number(j.number),
    title: String(j.title ?? ""),
    url: String(j.url ?? ""),
    state: PR_STATE[String(j.state).toUpperCase()] ?? "open",
    draft: j.isDraft === true,
    head: String(j.headRefName ?? ""),
    base: String(j.baseRefName ?? ""),
    updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
  };
}

/** The PR number from its URL (`…/pull/42`). */
export function prNumberOf(url: string): number | null {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/** gh's state for a check run, grouped the way `gh pr checks` groups it. */
export function bucketOf(state: string): CheckRun["bucket"] {
  const s = state.toUpperCase();
  if (["SUCCESS", "NEUTRAL"].includes(s)) return "pass";
  if (["SKIPPED", "SKIPPING"].includes(s)) return "skipping";
  if (["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(s)) return "fail";
  if (["CANCELLED", "CANCELED", "STALE"].includes(s)) return "cancel";
  return "pending";
}

/** One state for a PR's checks: failing beats pending beats passing. No checks at all is "none". */
export function rollupChecks(checks: CheckRun[]): ChecksState {
  if (!checks.length) return "none";
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "failing";
  if (checks.some((c) => c.bucket === "pending")) return "pending";
  return "passing";
}

/* -------------------------------------------------------------------------- */
/* PR calls                                                                   */
/* -------------------------------------------------------------------------- */

export interface PrCreateInput {
  title: string;
  body?: string;
  base?: string | null;
  head?: string | null;
  draft?: boolean;
}

/** Open a PR from the folder's current branch (or `head`). The body goes through stdin, so its length is no problem. */
export async function prCreate(root: string, o: PrCreateInput): Promise<{ number: number; url: string }> {
  const title = o.title.trim();
  if (!title) throw new PrError("A pull request needs a title.");
  const args = ["pr", "create", `--title=${title}`, "--body-file=-"];
  if (o.base) args.push(`--base=${o.base}`);
  if (o.head) args.push(`--head=${o.head}`);
  if (o.draft) args.push("--draft");
  const r = must(await gh(root, args, o.body ?? ""), "gh pr create");
  const url = r.stdout.trim().split("\n").pop()?.trim() ?? "";
  const number = prNumberOf(url);
  if (number === null) throw new PrError(`gh did not return a pull request URL: ${firstLine(r.stdout) || "no output"}`, 502);
  return { number, url };
}

export async function prView(root: string, n: number): Promise<PrDetail> {
  const r = must(await gh(root, ["pr", "view", String(n), "--json", `${PR_SUMMARY_FIELDS},mergeStateStatus,additions,deletions,changedFiles`]), "gh pr view");
  const j = JSON.parse(r.stdout);
  return { ...summaryOf(j), mergeState: typeof j.mergeStateStatus === "string" ? j.mergeStateStatus : null, additions: Number(j.additions ?? 0), deletions: Number(j.deletions ?? 0), changedFiles: Number(j.changedFiles ?? 0) };
}

export async function prList(root: string, o: { state?: "open" | "closed" | "merged" | "all" } = {}): Promise<PrSummary[]> {
  const state = o.state ?? "open";
  if (!["open", "closed", "merged", "all"].includes(state)) throw new PrError("state must be open, closed, merged or all.");
  const r = must(await gh(root, ["pr", "list", `--state=${state}`, "--limit=50", "--json", PR_SUMMARY_FIELDS]), "gh pr list");
  return (JSON.parse(r.stdout || "[]") as any[]).map(summaryOf);
}

/** The PR's checks. `gh pr checks` exits non-zero while checks are pending or failing, so its output decides. */
export async function prChecks(root: string, n: number): Promise<CheckRun[]> {
  const r = await gh(root, ["pr", "checks", String(n), "--json", "name,state,bucket,link,workflow"]);
  let items: unknown = null;
  try {
    items = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    items = null;
  }
  if (!Array.isArray(items)) {
    if (r.code === 0 || /no checks/i.test(r.stderr)) return [];
    must(r, "gh pr checks");
  }
  return (items as any[]).map((c) => ({
    name: String(c.name ?? ""),
    state: String(c.state ?? ""),
    bucket: (["pass", "fail", "pending", "skipping", "cancel"].includes(c.bucket) ? c.bucket : bucketOf(String(c.state ?? ""))) as CheckRun["bucket"],
    link: typeof c.link === "string" && c.link ? c.link : null,
    workflow: typeof c.workflow === "string" && c.workflow ? c.workflow : null,
  }));
}

export interface PrMergeOptions {
  method?: MergeMethod;
  deleteBranch?: boolean;
}

/**
 * Merge an open PR. Refused while its checks are failing: a red PR is not merged from here, even when the repo
 * would let it through. (Pending checks are left to gh and the repo's own rules.)
 */
export async function prMerge(root: string, n: number, o: PrMergeOptions = {}): Promise<{ number: number; method: MergeMethod }> {
  const method = o.method ?? "squash";
  if (!["squash", "merge", "rebase"].includes(method)) throw new PrError("The merge method must be squash, merge or rebase.");
  const pr = await prView(root, n);
  if (pr.state !== "open") throw new PrError(`PR #${n} is ${pr.state}, not open.`, 409);
  if (rollupChecks(await prChecks(root, n)) === "failing") throw new PrError(`PR #${n} has failing checks. Fix them before merging.`, 409);
  const args = ["pr", "merge", String(n), `--${method}`];
  if (o.deleteBranch) args.push("--delete-branch");
  must(await gh(root, args), "gh pr merge");
  return { number: n, method };
}

/* -------------------------------------------------------------------------- */
/* The session_prs table                                                      */
/* -------------------------------------------------------------------------- */

let ready = false;
function tables(): void {
  if (ready) return;
  db().exec(`CREATE TABLE IF NOT EXISTS session_prs (
    workspace_id TEXT NOT NULL, number INTEGER NOT NULL, session_id TEXT, url TEXT NOT NULL,
    state TEXT NOT NULL, checks_state TEXT NOT NULL DEFAULT 'none', updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, number)
  )`);
  db().exec("CREATE INDEX IF NOT EXISTS session_prs_session ON session_prs (session_id)");
  ready = true;
}

interface PrRowDb {
  workspace_id: string;
  number: number;
  session_id: string | null;
  url: string;
  state: string;
  checks_state: ChecksState;
  updated_at: string;
}
const toRow = (r: PrRowDb): SessionPrRow => ({ workspaceId: r.workspace_id, number: r.number, sessionId: r.session_id, url: r.url, state: r.state, checksState: r.checks_state, updatedAt: r.updated_at });

export function sessionPrsOf(workspaceId: string): SessionPrRow[] {
  tables();
  return (db().prepare("SELECT * FROM session_prs WHERE workspace_id = ? ORDER BY number DESC").all(workspaceId) as PrRowDb[]).map(toRow);
}

function prRow(workspaceId: string, number: number): SessionPrRow | null {
  tables();
  const r = db().prepare("SELECT * FROM session_prs WHERE workspace_id = ? AND number = ?").get(workspaceId, number) as PrRowDb | undefined;
  return r ? toRow(r) : null;
}

/** The open PR a session already has, if any. */
function openPrOf(sessionId: string): SessionPrRow | null {
  tables();
  const r = db().prepare("SELECT * FROM session_prs WHERE session_id = ? AND state = 'open' ORDER BY number DESC LIMIT 1").get(sessionId) as PrRowDb | undefined;
  return r ? toRow(r) : null;
}

/**
 * Bring a PR's state and checks up to date in the table. A PR opened outside TreeBoss gets a row with no session.
 * Returns the row and the checks.
 */
export async function refreshPr(workspaceId: string, n: number): Promise<{ pr: SessionPrRow; detail: PrDetail; checks: CheckRun[] }> {
  const dir = resolveRoot(workspaceId).dir;
  const detail = await prView(dir, n);
  const checks = await prChecks(dir, n);
  const checksState = rollupChecks(checks);
  tables();
  db()
    .prepare(
      `INSERT INTO session_prs (workspace_id, number, session_id, url, state, checks_state, updated_at) VALUES (?, ?, NULL, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(workspace_id, number) DO UPDATE SET url = excluded.url, state = excluded.state, checks_state = excluded.checks_state, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(workspaceId, n, detail.url, detail.state, checksState);
  return { pr: prRow(workspaceId, n)!, detail, checks };
}

/**
 * Poll a PR's checks until they pass or fail, or the timeout passes. "none" keeps polling too: a push's checks
 * appear a moment after the push. Returns the last state seen; `timedOut` is true when it did not settle.
 */
export async function waitForChecks(root: string, n: number, timeoutSec: number, o: { intervalSec?: number } = {}): Promise<{ state: ChecksState; checks: CheckRun[]; timedOut: boolean }> {
  const deadline = Date.now() + Math.max(0, timeoutSec) * 1000;
  const interval = Math.max(1, o.intervalSec ?? 15) * 1000;
  for (;;) {
    const checks = await prChecks(root, n);
    const state = rollupChecks(checks);
    if (state === "passing" || state === "failing") return { state, checks, timedOut: false };
    const left = deadline - Date.now();
    if (left <= 0) return { state, checks, timedOut: true };
    await sleep(Math.min(interval, left));
  }
}

/* -------------------------------------------------------------------------- */
/* Session to PR                                                              */
/* -------------------------------------------------------------------------- */

const TITLE_MAX = 72;
const SUMMARY_MAX = 2000;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** The output of the session's latest completed turn, the summary a reviewer reads first. */
function latestTurnOutput(sessionId: string): string {
  const r = db().prepare("SELECT output FROM turns WHERE session_id = ? AND status = 'completed' ORDER BY seq DESC LIMIT 1").get(sessionId) as { output: string | null } | undefined;
  return (r?.output ?? "").trim();
}

/** `N files changed, +A -D` against the commit the session started from, or null when there is nothing to measure. */
function diffStatOf(s: SessionRecord): { files: number; insertions: number; deletions: number } | null {
  if (!s.worktree_root || !s.base_sha) return null;
  const r = git(["diff", "--shortstat", `${s.base_sha}..HEAD`], s.worktree_root);
  if (!r.ok) return null;
  return parseShortstat(r.stdout);
}

export function prBodyFor(s: SessionRecord, summary: string, stat: { files: number; insertions: number; deletions: number } | null): string {
  const shown = summary ? clip(summary, SUMMARY_MAX) : "No turn has finished yet.";
  const changes = stat && stat.files ? `${stat.files} file${stat.files === 1 ? "" : "s"} changed, +${stat.insertions} -${stat.deletions}` : "No changes against the starting commit yet.";
  return ["## Summary", "", shown, "", "## Changes", "", changes, "", `Session \`${s.id}\` in TreeBoss, on branch \`${s.branch}\`.`, ""].join("\n");
}

export interface SessionPrResult {
  pr: SessionPrRow;
  /** False when the session already had an open PR, which is returned instead of a second one. */
  created: boolean;
}

/**
 * Push a session's branch and open a PR for it. The title is the session's title; the body is its latest turn
 * output and a diff stat. A session that already has an open PR gets that PR back.
 */
export async function sessionToPr(sessionId: string, o: { base?: string | null; draft?: boolean } = {}): Promise<SessionPrResult> {
  const s = getSession(sessionId);
  if (!s) throw new PrError(`No session "${sessionId}".`, 404);
  const existing = openPrOf(sessionId);
  if (existing) return { pr: existing, created: false };
  if (s.isolation !== "worktree" || !s.branch || !s.worktree_root) throw new PrError("This session has no branch of its own. A PR needs a session that runs in a worktree.");
  if (!fs.existsSync(s.worktree_root)) throw new PrError("The worktree of this session no longer exists.", 404);
  const workspaceId = owningWorkspace(s.base_cwd);
  if (!workspaceId) throw new PrError("The workspace this session belongs to is not registered.", 404);

  const dir = s.worktree_root;
  const pushed = git(["push", "-u", "origin", s.branch], dir);
  if (!pushed.ok) throw new PrError(`Could not push ${s.branch}: ${firstLine(pushed.stderr) || "git push failed"}`);

  const body = prBodyFor(s, latestTurnOutput(sessionId), diffStatOf(s));
  const pr = await prCreate(dir, { title: clip(s.title.trim() || s.id, TITLE_MAX), body, base: o.base ?? null, head: s.branch, draft: o.draft === true });
  tables();
  db()
    .prepare(
      `INSERT INTO session_prs (workspace_id, number, session_id, url, state, checks_state, updated_at) VALUES (?, ?, ?, ?, 'open', 'none', CURRENT_TIMESTAMP)
       ON CONFLICT(workspace_id, number) DO UPDATE SET session_id = excluded.session_id, url = excluded.url, state = 'open', updated_at = CURRENT_TIMESTAMP`,
    )
    .run(workspaceId, pr.number, sessionId, pr.url);
  const refreshed = await refreshPr(workspaceId, pr.number);
  return { pr: refreshed.pr, created: true };
}

/** The PRs of a workspace: open ones from gh, each with the session it came from and the checks state the table knows. */
export async function listWorkspacePrs(workspaceId: string, state: "open" | "closed" | "merged" | "all" = "open"): Promise<Array<PrSummary & { sessionId: string | null; checksState: ChecksState | null }>> {
  const dir = resolveRoot(workspaceId).dir;
  const rows = new Map(sessionPrsOf(workspaceId).map((r) => [r.number, r]));
  return (await prList(dir, { state })).map((p) => ({ ...p, sessionId: rows.get(p.number)?.sessionId ?? null, checksState: rows.get(p.number)?.checksState ?? null }));
}
