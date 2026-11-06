/**
 * Remote device tokens.
 *
 * A paired phone holds a random 256-bit token (HttpOnly cookie). Only its SHA-256 is stored, so a copy of
 * the database cannot be replayed. A token is revocable, expires, and is not the owner's token: it is
 * never accepted for anything the route policy (policy.ts) does not list.
 *
 * The table is created here on first use (`CREATE TABLE IF NOT EXISTS`, additive) so the shared schema in
 * db.ts stays untouched.
 */
import { createHash, randomBytes } from "crypto";
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { newId } from "../util";
import { getSetting } from "../settings";

export const TOKEN_PREFIX = "trbr_";

const ready = new WeakSet<Database>();
function conn(): Database {
  const d = db();
  if (!ready.has(d)) {
    d.exec(`CREATE TABLE IF NOT EXISTS remote_tokens (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'remote',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      last_ip TEXT,
      user_agent TEXT,
      revoked_at TEXT
    )`);
    ready.add(d);
  }
  return d;
}

export interface RemoteToken {
  id: string;
  label: string;
  scope: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  user_agent: string | null;
  revoked_at: string | null;
}

const COLS = "id, label, scope, created_at, expires_at, last_seen_at, last_ip, user_agent, revoked_at";

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Mint a token. The plaintext is returned once and never stored. */
export function mintToken(o: { label: string; ip?: string | null; userAgent?: string | null; now?: number }): { token: string; record: RemoteToken } {
  const now = o.now ?? Date.now();
  const token = TOKEN_PREFIX + randomBytes(32).toString("hex");
  const id = newId("rt");
  const days = Math.min(Math.max(Number(getSetting("remote_token_days")) || 30, 1), 365);
  conn()
    .prepare("INSERT INTO remote_tokens (id, label, token_hash, scope, created_at, expires_at, last_ip, user_agent) VALUES (?, ?, ?, 'remote', ?, ?, ?, ?)")
    .run(id, o.label.slice(0, 80) || "Phone", hashToken(token), new Date(now).toISOString(), new Date(now + days * 86_400_000).toISOString(), o.ip ?? null, (o.userAgent ?? "").slice(0, 200) || null);
  return { token, record: conn().prepare(`SELECT ${COLS} FROM remote_tokens WHERE id = ?`).get(id) as RemoteToken };
}

/** The live token behind a presented value: not revoked, not expired. null otherwise. */
export function verifyToken(token: string, o: { ip?: string | null; now?: number } = {}): RemoteToken | null {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const now = o.now ?? Date.now();
  const row = conn().prepare(`SELECT ${COLS} FROM remote_tokens WHERE token_hash = ?`).get(hashToken(token)) as RemoteToken | undefined;
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= now) return null;
  // last-seen is for the settings list; writing it on every request would be needless churn.
  if (!row.last_seen_at || now - Date.parse(row.last_seen_at) > 60_000) {
    conn().prepare("UPDATE remote_tokens SET last_seen_at = ?, last_ip = COALESCE(?, last_ip) WHERE id = ?").run(new Date(now).toISOString(), o.ip ?? null, row.id);
  }
  return row;
}

/** Is this token id still good (not revoked, not expired)? For sockets that outlive the request that opened them. */
export function tokenIsLive(id: string, now = Date.now()): boolean {
  const row = conn().prepare("SELECT expires_at, revoked_at FROM remote_tokens WHERE id = ?").get(id) as { expires_at: string; revoked_at: string | null } | undefined;
  return !!row && !row.revoked_at && Date.parse(row.expires_at) > now;
}

export function listTokens(): Array<RemoteToken & { active: boolean }> {
  const now = Date.now();
  const rows = conn().prepare(`SELECT ${COLS} FROM remote_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 200`).all() as RemoteToken[];
  return rows.map((r) => ({ ...r, active: Date.parse(r.expires_at) > now }));
}

export function revokeToken(id: string): boolean {
  const info = conn().prepare("UPDATE remote_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id);
  return info.changes > 0;
}

export function revokeAllTokens(): string[] {
  const ids = (conn().prepare("SELECT id FROM remote_tokens WHERE revoked_at IS NULL").all() as Array<{ id: string }>).map((r) => r.id);
  conn().prepare("UPDATE remote_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(new Date().toISOString());
  return ids;
}

/** Test seam. */
export function clearTokensForTests(): void {
  conn().exec("DELETE FROM remote_tokens");
}
