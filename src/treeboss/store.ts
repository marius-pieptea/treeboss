/**
 * Treeboss mode, per session: whether it is on, the tier in force and who set it, how many fix turns the gate has
 * sent in a row, whether the mode's rules have reached the engine, and the last check the gate made.
 *
 * A session with no row follows the global `treeboss_mode` setting. A row is made only by an explicit change or by
 * the first delivery, so a later change of the global setting still reaches the sessions that never chose.
 *
 * The tier is the agent's declaration (`tier_source` "agent") unless the operator set one (`"operator"`), which wins
 * over every later declaration until it is cleared. Clearing forgets the tier: the next turn's declaration sets it.
 */
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { getSetting } from "../settings";

export type Tier = "tweak" | "feature" | "area";
export const TIERS: readonly Tier[] = ["tweak", "feature", "area"];
export type TierSource = "agent" | "operator";

/** The rules the gate checks, in the order it checks them. */
export type CheckId = "design" | "spec" | "roadmap" | "docs";
/** "skip": the rule does not apply to this tier or to this turn's files; the detail says why. */
export type CheckStatus = "pass" | "fail" | "skip";
/** What the gate did with the turn: passed, sent a fix turn, gave up, built nothing, or could not check it. */
export type CheckOutcome = "passed" | "fixing" | "gave_up" | "nothing_built" | "not_checked";

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  /** The violation text on a fail, the reason on a skip, null on a pass. */
  detail: string | null;
}

export interface LastCheck {
  turn_id: string | null;
  /** ISO time the gate wrote this record. */
  at: string;
  tier: Tier | null;
  outcome: CheckOutcome;
  checks: CheckResult[];
}

export interface TreebossState {
  enabled: boolean;
  tier: Tier | null;
  tierSource: TierSource | null;
  attempts: number;
  delivered: boolean;
  lastCheck: LastCheck | null;
}

/** The session view's `treeboss_state`: what the web shows. Null in the view when the mode is off for the session. */
export interface TreebossViewState {
  tier: Tier | null;
  tier_source: TierSource | null;
  attempts: number;
  max_attempts: number;
  last_check: LastCheck | null;
}

interface Row {
  session_id: string;
  enabled: number;
  tier: string | null;
  attempts: number;
  delivered: number;
  tier_source: string | null;
  last_check: string | null;
}

/** Columns added after the first build. An older file gets them once, with ALTER TABLE. */
const ADDED_COLUMNS: Array<[name: string, ddl: string]> = [
  ["tier_source", "TEXT"],
  ["last_check", "TEXT"],
];

/** Create the table if it is missing and add the columns it lacks. Exported so a test can open an older table. */
export function migrateTable(conn: Database): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS session_treeboss (
    session_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    tier TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    delivered INTEGER NOT NULL DEFAULT 0
  )`);
  const have = new Set((conn.prepare("PRAGMA table_info(session_treeboss)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, ddl] of ADDED_COLUMNS) if (!have.has(name)) conn.exec(`ALTER TABLE session_treeboss ADD COLUMN ${name} ${ddl}`);
}

const prepared = new WeakSet<Database>();
function table(): Database {
  const conn = db();
  if (!prepared.has(conn)) {
    migrateTable(conn);
    prepared.add(conn);
  }
  return conn;
}

const globalOn = (): boolean => getSetting("treeboss_mode") === "on";

export function getState(sessionId: string): TreebossState {
  const r = table().prepare("SELECT * FROM session_treeboss WHERE session_id = ?").get(sessionId) as Row | undefined;
  if (!r) return { enabled: globalOn(), tier: null, tierSource: null, attempts: 0, delivered: false, lastCheck: null };
  const tier = (r.tier as Tier | null) ?? null;
  return {
    enabled: Boolean(r.enabled),
    tier,
    // A tier from before the column existed was the agent's.
    tierSource: tier ? ((r.tier_source as TierSource | null) ?? "agent") : null,
    attempts: r.attempts,
    delivered: Boolean(r.delivered),
    lastCheck: r.last_check ? (JSON.parse(r.last_check) as LastCheck) : null,
  };
}

export function isTreeboss(sessionId: string): boolean {
  return getState(sessionId).enabled;
}

/** Turning it on (or off) again starts over: the rules are sent once more on the next turn. */
export function setTreeboss(sessionId: string, enabled: boolean): void {
  table()
    .prepare(
      `INSERT INTO session_treeboss (session_id, enabled, delivered, attempts) VALUES (?, ?, 0, 0)
       ON CONFLICT(session_id) DO UPDATE SET enabled = excluded.enabled, delivered = 0, attempts = 0`,
    )
    .run(sessionId, enabled ? 1 : 0);
}

/** Make the row exist before one of its fields changes, with the mode the session is in right now. */
function ensureRow(sessionId: string): void {
  table().prepare("INSERT OR IGNORE INTO session_treeboss (session_id, enabled, delivered) VALUES (?, ?, 0)").run(sessionId, globalOn() ? 1 : 0);
}

/** The tier the agent declared. An operator's tier wins until it is cleared, so a declaration then changes nothing. */
export function setTier(sessionId: string, tier: Tier): void {
  ensureRow(sessionId);
  table()
    .prepare("UPDATE session_treeboss SET tier = ?, tier_source = 'agent' WHERE session_id = ? AND (tier_source IS NULL OR tier_source = 'agent')")
    .run(tier, sessionId);
}

/** The operator's tier, or null to clear the override. Either way the fix attempts start over. */
export function setOperatorTier(sessionId: string, tier: Tier | null): void {
  ensureRow(sessionId);
  table()
    .prepare("UPDATE session_treeboss SET tier = ?, tier_source = ?, attempts = 0 WHERE session_id = ?")
    .run(tier, tier ? "operator" : null, sessionId);
}

/** The gate's last check of this session, replaced on every turn the gate looked at. */
export function setLastCheck(sessionId: string, check: LastCheck): void {
  ensureRow(sessionId);
  table().prepare("UPDATE session_treeboss SET last_check = ? WHERE session_id = ?").run(JSON.stringify(check), sessionId);
}

/** One more fix turn sent in a row. Returns the new count. */
export function bumpAttempts(sessionId: string): number {
  ensureRow(sessionId);
  table().prepare("UPDATE session_treeboss SET attempts = attempts + 1 WHERE session_id = ?").run(sessionId);
  return getState(sessionId).attempts;
}

export function resetAttempts(sessionId: string): void {
  table().prepare("UPDATE session_treeboss SET attempts = 0 WHERE session_id = ?").run(sessionId);
}

/** The rules reached the engine. Delivering them means the session is on, so a row without one is made enabled. */
export function markDelivered(sessionId: string): void {
  table()
    .prepare(
      `INSERT INTO session_treeboss (session_id, enabled, delivered) VALUES (?, 1, 1)
       ON CONFLICT(session_id) DO UPDATE SET delivered = 1`,
    )
    .run(sessionId);
}
