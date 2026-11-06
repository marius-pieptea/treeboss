/**
 * The mobile pipeline's records: the builds and store submissions a workspace started, the poller that
 * follows in-flight builds with `eas build:view`, and the store listing read from store/metadata.json.
 *
 * The tables are created on first use of this module. The database holds what the CLI said, not the
 * artifacts: an artifact is the EAS URL, and the app binary stays with EAS.
 */
import fs from "fs";
import path from "path";
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { newId } from "../util";
import { resolveRoot } from "../workspaces";
import type { MobilePlatform } from "./detect";
import { easEnv, viewBuild, type EasBuild, type EasOptions } from "./eas";

export interface MobileBuild {
  id: string;
  workspaceId: string;
  platform: MobilePlatform;
  profile: string;
  easBuildId: string | null;
  /** EAS status, lower-cased (new, in_queue, in_progress, finished, errored, canceled). */
  status: string;
  artifactUrl: string | null;
  version: string | null;
  buildNumber: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MobileSubmission {
  id: string;
  workspaceId: string;
  platform: MobilePlatform;
  profile: string;
  buildId: string | null;
  status: "submitted" | "failed";
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

const IN_FLIGHT = ["new", "in_queue", "in_progress"];

const prepared = new WeakSet<Database>();
function tables(): Database {
  const conn = db();
  if (!prepared.has(conn)) {
    conn.exec(`CREATE TABLE IF NOT EXISTS mobile_builds (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, platform TEXT NOT NULL, profile TEXT NOT NULL,
      eas_build_id TEXT, status TEXT NOT NULL, artifact_url TEXT, version TEXT, build_number TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    conn.exec("CREATE INDEX IF NOT EXISTS mobile_builds_ws ON mobile_builds (workspace_id, created_at)");
    conn.exec(`CREATE TABLE IF NOT EXISTS mobile_submissions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, platform TEXT NOT NULL, profile TEXT NOT NULL,
      build_id TEXT, status TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    conn.exec("CREATE INDEX IF NOT EXISTS mobile_submissions_ws ON mobile_submissions (workspace_id, created_at)");
    prepared.add(conn);
  }
  return conn;
}

const toBuild = (r: any): MobileBuild => ({
  id: r.id,
  workspaceId: r.workspace_id,
  platform: r.platform,
  profile: r.profile,
  easBuildId: r.eas_build_id,
  status: r.status,
  artifactUrl: r.artifact_url,
  version: r.version,
  buildNumber: r.build_number,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSubmission = (r: any): MobileSubmission => ({
  id: r.id,
  workspaceId: r.workspace_id,
  platform: r.platform,
  profile: r.profile,
  buildId: r.build_id,
  status: r.status,
  detail: r.detail,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** One row per build the CLI queued. `requested` supplies the platform when EAS omits it. */
export function recordBuilds(workspaceId: string, requested: { platform: string; profile: string }, builds: EasBuild[]): MobileBuild[] {
  const conn = tables();
  const now = new Date().toISOString();
  const insert = conn.prepare("INSERT INTO mobile_builds (id, workspace_id, platform, profile, eas_build_id, status, artifact_url, version, build_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const ids: string[] = [];
  for (const b of builds) {
    const platform = b.platform ?? (requested.platform === "all" ? null : (requested.platform as MobilePlatform));
    if (!platform) continue;
    const id = newId("mb");
    insert.run(id, workspaceId, platform, b.profile ?? requested.profile, b.id, b.status, b.artifactUrl, b.version, b.buildNumber, now, now);
    ids.push(id);
  }
  return ids.map((id) => getBuild(id)!).filter(Boolean);
}

export function getBuild(id: string): MobileBuild | null {
  const r = tables().prepare("SELECT * FROM mobile_builds WHERE id = ?").get(id);
  return r ? toBuild(r) : null;
}

export function listBuilds(workspaceId: string, limit = 50): MobileBuild[] {
  return (tables().prepare("SELECT * FROM mobile_builds WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(workspaceId, limit) as any[]).map(toBuild);
}

export function inFlightBuilds(): MobileBuild[] {
  const marks = IN_FLIGHT.map(() => "?").join(", ");
  return (tables().prepare(`SELECT * FROM mobile_builds WHERE status IN (${marks}) AND eas_build_id IS NOT NULL ORDER BY created_at`).all(...IN_FLIGHT) as any[]).map(toBuild);
}

export function updateBuild(id: string, patch: { status: string; artifactUrl?: string | null; version?: string | null; buildNumber?: string | null }): void {
  tables()
    .prepare("UPDATE mobile_builds SET status = ?, artifact_url = COALESCE(?, artifact_url), version = COALESCE(?, version), build_number = COALESCE(?, build_number), updated_at = ? WHERE id = ?")
    .run(patch.status, patch.artifactUrl ?? null, patch.version ?? null, patch.buildNumber ?? null, new Date().toISOString(), id);
}

export function recordSubmission(workspaceId: string, input: { platform: MobilePlatform; profile: string; buildId: string | null; status: "submitted" | "failed"; detail: string | null }): MobileSubmission {
  const id = newId("ms");
  const now = new Date().toISOString();
  tables()
    .prepare("INSERT INTO mobile_submissions (id, workspace_id, platform, profile, build_id, status, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, workspaceId, input.platform, input.profile, input.buildId, input.status, input.detail, now, now);
  return toSubmission(tables().prepare("SELECT * FROM mobile_submissions WHERE id = ?").get(id));
}

export function listSubmissions(workspaceId: string, limit = 20): MobileSubmission[] {
  return (tables().prepare("SELECT * FROM mobile_submissions WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(workspaceId, limit) as any[]).map(toSubmission);
}

/**
 * One pass of the poller: asks EAS for every in-flight build (build:view) and stores what changed.
 * A workspace without EXPO_TOKEN is skipped, not an error: there is nothing to ask with. Returns how many
 * builds were refreshed.
 */
export async function refreshInFlightBuilds(opts: EasOptions = {}): Promise<number> {
  let refreshed = 0;
  for (const b of inFlightBuilds()) {
    if (!easEnv({ ...opts, workspaceId: b.workspaceId }).EXPO_TOKEN) continue;
    let dir: string;
    try {
      dir = resolveRoot(b.workspaceId).dir;
    } catch {
      continue; // the workspace or session is gone: its builds stay as they were
    }
    try {
      const view = await viewBuild(dir, b.easBuildId!, { ...opts, workspaceId: b.workspaceId });
      if (!view) continue;
      updateBuild(b.id, { status: view.status, artifactUrl: view.artifactUrl, version: view.version, buildNumber: view.buildNumber });
      refreshed++;
    } catch {
      // One failed poll (network, a build EAS no longer knows) must not stop the others.
    }
  }
  return refreshed;
}

/** Starts the poller. It runs one pass at a time and never throws. Returns the stop function. */
export function startMobilePoller(opts: EasOptions & { intervalMs?: number } = {}): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    refreshInFlightBuilds(opts)
      .catch(() => 0)
      .finally(() => (busy = false));
  }, opts.intervalMs ?? 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* -------------------------------------------------------------------------- */
/* The store listing                                                          */
/* -------------------------------------------------------------------------- */

export const METADATA_PATH = "store/metadata.json";

export interface StoreMetadata {
  /** App Store and Play name. At most 30 characters. */
  name: string;
  /** App Store subtitle. At most 30 characters. */
  subtitle: string;
  /** Comma-separated search keywords. At most 100 characters. */
  keywords: string;
  description: string;
  /** An https URL to the privacy policy. Both stores require one. */
  privacyUrl: string;
}

export interface MetadataIssue {
  field: string;
  problem: string;
}

export interface StoreCheck {
  path: string;
  present: boolean;
  metadata: StoreMetadata | null;
  issues: MetadataIssue[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The listing's rules, applied to parsed JSON. Returns every problem, not the first. */
export function checkStoreMetadata(value: unknown): { metadata: StoreMetadata | null; issues: MetadataIssue[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { metadata: null, issues: [{ field: "file", problem: "store/metadata.json must be a JSON object." }] };
  const v = value as Record<string, unknown>;
  const metadata: StoreMetadata = {
    name: str(v.name),
    subtitle: str(v.subtitle),
    keywords: str(v.keywords),
    description: str(v.description),
    privacyUrl: str(v.privacyUrl),
  };
  const issues: MetadataIssue[] = [];
  if (!metadata.name) issues.push({ field: "name", problem: "The name is missing." });
  else if (metadata.name.length > 30) issues.push({ field: "name", problem: `The name is ${metadata.name.length} characters; the limit is 30.` });
  if (!metadata.subtitle) issues.push({ field: "subtitle", problem: "The subtitle is missing." });
  else if (metadata.subtitle.length > 30) issues.push({ field: "subtitle", problem: `The subtitle is ${metadata.subtitle.length} characters; the limit is 30.` });
  if (!metadata.keywords) issues.push({ field: "keywords", problem: "The keywords are missing." });
  else if (metadata.keywords.length > 100) issues.push({ field: "keywords", problem: `The keywords are ${metadata.keywords.length} characters; the limit is 100.` });
  if (!metadata.description) issues.push({ field: "description", problem: "The description is missing." });
  if (!metadata.privacyUrl) issues.push({ field: "privacyUrl", problem: "The privacy policy URL is missing." });
  else {
    let ok = false;
    try {
      ok = new URL(metadata.privacyUrl).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) issues.push({ field: "privacyUrl", problem: "The privacy policy URL must be an absolute https:// address." });
  }
  return { metadata, issues };
}

/** Reads store/metadata.json under the project directory and checks it. A missing or unreadable file is an issue. */
export function readStoreMetadata(dir: string): StoreCheck {
  const file = path.join(dir, METADATA_PATH);
  if (!fs.existsSync(file)) {
    return { path: METADATA_PATH, present: false, metadata: null, issues: [{ field: "file", problem: "store/metadata.json is missing. It holds the store listing: name, subtitle, keywords, description and privacy URL." }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { path: METADATA_PATH, present: true, metadata: null, issues: [{ field: "file", problem: "store/metadata.json is not valid JSON." }] };
  }
  return { path: METADATA_PATH, present: true, ...checkStoreMetadata(value) };
}
