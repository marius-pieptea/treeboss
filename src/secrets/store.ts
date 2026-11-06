/**
 * Environments and encrypted secrets, per workspace.
 *
 * An environment is a name (dev, staging, prod, or a custom one) with an optional URL. dev, staging and prod always
 * exist, so their tabs never disappear; a custom one exists once added. A secret belongs to one workspace and one
 * environment, and its value is stored only as ciphertext (see crypto.ts).
 *
 * Who may read what: `resolveEnv` returns plaintext and is for server-side callers only (dev-server injection, and
 * later deploy and mobile). Nothing in this module returns a value to a route or a log: listings carry names and
 * timestamps. Files are read and written only inside the workspace folder.
 */
import type { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { db } from "../db";
import { UserError } from "../util";
import { Workspaces } from "../workspaces";
import { open, seal } from "./crypto";
import { formatDotenv, KEY_PATTERN, parseDotenv } from "./dotenv";

export const BUILTIN_ENVS = ["dev", "staging", "prod"];
const ENV_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_DOTENV_BYTES = 256 * 1024;

export interface EnvironmentView {
  name: string;
  url: string | null;
  builtin: boolean;
  secrets: number;
}

export interface SecretKeyView {
  key: string;
  updatedAt: string;
}

let ready: Database | null = null;
function tables(): Database {
  const conn = db();
  if (ready === conn) return conn;
  conn.exec(`CREATE TABLE IF NOT EXISTS environments (
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT,
    PRIMARY KEY (workspace_id, name)
  )`);
  conn.exec(`CREATE TABLE IF NOT EXISTS secrets (
    workspace_id TEXT NOT NULL,
    env TEXT NOT NULL,
    key TEXT NOT NULL,
    value_enc TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, env, key)
  )`);
  ready = conn;
  return conn;
}

/** Bound into every ciphertext, so a value copied to another row or environment does not open. */
const aad = (workspaceId: string, env: string, key: string): string => `${workspaceId}\u0000${env}\u0000${key}`;

function envName(raw: string): string {
  const n = String(raw ?? "").trim().toLowerCase();
  if (!ENV_PATTERN.test(n)) throw new UserError("An environment name is lowercase letters, digits, - or _, starting with a letter (up to 32 characters).");
  return n;
}

function secretKey(raw: string): string {
  const k = String(raw ?? "").trim();
  if (!KEY_PATTERN.test(k)) throw new UserError("A secret name is an environment variable name: letters, digits and _, not starting with a digit.");
  return k;
}

function cleanUrl(raw: string | null | undefined): string | null {
  const v = raw?.trim() ?? "";
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new UserError("The URL is not valid.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UserError("The URL must start with http:// or https://.");
  return v;
}

function requireEnv(workspaceId: string, name: string): void {
  if (BUILTIN_ENVS.includes(name)) return;
  const row = tables().prepare("SELECT 1 FROM environments WHERE workspace_id = ? AND name = ?").get(workspaceId, name);
  if (!row) throw new UserError(`There is no environment "${name}" here. Add it with: trb env add ${name}`);
}

/** dev, staging and prod first, then the custom ones by name. */
export function listEnvs(workspaceId: string): EnvironmentView[] {
  const conn = tables();
  const rows = conn.prepare("SELECT name, url FROM environments WHERE workspace_id = ?").all(workspaceId) as Array<{ name: string; url: string | null }>;
  const counts = new Map((conn.prepare("SELECT env, COUNT(*) AS n FROM secrets WHERE workspace_id = ? GROUP BY env").all(workspaceId) as Array<{ env: string; n: number }>).map((r) => [r.env, r.n]));
  const urls = new Map(rows.map((r) => [r.name, r.url]));
  const custom = rows.map((r) => r.name).filter((n) => !BUILTIN_ENVS.includes(n)).sort();
  return [...BUILTIN_ENVS, ...custom].map((name) => ({ name, url: urls.get(name) ?? null, builtin: BUILTIN_ENVS.includes(name), secrets: counts.get(name) ?? 0 }));
}

/** Adds an environment, or sets the URL of an existing one. A missing URL clears it. */
export function addEnv(workspaceId: string, name: string, url?: string | null): EnvironmentView {
  const n = envName(name);
  tables()
    .prepare("INSERT INTO environments (workspace_id, name, url) VALUES (?, ?, ?) ON CONFLICT(workspace_id, name) DO UPDATE SET url = excluded.url")
    .run(workspaceId, n, cleanUrl(url));
  return listEnvs(workspaceId).find((e) => e.name === n)!;
}

/** Removes a custom environment with its secrets. The built-in three cannot be removed. */
export function removeEnv(workspaceId: string, name: string): { removedSecrets: number } {
  const conn = tables();
  const n = envName(name);
  if (BUILTIN_ENVS.includes(n)) throw new UserError(`${n} is built in and cannot be removed. Unset its secrets one by one instead.`);
  const row = conn.prepare("SELECT 1 FROM environments WHERE workspace_id = ? AND name = ?").get(workspaceId, n);
  if (!row) throw new UserError(`There is no environment "${n}" here.`);
  return conn.transaction(() => {
    const removedSecrets = conn.prepare("DELETE FROM secrets WHERE workspace_id = ? AND env = ?").run(workspaceId, n).changes;
    conn.prepare("DELETE FROM environments WHERE workspace_id = ? AND name = ?").run(workspaceId, n);
    return { removedSecrets };
  })();
}

function putRow(conn: Database, workspaceId: string, env: string, key: string, value: string, now: string): void {
  if (typeof value !== "string") throw new UserError("The value must be text.");
  if (Buffer.byteLength(value, "utf-8") > MAX_VALUE_BYTES) throw new UserError(`A secret is at most ${MAX_VALUE_BYTES / 1024} KB.`);
  conn
    .prepare(
      "INSERT INTO secrets (workspace_id, env, key, value_enc, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, env, key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at",
    )
    .run(workspaceId, env, key, seal(value, aad(workspaceId, env, key)), now);
}

/** Sets or replaces one secret. Returns the name and time only. */
export function setSecret(workspaceId: string, env: string, key: string, value: string): SecretKeyView {
  const conn = tables();
  const e = envName(env);
  const k = secretKey(key);
  requireEnv(workspaceId, e);
  const now = new Date().toISOString();
  putRow(conn, workspaceId, e, k, value, now);
  return { key: k, updatedAt: now };
}

export function unsetSecret(workspaceId: string, env: string, key: string): boolean {
  const e = envName(env);
  const k = secretKey(key);
  return tables().prepare("DELETE FROM secrets WHERE workspace_id = ? AND env = ? AND key = ?").run(workspaceId, e, k).changes > 0;
}

/** Names and times of the secrets of one environment. Never values. */
export function listSecretKeys(workspaceId: string, env: string): SecretKeyView[] {
  const e = envName(env);
  return tables().prepare("SELECT key, updated_at AS updatedAt FROM secrets WHERE workspace_id = ? AND env = ? ORDER BY key").all(workspaceId, e) as SecretKeyView[];
}

/**
 * Every secret of one environment, decrypted. Server-side only: the result must go into a child process's environment
 * or an encrypted request, never into a response body or a log.
 */
export function resolveEnv(workspaceId: string, env: string): Record<string, string> {
  const e = envName(env);
  const rows = tables().prepare("SELECT key, value_enc FROM secrets WHERE workspace_id = ? AND env = ?").all(workspaceId, e) as Array<{ key: string; value_enc: string }>;
  // A null prototype, so a secret named __proto__ is kept as a key rather than swallowed.
  const out: Record<string, string> = Object.create(null);
  for (const r of rows) out[r.key] = open(r.value_enc, aad(workspaceId, e, r.key));
  return out;
}

/**
 * A path the user gave, resolved inside the workspace folder. Refuses anything that leaves it, including through a
 * symlinked folder or file. Returns the absolute path and the path relative to the workspace, for display.
 */
function inWorkspace(workspaceId: string, given: string): { abs: string; rel: string } {
  const ws = Workspaces.get(workspaceId);
  if (!ws) throw new UserError("No such workspace.");
  const base = fs.realpathSync(ws.path);
  const abs = path.resolve(base, String(given ?? "").trim());
  const outside = (p: string) => {
    const r = path.relative(base, p);
    return r.split(path.sep)[0] === ".." || path.isAbsolute(r);
  };
  const rel = path.relative(base, abs);
  if (!rel || outside(abs)) throw new UserError("The file must be inside the workspace folder.");
  if (fs.existsSync(path.dirname(abs)) && outside(fs.realpathSync(path.dirname(abs)))) throw new UserError("The file must be inside the workspace folder.");
  if (fs.existsSync(abs) && outside(fs.realpathSync(abs))) throw new UserError("The file must be inside the workspace folder.");
  return { abs, rel: rel.split(path.sep).join("/") };
}

/**
 * Reads a .env file into one environment. Existing keys are replaced, the rest kept. All or nothing.
 * Returns the names imported and how many lines were not assignments.
 */
export function importDotenv(workspaceId: string, env: string, filePath: string): { keys: string[]; skipped: number } {
  const conn = tables();
  const e = envName(env);
  requireEnv(workspaceId, e);
  const { abs, rel } = inWorkspace(workspaceId, filePath);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new UserError(`There is no file at ${rel}.`);
  }
  if (!st.isFile()) throw new UserError(`${rel} is not a file.`);
  if (st.size > MAX_DOTENV_BYTES) throw new UserError(`${rel} is larger than ${MAX_DOTENV_BYTES / 1024} KB.`);
  const { entries, skipped } = parseDotenv(fs.readFileSync(abs, "utf-8"));
  const now = new Date().toISOString();
  conn.transaction(() => {
    for (const { key, value } of entries) putRow(conn, workspaceId, e, key, value, now);
  })();
  return { keys: entries.map((x) => x.key), skipped };
}

/**
 * Writes one environment to a .env file in the workspace (default `.env.<env>`), mode 0600. Only runs when asked.
 * An existing file is replaced only with `force`. Returns the path and the count, never the values.
 */
export function exportDotenv(workspaceId: string, env: string, filePath: string | null | undefined, force = false): { path: string; count: number } {
  tables();
  const e = envName(env);
  requireEnv(workspaceId, e);
  const { abs, rel } = inWorkspace(workspaceId, filePath || `.env.${e}`);
  if (fs.existsSync(abs) && !force) throw new UserError(`${rel} already exists. Pass force to replace it.`);
  const entries = Object.entries(resolveEnv(workspaceId, e))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value }));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, formatDotenv(entries, `Exported from TreeBoss (${e}). Keep this file out of git.`), { mode: 0o600 });
  try {
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { path: rel, count: entries.length };
}
