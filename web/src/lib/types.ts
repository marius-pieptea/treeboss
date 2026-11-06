/** Shapes the daemon returns. Kept next to the client so a server change is a type error here. */

export type SessionStatus = "idle" | "running" | "failed" | "closed";

/** Treeboss mode: a turn's tier, the gates the gate runs in order, and each gate's result. */
export type Tier = "tweak" | "feature" | "area";
export type CheckId = "design" | "spec" | "roadmap" | "docs";
/** skip: the rule does not apply to this turn (the detail says why). */
export type CheckStatus = "pass" | "fail" | "skip";
export type CheckOutcome = "passed" | "fixing" | "gave_up" | "nothing_built" | "not_checked";

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  /** The violation on a fail, the reason on a skip; null otherwise. */
  detail: string | null;
}

export interface LastCheck {
  turn_id: string | null;
  at: string;
  tier: Tier | null;
  outcome: CheckOutcome;
  checks: CheckResult[];
}

export interface TreebossViewState {
  tier: Tier | null;
  /** Who set the tier: the agent on its own triage, or the operator's override. */
  tier_source: "agent" | "operator" | null;
  attempts: number;
  max_attempts: number;
  last_check: LastCheck | null;
}

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
  /** The specialized agent the session runs as, and the skills it is restricted to (null: every enabled skill). */
  agent?: string | null;
  skills?: string[] | null;
  turns: number;
  isolation: "none" | "worktree";
  cwd: string;
  branch: string | null;
  base_sha?: string | null;
  head_sha?: string | null;
  cli_session_id?: string | null;
  changes: { files: number; insertions: number; deletions: number } | null;
  merged: boolean;
  /** False while the last turn's commit and diff are still being recorded. Absent from older servers: treat as true. */
  finalized?: boolean;
  cost_usd: number | null;
  tokens: { input: number; output: number; cache_read: number };
  /** How full the engine's context window is. null: this engine has reported nothing (yet). */
  context?: {
    tokens: number;
    max: number | null;
    pct: number | null;
    breakdown: { input: number; cache_read: number; cache_creation: number; output: number };
    approx: boolean;
    updated_at: string | null;
  } | null;
  /** Context compactions so far, and whether `/compact` works for this engine. */
  compactions?: number;
  can_compact?: boolean;
  /** The session this one was handed off from. */
  handoff_from?: string | null;
  /** Why the model cannot change between turns (a pair owns it, or the engine cannot), or null. */
  model_lock?: string | null;
  /** The model was changed and the next turn has not started yet. */
  model_pending?: boolean;
  /** Pinned to the top of the sessions list, whichever workspace it belongs to. */
  pinned?: boolean;
  /** Last time a turn started or ended (ISO or SQLite UTC). */
  updated_at?: string;
  /** Set while the session is blocked in subagent_wait: the heads it waits on, and since when (ISO). */
  waiting_on?: Array<{ id: string; name: string }>;
  waiting_since?: string;
  /** plan: read-only until a plan is approved. ask: read-only quick questions. build: the agent may edit. */
  mode?: "build" | "plan" | "ask";
  /** Treeboss mode: the agent triages, checks design and docs, and writes specs. The daemon gates it after each turn. */
  treeboss?: boolean;
  /** The gate state: the tier and the last turn's checks. null while the mode is off. */
  treeboss_state?: TreebossViewState | null;
  /** What this session's ask-mode turns cost, in USD (null when it has none). */
  ask_cost_usd?: number | null;
  /** The goal the session keeps working toward, if one was set. */
  goal?: GoalView | null;
  /** The project's checks after the last turn (null: never run), and whether the session counts as done (verified and idle). */
  verify?: VerifyView | null;
  done?: boolean;
  output?: string | null;
  output_truncated?: boolean;
  error?: string | null;
  running_for_sec?: number;
}

/** A pinned lead, from any workspace: where it lives, so the sidebar can say and switch there. */
export interface PinnedSession extends SessionView {
  workspace_id: string | null;
  workspace_name: string | null;
}

export type VerifyState = "unknown" | "off" | "none" | "running" | "passed" | "failed" | "fixing";

export interface VerifyView {
  state: VerifyState;
  done: boolean;
  note: string | null;
  attempts: number;
  last: { turn_id: string | null; state: string; finished_at: string | null; results: Array<{ name: string; ok: boolean; exit: number; duration_ms: number }> } | null;
}

export type GoalStatus = "active" | "met" | "stopped" | "exhausted" | "stalled";

/** A goal the daemon keeps a session working on: after each turn it checks, then continues or stops. */
export interface GoalView {
  session_id: string;
  text: string;
  check_cmd: string | null;
  max_turns: number;
  max_minutes: number;
  status: GoalStatus;
  turns_used: number;
  started_at: string;
  ended_at: string | null;
  last_check_exit: number | null;
  last_check_output: string | null;
  last_note: string | null;
}

export interface SessionDetail {
  session: SessionView;
  brief: string | null;
  children: SessionView[];
}

export interface TurnRow {
  id: string;
  seq: number;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  finished_at: string | null;
  cost_usd: number | null;
  /** The mode the turn ran in. */
  mode?: "build" | "plan" | "ask" | null;
  /** The engine's usage report for the turn, as JSON text. */
  usage_json?: string | null;
  /** The follow-ups the agent suggested at the end of the turn, as JSON text: `[{label, prompt}]`. */
  next_json?: string | null;
  prompt: string;
  output: string | null;
}

export type LineKind = "text" | "tool" | "tool_ok" | "tool_err" | "thinking" | "done" | "fail" | "info" | "stderr";
export interface LineMeta {
  kind: LineKind;
  name?: string;
  arg?: string;
  size?: string;
  detail?: string;
  /** A context compaction: tokens before and after (null when the engine did not say). */
  compact?: { from: number | null; to: number | null };
}
export interface LogLine {
  id: number;
  session: string;
  turn_id?: string | null;
  text: string;
  kind: LineKind;
  data: LineMeta | null;
  /** Present on live events: who said it, for a tree view. */
  label?: string;
  depth?: number;
  ts?: string;
}

export interface Workspace {
  id: string;
  path: string;
  name: string;
  last_opened: string;
}

export interface RepoInfo {
  isRepo: boolean;
  root?: string;
  /** The workspace's own location inside the repo ("" at the top). Git paths are repo-relative. */
  prefix?: string;
  remotes?: Array<{ name: string; url: string }>;
  identity?: { name: string | null; email: string | null };
  /** Git could not answer (not installed, refused the folder, timed out); the reason, verbatim. */
  problem?: string;
  /** The problem is git's "dubious ownership" refusal: the folder can be trusted from the UI. */
  untrusted?: boolean;
}

export interface RootInfo {
  root: { ref: string; kind: "workspace" | "session"; dir: string; name: string };
  repo: RepoInfo;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  symlink?: boolean;
  size: number;
  mtime: number;
  ignored?: boolean;
}

export type FileRead =
  | { path: string; content: string; mtime: number; size: number; eol: "lf" | "crlf" }
  | { path: string; binary: true; size: number; mtime: number }
  | { path: string; tooLarge: true; size: number; mtime: number };

export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface GitFile {
  path: string;
  origPath?: string;
  /** Index (staged) letter: M A D R C T, "." none, "U" unmerged. */
  index: string;
  /** Worktree (unstaged) letter: M D T, "?" untracked, "." none, "U" unmerged. */
  worktree: string;
  conflict?: string;
}

export interface GitStatus {
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  stashCount: number;
}

export interface GitBranch {
  name: string;
  remote: boolean;
  current: boolean;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  subject: string;
  date: string;
}

export interface GitLogEntry {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  refs: string[];
  subject: string;
}

export interface GitCommitDetail extends GitLogEntry {
  body: string;
  files: Array<{ status: string; path: string; origPath?: string }>;
}

export interface GitStash {
  index: number;
  ref: string;
  message: string;
  date: string;
}

export interface DiffResult {
  diff: string;
  truncated: boolean;
  note?: string;
}

export interface TerminalInfo {
  id: string;
  rootRef: string;
  cwd: string;
  title: string;
  command: string[];
  cols: number;
  rows: number;
  createdAt: string;
  alive: boolean;
  exitCode: number | null;
}

export interface ListeningPort {
  port: number;
  pid: number;
  command: string;
  cwd: string | null;
  address: string;
}

export interface HeadRoleConfig {
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  /** A specialized agent this role runs as. */
  agent?: string | null;
  instructions?: string | null;
  label?: string | null;
}
export interface Pair {
  id: string;
  title: string;
  mode: "heads" | "roles";
  lead_engine: string | null;
  lead_model: string | null;
  lead_effort: string | null;
  heads_engine: string | null;
  heads_model: string | null;
  heads_effort: string | null;
  roles: Record<string, HeadRoleConfig> | null;
  max_heads: number | null;
  /** A standing brief for the lead, at most 2,000 characters (null: none). */
  lead_instructions?: string | null;
}
export interface PairRecipe extends Omit<Pair, "id"> {
  id: string;
  tagline: string;
}
export interface RolePreset {
  id: string;
  label: string;
  description: string;
  engine: string;
  effort: "low" | "medium" | "high";
  instructions: string;
}

export interface EngineInfo {
  id: string;
  label: string;
  installed: boolean;
  bin: string | null;
  mcp: "config-file" | "cli-override" | "workspace-file" | "none";
  skills_dir: string | null;
  resume: boolean;
}

export interface McpServer {
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
}

export interface Skill {
  name: string;
  description: string;
  path: string;
  source: string | null;
  enabled: boolean;
  /** In the default set: what a session with no agent or list of its own gets (the default_skills setting). */
  default?: boolean;
  /** Ships with trb (seeded into the store); `modified` when its files differ from what shipped. */
  builtin?: boolean;
  modified?: boolean;
  /** The skill pack it ships in (see src/skill-packs.ts); null for the operator's own skills and the five built-ins written in builtin.ts. */
  pack?: string | null;
}

export interface Setting {
  key: string;
  value: string | number;
  default: string | number;
  custom: boolean;
  help: string;
}

/** A specialized agent: instructions plus what it may use. null skills / mcp mean "every enabled one". */
export interface Agent {
  name: string;
  title: string;
  description: string;
  instructions: string;
  engine: string | null;
  model: string | null;
  effort: string | null;
  skills: string[] | null;
  mcp: string[] | null;
  created_at: string;
  updated_at: string;
  used_by_pairs: Array<{ pair: string; role: string }>;
  /** Ships with trb. `modified`: its copy differs from what trb last wrote. */
  builtin?: boolean;
  modified?: boolean;
}

/* ------------------------------------------------------------------ plan questionnaire */

export interface PlanOption {
  label: string;
  description?: string;
  recommended?: boolean;
  reason?: string;
}

export interface PlanAnswer {
  choices: string[];
  custom: string | null;
  skipped: boolean;
  note?: string;
}

export interface PlanQuestion {
  id: string;
  session_id: string;
  seq: number;
  question: string;
  options: PlanOption[];
  allow_custom: boolean;
  multi: boolean;
  status: "pending" | "answered" | "cancelled";
  answer: PlanAnswer | null;
  asked_at: string;
  answered_at: string | null;
}

export interface PlanStep {
  title: string;
  detail: string;
  files?: string[];
}

export interface PlanRecord {
  id: string;
  session_id: string;
  version: number;
  title: string;
  summary: string;
  steps: PlanStep[];
  risks: string[];
  open_questions: string[];
  status: "draft" | "approved" | "rejected" | "superseded";
  note: string | null;
  created_at: string;
  decided_at: string | null;
  /** The markdown file the plan lives in (workspace-relative); null for a plan from before plan files. */
  path: string | null;
  depth: "quick" | "spec";
  /** The spec feature this plan wrote (depth "spec") or was promoted into. */
  feature: string | null;
  promoted: string | null;
  /** The operator changed the file since the daemon wrote it. */
  edited?: boolean;
  file_missing?: boolean;
}

export interface PlanState {
  mode: "build" | "plan";
  questions: PlanQuestion[];
  pending: PlanQuestion | null;
  plan: PlanRecord | null;
  plans: PlanRecord[];
  expected_total: number;
  /** What the next plan becomes: a plans/ file or a spec feature. */
  depth: "quick" | "spec";
}
