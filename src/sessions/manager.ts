/**
 * Sessions: the unit of coding work.
 *
 * A session is one engine conversation that can take turns. The operator opens a **lead**
 * (depth 0, `trb run`). A running session opens **subagents** (depth >= 1) mid-turn with
 * `subagent_create`, keeps working, and collects their answers with `subagent_wait` in the
 * same turn: the child's final message comes back as a tool result, so the parent never loses
 * its context and nothing is relaunched. (This is Omni's `subagents/manager.ts` pattern, which
 * itself replaced "heads as queued subtasks": the lead's run ended, a scheduler polled, every
 * head cold-started, and the lead was woken in a fresh run to rediscover what happened.)
 *
 * What a session has:
 *  - an engine session id, so a follow-up resumes with the engine's own full context (engines
 *    with no resume, or a refused one, get the brief and the previous answer replayed instead);
 *  - a workspace: a lead runs in the operator's directory; a subagent gets its own git worktree
 *    when that directory is a repo (its work comes back through `subagent_merge`), else a private
 *    scratch directory plus the parent's workspace by absolute path;
 *  - turns, each a row with its output, usage and cost, and a replayable log (`events`).
 */
import fs from "fs";
import path from "path";
import { db } from "../db";
import { getSetting } from "../settings";
import { clean, newId, parseList } from "../util";
import { paths } from "../paths";
import { getEngine, resolveBinary, engineIds, type McpRunConfig } from "../engines/registry";
import { runTurn, type RunTurnOptions, type TurnResult } from "../engines/runner";
import { HydraPairs, resolveRole, type HydraPair } from "../hydra/pairs";
import { Agents, agentPromptBlock } from "../agents/store";
import { PAIR_ROLE_LIBRARY } from "../hydra/roles";
import { WorktreeManager, git, mergePatch, repoRootOf, type DepsMode, type WorktreeSession } from "../git/worktree";
import { pruneSharedTargets } from "../git/cargotarget";
import { drainSerialized, gitKey, LOCAL_GIT_TIMEOUT_MS, runGit } from "../git/run";
import { buildRunMcpConfig } from "../mcp/store";
import { practicesBrief } from "../practices/store";
import { CODEGRAPH_HINT } from "../codegraph/detect";
import { evidenceEnabled, evidenceHint } from "../evidence/store";
import { REA_HINT, reaEnabled } from "../evidence/rea";
import { scheduleKeepInSync } from "../codegraph/autosync";
import { browserEnabled } from "../browser/chrome";
import { emulatorEnabled } from "../emulator/emulator";
import { computerUseAvailable } from "../computer/driver";
import { SkillStore, defaultSkillNames, materializeSkills, parseSkillInvocation, skillInvocationPrompt } from "../skills/store";
import { classifyLine } from "../engines/classify";
import { Hub } from "./hub";
import { TITLE_INSTRUCTION, plainTitle, sessionTitle } from "./title";
import { contextOf, recordUsageEvent, type ContextView } from "./usage";
import { getDaemonContext } from "./context";
import { afterTurn as goalAfterTurn, getGoal, goalBlock, normalizeGoal, recoverGoals, setGoal, stopGoal, type Goal, type GoalInput } from "./goal";
import { planPreamble } from "./plan";
import { askOverrideModel, askPreamble } from "./ask";
import { NEXT_STEPS_INSTRUCTION, extractNextSteps, wantsNextSteps } from "./nextsteps";
import { modelLock } from "./modellock";
import { codegraphFor } from "../codegraph/detect";
import { planDepthOf, storePlanDepth } from "./plansdir";
import { cancelPendingQuestions, recoverPlanQuestions } from "./planq";
import { clearWaits, forgetInterruptedWaits, interruptWaitsOnStartup, waitingOf, waitInterruptedOf, type InterruptedWait } from "./waiting";
import { pruneCommandReceipts } from "./receipts";
import { specsAfterTurn } from "../specs/attach";
import { attach as attachSpec } from "../specs/attach";
import { attach as attachDoc } from "../docs/attach";
import { attachAny, attachmentsBlock, markDelivered as markAttachmentsDelivered } from "../attachments";
import { docsAfterTurn } from "../docs/generate";
import { dropCheckpoints, takeCheckpoint, withRewindNotice } from "../checkpoints/store";
import { diffSummary, finalizeHead, finalizingOf, type ChangeSummary } from "./finalize";
import { endTurnGroup, recordTurnGroup, reapGroups, sessionsWithGroups } from "./leftovers";
import { availableMemoryMb } from "./memory";
import { recoverVerify, verifyAfterTurn, verifyView, type VerifyView } from "../verify/loop";
import { MAX_FIX_ATTEMPTS, treebossAfterTurn } from "../treeboss/gate";
import { getState as treebossState, isTreeboss, markDelivered as markTreebossDelivered, setTreeboss, type TreebossViewState } from "../treeboss/store";
import { treebossBlock } from "../treeboss/rules";
import { isChecklistAudit } from "../lab/tables";
import { limitResetAt, resetFromRateLimitEvent } from "../engines/resets";
import { awaitPark, formatResumeAt, jitterMs, listParks, parkOf, releasePark, schedulePark, startParkScheduler, type ParkOutcome, type ParkRow } from "./parks";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type SessionStatus = "idle" | "running" | "failed" | "closed";
export type Isolation = "none" | "worktree";

export interface SessionRecord {
  id: string;
  title: string;
  brief: string | null;
  parent_id: string | null;
  root_id: string;
  depth: number;
  engine: string;
  model: string | null;
  effort: string | null;
  role: string | null;
  pair_id: string | null;
  status: SessionStatus;
  cli_session_id: string | null;
  cwd: string;
  base_cwd: string;
  isolation: Isolation;
  worktree_root: string | null;
  worktree_git_root: string | null;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  merged_at: string | null;
  /** The branch tip the last merge applied (null before the first, and on heads merged before this was recorded). */
  merged_sha: string | null;
  /** Set once the last turn's commit, checkpoint and diff summary are recorded; NULL while pending (see finalize.ts). */
  finalized_at: string | null;
  /** The diff summary as of the last finalization (JSON), or NULL when not finalized yet. */
  changes_json: string | null;
  /** The repo-relative files or directory prefixes a head said it will touch (JSON array), or NULL when it named none. */
  files_json: string | null;
  subagents: number;
  agent: string | null;
  skills_json: string | null;
  /** 'launching' from the moment a head is recorded until its first turn starts; null otherwise. */
  launch_state: "launching" | null;
  /** plan: read-only, the agent proposes; build: it may edit. */
  mode: "build" | "plan" | "ask";
  last_output: string | null;
  last_error: string | null;
  last_turn_id: string | null;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number | null;
  context_tokens: number | null;
  context_max: number | null;
  context_json: string | null;
  context_at: string | null;
  compactions: number;
  /** The session this one continues from a handoff summary. */
  handoff_from: string | null;
  /** 1 once the operator picked the model by hand between turns; 1 until the next turn starts when it has not run yet. */
  model_manual: number;
  model_pending: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** When the operator pinned it to the top of the sessions list (any workspace). Null: not pinned. */
  pinned_at: string | null;
}

/** Who is calling: a running session (via its MCP shim), or the operator (CLI / UI). */
export interface Caller {
  sessionId?: string | null;
  operator?: boolean;
}

export class SessionError extends Error {}

export interface CreateLeadInput {
  prompt: string;
  title?: string | null;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  pairId?: string | null;
  cwd: string;
  /** Run the lead itself in a worktree. Default false: a lead works where the operator points it. */
  isolate?: boolean;
  /** Give the lead the subagent tools. Default true. */
  subagents?: boolean;
  /** Run as this specialized agent: its instructions, defaults and skill/MCP assignment. */
  agent?: string | null;
  /** Restrict this session to these skills, overriding the agent's assignment. null: no override. */
  skills?: string[] | null;
  /** Start in plan mode: read-only until the operator approves a plan. */
  mode?: "build" | "plan" | "ask" | null;
  /** Plan mode: what the plan becomes, a plans/ file ("quick", the default) or a spec feature ("spec"). */
  planDepth?: "quick" | "spec" | null;
  /** Keep working until this goal is met (see sessions/goal.ts). */
  goal?: GoalInput | null;
  /** With `isolate`: start the worktree's branch at this commit (a checkpoint) instead of HEAD. */
  startRef?: string | null;
  /** Specification files attached from the first turn (see specs/attach.ts). */
  specs?: Array<{ path: string; mode?: "ref" | "inline"; purpose?: "context" | "architecture" | "implement" | "head" | "step"; state?: string | null }> | null;
  /** Documentation pages attached from the first turn (see docs/attach.ts). */
  docs?: Array<{ path: string; mode?: "ref" | "inline"; purpose?: "context" | "generate" }> | null;
  /** Anything attached from the first turn, the kind decided by the path (specs, plans, docs). */
  attachments?: Array<{ path: string; mode?: "ref" | "inline" }> | null;
  /** Treeboss mode for this session. Unset: follow the global `treeboss_mode` setting (see treeboss/store.ts). */
  treeboss?: boolean | null;
  /** Called with the new session's id before its first turn starts, for a caller that must register the session first. */
  onCreated?: ((id: string) => void) | null;
}

export interface CreateChildInput {
  caller: Caller;
  /** Operator acting as a parent (`trb spawn`): the parent session to open the child under. */
  parentId?: string | null;
  brief: string;
  title?: string | null;
  role?: string | null;
  /** A specialized agent to run as. Defaults to the pair role's agent, if the role names one. */
  agent?: string | null;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  isolate?: boolean | "auto" | null;
  /** Repo-relative files or directory prefixes the head will touch. Used to warn about overlapping heads (see overlappingHeads). */
  files?: unknown;
}

/** The test seam: swap how a turn is run. `null` restores the real engine runner. */
export type TurnRunner = (opts: RunTurnOptions) => Promise<TurnResult>;
let runnerOverride: TurnRunner | null = null;
/** The runner a turn would use now (the test seam, else the real one): for one-off turns that are not session turns. */
export function currentTurnRunner(): TurnRunner {
  return runnerOverride ?? runTurn;
}
export function setTurnRunner(r: TurnRunner | null): void {
  runnerOverride = r;
}

interface LiveTurn {
  turnId: string;
  controller: AbortController;
  promise: Promise<void>;
  startedAt: number;
  /** Held on a usage limit until its reset (sessions/parks.ts): not working, so it does not take a concurrency slot. */
  parked?: boolean;
}
const liveTurns = new Map<string, LiveTurn>();
/** The running turn's tokens so far (engines/stream.ts "turn" events), shown on top of the settled totals until it settles. */
const liveTurnUsage = new Map<string, { input: number; output: number; cacheRead: number; cacheCreation: number }>();

/** Aborts when the session's running turn is interrupted or closed. Undefined when it has no turn in flight. */
export function turnSignal(id: string): AbortSignal | undefined {
  return liveTurns.get(id)?.controller.signal;
}

const IDLE_CLOSE_CHECK_MS = 5 * 60 * 1000;
let reaperTimer: ReturnType<typeof setInterval> | null = null;

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function getSession(id: string): SessionRecord | null {
  const r = db().prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  return r ? (r as SessionRecord) : null;
}

/** Sessions whose folder is `dir` or below it. Used with `except` (nested workspaces) to find a workspace's own sessions. */
export interface WithinFilter {
  dir: string;
  except?: string[];
}

export interface SessionFilter {
  rootId?: string;
  parentId?: string;
  status?: SessionStatus | "open" | null;
  leadsOnly?: boolean;
  pinned?: boolean;
  /** Only sessions that are not pinned (they are listed in their own group elsewhere). */
  unpinned?: boolean;
  /** Case-insensitive substring of the title, id, engine, model, pair or branch. */
  q?: string;
  within?: WithinFilter;
  limit?: number;
  offset?: number;
}

function sessionWhere(filter: SessionFilter): { sql: string; values: Array<string | number> } {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (filter.rootId) {
    where.push("root_id = ?");
    values.push(filter.rootId);
  }
  if (filter.parentId) {
    where.push("parent_id = ?");
    values.push(filter.parentId);
  }
  if (filter.within) {
    // substr, not LIKE: a path may contain % or _, and a plain prefix test is exact.
    const under = (dir: string): [string, Array<string>] => [`(base_cwd = ? OR substr(base_cwd, 1, ?) = ?)`, [dir, String(dir.length + 1), dir + "/"]];
    const [sql, args] = under(filter.within.dir);
    where.push(sql);
    values.push(...args);
    for (const nested of filter.within.except ?? []) {
      const [nsql, nargs] = under(nested);
      where.push(`NOT ${nsql}`);
      values.push(...nargs);
    }
  }
  if (filter.pinned) where.push("pinned_at IS NOT NULL");
  if (filter.unpinned) where.push("pinned_at IS NULL");
  if (filter.leadsOnly) where.push("depth = 0");
  if (filter.status === "open") where.push("status != 'closed'");
  else if (filter.status) {
    where.push("status = ?");
    values.push(filter.status);
  }
  const needle = filter.q?.trim().toLowerCase();
  if (needle) {
    // instr, not LIKE: the needle may contain % or _.
    const cols = ["title", "engine", "model", "pair_id", "id", "branch"];
    where.push(`(${cols.map((c) => `instr(lower(coalesce(${c}, '')), ?) > 0`).join(" OR ")})`);
    values.push(...cols.map(() => needle));
  }
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", values };
}

export function listSessions(filter: SessionFilter = {}): SessionRecord[] {
  const { sql: where, values } = sessionWhere(filter);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(Math.floor(filter.offset ?? 0), 0);
  // Most recently active first: updated_at moves on every turn start and end, so a session with new work rises to the top.
  const sql = `SELECT * FROM sessions${where} ORDER BY updated_at DESC, rowid DESC LIMIT ${limit} OFFSET ${offset}`;
  return db().prepare(sql).all(...values) as SessionRecord[];
}

/** How many sessions match, ignoring limit and offset. */
export function countSessions(filter: SessionFilter = {}): number {
  const { sql: where, values } = sessionWhere(filter);
  return (db().prepare(`SELECT COUNT(*) AS n FROM sessions${where}`).get(...values) as { n: number }).n;
}

/** A session and everything under it, depth-first. */
export function descendantsOf(rootId: string, onlyOpen = false): SessionRecord[] {
  const out: SessionRecord[] = [];
  const walk = (id: string) => {
    const kids = db()
      .prepare(`SELECT * FROM sessions WHERE parent_id = ? ${onlyOpen ? "AND status != 'closed'" : ""} ORDER BY created_at, rowid`)
      .all(id) as SessionRecord[];
    for (const k of kids) {
      out.push(k);
      walk(k.id);
    }
  };
  walk(rootId);
  return out;
}

export function isTurnLive(id: string): boolean {
  return liveTurns.has(id);
}
export function liveTurnCount(): number {
  return liveTurns.size;
}
/** Turns that hold a concurrency slot: in flight and not parked on a usage limit. */
function activeTurnCount(): number {
  let n = 0;
  for (const t of liveTurns.values()) if (!t.parked) n++;
  return n;
}

/** Whether any of a session's open children is mid-turn (a lead blocked on subagent_wait is silent, not stuck). */
export function hasWorkingChildren(sessionId: string): boolean {
  const kids = db().prepare("SELECT id FROM sessions WHERE parent_id = ? AND status = 'running'").all(sessionId) as Array<{ id: string }>;
  return kids.some((k) => liveTurns.has(k.id));
}

export function owns(caller: Caller, s: SessionRecord): boolean {
  if (caller.operator) return true;
  return Boolean(caller.sessionId) && s.parent_id === caller.sessionId;
}

function requireOwned(caller: Caller, id: string): SessionRecord {
  const s = getSession(id);
  if (!s) throw new SessionError(`No session "${id}".`);
  if (!owns(caller, s)) throw new SessionError(`Session "${id}" belongs to another parent; you can only manage subagents you opened.`);
  return s;
}

/** Sessions this caller opened and still owns. */
export function listForCaller(caller: Caller, includeClosed = false): SessionRecord[] {
  if (caller.operator) return listSessions({ status: includeClosed ? null : "open", limit: 200 });
  if (!caller.sessionId) return [];
  return listSessions({ parentId: caller.sessionId, status: includeClosed ? null : "open", limit: 200 });
}

/* -------------------------------------------------------------------------- */
/* Logging                                                                    */
/* -------------------------------------------------------------------------- */

export function appendLog(s: Pick<SessionRecord, "id" | "root_id">, turnId: string | null, text: string, kind?: string): void {
  if (!text) return;
  const meta = classifyLine(text);
  const info = db()
    .prepare("INSERT INTO events (session_id, turn_id, kind, text, data) VALUES (?, ?, ?, ?, ?)")
    .run(s.id, turnId, kind ?? meta.kind, text, JSON.stringify(meta));
  Hub.publish({ type: "log", sessionId: s.id, rootId: s.root_id, eventId: Number(info.lastInsertRowid), turnId, text, kind: kind ?? meta.kind, data: meta });
}

export function readLog(sessionId: string, opts: { sinceId?: number; limit?: number } = {}): Array<{ id: number; turn_id: string | null; ts: string; kind: string; text: string; data: any }> {
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 20000);
  const rows = db()
    .prepare("SELECT id, turn_id, ts, kind, text, data FROM events WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?")
    .all(sessionId, opts.sinceId ?? 0, limit) as any[];
  return rows.map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
}

function setStatus(s: SessionRecord, status: SessionStatus): void {
  Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status });
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

function requireEngine(id: string) {
  const def = getEngine(id);
  if (!def) throw new SessionError(`Unknown engine "${id}". Engines: ${engineIds().join(", ")}.`);
  if (!resolveBinary(def)) throw new SessionError(`${def.label} is not installed (looked for: ${def.binaries.join(", ")}). Run \`trb doctor\`.`);
  return def;
}

/**
 * A model id only means something to the engine it was chosen for: a `claude-sonnet-*` handed
 * to codex is at best ignored, at worst a failed launch. Each fallback therefore applies only
 * when its source engine is the engine actually chosen; otherwise the engine's own default.
 */
function pickModel(engine: string, candidates: Array<[string | null, string | null]>): string | null {
  for (const [model, from] of candidates) if (model && from === engine) return model;
  return null;
}

/**
 * Refuses an engine/model the governing pair does not offer: the chosen role's config, else a
 * heads pair's heads config. The operator picked those engines; a lead does not get to swap them,
 * not even when one is failing. That is the operator's call, so the error says so.
 */
function assertWithinPair(pair: HydraPair, role: NonNullable<HydraPair["roles"]>[string] | null, engine: string | null, model: string | null): void {
  if (!engine && !model) return;
  const offered = role ? { engine: clean(role.engine), model: clean(role.model) } : { engine: clean(pair.heads_engine), model: clean(pair.heads_model) };
  const fits = (!engine || engine === offered.engine) && (!model || model === offered.model);
  if (fits) return;
  const list = [offered.engine ?? "default engine", offered.model].filter(Boolean).join("/");
  const asked = [engine, model].filter(Boolean).join("/");
  throw new SessionError(
    `Hydra pair "${pair.title}" governs this session: heads run on ${list}. ${asked} is outside the pair, and only the operator can change that. ` +
      `If the pair's engine is failing (503s, rate limits, auth errors), do not switch engines and do not do the work yourself: stop, tell the operator ` +
      `which heads failed and the exact error, and ask whether to retry later or switch.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

function checkSkillNames(names: string[]): string[] {
  const known = new Set(SkillStore.list().map((x) => x.name));
  const list = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  const bad = list.filter((n) => !known.has(n));
  if (bad.length) throw new SessionError(`Unknown skill${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}.`);
  return list;
}

/** Open a lead session and start its first turn. Returns immediately; the turn runs in the daemon. */
export function createLead(input: CreateLeadInput): SessionRecord {
  const prompt = clean(input.prompt);
  if (!prompt) throw new SessionError("A prompt is required.");
  let cwd = path.resolve(input.cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new SessionError(`Directory not found: ${cwd}`);
  // The real path, so a session and the workspace it belongs to agree on where "here" is even when the
  // folder is reached through a symlink (on macOS /var and /tmp both are).
  cwd = fs.realpathSync(cwd);
  assertMemoryFree();

  const pair = input.pairId ? HydraPairs.find(input.pairId) : null;
  if (input.pairId && !pair) throw new SessionError(`No Hydra pair "${input.pairId}". See \`trb pair list\`.`);

  const agent = input.agent ? Agents.require(input.agent) : null;
  // Explicit choice > the pair (the operator's binding setup) > the agent's preference > the global default.
  const engine = clean(input.engine) ?? clean(pair?.lead_engine) ?? clean(agent?.engine) ?? (getSetting("default_engine") as string);
  const leadDef = requireEngine(engine);
  // A lead is told to open heads through trb's MCP tools. An engine that cannot reach them would be
  // handed a contract it cannot keep, and would quietly do the work itself.
  if (pair && input.subagents !== false && leadDef.mcp === "none") {
    throw new SessionError(`${leadDef.label} cannot lead a Hydra pair: trb's MCP tools are not wired for it. Lead with claude, codex or cursor (it can still run as a head).`);
  }
  const model = clean(input.model) ?? pickModel(engine, [[clean(pair?.lead_model), clean(pair?.lead_engine)], [clean(agent?.model), clean(agent?.engine)]]);
  const effort = clean(input.effort) ?? clean(pair?.lead_effort) ?? clean(agent?.effort);
  const skillsOverride = input.skills === undefined || input.skills === null ? null : checkSkillNames(input.skills);
  if (input.mode && input.mode !== "plan" && input.mode !== "build" && input.mode !== "ask") throw new SessionError(`Unknown mode "${input.mode}". Use "build", "plan" or "ask".`);
  if (input.goal) normalizeGoal(input.goal); // refuse a bad goal before a session exists

  const id = newId("s");
  const title = sessionTitle(clean(input.title), prompt);
  let workspace = cwd;
  let wt: WorktreeSession | null = null;
  if (input.isolate && input.mode !== "ask") {
    wt = new WorktreeManager(cwd).prepare({ sessionId: id, label: "lead", setupCmd: clean(getSetting("worktree_setup_cmd")), deps: getSetting("worktree_deps") as DepsMode, startRef: clean(input.startRef) });
    if (!wt) throw new SessionError(`Cannot isolate: ${cwd} is not inside a git repository.`);
    workspace = wt.cwd;
  }

  db()
    .prepare(
      `INSERT INTO sessions (id, title, brief, parent_id, root_id, depth, engine, model, effort, role, pair_id, status, cwd, base_cwd,
         isolation, worktree_root, worktree_git_root, branch, base_sha, head_sha, subagents, agent, skills_json)
       VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, NULL, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, title, prompt, id, engine, model, effort, pair?.id ?? null, workspace, cwd, wt ? "worktree" : "none", wt?.root ?? null, wt?.gitRoot ?? null, wt?.branch ?? null, wt?.baseSha ?? null, wt?.baseSha ?? null, input.subagents === false ? 0 : 1, agent?.name ?? null, skillsOverride ? JSON.stringify(skillsOverride) : null);

  const session = getSession(id)!;
  if (input.mode === "plan" || input.mode === "ask") db().prepare("UPDATE sessions SET mode = ? WHERE id = ?").run(input.mode, id);
  if (input.planDepth === "spec") storePlanDepth(id, "spec");
  // Before the first turn starts, so its prompt carries them.
  for (const a of input.specs ?? []) attachSpec(id, a.path, { mode: a.mode, purpose: a.purpose, state: a.state });
  for (const a of input.docs ?? []) attachDoc(id, a.path, { mode: a.mode, purpose: a.purpose });
  for (const a of input.attachments ?? []) attachAny(id, a.path, { mode: a.mode });
  if (typeof input.treeboss === "boolean") setTreeboss(id, input.treeboss);
  let firstPrompt = prompt;
  if (input.goal) {
    const goal = setGoal(id, input.goal, { kickoff: false });
    firstPrompt = `${prompt}\n\n${goalBlock(goal)}`;
  }
  input.onCreated?.(id);
  startTurn(getSession(id)!, firstPrompt, { resume: false });
  return getSession(id)!;
}

/** Open a subagent under a running session (or, for the operator, under `parentId`). */
/** Most paths a head may declare: plenty for one slice, short enough to keep the tool call readable. */
const MAX_FILES = 200;

/**
 * Repo-relative paths or directory prefixes, as the agent wrote them, normalized: forward slashes, no "./", no trailing
 * "/", no blanks or duplicates. A single string counts as one entry. null when none are left.
 */
export function normalizeFiles(input: unknown): string[] | null {
  const list = typeof input === "string" ? [input] : input;
  if (!Array.isArray(list)) return null;
  const out = new Set<string>();
  for (const raw of list) {
    const p = String(raw ?? "").trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (p && p !== ".") out.add(p);
  }
  return out.size ? [...out].slice(0, MAX_FILES) : null;
}

/** Two entries overlap when they are the same path, or one is a directory that holds the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export interface HeadOverlap {
  id: string;
  title: string;
  /** The overlapping entries: the path itself, or `mine ~ theirs` when the two differ (a directory and a file in it). */
  files: string[];
}

/** Files a worktree head has changed against its base, from its branch. [] when that is not cheaply known. */
function changedFilesOf(s: SessionRecord): string[] {
  const tip = s.isolation === "worktree" ? branchTip(s) : null;
  if (!tip || !s.base_sha || !s.worktree_git_root || tip === s.base_sha) return [];
  const res = git(["-c", "core.quotePath=false", "diff", "--name-only", s.base_sha, tip], s.worktree_git_root);
  return res.ok ? res.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/**
 * The open, unmerged heads of the same lead whose files overlap `s`'s declared files. A head's files are what it
 * declared plus, for a worktree head, what it has changed so far. Advisory only: it never refuses anything.
 */
export function overlappingHeads(s: SessionRecord): HeadOverlap[] {
  const mine: string[] = s.files_json ? JSON.parse(s.files_json) : [];
  if (!mine.length || !s.parent_id) return [];
  const siblings = db()
    .prepare("SELECT * FROM sessions WHERE parent_id = ? AND id != ? AND status != 'closed' AND (merged_at IS NULL OR (merged_sha IS NOT NULL AND head_sha IS NOT merged_sha)) ORDER BY created_at")
    .all(s.parent_id, s.id) as SessionRecord[];
  const out: HeadOverlap[] = [];
  for (const o of siblings) {
    const theirs = [...new Set([...(o.files_json ? (JSON.parse(o.files_json) as string[]) : []), ...changedFilesOf(o)])];
    const shared = new Set<string>();
    for (const a of mine) for (const b of theirs) if (pathsOverlap(a, b)) shared.add(a === b ? a : `${a} ~ ${b}`);
    if (shared.size) out.push({ id: o.id, title: o.title, files: [...shared] });
  }
  return out;
}

export function createChild(input: CreateChildInput): SessionRecord {
  const { caller } = input;
  const brief = clean(input.brief);
  if (!brief) throw new SessionError("brief is required: say what the subagent should do and what to report back.");

  const parentId = caller.operator ? clean(input.parentId) : caller.sessionId;
  if (!parentId) throw new SessionError(caller.operator ? "Pass a parent session id to open a subagent under." : "Subagents can only be opened from a running session.");
  const parent = getSession(parentId);
  if (!parent) throw new SessionError(`No session "${parentId}".`);
  if (parent.status === "closed") throw new SessionError(`Session ${parent.id} is closed.`);

  const depth = parent.depth + 1;
  const maxDepth = getSetting("max_depth") as number;
  if (depth > maxDepth) {
    throw new SessionError(`Depth limit reached (${maxDepth}): a subagent at depth ${parent.depth} cannot open another. Do the work yourself or report back to your parent.`);
  }

  const pair = HydraPairs.get(parent.pair_id);
  const asked = clean(input.role);
  let role: string | null = null;
  let roleCfg: NonNullable<HydraPair["roles"]>[string] | null = null;
  if (asked) {
    const roles = pair?.roles ?? null;
    // A preset or pstack name (worker, explorer) finds the pair's role with that label or agent.
    role = roles ? resolveRole(roles, asked) : null;
    if (!pair || !roles || !role) {
      const available = roles ? Object.entries(roles).map(([id, c]) => (c.label?.trim() && c.label.trim().toLowerCase() !== id ? `${id} ("${c.label.trim()}")` : id)) : [];
      throw new SessionError(
        available.length ? `Unknown role "${asked}". This pair's roles: ${available.join(", ")}.` : `Role "${asked}" needs a Hydra pair with roles; none governs this session. Pass engine/model instead.`,
      );
    }
    roleCfg = roles[role]!;
  } else if (pair?.mode === "roles" && !caller.operator) {
    // A roles pair has no heads config to fall back on, by design: the lead picks a role.
    throw new SessionError(`This pair runs heads by role. Pass role: one of ${Object.keys(pair.roles ?? {}).join(", ")}.`);
  }
  if (pair && !caller.operator) assertWithinPair(pair, roleCfg, clean(input.engine), clean(input.model));

  // The specialized agent: asked for explicitly, else the one the pair role names.
  const agentName = clean(input.agent) ?? clean(roleCfg?.agent);
  const agent = agentName ? Agents.require(agentName) : null;

  // Engine: explicit → role → pair heads → the agent's preference → the parent's own.
  const engine = clean(input.engine) ?? clean(roleCfg?.engine) ?? clean(pair?.heads_engine) ?? clean(agent?.engine) ?? parent.engine;
  requireEngine(engine);
  const roleEngine = clean(roleCfg?.engine) ?? clean(pair?.heads_engine) ?? clean(agent?.engine) ?? parent.engine;
  const model =
    clean(input.model) ??
    pickModel(engine, [
      [clean(roleCfg?.model), roleEngine],
      [clean(pair?.heads_model), clean(pair?.heads_engine) ?? clean(agent?.engine) ?? parent.engine],
      [clean(agent?.model), clean(agent?.engine) ?? parent.engine],
      [parent.model, parent.engine],
    ]);
  const effort = clean(input.effort) ?? clean(roleCfg?.effort) ?? clean(pair?.heads_effort) ?? clean(agent?.effort) ?? parent.effort;

  // Caps. A head that is idle with all its work merged holds no slot: it stays open only so follow-ups can reuse it.
  const openHeads = db().prepare("SELECT * FROM sessions WHERE parent_id = ? AND status != 'closed' ORDER BY created_at").all(parent.id) as SessionRecord[];
  const holding = openHeads.filter((h) => liveTurns.has(h.id) || h.status !== "idle" || !fullyMerged(h));
  const perParentCap = Math.min(getSetting("max_per_parent") as number, pair?.max_heads ?? Number.POSITIVE_INFINITY);
  if (!caller.operator && holding.length >= perParentCap) {
    const list = holding.map((h) => `${h.id} (${h.role ?? h.engine}, ${headState(h)})`).join(", ");
    throw new SessionError(
      `You already have ${holding.length} open subagent(s) holding a slot (cap ${perParentCap}): ${list}. Merge or close finished ones (an idle head with its work merged frees its slot), or send follow-ups to an idle one.`,
    );
  }
  const maxConcurrent = getSetting("max_concurrent") as number;
  if (liveTurns.size >= maxConcurrent) {
    throw new SessionError(`${liveTurns.size} turns are already running daemon-wide (cap ${maxConcurrent}). Wait for yours with subagent_wait, then retry.`);
  }
  assertMemoryFree();

  const id = newId("s");
  const title = sessionTitle(clean(input.title), brief);
  const wantIsolation = input.isolate ?? "auto";
  const files = normalizeFiles(input.files);
  const filesJson = files ? JSON.stringify(files) : null;

  // Workspace. A child never shares the parent's directory for writing when it can have its own.
  let wt: WorktreeSession | null = null;
  let workspace: string;
  let isolation: Isolation = "none";
  if (wantIsolation !== false && repoRootOf(parent.cwd)) {
    wt = new WorktreeManager(parent.cwd).prepare({ sessionId: id, label: role || engine, setupCmd: clean(getSetting("worktree_setup_cmd")), deps: getSetting("worktree_deps") as DepsMode });
  }
  if (wt) {
    isolation = "worktree";
    workspace = wt.cwd;
  } else {
    workspace = path.join(paths.scratch(), id);
    fs.mkdirSync(workspace, { recursive: true });
  }

  try {
    db()
      .prepare(
        `INSERT INTO sessions (id, title, brief, parent_id, root_id, depth, engine, model, effort, role, pair_id, status, cwd, base_cwd,
           isolation, worktree_root, worktree_git_root, branch, base_sha, head_sha, subagents, agent, files_json, launch_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'launching')`,
      )
      // launch_state is the intent, written before the engine is started (startTurn clears it): a crash in between is detectable.
      .run(id, title, brief, parent.id, parent.root_id, depth, engine, model, effort, role, parent.pair_id, workspace, parent.cwd, isolation, wt?.root ?? null, wt?.gitRoot ?? null, wt?.branch ?? null, wt?.baseSha ?? null, wt?.baseSha ?? null, depth < maxDepth ? 1 : 0, agent?.name ?? null, filesJson);
  } catch (err) {
    if (wt) {
      new WorktreeManager(parent.cwd).cleanup(wt);
      git(["branch", "-D", wt.branch], wt.gitRoot);
    }
    throw err;
  }

  const session = getSession(id)!;
  startTurn(session, firstTurnPrompt(session, caller), { resume: false });
  return getSession(id)!;
}

/* -------------------------------------------------------------------------- */
/* Follow-ups, wait, interrupt, close, merge                                   */
/* -------------------------------------------------------------------------- */

/** Send a follow-up to an idle session. It resumes its own engine session with full context. */
export function send(caller: Caller, id: string, message: string): SessionRecord {
  const s = requireOwned(caller, id);
  const asked = clean(message);
  if (!asked) throw new SessionError("message is required.");
  if (s.status === "closed") throw new SessionError(`Session ${id} is closed. Open a new one.`);
  const park = parkOf(id);
  if (park) throw new SessionError(`Session ${id} is parked until ${formatResumeAt(park.resume_at)} (usage limit). It resumes by itself; interrupt it to cancel.`);
  if (liveTurns.has(id)) throw new SessionError(`Session ${id} is still working. Wait for it, or interrupt it first.`);
  // A restart swept the empty worktree of a head that never started: there is no workspace left to resume in.
  if (s.depth > 0 && s.isolation === "worktree" && !fs.existsSync(s.cwd)) {
    throw new SessionError(`Session ${id} has no workspace: it was interrupted before it started and its empty worktree was removed. Open a new subagent instead.`);
  }
  if (finalizingOf(id)) throw new SessionError(`Session ${id} is still finishing its last turn. Try again in a moment.`);
  assertMemoryFree();
  if (s.depth > 0) {
    const maxConcurrent = getSetting("max_concurrent") as number;
    const working = activeTurnCount();
    if (working >= maxConcurrent) throw new SessionError(`${working} turns are already running daemon-wide (cap ${maxConcurrent}). Wait, then retry.`);
  }
  // After a rewind the agent's next prompt says so, once.
  const text = withRewindNotice(id, asked);
  const def = getEngine(s.engine);
  const canResume = Boolean(s.cli_session_id) && Boolean(def?.resume);
  const prompt =
    s.depth === 0
      ? canResume
        ? text
        : leadReplayPrompt(s, text)
      : canResume
        ? `# Follow-up from ${parentLabel(s)}\n\n${text}`
        : replayPrompt(s, text);
  startTurn(s, prompt, { resume: canResume, followUp: text });
  return getSession(id)!;
}

/**
 * The turn whose answer each caller last received from subagent_wait, per head: a later wait does not hand the same answer
 * back as if it were new. In memory: after a restart an answer may be delivered once more, never lost.
 */
const deliveredTurn = new Map<string, string>();
const deliveredKey = (caller: Caller, id: string) => `${caller.sessionId ?? "operator"}:${id}`;

/** Whether `caller` already received this head's latest answer. */
export function answerDelivered(caller: Caller, s: Pick<SessionRecord, "id" | "last_turn_id">): boolean {
  return !!s.last_turn_id && deliveredTurn.get(deliveredKey(caller, s.id)) === s.last_turn_id;
}

/** Record that `caller` received the answers of these heads (the ones not still working). */
export function markAnswersDelivered(caller: Caller, sessions: SessionRecord[]): void {
  for (const s of sessions) if (s.status !== "running" && s.last_turn_id) deliveredTurn.set(deliveredKey(caller, s.id), s.last_turn_id);
}

export async function wait(
  caller: Caller,
  ids: string[],
  opts: { timeoutSec?: number | null; mode?: "all" | "any" | null; signal?: AbortSignal } = {},
): Promise<{ sessions: SessionRecord[]; timedOut: boolean; elapsedMs: number; aborted: boolean }> {
  const started = Date.now();
  const targets = (ids.length ? ids : listForCaller(caller).map((s) => s.id)).map((id) => requireOwned(caller, id));
  const def = getSetting("wait_default_sec") as number;
  const max = getSetting("wait_max_sec") as number;
  const timeoutSec = Math.min(Math.max(Number(opts.timeoutSec ?? def) || def, 1), max);
  // A target is busy while its turn runs, and until that turn is finalized (see finalize.ts): the caller reads the result then.
  const busy = (s: SessionRecord) => [liveTurns.get(s.id)?.promise, finalizingOf(s.id)].filter(Boolean) as Promise<void>[];
  const pending = targets.flatMap(busy);
  // "any" is already satisfied when one of the targets settled before this call with an answer the caller has not had:
  // racing only the busy ones would block on the slowest. An answer an earlier wait returned does not count.
  const anyAlreadyDone = opts.mode === "any" && targets.some((s) => busy(s).length === 0 && !!s.last_turn_id && !answerDelivered(caller, s));
  let timedOut = false;
  let aborted = false;
  if (pending.length > 0 && !anyAlreadyDone) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutSec * 1000);
    });
    // The waiter's own turn being interrupted ends the wait at once: nothing is left listening for the answer.
    let onAbort: (() => void) | null = null;
    const abort = new Promise<"aborted">((resolve) => {
      if (!opts.signal) return;
      if (opts.signal.aborted) return resolve("aborted");
      onAbort = () => resolve("aborted");
      opts.signal.addEventListener("abort", onAbort, { once: true });
    });
    const settled = opts.mode === "any" ? Promise.race(pending) : Promise.all(pending);
    const winner = await Promise.race([settled.then(() => "done" as const), timeout, abort]);
    if (timer) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    timedOut = winner === "timeout";
    aborted = winner === "aborted";
  }
  return { sessions: targets.map((s) => getSession(s.id)!), timedOut, aborted, elapsedMs: Date.now() - started };
}

/** Stop the turn in flight. The session survives: its engine session id is kept, so a later `send` resumes. */
export async function interrupt(caller: Caller, id: string): Promise<SessionRecord> {
  const s = requireOwned(caller, id);
  const live = liveTurns.get(id);
  if (!live) return s;
  live.controller.abort();
  // Bounded: a process that ignores SIGTERM must not hang the call.
  await Promise.race([live.promise, new Promise((r) => setTimeout(r, 5000))]);
  return getSession(id)!;
}

export async function close(caller: Caller, id: string, opts: { reason?: string } = {}): Promise<SessionRecord> {
  const s = requireOwned(caller, id);
  if (s.status === "closed") return s;
  stopGoal(id, "the session was closed"); // before the interrupt below, which would otherwise be named as the reason
  // Children first: a closed parent must not strand running heads.
  for (const kid of descendantsOf(id, true).reverse()) {
    if (liveTurns.has(kid.id)) await interrupt({ operator: true }, kid.id);
    await settleGit(kid);
    closeInternal(getSession(kid.id)!, opts.reason ?? "closed with its parent");
  }
  if (liveTurns.has(id)) await interrupt(caller, id);
  await settleGit(s);
  closeInternal(getSession(id)!, opts.reason ?? null);
  return getSession(id)!;
}

/**
 * Let a head's pending finalization and the queued git writes on its repository finish, so the synchronous cleanup in
 * closeInternal does not overlap them: its checkpoint would otherwise be recorded after the rows were dropped.
 */
async function settleGit(s: SessionRecord): Promise<void> {
  await finalizingOf(s.id);
  if (s.worktree_git_root) await drainSerialized(gitKey(s.worktree_git_root));
}

function closeInternal(s: SessionRecord, reason: string | null): void {
  if (s.isolation === "worktree" && s.worktree_root && s.worktree_git_root) {
    try {
      const wt = worktreeSession(s);
      if (fs.existsSync(wt.root)) {
        // Anything left uncommitted (a turn killed mid-edit) is committed as wip, not thrown away.
        new WorktreeManager(wt.cwd).finalize(wt, { title: s.title, label: s.role || s.engine, sessionId: s.id, turnId: s.last_turn_id ?? undefined, wip: true });
        new WorktreeManager(wt.cwd).cleanup(wt);
      }
      const tip = branchTip(s);
      if (tip) db().prepare("UPDATE sessions SET head_sha = ? WHERE id = ?").run(tip, s.id);
      const fresh = getSession(s.id)!;
      const unchanged = !fresh.head_sha || fresh.head_sha === fresh.base_sha;
      // An empty branch is noise; a merged one has already landed, unless the head committed more after its last merge.
      if ((unchanged || fullyMerged(fresh)) && fresh.branch) {
        git(["branch", "-D", fresh.branch], s.worktree_git_root);
        db().prepare("UPDATE sessions SET branch = NULL WHERE id = ?").run(s.id);
      }
    } catch (err: any) {
      console.warn(`[trb] ${s.id}: worktree cleanup failed: ${err?.message ?? err}`);
    }
  } else if (s.depth > 0 && s.isolation === "none") {
    try {
      fs.rmSync(s.cwd, { recursive: true, force: true });
    } catch {}
  }
  db()
    .prepare("UPDATE sessions SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, last_error = COALESCE(?, last_error) WHERE id = ?")
    .run(reason, s.id);
  dropCheckpoints(s.id);
  setStatus(s, "closed");
  stopGoal(s.id, "the session was closed");
  reapLeftovers(s, "the session was closed");
}

/**
 * Refuse a new turn while the machine is short of memory (min_free_memory_mb, 0 = no guard). Checked where a turn is
 * asked for, before anything is written, so the caller sees the refusal and nothing is left half-started.
 */
function assertMemoryFree(): void {
  const min = getSetting("min_free_memory_mb") as number;
  if (min <= 0) return;
  const free = Math.floor(availableMemoryMb());
  if (free < min) {
    throw new SessionError(
      `only ${free} MB free, under min_free_memory_mb (${min}); wait for turns to finish, then retry. To change the limit: Settings > General > "Refuse new turns below free memory", or \`trb config set min_free_memory_mb <MB>\` (0 turns the guard off).`,
    );
  }
}

/**
 * Stop the background processes a session's earlier turns left running (sessions/leftovers.ts). Never called on a
 * session with a live turn: that turn's group is its own. Returns how many processes were stopped.
 */
function reapLeftovers(s: Pick<SessionRecord, "id" | "root_id">, why: string): number {
  if (liveTurns.has(s.id)) return 0;
  return reapGroups(s.id, why, (text) => appendLog(s, null, text, "info")).processes;
}

/**
 * Apply a worktree child's committed changes to the parent's checkout as UNCOMMITTED edits. The
 * parent then owns them like any of its own: reviewed, adjusted, committed with its own work. A
 * conflicting patch applies nothing.
 */
export function merge(caller: Caller, id: string): { merged: boolean; message: string; files: string[]; session: SessionRecord } {
  const s = requireOwned(caller, id);
  if (s.isolation !== "worktree" || !s.worktree_git_root) {
    throw new SessionError(`Session ${id} worked in a shared directory; its edits are already there. Nothing to merge.`);
  }
  if (liveTurns.has(id)) throw new SessionError(`Session ${id} is still working. Wait for it first.`);
  if (finalizingOf(id)) throw new SessionError(`Session ${id} is still finishing its last turn. Try again in a moment.`);
  const headSha = branchTip(s) || "";
  // A head reused after a merge (subagent_send) merges again: only the commits after the tip the last merge applied.
  if (s.merged_at && (!s.merged_sha || headSha === s.merged_sha)) {
    return { merged: false, message: `Already merged at ${s.merged_at}; no commits since.`, files: [], session: s };
  }
  const fromSha = s.merged_at ? s.merged_sha : s.base_sha;
  if (!headSha || !fromSha || headSha === fromSha) {
    return { merged: false, message: "The subagent committed no changes; nothing to merge.", files: [], session: s };
  }
  const parent = s.parent_id ? getSession(s.parent_id) : null;
  const target = parent ? repoRootOf(parent.cwd) : null;
  if (!target) throw new SessionError(`The parent workspace (${parent?.cwd ?? "unknown"}) is no longer a git checkout.`);

  const res = mergePatch({ fromGitRoot: s.worktree_git_root, baseSha: fromSha, headSha, targetDir: target });
  if (!res.ok) {
    return {
      merged: false,
      message: `The changes do not apply cleanly to ${target}: ${res.reason}\nNothing was changed. Resolve by hand with \`git merge ${s.branch}\` (branch kept), or send the subagent a follow-up to rebase its work.`,
      files: res.files,
      session: s,
    };
  }
  db().prepare("UPDATE sessions SET merged_at = CURRENT_TIMESTAMP, merged_sha = ?, head_sha = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(headSha, headSha, id);
  if (parent) scheduleKeepInSync(parent.cwd, (line) => appendLog(parent, null, line, "info"));
  return { merged: true, message: `Applied ${res.files.length} file(s) from ${s.branch} to ${target} as uncommitted changes.`, files: res.files, session: getSession(id)! };
}

/** A head's state in a few words, for the cap refusal. */
function headState(h: SessionRecord): string {
  if (liveTurns.has(h.id) || h.status === "running") return "working";
  if (h.status === "failed") return "failed, not merged";
  if (h.merged_at) return "idle, committed more since its merge";
  return h.head_sha && h.head_sha !== h.base_sha ? "idle, not merged" : "idle, no changes";
}

/** The settled token totals, plus the running turn's so far. */
function tokensOf(s: SessionRecord): SessionView["tokens"] {
  const live = liveTurns.has(s.id) ? liveTurnUsage.get(s.id) : undefined;
  return {
    input: s.input_tokens + (live ? live.input + live.cacheCreation : 0),
    output: s.output_tokens + (live?.output ?? 0),
    cache_read: s.cache_read_tokens + (live?.cacheRead ?? 0),
  };
}

/** Merged, with nothing committed since the last merge. */
function fullyMerged(s: Pick<SessionRecord, "merged_at" | "merged_sha" | "head_sha">): boolean {
  return Boolean(s.merged_at) && (!s.merged_sha || s.head_sha === s.merged_sha);
}

/** The child's committed changes as a unified diff (worktree sessions only). Reads at most `maxBytes`: git is stopped there. */
export async function diff(id: string, maxBytes = 200_000): Promise<{ diff: string; truncated: boolean } | null> {
  const s = getSession(id);
  if (!s || s.isolation !== "worktree" || !s.worktree_git_root || !s.base_sha) return null;
  const head = await branchTipAsync(s);
  if (!head || head === s.base_sha) return { diff: "", truncated: false };
  const r = await runGit(["diff", s.base_sha, head], { cwd: s.worktree_git_root, stopAfter: maxBytes, timeoutMs: LOCAL_GIT_TIMEOUT_MS }).catch(() => null);
  return { diff: r ? r.stdout.toString() : "", truncated: r?.truncated ?? false };
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Called once at daemon start. Turns in flight when the daemon died are marked failed (the engine
 * session id is kept, so a follow-up resumes them), and worktrees nobody owns are swept.
 */
export interface RecoveryReport {
  /** Sessions the dead daemon left running or launching, now failed (and resumable by a follow-up). */
  interrupted: number;
  /** Stale worktrees removed. */
  swept: number;
  /** Of the interrupted, heads that never reached their engine (their launch was recorded, the start was not). */
  launchInterrupted: number;
  /** Of the interrupted, heads (depth > 0). */
  headsInterrupted: number;
  /** Interrupted heads whose worktree was kept because it holds commits or uncommitted edits. */
  worktreesKept: number;
  /** Leads that were blocked in subagent_wait when the daemon died. Their heads' results are still in the database. */
  waitsInterrupted: number;
  /** Sessions parked on a usage limit when the daemon died, held again until their reset (see parks.ts). */
  parked: number;
  /** Heads whose last turn was never finalized (its commit, checkpoint and diff), now finalized in the background. */
  finalized: number;
}

/**
 * Called once at daemon start. Turns in flight when the daemon died are marked failed (the engine
 * session id is kept, so a follow-up resumes them), and worktrees nobody owns are swept. A head whose
 * launch was recorded but never started is interrupted too; its worktree is swept unless it holds work.
 * A lead that was waiting on heads is flagged (its waits are kept, see waiting.ts). A session parked on
 * a usage limit is held again first, so it is still running, not stranded, when the check below runs.
 */
export function recoverOnStartup(): RecoveryReport {
  const parked = rearmParks();
  const stranded = db().prepare("SELECT * FROM sessions WHERE status = 'running' OR launch_state = 'launching'").all() as SessionRecord[];
  let interrupted = 0;
  let launchInterrupted = 0;
  let headsInterrupted = 0;
  let worktreesKept = 0;
  // Interrupted heads with nothing in their worktree worth keeping: swept below, so they are not "live".
  const emptyHeads = new Set<string>();
  for (const s of stranded) {
    if (liveTurns.has(s.id)) continue;
    const neverStarted = s.launch_state === "launching";
    const isHead = s.depth > 0;
    const keepWorktree = isHead && s.isolation === "worktree" ? worktreeHasWork(s) : true;
    if (isHead && s.isolation === "worktree" && !keepWorktree) emptyHeads.add(s.id);
    const message = neverStarted
      ? keepWorktree
        ? "interrupted: the daemon stopped before this subagent started; send a follow-up to start it"
        : "interrupted: the daemon stopped before this subagent started, and its empty worktree was removed; open a new subagent instead"
      : "interrupted: the daemon stopped mid-turn; send a follow-up to resume";
    db()
      .prepare("UPDATE sessions SET status = 'failed', launch_state = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(message, s.id);
    interrupted++;
    if (neverStarted) launchInterrupted++;
    if (isHead) headsInterrupted++;
    if (isHead && keepWorktree && s.isolation === "worktree") worktreesKept++;
  }
  db().prepare("UPDATE turns SET status = 'failed', error = 'interrupted: the daemon stopped mid-turn', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'").run();
  // A lead blocked in subagent_wait keeps the heads' results; the wait itself is what was cut short.
  const waits = interruptWaitsOnStartup();
  for (const w of waits) {
    db()
      .prepare("UPDATE sessions SET last_error = ? WHERE id = ? AND status = 'failed'")
      .run(`wait interrupted: the daemon stopped while waiting on ${w.ids.length} subagent(s). Their results are kept: call subagent_wait with their ids to read them.`, w.caller);
  }
  recoverGoals();
  recoverVerify();
  recoverPlanQuestions();
  pruneCommandReceipts();
  // Sessions closed while their agent's processes were still running, or before this daemon started: those are stopped now.
  // Open sessions keep theirs until the reaper finds them idle (reapIdle).
  for (const g of sessionsWithGroups()) {
    const s = g.status === "closed" && !liveTurns.has(g.session_id) ? getSession(g.session_id) : null;
    if (s) reapLeftovers(s, "the daemon restarted");
  }
  // A turn the daemon died in the middle of finalizing (or ended with it) is finished now, as its turn would have been:
  // its work is committed (as wip unless the turn completed) and its diff recorded. Heads swept below are skipped.
  const unfinalized = db()
    .prepare(
      `SELECT s.id AS id, t.id AS turn_id, t.seq AS seq, t.status AS status
         FROM sessions s JOIN turns t ON t.id = s.last_turn_id
        WHERE s.finalized_at IS NULL AND s.status != 'closed' AND t.status != 'running'`,
    )
    .all() as Array<{ id: string; turn_id: string; seq: number; status: string }>;
  let finalized = 0;
  for (const u of unfinalized) {
    if (liveTurns.has(u.id) || emptyHeads.has(u.id)) continue;
    void finalizeHead(u.id, () => finalizeTurnWork(u.id, u.turn_id, u.seq, u.status !== "completed"));
    finalized++;
  }
  const liveShortIds = new Set(
    (db().prepare("SELECT id FROM sessions WHERE status != 'closed' AND isolation = 'worktree'").all() as Array<{ id: string }>)
      .filter((r) => !emptyHeads.has(r.id))
      .map((r) => r.id.replace(/^s_/, "").slice(0, 10)),
  );
  const swept = WorktreeManager.sweep((shortId) => liveShortIds.has(shortId));
  pruneSharedTargets(getSetting("cargo_target_max_gb") * 1024 ** 3);
  return { interrupted, swept, launchInterrupted, headsInterrupted, worktreesKept, waitsInterrupted: waits.length, parked, finalized };
}

/** Whether a head's worktree holds work to keep: commits past its base, or uncommitted edits. A git failure counts as work. */
function worktreeHasWork(s: SessionRecord): boolean {
  if (!fs.existsSync(s.cwd)) return false;
  const tip = branchTip(s);
  if (tip && s.base_sha && tip !== s.base_sha) return true;
  const status = git(["status", "--porcelain"], s.cwd);
  return !status.ok || status.stdout.trim() !== "";
}

/** Close subagents that have sat idle past the TTL, and orphans of a closed parent. */
export function reapIdle(now = Date.now()): number {
  const ttlMs = (getSetting("idle_close_hours") as number) * 3600 * 1000;
  const open = db().prepare("SELECT * FROM sessions WHERE depth > 0 AND status IN ('idle','failed')").all() as SessionRecord[];
  let closed = 0;
  for (const s of open) {
    // A head still finishing its last turn writes its checkpoint off the thread: it is closed on a later sweep.
    if (liveTurns.has(s.id) || finalizingOf(s.id)) continue;
    const updated = Date.parse(s.updated_at.includes("T") ? s.updated_at : `${s.updated_at.replace(" ", "T")}Z`);
    const stale = Number.isFinite(updated) && now - updated > ttlMs;
    const parent = s.parent_id ? getSession(s.parent_id) : null;
    const orphaned = !parent || parent.status === "closed";
    if (stale || orphaned) {
      closeInternal(s, stale ? `closed after ${getSetting("idle_close_hours")}h idle` : "closed: parent is closed");
      closed++;
    }
  }
  // Leads: closed after lead_idle_close_hours without a turn (off at 0), unless pinned or still working.
  const leadHours = getSetting("lead_idle_close_hours") as number;
  if (leadHours > 0) {
    const leads = db().prepare("SELECT * FROM sessions WHERE depth = 0 AND status IN ('idle','failed') AND pinned_at IS NULL").all() as SessionRecord[];
    for (const s of leads) {
      if (liveTurns.has(s.id) || finalizingOf(s.id) || hasWorkingChildren(s.id)) continue;
      const updated = Date.parse(s.updated_at.includes("T") ? s.updated_at : `${s.updated_at.replace(" ", "T")}Z`);
      if (!Number.isFinite(updated) || now - updated <= leadHours * 3600 * 1000) continue;
      const kids = descendantsOf(s.id, true);
      if (kids.some((k) => liveTurns.has(k.id) || finalizingOf(k.id))) continue;
      // Deepest first, as close() does; the subagents were idle too, so nothing is interrupted.
      for (const k of kids.reverse()) closeInternal(k, `closed with its lead: idle ${leadHours}h`);
      closeInternal(s, `closed after ${leadHours}h idle`);
      closed++;
    }
  }
  // Leftover processes of sessions whose last turn ended more than leftover_reap_hours ago. The sessions stay open.
  const leftoverHours = getSetting("leftover_reap_hours") as number;
  if (leftoverHours > 0) {
    const cutoff = new Date(now - leftoverHours * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
    for (const g of sessionsWithGroups()) {
      if (liveTurns.has(g.session_id) || finalizingOf(g.session_id)) continue;
      if (!g.last_turn_end || g.last_turn_end >= cutoff) continue;
      const s = getSession(g.session_id);
      if (s) reapLeftovers(s, `no turn for ${leftoverHours}h`);
    }
  }
  return closed;
}

export function startReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    try {
      reapIdle();
    } catch (err: any) {
      console.warn(`[trb] reaper failed: ${err?.message ?? err}`);
    }
  }, IDLE_CLOSE_CHECK_MS);
  (reaperTimer as any).unref?.();
}

export function stopReaper(): void {
  if (reaperTimer) clearInterval(reaperTimer);
  reaperTimer = null;
}

/** Interrupt every live turn (daemon shutdown). Sessions keep their engine session ids. Parked turns are left alone: their park is in the DB and the next start re-arms it. */
export async function interruptAll(): Promise<void> {
  const live = [...liveTurns.values()].filter((t) => !t.parked);
  for (const t of live) t.controller.abort();
  await Promise.race([Promise.allSettled(live.map((t) => t.promise)), new Promise((r) => setTimeout(r, 6000))]);
}

/* -------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* -------------------------------------------------------------------------- */

function parentLabel(s: SessionRecord): string {
  return s.parent_id ? `the parent session (${s.parent_id})` : "the operator";
}

/**
 * Where a worktree session's work actually ends. An agent that commits for itself (many do:
 * "git add && git commit") leaves nothing for `finalize` to commit, so the recorded head would
 * still equal the base and the work would look like no work at all: `viewSession` would show no
 * changes, and closing would delete a branch that holds real commits. The branch tip is the truth.
 */
function branchTip(s: Pick<SessionRecord, "branch" | "worktree_git_root" | "head_sha">): string | null {
  if (s.branch && s.worktree_git_root) {
    const tip = git(["rev-parse", "--verify", "--quiet", s.branch], s.worktree_git_root).stdout.trim();
    if (tip) return tip;
  }
  return s.head_sha;
}

/** `branchTip` without blocking the event loop. */
async function branchTipAsync(s: Pick<SessionRecord, "branch" | "worktree_git_root" | "head_sha">): Promise<string | null> {
  if (s.branch && s.worktree_git_root) {
    const tip = (await runGit(["rev-parse", "--verify", "--quiet", s.branch], { cwd: s.worktree_git_root, timeoutMs: LOCAL_GIT_TIMEOUT_MS }).then((r) => r.stdout.toString()).catch(() => "")).trim();
    if (tip) return tip;
  }
  return s.head_sha;
}

/** A head's diff stats against its base, measured now. `ok` is false when git could not answer, so nothing is recorded. */
function measureChanges(s: SessionRecord): { changes: SessionView["changes"]; ok: boolean } {
  if (s.isolation !== "worktree" || !s.worktree_git_root || !s.base_sha) return { changes: null, ok: false };
  const tip = branchTip(s);
  if (!tip) return { changes: null, ok: false };
  if (tip === s.base_sha) return { changes: null, ok: true };
  const res = git(["diff", "--shortstat", s.base_sha, tip], s.worktree_git_root);
  if (!res.ok) return { changes: null, ok: false };
  const stat = res.stdout.trim();
  const num = (re: RegExp) => Number(stat.match(re)?.[1] ?? 0);
  return { changes: { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) }, ok: true };
}

function worktreeSession(s: SessionRecord): WorktreeSession {
  return { gitRoot: s.worktree_git_root!, root: s.worktree_root!, cwd: s.cwd, branch: s.branch || "", baseSha: s.base_sha || "", reused: false, notes: [] };
}

function workspaceNote(s: SessionRecord): string {
  if (s.isolation === "worktree") {
    return (
      `You are working in an isolated git worktree (branch \`${s.branch}\`) cut from your parent's checkout. ` +
      `Edit files here freely. Your changes are committed to that branch when your turn ends and your parent decides whether to merge them. ` +
      `Do not push and do not switch branches.`
    );
  }
  return (
    `The project workspace is \`${s.base_cwd}\`. Read and edit project files there by absolute path. ` +
    `Your current directory is a private scratch area for notes and temporary files. Other agents may be editing the same workspace right now, so touch only what your brief covers.`
  );
}

function roleInstructionsFor(s: SessionRecord): string | null {
  const pair = HydraPairs.get(s.pair_id);
  if (!pair) return null;
  const cfg = s.role ? pair.roles?.[s.role] : null;
  // Roles saved without instructions fall back to the library's text for that id; the operator's own always wins.
  const instructions = cfg?.instructions?.trim() || (s.role ? PAIR_ROLE_LIBRARY.find((p) => p.id === s.role)?.instructions : null);
  return HydraPairs.leadBrief(pair, "head", s.role ?? undefined) + (instructions ? `\n${instructions}` : "");
}

function firstTurnPrompt(s: SessionRecord, caller: Caller): string {
  const parent = caller.operator && !caller.sessionId ? "the operator" : `the parent session (${s.parent_id})`;
  const role = roleInstructionsFor(s);
  const agent = Agents.get(s.agent);
  const agentBlock = agent ? agentPromptBlock(agent).trim() : "";
  // A head outside a checkout runs in a scratch folder, where no AGENTS.md or CLAUDE.md is read: the project's practice
  // rules ride in its brief. The root lead's directory is the project's, whatever checkout this head's parent is in.
  const practices = s.isolation === "worktree" ? "" : practicesBrief(getSession(s.root_id)?.base_cwd ?? s.base_cwd);
  return [
    `# Subagent brief`,
    `You are a subagent opened by ${parent}${s.role ? `, in the **${s.role}** role` : ""}. Your final message is returned to ${parent} verbatim as a tool result: it is your deliverable, so make it complete and self-contained.`,
    ``,
    workspaceNote(s),
    ``,
    `Rules:`,
    `- Do this brief only. Do not re-plan the parent's job.`,
    `- If the brief is ambiguous or you are blocked, say exactly what is missing in your final message instead of guessing.`,
    `- End with: what you did, the files you changed (paths), how you verified it, and anything left undone.`,
    ...(agentBlock ? [``, agentBlock] : []),
    ...(practices ? [``, practices] : []),
    ...(role ? [``, `# Role`, role] : []),
    ``,
    `---`,
    ``,
    s.brief ?? "",
  ].join("\n");
}

/** A lead with no engine session to resume (its first turn died before reporting one): carry the thread in the prompt. */
function leadReplayPrompt(s: SessionRecord, message: string): string {
  return [
    `# Earlier in this session`,
    `Task: ${s.brief ?? ""}`,
    ...(s.last_output ? [``, `Your previous answer:`, s.last_output.slice(0, 20_000)] : []),
    ``,
    `# Follow-up`,
    message,
  ].join("\n");
}

/** For engines with no resume (or a refused one): replay the thread so far. */
function replayPrompt(s: SessionRecord, message: string): string {
  return [
    firstTurnPrompt(s, { sessionId: s.parent_id, operator: !s.parent_id }),
    ``,
    `---`,
    `# Your previous answer`,
    (s.last_output || "(none recorded)").slice(0, 20_000),
    ``,
    `# Follow-up from ${parentLabel(s)}`,
    message,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Turns                                                                      */
/* -------------------------------------------------------------------------- */

function startTurn(s: SessionRecord, prompt: string, opts: { resume: boolean; followUp?: string; isRetry?: boolean }): void {
  // The last turn's commit and diff are still being recorded: this turn starts once they are, from what they left.
  const pendingFinal = finalizingOf(s.id);
  if (pendingFinal) {
    void pendingFinal.then(() => {
      const fresh = getSession(s.id);
      if (fresh && fresh.status !== "closed") startTurn(fresh, prompt, opts);
    });
    return;
  }
  const def = getEngine(s.engine);
  // The prompt as it was handed in: a parked turn is sent again from this, not from the preambled copy below.
  const sentPrompt = prompt;
  // The reset the engine's own rate-limit event named during this turn, if it rejected the request (see engines/resets.ts).
  let limitEventReset: number | null = null;
  // The MCP servers this turn was started with: its group is searched for them when the turn ends (sessions/leftovers.ts).
  let turnMcp: McpRunConfig = {};
  const turnId = newId("t");
  const seq = (db().prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM turns WHERE session_id = ?").get(s.id) as { n: number }).n;
  db().prepare("INSERT INTO turns (id, session_id, seq, prompt, status, mode) VALUES (?, ?, ?, ?, 'running', ?)").run(turnId, s.id, seq, prompt, s.mode ?? "build");
  db().prepare("UPDATE sessions SET status = 'running', launch_state = NULL, last_turn_id = ?, last_error = NULL, model_pending = 0, finalized_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(turnId, s.id);
  forgetInterruptedWaits(s.id);
  setStatus(s, "running");
  Hub.publish({ type: "turn_start", sessionId: s.id, rootId: s.root_id, turnId });
  // Set once the prompt is built: whether this turn was asked for next-step chips (their lines stay out of the log).
  let nextWanted = false;
  const log = (text: string) => {
    let line = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (nextWanted && classifyLine(line).kind === "text") line = extractNextSteps(line).text;
    if (line) appendLog(s, turnId, line);
  };
  log(`[trb] ${s.id} (${s.role ? `${s.role}, ` : ""}${s.engine}${s.model ? `, ${s.model}` : ""}) — ${opts.resume ? "follow-up" : opts.isRetry ? "fresh retry" : "turn " + seq}`);

  const controller = new AbortController();
  const promise = (async () => {
    // The state turn 1 can be rewound to. Later turns rewind to the end of the one before. Taken before the engine can touch a file.
    if (seq === 1) await takeCheckpoint({ sessionId: s.id, cwd: s.cwd, turnId, seq: 0, kind: "base", label: "before the first turn" });
    let result: TurnResult;
    const cleanups: Array<() => void> = [];
    try {
      if (!def) throw new Error(`Unknown engine "${s.engine}".`);

      // A lead leads every turn with its contract plus the heads still open from earlier turns.
      // A slash command only works as the very start of the prompt: nothing goes in front of `/compact`.
      const slash = /^\/compact\b/.test(prompt);
      const asking = s.mode === "ask";
      // `/skill-name …` typed in the composer calls that skill explicitly, even if the session's skill list leaves it out.
      const invoked = slash || asking ? null : parseSkillInvocation(prompt);
      if (invoked) prompt = skillInvocationPrompt(invoked);
      const askIndex = asking ? codegraphFor(s.base_cwd, null) : null;
      let finalPrompt = asking && !slash ? askPreamble({ codegraph: Boolean(askIndex) }) + prompt : s.mode === "plan" && !slash ? planPreamble({ tools: Boolean(getDaemonContext()), depth: planDepthOf(s.id) }) + prompt : prompt;
      const pair = HydraPairs.get(s.pair_id);
      // Ask mode is lean: no agent instructions, no pair preamble, no skills, no extra MCP servers.
      const agent = asking ? null : Agents.get(s.agent);
      // Who the agent is goes in once, on the turn that starts a conversation: a resumed one already has it.
      // (A child's first-turn prompt already carries it; see firstTurnPrompt.)
      if (s.depth === 0 && agent && !opts.resume && !slash) finalPrompt = agentPromptBlock(agent) + finalPrompt;
      if (s.depth === 0 && pair && s.subagents && !slash && !asking) {
        const open = descendantsOf(s.id, true).filter((k) => k.parent_id === s.id);
        finalPrompt = HydraPairs.leadTurnPreamble(pair, s.engine, open.map((k) => ({ id: k.id, title: k.title, status: k.status, engine: k.engine, role: k.role }))) + finalPrompt;
      }

      // Skills: the session's own override, else its agent's assignment, else the default set (not the whole library).
      const baseSkills = s.skills_json ? parseList(s.skills_json) : (agent?.skills ?? defaultSkillNames(def));
      const allowedSkills = invoked && baseSkills && !baseSkills.includes(invoked.skill.name) ? [...baseSkills, invoked.skill.name] : baseSkills;
      const skills = asking ? { names: [] as string[], promptBlock: "", cleanup: () => {} } : materializeSkills(def, s.cwd, allowedSkills);
      cleanups.push(skills.cleanup);
      if (skills.names.length) log(`[trb] skills: ${skills.names.join(", ")}`);
      if (skills.promptBlock && !slash) finalPrompt = skills.promptBlock + finalPrompt;

      const daemon = getDaemonContext();
      // Both follow their settings (on by default). Evidence needs the daemon (its tools run there); REA is a standalone stdio server and does not.
      const evidenceOn = evidenceEnabled() && Boolean(daemon) && !asking;
      const reaOn = reaEnabled() && !asking;
      const mcp: McpRunConfig = buildRunMcpConfig({ sessionId: s.id, subagents: Boolean(s.subagents) && Boolean(daemon), plan: s.mode === "plan" && Boolean(daemon), title: s.depth === 0 && !asking && Boolean(daemon) && getSetting("session_titles") === "on", ask: asking, daemonUrl: daemon?.url ?? "", token: daemon?.token ?? "", allowed: agent?.mcp ?? null, browser: browserEnabled(), emulator: emulatorEnabled(), computer: computerUseAvailable(), evidence: evidenceOn, rea: reaOn, treeboss: !asking && isTreeboss(s.id) && Boolean(daemon), checklists: !asking && isChecklistAudit(s.id) && Boolean(daemon), codegraphDir: s.base_cwd });
      turnMcp = mcp;
      // One line, once per conversation: a resumed turn already has it.
      if (mcp.codegraph && !opts.resume && !asking) finalPrompt = `${CODEGRAPH_HINT}\n\n` + finalPrompt;
      // Evidence and REA: said once per conversation, like CodeGraph, and only where the engine can reach trb's MCP server.
      if (!opts.resume && !asking && !slash && def.mcp !== "none") {
        const aware = [mcp.rea ? REA_HINT : null, mcp.trb?.type === "stdio" && mcp.trb.env?.TRB_EVIDENCE === "1" ? evidenceHint(s.base_cwd) : null].filter(Boolean);
        if (aware.length) finalPrompt = `${aware.join("\n\n")}\n\n` + finalPrompt;
      }
      // Treeboss mode: its rules reach the engine once, and again on a fresh engine conversation (a replayed thread
      // does not carry them) or when the mode was just switched on. A resumed turn already has them.
      if (!slash && !asking && isTreeboss(s.id) && (!opts.resume || !treebossState(s.id).delivered)) {
        finalPrompt = `${treebossBlock()}\n\n` + finalPrompt;
        markTreebossDelivered(s.id);
      }
      // A lead's first turn names the session through the `session_title` tool, while it still has its plain title.
      // Only where the engine can reach trb's MCP server: asking an engine for a tool it cannot see would only confuse it.
      if (def.mcp !== "none" && mcp.trb?.type === "stdio" && mcp.trb.env?.TRB_TITLE === "1" && !opts.resume && !slash && s.title === plainTitle(s.brief)) finalPrompt = `${TITLE_INSTRUCTION}\n\n` + finalPrompt;
      // Attached specs, plans and docs, as one block: what is new since the last turn, or all of it when the thread is replayed fresh.
      if (!slash) {
        // Ask mode carries only what was attached since the last turn, never the whole set again.
        const attached = await attachmentsBlock(s.id, { all: !opts.resume && !asking });
        if (attached) {
          finalPrompt = `${attached}\n\n` + finalPrompt;
          markAttachmentsDelivered(s.id);
        }
      }

      nextWanted = wantsNextSteps({ depth: s.depth, mode: s.mode, slash, prompt: finalPrompt, enabled: getSetting("next_steps") === "on" });
      if (nextWanted) finalPrompt += `\n\n${NEXT_STEPS_INSTRUCTION}`;

      const run = runnerOverride ?? runTurn;
      result = await run({
        engine: s.engine,
        key: `${s.id}-${turnId}`,
        prompt: finalPrompt,
        cwd: s.cwd,
        model: asking && !s.model_manual ? (askOverrideModel(s.engine, s.model) ?? s.model) : s.model,
        effort: s.effort,
        resumeId: opts.resume ? s.cli_session_id : null,
        mcp,
        mode: s.mode === "plan" ? "plan" : asking ? "ask" : "build",
        maxTurns: s.engine === "claude" ? (getSetting("claude_max_turns") as number) : 0,
        strictMcp: getSetting("mcp_isolation") === "strict",
        // An engine's own print timeout is the absolute limit: the runner keeps the ceiling, which leaves waits out.
        timeoutSec: getSetting("turn_hard_ceiling_sec") as number,
        idleMs: (getSetting("turn_idle_timeout_sec") as number) * 1000,
        ceilingMs: (getSetting("turn_ceiling_sec") as number) * 1000,
        hardCeilingMs: (getSetting("turn_hard_ceiling_sec") as number) * 1000,
        isBusy: () => hasWorkingChildren(s.id),
        isWaiting: () => waitingOf(s.id) !== null,
        signal: controller.signal,
        onLog: log,
        onSpawn: (pid) => recordTurnGroup(s.id, turnId, pid),
        onSessionId: (sid) => db().prepare("UPDATE sessions SET cli_session_id = ? WHERE id = ?").run(sid, s.id),
        onUsage: (e) => {
          if (e.kind === "turn") liveTurnUsage.set(s.id, e.usage);
          recordUsageEvent(s, e);
          if (e.kind === "limits") limitEventReset = resetFromRateLimitEvent(e.info) ?? limitEventReset;
        },
      });
    } catch (err: any) {
      result = { success: false, output: `Turn crashed: ${err?.message ?? String(err)}`, sessionId: null, resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: null, stderr: "" };
    } finally {
      for (const c of cleanups) {
        try {
          c();
        } catch {}
      }
    }
    // Whatever the engine left running in its group (a dev server, say) is kept for the reaper, and said once.
    const { left: leftover, mcpStopped } = endTurnGroup(turnId, turnMcp);
    if (mcpStopped) log(`[trb] stopped ${mcpStopped} MCP server process(es) this turn left running`);
    if (leftover) log(`[trb] ${leftover} background process(es) still running from this turn`);
    let interrupted = controller.signal.aborted;

    // A turn stopped by a usage limit whose reset time is known waits for it rather than failing (sessions/parks.ts).
    // The session stays running and held; when the reset comes, the same prompt is sent again. Cancelled while parked
    // (interrupt, close), it settles below as an interrupted turn.
    const limitReset = !interrupted && !result.success && !result.timedOut && !result.aborted && !result.resumeRejected ? (limitEventReset ?? limitResetAt(`${result.output}\n${result.stderr}`)) : null;
    if (limitReset !== null) {
      const outcome = await parkTurn(s, turnId, { prompt: sentPrompt, resume: opts.resume, resetAt: limitReset }, controller);
      const fresh = outcome === "due" ? getSession(s.id) : null;
      if (fresh && fresh.status !== "closed") {
        // The resumed turn's promise settles when its own does, so a waiter sees the real end.
        startTurn(fresh, sentPrompt, { resume: opts.resume && Boolean(fresh.cli_session_id), followUp: sentPrompt });
        await liveTurns.get(s.id)?.promise;
        return;
      }
      interrupted = true;
    }

    // A refused resume never ran the follow-up. Retry once, fresh, with the thread replayed.
    if (result.resumeRejected && opts.resume && !interrupted && opts.followUp !== undefined) {
      log(`[trb] resume refused; retrying fresh with the thread replayed.`);
      settle(s, turnId, result, { interrupted: false, superseded: true });
      liveTurns.delete(s.id);
      liveTurnUsage.delete(s.id);
      db().prepare("UPDATE sessions SET cli_session_id = NULL WHERE id = ?").run(s.id);
      const stale = getSession(s.id)!;
      startTurn(stale, stale.depth === 0 ? opts.followUp : replayPrompt(stale, opts.followUp), { resume: false, isRetry: true });
      await liveTurns.get(s.id)?.promise; // chain, so a waiter sees the real end
      return;
    }

    // The chips come out of the reply before it is stored anywhere.
    let nextSteps: ReturnType<typeof extractNextSteps>["steps"] = [];
    if (nextWanted && result.success && !interrupted) {
      const x = extractNextSteps(result.output);
      result = { ...result, output: x.text };
      nextSteps = x.steps;
    }
    settle(s, turnId, result, { interrupted, superseded: false });
    if (nextSteps.length) db().prepare("UPDATE turns SET next_json = ? WHERE id = ?").run(JSON.stringify(nextSteps), turnId);
    liveTurns.delete(s.id);
    liveTurnUsage.delete(s.id);
    // Closed while this turn ran: its leftovers could not be reaped then, so they are now.
    if (leftover && getSession(s.id)?.status === "closed") reapLeftovers(s, "the session was closed");
    Hub.publish({ type: "turn_end", sessionId: s.id, rootId: s.root_id, turnId, status: interrupted ? "cancelled" : result.success ? "completed" : "failed" });
    cancelPendingQuestions(s.id, interrupted ? "the turn was interrupted" : "the turn ended");
    clearWaits(s.id);
    // Commit, checkpoint and diff summary of the turn: after turn_end, so a slow git call holds neither the event nor the
    // turn's recorded duration (see finalize.ts). The hooks below wait for it: they judge the turn's files.
    const wip = !result.success || interrupted;
    const finalized = finalizeHead(s.id, () => finalizeTurnWork(s.id, turnId, seq, wip));
    // Ticks first, so a box the agent reported done counts toward the goal's check. Then the docs, then treeboss's
    // gate, then the project's own checks (a failure starts a fix turn, and the goal is judged when that one ends).
    // A treeboss fix turn waits the same way: verify and the goal are judged when it ends.
    void finalized
      .then(() => specsAfterTurn(s.id, { interrupted, success: result.success }))
      .then(() => docsAfterTurn(s.id, { interrupted, success: result.success }))
      .catch(() => {})
      .then(() => treebossAfterTurn(s.id, { interrupted, success: result.success, turnId }))
      .catch(() => ({ continued: false }))
      .then(async (t) => {
        if (t.continued) return;
        const v = await verifyAfterTurn(s.id, { interrupted, success: result.success, turnId }).catch(() => ({ continued: false }));
        if (!v.continued) await goalAfterTurn(s.id, { interrupted, success: result.success, turnId });
      });
    // A head in a worktree edits its own copy: the main index is synced when its work is merged, not per turn.
    if (s.isolation !== "worktree") scheduleKeepInSync(s.cwd, (line) => appendLog(s, turnId, line, "info"));
    // The turn counts as done once it is finalized too: a waiter, or an interrupt, sees the head as it was left.
    await finalized;
  })();
  liveTurns.set(s.id, { turnId, controller, promise, startedAt: Date.now() });
}

/** The worktree commit of a finished turn, run in finalization (after turn_end). Returns the head's sha, or null. */
function commitTurn(s: SessionRecord, turnId: string, wip: boolean): string | null {
  // Commit the turn's work so it survives the checkout and can be merged. A failed or interrupted
  // turn commits as `wip:`: half-finished work on a branch is recoverable, a discarded one is not.
  let headSha: string | null = null;
  const fresh = getSession(s.id)!;
  if (fresh.isolation === "worktree" && fresh.worktree_root) {
    try {
      const wt = worktreeSession(fresh);
      if (fs.existsSync(wt.root)) {
        const delivery = new WorktreeManager(wt.cwd).finalize(wt, { title: s.title, label: s.role || s.engine, sessionId: s.id, turnId, wip });
        if (delivery.committed && delivery.headSha) appendLog(s, turnId, `[worktree] ${delivery.summary}`);
        headSha = git(["rev-parse", "HEAD"], wt.root).stdout.trim() || null; // includes commits the agent made itself
      }
    } catch (err: any) {
      console.warn(`[trb] ${s.id}: could not commit worktree: ${err?.message ?? err}`);
    }
  }
  return headSha;
}

/**
 * What a finished turn leaves for its head, run by finalizeHead: the worktree commit (`wip` when the turn did not complete),
 * the turn's checkpoint, and the diff summary the head is shown with (null when it has no changes).
 */
async function finalizeTurnWork(sessionId: string, turnId: string, seq: number, wip: boolean): Promise<ChangeSummary | null> {
  const s = getSession(sessionId);
  if (!s) return null;
  if (s.isolation === "worktree") {
    const headSha = commitTurn(s, turnId, wip);
    if (headSha) db().prepare("UPDATE sessions SET head_sha = ? WHERE id = ?").run(headSha, sessionId);
  }
  // The turn's files, kept in a hidden ref so it can be rewound or forked (see checkpoints/store.ts).
  const current = getSession(sessionId)!;
  if (current.status !== "closed") await takeCheckpoint({ sessionId, cwd: current.cwd, turnId, seq, kind: "turn", label: `turn ${seq}` });
  const tip = current.isolation === "worktree" && current.worktree_git_root && current.base_sha ? await branchTipAsync(current) : null;
  return tip && tip !== current.base_sha ? await diffSummary(current.worktree_git_root!, current.base_sha!, tip) : null;
}

function settle(s: SessionRecord, turnId: string, result: TurnResult, flags: { interrupted: boolean; superseded: boolean }): void {
  liveTurnUsage.delete(s.id);
  if (result.sessionId) db().prepare("UPDATE sessions SET cli_session_id = ? WHERE id = ?").run(result.sessionId, s.id);

  const u = result.usage;
  const turnStatus = flags.interrupted ? "cancelled" : flags.superseded ? "failed" : result.success ? "completed" : "failed";
  db()
    .prepare("UPDATE turns SET status = ?, output = ?, error = ?, usage_json = ?, cost_usd = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(turnStatus, result.output, result.success ? null : result.output.slice(0, 2000), u ? JSON.stringify(u) : null, u?.totalCostUsd ?? null, turnId);
  if (flags.superseded) return;
  // A killed engine never writes its own end line (there is no result event), so the log gets one here. The
  // transcript closes the turn's live "thinking" marker on it; without it the marker stays on after the stop.
  if (flags.interrupted) appendLog(s, turnId, `[${s.engine}] stopped by user`);

  const status: SessionStatus = flags.interrupted || result.success ? "idle" : "failed";
  const output = (result.output || "").trim();
  db()
    .prepare(
      `UPDATE sessions
          SET status = ?, last_output = ?, last_error = ?, turns = turns + 1,
              input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cache_read_tokens = cache_read_tokens + ?,
              cost_usd = CASE WHEN ? IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + ? END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status != 'closed'`,
    )
    .run(
      status,
      output,
      flags.interrupted ? "interrupted; send a follow-up to resume" : result.success ? null : output.slice(0, 2000),
      (u?.inputTokens ?? 0) + (u?.cacheCreationInputTokens ?? 0),
      u?.outputTokens ?? 0,
      u?.cacheReadInputTokens ?? 0,
      u?.totalCostUsd ?? null,
      u?.totalCostUsd ?? null,
      s.id,
    );
  setStatus(s, status);
}

/**
 * A turn stopped by a usage limit: its row ends failed (naming the reset), the session stays running and is parked
 * until the reset plus jitter. Resolves "due" when the scheduler wakes it, "cancelled" when it is interrupted meanwhile.
 */
function parkTurn(s: SessionRecord, turnId: string, p: { prompt: string; resume: boolean; resetAt: number }, controller: AbortController): Promise<ParkOutcome> {
  const resumeAt = p.resetAt + jitterMs();
  const reason = `usage limit reached; resumes ${formatResumeAt(resumeAt)}`;
  db().prepare("UPDATE turns SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(reason, turnId);
  db().prepare("UPDATE sessions SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(`parked: ${reason}`, s.id);
  schedulePark({ session_id: s.id, turn_id: turnId, resume_at: resumeAt, prompt: p.prompt, resume: p.resume, reason: "usage limit reached" });
  const live = liveTurns.get(s.id);
  if (live) live.parked = true;
  appendLog(s, turnId, `[trb] ${reason}. It resumes by itself; interrupt to cancel.`, "info");
  Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: "parked" });
  return awaitPark(s.id, controller.signal);
}

/** After a restart: hold each parked session again from its DB row (the turn that parked it died with the daemon). */
function rearmParks(): number {
  const rows = listParks();
  if (rows.length) startParkScheduler();
  let rearmed = 0;
  for (const row of rows) {
    const s = getSession(row.session_id);
    if (!s || s.status === "closed") {
      releasePark(row.session_id, "cancelled");
      continue;
    }
    if (liveTurns.has(s.id)) continue;
    holdAfterRestart(s, row);
    rearmed++;
  }
  return rearmed;
}

function holdAfterRestart(s: SessionRecord, row: ParkRow): void {
  const controller = new AbortController();
  const promise = (async () => {
    if ((await awaitPark(s.id, controller.signal)) === "due") {
      const fresh = getSession(s.id);
      if (fresh && fresh.status !== "closed") {
        startTurn(fresh, row.prompt, { resume: row.resume && Boolean(fresh.cli_session_id), followUp: row.prompt });
        await liveTurns.get(s.id)?.promise;
        return;
      }
    }
    const stopped: TurnResult = { success: false, output: "Stopped by the operator.", sessionId: null, resumeRejected: false, aborted: true, timedOut: false, maxTurnsHit: false, usage: null, exitCode: null, stderr: "" };
    settle(getSession(s.id)!, row.turn_id, stopped, { interrupted: true, superseded: false });
    liveTurns.delete(s.id);
    liveTurnUsage.delete(s.id);
    Hub.publish({ type: "turn_end", sessionId: s.id, rootId: s.root_id, turnId: row.turn_id, status: "cancelled" });
  })();
  liveTurns.set(s.id, { turnId: row.turn_id, controller, promise, startedAt: Date.now(), parked: true });
}

/* -------------------------------------------------------------------------- */
/* Presentation (shared by the MCP tools and the HTTP API)                    */
/* -------------------------------------------------------------------------- */

export const OUTPUT_INLINE_CHARS = 16_000;

export interface SessionView {
  id: string;
  title: string;
  status: SessionStatus;
  parent: string | null;
  depth: number;
  role: string | null;
  engine: string;
  model: string | null;
  effort: string | null;
  pair: string | null;
  agent: string | null;
  /** Skills this session is restricted to (override or its agent's), or null for every enabled skill. */
  skills: string[] | null;
  mode: "build" | "plan" | "ask";
  /** Treeboss mode is on for this session (its own choice, else the global setting). */
  treeboss: boolean;
  /** Treeboss mode's tier, attempts and last check for the web; null when the mode is off for this session. */
  treeboss_state: TreebossViewState | null;
  goal: Goal | null;
  /** The project's checks after the last turn (null: never run), and whether the session counts as done: verified and idle. */
  verify: VerifyView | null;
  done: boolean;
  turns: number;
  isolation: Isolation;
  cwd: string;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  cli_session_id: string | null;
  changes: { files: number; insertions: number; deletions: number } | null;
  merged: boolean;
  /** False while the last turn's commit and diff are still being recorded. Sessions from before this existed: true. */
  finalized: boolean;
  cost_usd: number | null;
  /** What the ask-mode turns of this session cost (null when it has none). */
  ask_cost_usd: number | null;
  tokens: { input: number; output: number; cache_read: number };
  /** How full the engine's context window is (null: this engine reported nothing yet), compactions so far, whether `/compact` works. */
  context: ContextView | null;
  compactions: number;
  can_compact: boolean;
  /** The session this one was handed off from. */
  handoff_from: string | null;
  /** Why the model cannot be changed between turns (the pair owns it, the engine cannot), or null when it can. */
  model_lock: string | null;
  /** The operator changed the model and the next turn has not started yet. */
  model_pending: boolean;
  /** Pinned to the top of the sessions list, whichever workspace it belongs to. */
  pinned: boolean;
  /** Last time a turn started or ended (ISO). */
  updated_at: string;
  /** Set while the session is parked on a usage limit: when its turn is sent again (ISO). Its status stays running. */
  parked_until: string | null;
  /** Set while this session is blocked in subagent_wait: the heads it waits on, and since when (ISO). */
  waiting_on?: Array<{ id: string; name: string }>;
  waiting_since?: string;
  /** Set when a daemon restart cut this session's subagent_wait short: the heads it was waiting on, and their current state. */
  wait_interrupted?: InterruptedWait | null;
  output?: string | null;
  output_truncated?: boolean;
  error?: string | null;
  running_for_sec?: number;
}

/** The treeboss part of a session view: null when the mode is off for the session (the same shape the route returns). */
export function treebossStateOf(sessionId: string): TreebossViewState | null {
  if (!isTreeboss(sessionId)) return null;
  const st = treebossState(sessionId);
  return { tier: st.tier, tier_source: st.tierSource, attempts: st.attempts, max_attempts: MAX_FIX_ATTEMPTS, last_check: st.lastCheck };
}

export function viewSession(s: SessionRecord, opts: { full?: boolean; withOutput?: boolean } = {}): SessionView {
  const live = liveTurns.get(s.id);
  // The diff as of the last finalization. A head that was never finalized (from before that existed) is measured now.
  let changes: SessionView["changes"] = null;
  if (s.changes_json !== null) {
    changes = JSON.parse(s.changes_json);
  } else {
    const measured = measureChanges(s);
    changes = measured.changes;
    // A finalized (or closed) head's diff no longer moves: keep the answer so later reads do not run git again.
    if (measured.ok && (s.status === "closed" || s.finalized_at !== null)) {
      db().prepare("UPDATE sessions SET changes_json = ? WHERE id = ?").run(JSON.stringify(changes), s.id);
      s.changes_json = JSON.stringify(changes);
    }
  }
  const verifyOf = verifyView(s);
  const park = s.status === "running" ? parkOf(s.id) : null;
  const view: SessionView = {
    id: s.id,
    title: s.title,
    status: s.status,
    updated_at: s.updated_at,
    parent: s.parent_id,
    depth: s.depth,
    role: s.role,
    engine: s.engine,
    model: s.model,
    effort: s.effort,
    pair: s.pair_id,
    agent: s.agent,
    skills: s.skills_json ? parseList(s.skills_json) : (Agents.get(s.agent)?.skills ?? null),
    mode: s.mode === "plan" ? "plan" : s.mode === "ask" ? "ask" : "build",
    treeboss: isTreeboss(s.id),
    treeboss_state: treebossStateOf(s.id),
    goal: getGoal(s.id),
    verify: verifyOf,
    done: Boolean(verifyOf?.done),
    turns: s.turns,
    isolation: s.isolation,
    cwd: s.cwd,
    branch: s.branch,
    base_sha: s.base_sha,
    head_sha: s.head_sha,
    cli_session_id: s.cli_session_id,
    changes,
    merged: fullyMerged(s),
    finalized: s.finalized_at !== null,
    cost_usd: s.cost_usd,
    ask_cost_usd: (db().prepare("SELECT SUM(cost_usd) AS c FROM turns WHERE session_id = ? AND mode = 'ask'").get(s.id) as { c: number | null }).c,
    tokens: tokensOf(s),
    ...contextOf(s),
    handoff_from: s.handoff_from,
    model_lock: modelLock(s),
    model_pending: s.model_pending === 1,
    pinned: s.pinned_at !== null,
    parked_until: park ? new Date(park.resume_at).toISOString() : null,
  };
  if (live) view.running_for_sec = Math.round((Date.now() - live.startedAt) / 1000);
  const waiting = waitingOf(s.id);
  if (waiting) Object.assign(view, waiting);
  const interruptedWait = waitInterruptedOf(s.id);
  if (interruptedWait) view.wait_interrupted = interruptedWait;
  if (opts.withOutput !== false && s.status !== "running") {
    const out = s.last_output ?? null;
    const limit = opts.full ? Number.POSITIVE_INFINITY : OUTPUT_INLINE_CHARS;
    if (out && out.length > limit) {
      view.output = `${out.slice(0, limit)}\n\n[... ${out.length - limit} more chars — subagent_list with id="${s.id}" returns the full answer]`;
      view.output_truncated = true;
    } else {
      view.output = out;
    }
    if (s.status === "failed" || s.last_error) view.error = s.last_error;
  }
  return view;
}

