/**
 * Autopilot: work through a spec's tasks.md without the operator.
 *
 * A run is a row in `autopilot_runs`. The loop picks the next open task, starts it (a session per task, see
 * specs/implement.ts runTask), waits for the turn and its verification to settle, requires verification to
 * pass, ticks the box, and goes on. Runs of `[P]` tasks start together in their own worktrees, up to the run's
 * concurrency; their changes are applied to the workspace once the whole batch has passed.
 *
 * The loop is `advanceAll`: a synchronous pass over the runs that are working. It is driven by the session hub
 * (every turn end and state change) and by a slow fallback timer, so nothing depends on one event arriving.
 * It keeps all its state in the row, so a daemon restart picks the runs up where they were: a task whose turn
 * the restart interrupted is sent a follow-up, not started again.
 *
 * Stops: budget exceeded (the sum of the cost of the run's turns), a verification that still fails after the
 * automatic fixes, a turn that failed, a task whose checks could not run, or the task limit. Approval gates
 * pause the run as `awaiting_approval` until the operator approves or rejects: before a merge of parallel work,
 * before a task tagged [APPROVE], or after every N tasks.
 */
import fs from "fs";
import path from "path";
import { db } from "../db";
import { sessionToPr, waitForChecks, type ChecksState } from "../ci/pr";
import { git, mergePatch } from "../git/worktree";
import { Hub } from "../sessions/hub";
import { createLead, getSession, interrupt, isTurnLive, send, type SessionRecord } from "../sessions/manager";
import { requireFeature } from "../specs/store";
import { runTask } from "../specs/implement";
import { taskPrompt } from "../specs/prompts";
import { parseTasks, setTaskDone, type SpecTask } from "../specs/tasks";
import { getSessionRow } from "../verify/store";
import { newId, UserError } from "../util";
import { Workspaces } from "../workspaces";

export type RunStatus = "running" | "paused" | "awaiting_approval" | "done" | "failed" | "stopped";
export const RUN_STATUSES: RunStatus[] = ["running", "paused", "awaiting_approval", "done", "failed", "stopped"];
const WORKING: RunStatus[] = ["running", "paused"];
const OPEN: RunStatus[] = ["running", "paused", "awaiting_approval"];
export const MAX_CONCURRENCY = 4;
const LOG_KEEP = 300;
const FALLBACK_MS = 30_000;
/** How long a task pull request may wait for its checks to settle before the run stops. */
const CHECKS_WAIT_MS = 60 * 60_000;
const APPROVE_TAG = /\[APPROVE\]/i;

export interface ApprovalPolicy {
  /** Pause before the changes of a parallel batch are applied to the workspace. */
  merge: boolean;
  /** Pause before a task whose text carries [APPROVE]. */
  tagged: boolean;
  /** Pause after every N finished tasks. */
  every: number | null;
}

export interface Gate {
  key: string;
  kind: "merge" | "tagged" | "every";
  text: string;
}

export interface ActiveTask {
  line: number;
  id: string | null;
  text: string;
  phase: string | null;
  session: string;
  /** Started in its own worktree (a parallel batch), so its changes need merging. */
  isolated: boolean;
  /** Its checks passed; it waits for the rest of its batch. */
  passed: boolean;
  /** With `open_pr`: the pull request opened for it once it passed, and what its checks say (null until polled). */
  pr?: number | null;
  checks?: ChecksState | null;
  /** When it passed, as an ISO time: the wait for the pull request's checks is measured from here. */
  passed_at?: string | null;
}

export interface LogEntry {
  at: string;
  kind: "info" | "task" | "gate" | "error";
  text: string;
}

export interface AutopilotRun {
  id: string;
  workspace_id: string;
  spec_dir: string;
  status: RunStatus;
  budget_usd: number | null;
  spent_usd: number;
  max_tasks: number | null;
  concurrency: number;
  approval_policy: ApprovalPolicy;
  /** Each task runs in its own worktree and becomes a pull request; the run waits for its checks before it ticks the box. */
  open_pr: boolean;
  /** What is in flight now, as the operator reads it ("T003", "T004, T005"), or null. */
  current_task: string | null;
  /** Why the run stopped, failed or waits (the gate's text while awaiting approval). */
  reason: string | null;
  done: number;
  active: ActiveTask[];
  gate: Gate | null;
  /** Gate keys the operator has approved: a gate that is cleared does not come back. */
  cleared: string[];
  sessions: string[];
  log: LogEntry[];
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface StartOpts {
  budget_usd?: number | null;
  max_tasks?: number | null;
  concurrency?: number | null;
  approval_policy?: Partial<ApprovalPolicy> | null;
  open_pr?: boolean | null;
}

interface RunRow {
  id: string;
  workspace_id: string;
  spec_dir: string;
  status: RunStatus;
  budget_usd: number | null;
  spent_usd: number;
  max_tasks: number | null;
  concurrency: number;
  approval_policy: string;
  current_task: string | null;
  reason: string | null;
  log: string;
  state: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface State {
  done: number;
  active: ActiveTask[];
  gate: Gate | null;
  sessions: string[];
  cleared: string[];
  open_pr: boolean;
}

/** The state of a run before any step, as the row is created. */
const EMPTY_STATE: State = { done: 0, active: [], gate: null, sessions: [], cleared: [], open_pr: false };

const CONTINUE_PROMPT = "The daemon restarted while you were working on this task. Look at what is already in the working tree, finish the task, and stop when its checks pass.";
const ISOLATED_NOTE = "Work only in your own worktree. Do not edit tasks.md: the runner ticks it after your changes are merged.";

let ready = false;
function tables(): void {
  if (ready) return;
  db().exec(`CREATE TABLE IF NOT EXISTS autopilot_runs (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, spec_dir TEXT NOT NULL, status TEXT NOT NULL,
    budget_usd REAL, spent_usd REAL NOT NULL DEFAULT 0, max_tasks INTEGER, concurrency INTEGER NOT NULL DEFAULT 1,
    approval_policy TEXT NOT NULL DEFAULT '{}', current_task TEXT, reason TEXT,
    log TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, finished_at TEXT
  )`);
  db().exec(`CREATE INDEX IF NOT EXISTS autopilot_runs_ws ON autopilot_runs (workspace_id, created_at)`);
  ready = true;
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

function fromRow(r: RunRow): AutopilotRun {
  const st: State = { ...EMPTY_STATE, ...JSON.parse(r.state || "{}") };
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    spec_dir: r.spec_dir,
    status: r.status,
    budget_usd: r.budget_usd,
    spent_usd: r.spent_usd,
    max_tasks: r.max_tasks,
    concurrency: r.concurrency,
    approval_policy: { merge: false, tagged: false, every: null, ...JSON.parse(r.approval_policy || "{}") },
    open_pr: st.open_pr,
    current_task: r.current_task,
    reason: r.reason,
    done: st.done,
    active: st.active,
    gate: st.gate,
    cleared: st.cleared,
    sessions: st.sessions,
    log: JSON.parse(r.log || "[]"),
    created_at: r.created_at,
    updated_at: r.updated_at,
    finished_at: r.finished_at,
  };
}

/** The state that is not a column of its own: kept in `state` as one JSON object. */
const stateOf = (run: AutopilotRun): State => ({ done: run.done, active: run.active, gate: run.gate, sessions: run.sessions, cleared: run.cleared, open_pr: run.open_pr });

function save(run: AutopilotRun): void {
  const st = stateOf(run);
  db()
    .prepare(
      `UPDATE autopilot_runs SET status = ?, spent_usd = ?, current_task = ?, reason = ?, log = ?, state = ?, updated_at = CURRENT_TIMESTAMP, finished_at = ? WHERE id = ?`,
    )
    .run(run.status, run.spent_usd, run.current_task, run.reason, JSON.stringify(run.log.slice(-LOG_KEEP)), JSON.stringify(st), run.finished_at, run.id);
}

function note(run: AutopilotRun, kind: LogEntry["kind"], text: string): void {
  run.log.push({ at: new Date().toISOString(), kind, text });
  if (run.log.length > LOG_KEEP) run.log.splice(0, run.log.length - LOG_KEEP);
}

const label = (m: Pick<ActiveTask, "id" | "line">): string => m.id ?? `line ${m.line + 1}`;
const tasksPath = (rootDir: string, specDir: string): string => path.join(rootDir, specDir, "tasks.md");

function loadRun(id: string): AutopilotRun | null {
  tables();
  const r = db().prepare("SELECT * FROM autopilot_runs WHERE id = ?").get(id) as RunRow | undefined;
  if (!r) return null;
  return fromRow(r);
}

export function getRun(id: string): AutopilotRun | null {
  return loadRun(id);
}

export function listRuns(workspaceId?: string | null, limit = 50): AutopilotRun[] {
  tables();
  const rows = workspaceId
    ? (db().prepare("SELECT * FROM autopilot_runs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(workspaceId, limit) as RunRow[])
    : (db().prepare("SELECT * FROM autopilot_runs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as RunRow[]);
  return rows.map((r) => {
    const run = fromRow(r);
    run.log = run.log.slice(-20);
    return run;
  });
}

const isCleared = (run: AutopilotRun, key: string): boolean => run.cleared.includes(key);

/** What the runs have cost so far: the turns of every session the run started. */
export function spentOn(sessions: string[]): number {
  if (!sessions.length) return 0;
  const marks = sessions.map(() => "?").join(",");
  return (db().prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM turns WHERE session_id IN (${marks})`).get(...sessions) as { c: number }).c;
}

/* -------------------------------------------------------------------------- */
/* Start and operator actions                                                 */
/* -------------------------------------------------------------------------- */

function policyOf(p: Partial<ApprovalPolicy> | null | undefined): ApprovalPolicy {
  const every = p?.every == null ? null : Math.floor(Number(p.every));
  if (every !== null && (!Number.isFinite(every) || every < 1)) throw new UserError("Approve every N tasks: N must be a whole number of at least 1.");
  return { merge: p?.merge === true, tagged: p?.tagged === true, every };
}

/** Start a run on a spec. Refuses a spec that already has a run that is still open. */
export function startRun(workspaceId: string, spec: string, o: StartOpts = {}): AutopilotRun {
  tables();
  const ws = Workspaces.get(workspaceId);
  if (!ws) throw new UserError(`No workspace "${workspaceId}".`);
  const f = requireFeature(ws.path, spec);
  if (!f.files.tasks) throw new UserError(`${f.dir} has no tasks.md yet. Run the Tasks step first.`);
  const parsed = parseTasks(fs.readFileSync(tasksPath(ws.path, f.dir), "utf-8"));
  if (!parsed.total) throw new UserError(`${f.dir}/tasks.md has no tasks yet. Run the Tasks step first.`);
  if (!parsed.tasks.some((t) => !t.done)) throw new UserError(`All ${parsed.total} tasks in ${f.dir}/tasks.md are already done.`);
  const open = db().prepare("SELECT id FROM autopilot_runs WHERE workspace_id = ? AND spec_dir = ? AND status IN ('running','paused','awaiting_approval')").get(ws.id, f.dir) as { id: string } | undefined;
  if (open) throw new UserError(`Autopilot run ${open.id} is already working on ${f.dir}. Stop it first.`);
  if (o.budget_usd != null && !(Number(o.budget_usd) > 0)) throw new UserError("The budget must be more than zero dollars.");
  if (o.max_tasks != null && !(Math.floor(Number(o.max_tasks)) >= 1)) throw new UserError("The task limit must be at least 1.");
  const concurrency = Math.min(Math.max(1, Math.floor(Number(o.concurrency ?? 1)) || 1), MAX_CONCURRENCY);

  const id = newId("ap");
  db()
    .prepare("INSERT INTO autopilot_runs (id, workspace_id, spec_dir, status, budget_usd, max_tasks, concurrency, approval_policy, state) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)")
    .run(id, ws.id, f.dir, o.budget_usd ?? null, o.max_tasks == null ? null : Math.floor(Number(o.max_tasks)), concurrency, JSON.stringify(policyOf(o.approval_policy)), JSON.stringify({ ...EMPTY_STATE, open_pr: o.open_pr === true }));
  const run = loadRun(id)!;
  note(run, "info", `Started on ${f.dir}: ${parsed.tasks.filter((t) => !t.done).length} open task(s).`);
  save(run);
  advanceAll();
  return getRun(id)!;
}

function requireRun(id: string): AutopilotRun {
  const run = loadRun(id);
  if (!run) throw new UserError(`No autopilot run "${id}".`);
  return run;
}

export function pauseRun(id: string): AutopilotRun {
  const run = requireRun(id);
  if (run.status !== "running") throw new UserError(`The run is ${run.status}; only a running run can pause.`);
  run.status = "paused";
  note(run, "info", "Paused. Tasks already running finish; no new task starts until resumed.");
  save(run);
  return run;
}

export function resumeRun(id: string): AutopilotRun {
  const run = requireRun(id);
  if (run.status !== "paused") throw new UserError(`The run is ${run.status}; only a paused run can resume.`);
  run.status = "running";
  note(run, "info", "Resumed.");
  save(run);
  advanceAll();
  return getRun(id)!;
}

export function stopRun(id: string, reason = "Stopped by the operator."): AutopilotRun {
  const run = requireRun(id);
  if (!OPEN.includes(run.status)) throw new UserError(`The run is already ${run.status}.`);
  finish(run, "stopped", reason);
  return getRun(id)!;
}

export function approveRun(id: string): AutopilotRun {
  const run = requireRun(id);
  if (run.status !== "awaiting_approval" || !run.gate) throw new UserError(`The run is not waiting for approval (it is ${run.status}).`);
  run.cleared.push(run.gate.key);
  note(run, "gate", `Approved: ${run.gate.text}`);
  run.gate = null;
  run.reason = null;
  run.status = "running";
  save(run);
  advanceAll();
  return getRun(id)!;
}

export function rejectRun(id: string): AutopilotRun {
  const run = requireRun(id);
  if (run.status !== "awaiting_approval" || !run.gate) throw new UserError(`The run is not waiting for approval (it is ${run.status}).`);
  const text = run.gate.text;
  run.gate = null;
  finish(run, "stopped", `Rejected: ${text}`);
  return getRun(id)!;
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

function finish(run: AutopilotRun, status: RunStatus, reason: string): void {
  run.status = status;
  run.reason = reason;
  run.finished_at = new Date().toISOString();
  note(run, status === "done" ? "info" : "error", reason);
  for (const m of run.active) {
    const s = getSession(m.session);
    if (!m.passed && s && s.status === "running") interrupt({ operator: true }, s.id).catch(() => {});
  }
  run.current_task = null;
  save(run);
}

function gate(run: AutopilotRun, g: Gate): void {
  run.status = "awaiting_approval";
  run.gate = g;
  run.reason = g.text;
  note(run, "gate", `Waiting for approval: ${g.text}`);
  save(run);
}

/** Put the changes of an isolated batch into the workspace as uncommitted edits. Stops at the first that does not apply. */
function applyBatch(run: AutopilotRun, targetDir: string): { ok: true } | { ok: false; reason: string } {
  for (const m of run.active.filter((x) => x.isolated)) {
    const s = getSession(m.session);
    if (!s?.worktree_git_root || !s.base_sha || !s.branch) return { ok: false, reason: `${label(m)}: its worktree is gone, so its changes were not merged.` };
    const head = git(["rev-parse", "--verify", s.branch], s.worktree_git_root).stdout.trim();
    if (!head || head === s.base_sha) continue;
    const res = mergePatch({ fromGitRoot: s.worktree_git_root, baseSha: s.base_sha, headSha: head, targetDir });
    if (!res.ok) return { ok: false, reason: `${label(m)}: its changes do not apply cleanly (${res.reason.split("\n")[0]}). Nothing from it was applied; its branch ${s.branch} is kept.` };
    note(run, "info", `${label(m)}: applied ${res.files.length} file(s) from ${s.branch}.`);
  }
  return { ok: true };
}

/** Tick the task's box in tasks.md. Matched by id, else by line and text (the file may have moved under us). */
function tickTask(rootDir: string, specDir: string, m: ActiveTask): boolean {
  const file = tasksPath(rootDir, specDir);
  const text = fs.readFileSync(file, "utf-8");
  const parsed = parseTasks(text);
  const hit = (m.id && parsed.tasks.find((t) => t.id === m.id)) || parsed.tasks.find((t) => t.line === m.line && t.text === m.text) || null;
  if (!hit) return false;
  if (!hit.done) fs.writeFileSync(file, setTaskDone(text, hit.line, true));
  return true;
}

/** The seam for the pull request flow: tests swap it, `null` restores the real one (src/ci/pr.ts). */
export interface PrFlow {
  open: (sessionId: string) => Promise<{ pr: { number: number } }>;
  checks: (root: string, number: number) => Promise<{ state: ChecksState }>;
}
const realPrFlow: PrFlow = { open: (sessionId) => sessionToPr(sessionId), checks: (root, n) => waitForChecks(root, n, 0) };
let prFlow: PrFlow = realPrFlow;
export function setPrFlow(f: PrFlow | null): void {
  prFlow = f ?? realPrFlow;
}

/** A passed task waits for its pull request's checks when the run opens pull requests. */
const awaitsChecks = (run: AutopilotRun, m: ActiveTask): boolean => run.open_pr && m.passed && m.checks !== "passing";

/** Runs whose pull requests are being polled now: one poll per run at a time, so a pass never stacks them. */
const watching = new Set<string>();

/**
 * Open the pull request of each passed task that has none, and read its checks once. This is async, so the step only
 * starts it; the result is written to the row and the loop is advanced when a task's checks settled (passing or
 * failing) or a call failed. Checks that are still pending are read again on the next pass.
 */
function watchChecks(runId: string): void {
  if (watching.has(runId)) return;
  watching.add(runId);
  void (async () => {
    let changed = false;
    try {
      const run = loadRun(runId);
      const ws = run && Workspaces.get(run.workspace_id);
      if (!run || !ws) return;
      const seen = new Map<string, { pr: number; state: ChecksState }>();
      let error: string | null = null;
      for (const m of run.active.filter((x) => awaitsChecks(run, x) && x.checks !== "failing")) {
        try {
          const pr = m.pr ?? (await prFlow.open(m.session)).pr.number;
          seen.set(m.session, { pr, state: (await prFlow.checks(ws.path, pr)).state });
        } catch (err: any) {
          error = `${label(m)}: could not get its pull request checks: ${err?.message ?? err}`;
          break;
        }
      }
      const fresh = loadRun(runId);
      if (!fresh || !WORKING.includes(fresh.status)) return;
      for (const m of fresh.active) {
        const r = seen.get(m.session);
        if (!r) continue;
        if (m.pr == null) note(fresh, "task", `${label(m)}: opened pull request #${r.pr}.`);
        m.pr = r.pr;
        m.checks = r.state;
        if (r.state === "passing" || r.state === "failing") changed = true;
      }
      if (error) {
        changed = true;
        return finish(fresh, "failed", error);
      }
      save(fresh);
    } catch (err: any) {
      console.warn(`[trb] autopilot ${runId}: ${err?.message ?? err}`);
    } finally {
      watching.delete(runId);
      if (changed) advanceAll();
    }
  })();
}

const tagged = (run: AutopilotRun, t: SpecTask): boolean => run.approval_policy.tagged && APPROVE_TAG.test(t.text);

/**
 * One step of a run. Settles what is in flight, then starts what comes next, or stops at a gate or a failure.
 * Every path that changes the run ends in a save (or finish, which saves).
 */
function step(run: AutopilotRun): void {
  const ws = Workspaces.get(run.workspace_id);
  if (!ws) return finish(run, "failed", "The workspace is no longer registered.");

  run.spent_usd = spentOn(run.sessions);

  // 1. Settle what is in flight.
  for (const m of run.active) {
    if (m.passed) continue;
    const s = getSession(m.session);
    if (!s || s.status === "closed") return finish(run, "failed", `The session for ${label(m)} was closed.`);
    if (s.status === "running" || isTurnLive(s.id)) continue;
    if (s.status === "failed" && (s.last_error ?? "").startsWith("interrupted")) {
      try {
        note(run, "info", `${label(m)}: the daemon restarted during its turn; continuing it.`);
        send({ operator: true }, s.id, CONTINUE_PROMPT);
      } catch (err: any) {
        return finish(run, "failed", `${label(m)}: could not continue after the restart: ${err?.message ?? err}`);
      }
      continue;
    }
    const v = getSessionRow(s.id)?.state ?? null;
    if (v === "passed") {
      m.passed = true;
      m.passed_at = new Date().toISOString();
      note(run, "task", `${label(m)}: checks passed.`);
      continue;
    }
    if (v === null || v === "running" || v === "fixing") continue;
    if (v === "failed") return finish(run, "failed", `${label(m)}: the checks still fail (verification has used its automatic fixes).`);
    if (s.status === "failed") return finish(run, "failed", `${label(m)}: its turn failed: ${s.last_error ?? "no reason given"}`);
    return finish(run, "failed", `${label(m)}: the checks did not run (verification is ${v}). Turn verification on for this workspace so each task is checked.`);
  }

  // With pull requests: a passed task waits for its PR's checks. Failing checks, or no verdict in time, stop the run.
  for (const m of run.active.filter((x) => awaitsChecks(run, x))) {
    if (m.checks === "failing") return finish(run, "failed", `${label(m)}: the checks of pull request #${m.pr} are failing. The box stays open and the PR is kept.`);
    if (Date.now() - Date.parse(m.passed_at ?? run.updated_at) > CHECKS_WAIT_MS) return finish(run, "failed", `${label(m)}: the checks of its pull request did not finish within an hour.`);
  }
  // The watcher reads the row, so what this pass settled is saved before it starts.
  if (run.active.some((m) => awaitsChecks(run, m))) {
    save(run);
    watchChecks(run.id);
  }

  // 2. A batch whose members have all passed: merge it (behind a gate if asked), then tick its tasks.
  if (run.active.length && run.active.every((m) => m.passed && !awaitsChecks(run, m))) {
    // With pull requests the change travels in the PR, so there is no patch to apply here.
    const isolated = !run.open_pr && run.active.some((m) => m.isolated);
    if (isolated) {
      const key = `merge:${run.active.map((m) => m.line).join(",")}`;
      if (run.approval_policy.merge && !isCleared(run, key)) {
        return gate(run, { key, kind: "merge", text: `Apply the parallel changes of ${run.active.map(label).join(", ")} to the workspace` });
      }
      const r = applyBatch(run, ws.path);
      if (!r.ok) return finish(run, "failed", r.reason);
    }
    for (const m of run.active) {
      if (!tickTask(ws.path, run.spec_dir, m)) note(run, "error", `${label(m)}: could not find it in tasks.md to tick.`);
      else note(run, "task", `${label(m)}: done.`);
    }
    run.done += run.active.length;
    run.active = [];
    run.current_task = null;
    save(run);
  }

  // 3. Nothing starts while paused, or while a sequential task is still running.
  if (run.active.some((m) => !m.isolated)) return save(run);
  if (run.status !== "running") return save(run);

  const f = requireFeature(ws.path, run.spec_dir);
  const parsed = parseTasks(fs.readFileSync(tasksPath(ws.path, f.dir), "utf-8"));
  const inFlight = new Set(run.active.map((m) => m.line));
  const open = parsed.tasks.filter((t) => !t.done && !inFlight.has(t.line));

  if (!open.length) {
    if (run.active.length) return save(run);
    return finish(run, "done", `All ${parsed.total} tasks are done.`);
  }
  // The budget is checked between tasks: nothing new starts once it is spent, and what is in flight is settled first
  // (its turn is already paid for, and its checks decide whether its box is ticked).
  if (run.budget_usd != null && run.spent_usd >= run.budget_usd) {
    if (run.active.length) return save(run);
    return finish(run, "stopped", `Budget reached: $${run.spent_usd.toFixed(2)} of $${run.budget_usd.toFixed(2)} spent.`);
  }
  const started = run.done + run.active.length;
  if (run.max_tasks != null && started >= run.max_tasks) {
    if (run.active.length) return save(run);
    return finish(run, "stopped", `Reached the limit of ${run.max_tasks} task(s).`);
  }

  const next = open[0];
  // A batch already in flight is extended only by parallel tasks of the same phase; anything else waits for it.
  if (run.active.length && !(next.parallel && run.active.every((m) => m.isolated) && next.phase === run.active[0].phase)) return save(run);

  if (!run.active.length) {
    const every = run.approval_policy.every;
    if (every && run.done >= every) {
      const key = `every:${Math.floor(run.done / every)}`;
      if (!isCleared(run, key)) return gate(run, { key, kind: "every", text: `${run.done} task(s) done; review before the next one` });
    }
    if (tagged(run, next)) {
      const key = `tag:${next.line}`;
      if (!isCleared(run, key)) return gate(run, { key, kind: "tagged", text: `${label({ id: next.id, line: next.line })} is tagged [APPROVE]: ${next.text}` });
    }
  }

  // The tasks that start now: a parallel run of the same phase, up to the concurrency, else the next task alone.
  const cap = run.concurrency - run.active.length;
  const batch: SpecTask[] = [];
  if (next.parallel && run.concurrency > 1) {
    for (const t of open) {
      if (batch.length >= cap || !t.parallel || t.phase !== next.phase || tagged(run, t)) break;
      batch.push(t);
    }
  }
  const parallel = run.open_pr || run.active.length > 0 || batch.length >= 2;
  const starts = run.active.length > 0 || batch.length >= 2 ? batch : [next];
  if (!starts.length) return save(run);

  for (const t of starts) {
    let s: SessionRecord;
    try {
      s = parallel
        ? createLead({ prompt: `${taskPrompt(f, t)}\n\n${ISOLATED_NOTE}`, title: `${t.id ?? "Task"}: ${t.text}`.slice(0, 100), cwd: ws.path, isolate: true, specs: [{ path: f.dir, purpose: "step" }] })
        : runTask(ws.path, f.dir, t.line, {});
    } catch (err: any) {
      return finish(run, "failed", `Could not start ${t.id ?? `line ${t.line + 1}`}: ${err?.message ?? err}`);
    }
    run.active.push({ line: t.line, id: t.id, text: t.text, phase: t.phase, session: s.id, isolated: parallel, passed: false });
    run.sessions.push(s.id);
    note(run, "task", `Started ${label({ id: t.id, line: t.line })}: ${t.text}${parallel ? " (own worktree)" : ""}`);
  }
  run.current_task = run.active.map((m) => m.id ?? `line ${m.line + 1}`).join(", ") || null;
  save(run);
}

/** Advance one run. A failure inside a step stops the run with the error, so it never loops. */
function advanceOne(id: string): void {
  const run = loadRun(id);
  if (!run || !WORKING.includes(run.status)) return;
  try {
    step(run);
  } catch (err: any) {
    finish(run, "failed", `Unexpected error: ${err?.message ?? err}`);
  }
}

let busy = false;
let dirty = false;

/**
 * Advance every working run. Re-entrant calls (a session event fired while a step is starting one) only mark
 * the pass dirty, and the outer call makes one more pass, so a step never reads state a step is writing.
 */
export function advanceAll(): void {
  if (busy) {
    dirty = true;
    return;
  }
  busy = true;
  try {
    let passes = 0;
    do {
      dirty = false;
      tables();
      const ids = db().prepare("SELECT id FROM autopilot_runs WHERE status IN ('running','paused')").all() as Array<{ id: string }>;
      for (const { id } of ids) {
        try {
          advanceOne(id);
        } catch (err: any) {
          console.warn(`[trb] autopilot ${id}: ${err?.message ?? err}`);
        }
      }
    } while (dirty && ++passes < 50);
  } finally {
    busy = false;
  }
}

let unsubscribe: (() => void) | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

/** Start the loop: on every session event, and on a slow timer. Runs that were working when the daemon stopped carry on. */
export function startAutopilot(): void {
  if (unsubscribe) return;
  tables();
  unsubscribe = Hub.subscribe((e) => {
    if (e.type === "turn_end" || e.type === "state") advanceAll();
  });
  ticker = setInterval(() => advanceAll(), FALLBACK_MS);
  (ticker as any).unref?.();
  advanceAll();
}

export function stopAutopilot(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (ticker) clearInterval(ticker);
  ticker = null;
}
