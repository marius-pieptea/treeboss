/**
 * Signals: what the product reports back (production errors, product metrics, user feedback, notes), one row
 * per thing per workspace. Tables are created lazily, like roadmap/store.ts, so db.ts stays untouched.
 *
 * A signal is unique on (workspace, source, external id): syncing again updates the row in place and keeps
 * what the operator decided (its status and link). Status moves new → triaged | linked | ignored; see triage.ts.
 */
import crypto from "crypto";
import { db } from "../db";
import { UserError } from "../util";
import { KINDS, SEVERITIES, SOURCES, STATUSES, type Kind, type Severity, type Signal, type SignalInput, type Source, type Status } from "./types";

let ready = false;
function tables(): void {
  if (ready) return;
  db().exec(`CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('sentry','posthog','feedback','manual')),
    kind TEXT NOT NULL CHECK(kind IN ('error','metric','feedback')),
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'low',
    count INTEGER NOT NULL DEFAULT 1,
    url TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','triaged','ignored','linked')),
    linked_ref TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    UNIQUE (workspace_id, source, external_id)
  )`);
  db().exec(`CREATE INDEX IF NOT EXISTS signals_workspace_status ON signals (workspace_id, status)`);
  db().exec(`CREATE TABLE IF NOT EXISTS signal_tokens (
    workspace_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  ready = true;
}

interface Row {
  id: string;
  workspace_id: string;
  source: Source;
  kind: Kind;
  external_id: string;
  title: string;
  body: string;
  severity: Severity;
  count: number;
  url: string | null;
  meta: string;
  status: Status;
  linked_ref: string | null;
  first_seen: string;
  last_seen: string;
}

const view = (r: Row): Signal => ({
  id: r.id,
  workspaceId: r.workspace_id,
  source: r.source,
  kind: r.kind,
  externalId: r.external_id,
  title: r.title,
  body: r.body,
  severity: r.severity,
  count: r.count,
  url: r.url,
  meta: JSON.parse(r.meta || "{}") as Record<string, unknown>,
  status: r.status,
  linkedRef: r.linked_ref,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
});

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Most severe first, then most frequent, then most recent. */
export function compareSignals(a: Signal, b: Signal): number {
  return RANK[a.severity] - RANK[b.severity] || b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.id.localeCompare(b.id);
}

/**
 * Insert a signal, or update the one with the same (workspace, source, external id). Status, link and
 * first_seen are kept on update: a new sync must not reopen what the operator already decided.
 */
export function upsertSignal(workspaceId: string, input: SignalInput): Signal {
  tables();
  if (!SOURCES.includes(input.source)) throw new UserError(`Unknown signal source "${input.source}".`);
  if (!KINDS.includes(input.kind)) throw new UserError(`Unknown signal kind "${input.kind}".`);
  const externalId = String(input.externalId ?? "").trim();
  if (!externalId) throw new UserError("A signal needs an external id.");
  const title = String(input.title ?? "").trim().slice(0, 300);
  if (!title) throw new UserError("A signal needs a title.");
  const severity = input.severity && SEVERITIES.includes(input.severity) ? input.severity : "low";
  const now = new Date().toISOString();
  const firstSeen = input.firstSeen ?? now;
  const lastSeen = input.lastSeen ?? now;
  db()
    .prepare(
      `INSERT INTO signals (id, workspace_id, source, kind, external_id, title, body, severity, count, url, meta, status, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
       ON CONFLICT (workspace_id, source, external_id) DO UPDATE SET
         kind = excluded.kind, title = excluded.title, body = excluded.body, severity = excluded.severity,
         count = excluded.count, url = excluded.url, meta = excluded.meta, last_seen = excluded.last_seen`,
    )
    .run(
      `sig_${crypto.randomBytes(5).toString("hex")}`,
      workspaceId,
      input.source,
      input.kind,
      externalId,
      title,
      String(input.body ?? "").slice(0, 8000),
      severity,
      Math.max(1, Math.floor(input.count ?? 1)),
      input.url ?? null,
      JSON.stringify(input.meta ?? {}),
      firstSeen,
      lastSeen,
    );
  return findSignal(workspaceId, input.source, externalId)!;
}

export function findSignal(workspaceId: string, source: Source, externalId: string): Signal | null {
  tables();
  const r = db().prepare("SELECT * FROM signals WHERE workspace_id = ? AND source = ? AND external_id = ?").get(workspaceId, source, externalId) as Row | undefined;
  return r ? view(r) : null;
}

export interface SignalFilter {
  source?: string | null;
  status?: string | null;
  kind?: string | null;
}

/** The signals of a workspace, most important first. Unknown filter values match nothing rather than everything. */
export function listSignals(workspaceId: string, filter: SignalFilter = {}): Signal[] {
  tables();
  const where = ["workspace_id = ?"];
  const args: unknown[] = [workspaceId];
  if (filter.source) {
    where.push("source = ?");
    args.push(filter.source);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.kind) {
    where.push("kind = ?");
    args.push(filter.kind);
  }
  const rows = db().prepare(`SELECT * FROM signals WHERE ${where.join(" AND ")}`).all(...(args as string[])) as Row[];
  return rows.map(view).sort(compareSignals);
}

export function getSignal(id: string): Signal {
  tables();
  const r = db().prepare("SELECT * FROM signals WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new UserError(`There is no signal "${id}".`);
  return view(r);
}

export interface SignalUpdate {
  status?: Status;
  linkedRef?: string | null;
  /** Merged into the existing meta; a key set to null is removed. */
  meta?: Record<string, unknown>;
}

export function updateSignal(id: string, patch: SignalUpdate): Signal {
  const cur = getSignal(id);
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new UserError(`Status must be one of ${STATUSES.join(", ")}.`);
  const meta: Record<string, unknown> = { ...cur.meta };
  for (const [k, v] of Object.entries(patch.meta ?? {})) {
    if (v === null) delete meta[k];
    else meta[k] = v;
  }
  db()
    .prepare("UPDATE signals SET status = ?, linked_ref = ?, meta = ? WHERE id = ?")
    .run(patch.status ?? cur.status, patch.linkedRef === undefined ? cur.linkedRef : patch.linkedRef, JSON.stringify(meta), id);
  return getSignal(id);
}

/* -------------------------------------------------------------------------- */
/* Feedback tokens: one per workspace. The token is the only credential the public intake accepts.           */
/* -------------------------------------------------------------------------- */

export function feedbackTokenOf(workspaceId: string): string | null {
  tables();
  const r = db().prepare("SELECT token FROM signal_tokens WHERE workspace_id = ?").get(workspaceId) as { token: string } | undefined;
  return r?.token ?? null;
}

/** The token that exists, or a new one. `rotate` replaces it, and the old one stops working at once. */
export function ensureFeedbackToken(workspaceId: string, rotate = false): string {
  tables();
  const existing = feedbackTokenOf(workspaceId);
  if (existing && !rotate) return existing;
  const token = crypto.randomBytes(24).toString("base64url");
  db().prepare("INSERT OR REPLACE INTO signal_tokens (workspace_id, token) VALUES (?, ?)").run(workspaceId, token);
  return token;
}

/** The workspace a feedback token belongs to, or null for an unknown token. */
export function workspaceOfFeedbackToken(token: string): string | null {
  tables();
  if (!token) return null;
  const r = db().prepare("SELECT workspace_id FROM signal_tokens WHERE token = ?").get(token) as { workspace_id: string } | undefined;
  return r?.workspace_id ?? null;
}
