/**
 * Deploy targets (one per workspace and environment), the deploy history, and rollback.
 *
 * A deploy is a background job: `runDeploy` inserts a row, returns it queued, and streams the provider's
 * output into `log_tail` while the CLI runs. Callers poll the row (GET /api/deploys/:id). One deploy per
 * target runs at a time. Rollback is the same kind of job: it makes the previous live artifact live again
 * (a new row with kind "rollback"), so the history says what happened.
 *
 * Tables are created lazily, like the roadmap's. Secrets come from `envProvider` (see setEnvProvider) and
 * reach only the provider's child env; every log tail is redacted before it is saved.
 */
import fs from "fs";
import path from "path";
import { db } from "../db";
import { newId, UserError } from "../util";
import { Workspaces } from "../workspaces";
import { launchBlockers, type LaunchBlocker } from "../checklists/store";
import { isProviderId, PROVIDER_IDS, providerFor, type DeployOptions, type ProviderId } from "./providers";
import { redact } from "./providers/exec";

export const LOG_TAIL_MAX = 8000;
const ENV_RE = /^[a-z][a-z0-9-]{0,19}$/;

export type DeployStatus = "queued" | "running" | "succeeded" | "failed";
export type DeployKind = "deploy" | "rollback";

export interface DeployTarget {
  id: string;
  workspace_id: string;
  env: string;
  provider: ProviderId;
  config: Record<string, any>;
  url: string | null;
  created_at: string;
}

export interface Deploy {
  id: string;
  target_id: string;
  kind: DeployKind;
  status: DeployStatus;
  git_sha: string | null;
  version: string | null;
  url: string | null;
  provider_deploy_id: string | null;
  log_tail: string;
  started_at: string;
  finished_at: string | null;
}

/* -------------------------------------------------------------------------- */
/* Secrets                                                                    */
/* -------------------------------------------------------------------------- */

/** Returns the secrets for a workspace and environment. Set by the daemon once the secrets store exists. */
export type EnvProvider = (workspaceId: string, env: string) => Record<string, string>;

let envProvider: EnvProvider = () => ({});

/** Plug the secrets store in here (resolveEnv). Pass null to go back to no secrets. */
export function setEnvProvider(p: EnvProvider | null): void {
  envProvider = p ?? (() => ({}));
}

export function secretsFor(workspaceId: string, env: string): Record<string, string> {
  return envProvider(workspaceId, env) ?? {};
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

const schemaReady = new WeakSet<object>();

/**
 * The history table. Spec 030 left a `deploys` table in some users' databases with other columns, and it is
 * never touched. When that name is taken by it, history goes to `deploy_runs` instead.
 */
let RUNS = "deploys";
function runsTableIn(d: ReturnType<typeof db>): string {
  const cols = d.prepare("PRAGMA table_info(deploys)").all() as Array<{ name: string }>;
  return cols.length && !cols.some((c) => c.name === "target_id") ? "deploy_runs" : "deploys";
}

function tables() {
  const d = db();
  if (schemaReady.has(d)) return d;
  RUNS = runsTableIn(d);
  d.exec(`CREATE TABLE IF NOT EXISTS deploy_targets (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, env TEXT NOT NULL, provider TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}', url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (workspace_id, env)
  )`);
  d.exec(`CREATE TABLE IF NOT EXISTS ${RUNS} (
    id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES deploy_targets (id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'deploy', status TEXT NOT NULL, git_sha TEXT, version TEXT, url TEXT,
    provider_deploy_id TEXT, log_tail TEXT NOT NULL DEFAULT '',
    started_at TEXT DEFAULT CURRENT_TIMESTAMP, finished_at TEXT
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS ${RUNS}_target ON ${RUNS} (target_id)`);
  // A deploy still queued or running when the daemon stopped cannot finish now.
  d.prepare(`UPDATE ${RUNS} SET status = 'failed', finished_at = CURRENT_TIMESTAMP, log_tail = log_tail || ? WHERE status IN ('queued', 'running')`).run("\ninterrupted: the daemon stopped before this deploy finished.\n");
  schemaReady.add(d);
  return d;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const TEXT_KEYS = ["dir", "project", "app", "scope", "branch", "configFile"] as const;

function parseConfig(raw: unknown): Record<string, any> {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Keeps only the keys a provider reads, and checks their shape. A command target must have an argv. */
export function cleanConfig(provider: ProviderId, raw: unknown): Record<string, any> {
  const c: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, any> = {};
  for (const k of TEXT_KEYS) {
    const v = c[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || v.length > 300) throw new UserError(`config.${k} must be a short string.`);
    out[k] = v.trim();
  }
  for (const k of ["argv", "rollbackArgv"] as const) {
    const v = c[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x || x.length > 1000)) throw new UserError(`config.${k} must be a list of strings (argv, not a shell line).`);
    out[k] = v;
  }
  if (provider === "command" && !out.argv) throw new UserError("A command target needs config.argv: the command to run, as a list of strings.");
  return out;
}

function cleanUrl(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new UserError("The target URL must be a string.");
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new UserError("The target URL is not a valid URL.");
  }
  if (u.protocol !== "https:") throw new UserError("The target URL must be https.");
  return u.toString().replace(/\/$/, "");
}

function cleanEnv(v: unknown): string {
  if (typeof v !== "string" || !ENV_RE.test(v.trim())) throw new UserError("An environment is a short lowercase name: dev, staging, prod.");
  return v.trim();
}

function cleanProvider(v: unknown): ProviderId {
  if (!isProviderId(v)) throw new UserError(`Unknown deploy provider "${String(v)}". Use one of: ${PROVIDER_IDS.join(", ")}.`);
  return v;
}

/* -------------------------------------------------------------------------- */
/* Targets                                                                    */
/* -------------------------------------------------------------------------- */

const targetOf = (r: any): DeployTarget => ({ ...r, provider: r.provider as ProviderId, config: parseConfig(r.config) });

export function getTarget(id: string): DeployTarget | null {
  const r = tables().prepare("SELECT * FROM deploy_targets WHERE id = ?").get(id);
  return r ? targetOf(r) : null;
}

function requireTarget(id: string): DeployTarget {
  const t = getTarget(id);
  if (!t) throw new UserError(`No deploy target "${id}".`);
  return t;
}

export function listTargets(workspaceId: string): DeployTarget[] {
  return (tables().prepare("SELECT * FROM deploy_targets WHERE workspace_id = ? ORDER BY created_at, rowid").all(workspaceId) as any[]).map(targetOf);
}

export interface TargetInput {
  workspaceId: string;
  env: string;
  provider: string;
  config?: unknown;
  url?: string | null;
}

export function createTarget(input: TargetInput): DeployTarget {
  const d = tables();
  if (!Workspaces.get(input.workspaceId)) throw new UserError(`No workspace "${input.workspaceId}".`);
  const env = cleanEnv(input.env);
  const provider = cleanProvider(input.provider);
  const id = newId("dt");
  try {
    d.prepare("INSERT INTO deploy_targets (id, workspace_id, env, provider, config, url) VALUES (?, ?, ?, ?, ?, ?)").run(id, input.workspaceId, env, provider, JSON.stringify(cleanConfig(provider, input.config)), cleanUrl(input.url));
  } catch (e: any) {
    if (/UNIQUE/.test(String(e?.message))) throw new UserError(`${env} already has a deploy target in this workspace. Edit it instead.`);
    throw e;
  }
  return getTarget(id)!;
}

export interface TargetPatch {
  env?: string;
  provider?: string;
  config?: unknown;
  url?: string | null;
}

export function updateTarget(id: string, patch: TargetPatch): DeployTarget {
  const cur = requireTarget(id);
  const env = patch.env !== undefined ? cleanEnv(patch.env) : cur.env;
  const provider = patch.provider !== undefined ? cleanProvider(patch.provider) : cur.provider;
  const config = cleanConfig(provider, patch.config !== undefined ? patch.config : cur.config);
  const url = patch.url !== undefined ? cleanUrl(patch.url) : cur.url;
  try {
    tables().prepare("UPDATE deploy_targets SET env = ?, provider = ?, config = ?, url = ? WHERE id = ?").run(env, provider, JSON.stringify(config), url, id);
  } catch (e: any) {
    if (/UNIQUE/.test(String(e?.message))) throw new UserError(`${env} already has a deploy target in this workspace.`);
    throw e;
  }
  return getTarget(id)!;
}

export function deleteTarget(id: string): void {
  requireTarget(id);
  if (busy.has(id)) throw new UserError("A deploy for this target is running. Wait for it to finish.");
  const d = tables();
  d.prepare(`DELETE FROM ${RUNS} WHERE target_id = ?`).run(id);
  d.prepare("DELETE FROM deploy_targets WHERE id = ?").run(id);
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

export function getDeploy(id: string): Deploy | null {
  return (tables().prepare(`SELECT * FROM ${RUNS} WHERE id = ?`).get(id) as Deploy | undefined) ?? null;
}

export interface DeployFilter {
  targetId?: string;
  workspaceId?: string;
  limit?: number;
}

/** Newest first. */
export function listDeploys(f: DeployFilter = {}): Deploy[] {
  const d = tables();
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (f.targetId) {
    where.push("d.target_id = ?");
    args.push(f.targetId);
  }
  if (f.workspaceId) {
    where.push("t.workspace_id = ?");
    args.push(f.workspaceId);
  }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const sql = `SELECT d.* FROM ${RUNS} d JOIN deploy_targets t ON t.id = d.target_id${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY d.rowid DESC LIMIT ?`;
  return d.prepare(sql).all(...args, limit) as Deploy[];
}

/** What a rollback needs to make a deploy live again: its provider handle, else its URL. */
const artifactOf = (d: Pick<Deploy, "provider_deploy_id" | "url">): string => d.provider_deploy_id ?? d.url ?? "";

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

/** Deploy id by target id, for the one job each target may run. */
const busy = new Map<string, string>();
/** Deploy id to its job, so a test (or a shutdown) can wait for it. */
const jobs = new Map<string, Promise<void>>();

/** Resolves once the deploy's background job has finished. Resolves at once for an unknown or finished id. */
export async function waitDeploy(id: string): Promise<void> {
  await jobs.get(id);
}

function rootOf(t: DeployTarget): string {
  const w = Workspaces.get(t.workspace_id);
  if (!w || !fs.existsSync(w.path)) throw new UserError("The workspace folder for this target no longer exists.");
  return w.path;
}

function readVersion(root: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function headSha(root: string): string | null {
  const r = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore", windowsHide: true });
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
}

/** A prod deploy refused by the launch checklists. The blockers ride along so the UI can list them without parsing the message. */
export class LaunchRefused extends UserError {
  constructor(public blockers: LaunchBlocker[]) {
    const list = blockers.map((b) => `  - ${b.checklistTitle}: ${b.text} (${b.status === "fail" ? "failing" : "not passing yet"})`).join("\n");
    super(`Prod deploy refused: ${blockers.length} required launch check${blockers.length === 1 ? "" : "s"} not passing:\n${list}\nFix them, or deploy anyway with force.`);
  }
}

/**
 * Start a deploy of a target. Returns the queued row at once; the work runs in the background.
 * A prod deploy is refused (LaunchRefused) while the workspace's required launch checklist items do not pass, unless `force` is set.
 */
export function runDeploy(targetId: string, opts: { force?: boolean } = {}): Deploy {
  const t = requireTarget(targetId);
  if (t.env === "prod" && !opts.force) {
    const blockers = launchBlockers(t.workspace_id);
    if (blockers.length) throw new LaunchRefused(blockers);
  }
  return start(t, "deploy", null);
}

function start(t: DeployTarget, kind: DeployKind, source: Deploy | null): Deploy {
  if (busy.has(t.id)) throw new UserError(`${t.env} is already deploying. Wait for it to finish.`);
  const root = rootOf(t);
  const id = newId("dp");
  tables()
    .prepare(`INSERT INTO ${RUNS} (id, target_id, kind, status, git_sha, version, url, provider_deploy_id, log_tail) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, '')`)
    .run(id, t.id, kind, headSha(root), readVersion(root), source?.url ?? null, source ? artifactOf(source) : null);
  busy.set(t.id, id);
  const job = execute(id, t, kind, source)
    .catch(() => {
      // Something outside the provider failed (a secrets lookup, the database). Say so on the row, without its text: it may hold a secret.
      try {
        tables().prepare(`UPDATE ${RUNS} SET status = 'failed', finished_at = CURRENT_TIMESTAMP, log_tail = log_tail || ? WHERE id = ? AND status IN ('queued', 'running')`).run("\ninternal error: the deploy stopped.\n", id);
      } catch {}
    })
    .finally(() => {
      busy.delete(t.id);
      jobs.delete(id);
    });
  jobs.set(id, job);
  return getDeploy(id)!;
}

const tailOf = (text: string): string => text.slice(-LOG_TAIL_MAX);

/** The job body. Never rejects: a failure is recorded on the row. */
async function execute(id: string, t: DeployTarget, kind: DeployKind, source: Deploy | null): Promise<void> {
  const d = tables();
  const vars = secretsFor(t.workspace_id, t.env);
  // Raw output, kept in memory only. What is saved is redacted.
  let raw = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    timer = null;
    d.prepare(`UPDATE ${RUNS} SET log_tail = ? WHERE id = ?`).run(tailOf(redact(raw, vars)), id);
  };
  const onLog = (text: string) => {
    raw = (raw + text).slice(-LOG_TAIL_MAX * 2);
    if (!timer) timer = setTimeout(persist, 300);
  };
  d.prepare(`UPDATE ${RUNS} SET status = 'running' WHERE id = ?`).run(id);
  try {
    const provider = providerFor(t.provider);
    const root = rootOf(t);
    const opts: DeployOptions = { config: t.config, vars, onLog };
    onLog(kind === "deploy" ? `Deploying ${t.env} with ${provider.label}\n` : `Rolling ${t.env} back with ${provider.label}\n`);
    if (kind === "deploy") {
      const r = await provider.deploy(root, t.env, opts);
      const url = r.url ?? getTarget(t.id)?.url ?? null;
      d.prepare(`UPDATE ${RUNS} SET status = 'succeeded', url = ?, provider_deploy_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`).run(url, r.providerDeployId, id);
      if (r.url) d.prepare("UPDATE deploy_targets SET url = ? WHERE id = ?").run(r.url, t.id);
    } else {
      const r = await provider.rollback(root, artifactOf(source!), opts);
      const url = r.url ?? source!.url;
      d.prepare(`UPDATE ${RUNS} SET status = 'succeeded', url = ?, provider_deploy_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`).run(url, artifactOf(source!), id);
      if (url) d.prepare("UPDATE deploy_targets SET url = ? WHERE id = ?").run(url, t.id);
    }
  } catch (e: any) {
    onLog(`\n${e?.message ?? String(e)}\n`);
    d.prepare(`UPDATE ${RUNS} SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  } finally {
    if (timer) clearTimeout(timer);
    persist();
  }
}

/**
 * Roll back from a deploy: it must be the live one (the newest successful deploy). The target goes back to
 * the newest earlier successful deploy with a different artifact. Returns the rollback's queued row.
 */
export function rollbackDeploy(deployId: string): Deploy {
  const live = getDeploy(deployId);
  if (!live) throw new UserError(`No deploy "${deployId}".`);
  const t = requireTarget(live.target_id);
  const chain = tables().prepare(`SELECT * FROM ${RUNS} WHERE target_id = ? AND status = 'succeeded' ORDER BY rowid ASC`).all(t.id) as Deploy[];
  if (!chain.length || chain[chain.length - 1]!.id !== live.id) throw new UserError("Only the live deploy can be rolled back. Roll back from the newest successful deploy.");
  const artifact = artifactOf(live);
  const prev = [...chain].reverse().find((d) => d.id !== live.id && artifactOf(d) !== "" && artifactOf(d) !== artifact);
  if (!prev) throw new UserError("There is no earlier successful deploy to roll back to.");
  return start(t, "rollback", prev);
}

/** The provider's own view of the target's URL (up, down or unknown). */
export async function targetStatus(targetId: string) {
  const t = requireTarget(targetId);
  return providerFor(t.provider).status(rootOf(t), t.url);
}

/** The detected providers for a workspace folder, as the UI shows them. */
export { detectProviders } from "./providers";
