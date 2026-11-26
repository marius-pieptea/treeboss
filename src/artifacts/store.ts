import fs from "fs";
import path from "path";
import { db } from "../db";
import { home } from "../paths";
import { UserError } from "../util";
import { ARTIFACT_ID_RE, intentFromPath, parseArtifactUrl } from "./capture";
import type { Artifact, ArtifactError, ArtifactIntent, ArtifactOwner } from "./types";

interface ArtifactRow {
  id: string;
  url: string;
  title: string;
  intent: ArtifactIntent;
  owner: ArtifactOwner;
  source: "created" | "pasted";
  session_id: string | null;
  session_title: string | null;
  created_at: number;
  updated_at: number | null;
  last_read_at: number | null;
  html_path: string | null;
  summary: string | null;
  error: ArtifactError | null;
  error_text: string | null;
  removed_at: number | null;
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    intent: row.intent,
    owner: row.owner,
    source: row.source,
    sessionId: row.session_id,
    sessionTitle: row.session_title ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastReadAt: row.last_read_at,
    htmlPath: row.html_path,
    summary: row.summary,
    error: row.error,
    errorText: row.error_text,
  };
}

const SELECT_WITH_SESSION = `
  SELECT a.*, s.title AS session_title
  FROM artifacts a
  LEFT JOIN sessions s ON s.id = a.session_id
`;

function getArtifactAny(id: string): Artifact | null {
  const row = db()
    .prepare(`${SELECT_WITH_SESSION} WHERE a.id = ?`)
    .get(id) as ArtifactRow | undefined;
  return row ? toArtifact(row) : null;
}

/** Record or update an artifact published by a Claude session. */
export function recordPublished(input: {
  url: string;
  title: string;
  filePath: string;
  sessionId?: string | null;
}): Artifact {
  const parsed = parseArtifactUrl(input.url);
  if (!parsed) throw new UserError(`Invalid artifact URL: ${input.url}`);
  const { id, url } = parsed;
  const now = Date.now();
  const title = (input.title || "").trim() || "Untitled artifact";
  const intent = intentFromPath(input.filePath || "", title);
  const sessionId = input.sessionId ?? null;

  db()
    .prepare(
      `INSERT INTO artifacts (id, url, title, intent, owner, source, session_id, created_at)
       VALUES (?, ?, ?, ?, 'mine', 'created', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         intent = excluded.intent,
         owner = 'mine',
         session_id = COALESCE(excluded.session_id, artifacts.session_id),
         updated_at = excluded.created_at,
         last_read_at = NULL,
         html_path = NULL,
         summary = NULL,
         error = NULL,
         error_text = NULL`,
    )
    .run(id, url, title, intent, sessionId, now);

  return getArtifactAny(id)!;
}

/** Add a pasted claude.ai artifact link, restoring it if it was soft-removed. */
export function addPasted(url: string): Artifact {
  const parsed = parseArtifactUrl(url);
  if (!parsed) throw new UserError("Paste a link that starts with claude.ai/artifact/.");
  const { id, url: canonicalUrl } = parsed;

  const existing = db().prepare("SELECT id, removed_at FROM artifacts WHERE id = ?").get(id) as
    | { id: string; removed_at: number | null }
    | undefined;
  if (existing) {
    if (existing.removed_at !== null) {
      db().prepare("UPDATE artifacts SET removed_at = NULL WHERE id = ?").run(id);
    }
    return getArtifact(id)!;
  }

  db()
    .prepare(
      `INSERT INTO artifacts (id, url, title, intent, owner, source, created_at)
       VALUES (?, ?, ?, 'other', 'unknown', 'pasted', ?)`,
    )
    .run(id, canonicalUrl, "Untitled artifact", Date.now());

  return getArtifact(id)!;
}

/** List all non-removed artifacts, newest createdAt first. */
export function listArtifacts(): Artifact[] {
  const rows = db()
    .prepare(`${SELECT_WITH_SESSION} WHERE a.removed_at IS NULL ORDER BY a.created_at DESC, a.rowid DESC`)
    .all() as ArtifactRow[];
  return rows.map(toArtifact);
}

/** Fetch one non-removed artifact by id, or null if missing/removed. */
export function getArtifact(id: string): Artifact | null {
  const row = db()
    .prepare(`${SELECT_WITH_SESSION} WHERE a.id = ? AND a.removed_at IS NULL`)
    .get(id) as ArtifactRow | undefined;
  return row ? toArtifact(row) : null;
}

/** Soft-remove an artifact so Undo can restore it before purging. */
export function markRemoved(id: string): boolean {
  const res = db()
    .prepare("UPDATE artifacts SET removed_at = ? WHERE id = ? AND removed_at IS NULL")
    .run(Date.now(), id);
  return res.changes > 0;
}

/** Restore a soft-removed artifact and return it, or null if not found. */
export function restore(id: string): Artifact | null {
  db().prepare("UPDATE artifacts SET removed_at = NULL WHERE id = ?").run(id);
  return getArtifact(id);
}

/** Permanently delete rows soft-removed at least `olderThanMs` ago and remove their local directories. */
export function purgeRemoved(olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  const rows = db()
    .prepare("SELECT id FROM artifacts WHERE removed_at IS NOT NULL AND removed_at <= ?")
    .all(cutoff) as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  const res = db()
    .prepare("DELETE FROM artifacts WHERE removed_at IS NOT NULL AND removed_at <= ?")
    .run(cutoff);
  for (const { id } of rows) {
    if (!ARTIFACT_ID_RE.test(id)) continue;
    fs.rmSync(path.join(home(), "artifacts", id), { recursive: true, force: true });
  }
  return res.changes;
}

/** Record the result of reading an artifact from claude.ai and clear any prior error. */
export function saveRead(
  id: string,
  data: { htmlPath?: string; summary?: string; owner?: ArtifactOwner; title?: string },
): Artifact | null {
  const sets = ["last_read_at = ?", "error = NULL", "error_text = NULL"];
  const params: Array<string | number | null> = [Date.now()];
  if (data.htmlPath !== undefined) {
    sets.push("html_path = ?");
    params.push(data.htmlPath);
  }
  if (data.summary !== undefined) {
    sets.push("summary = ?");
    params.push(data.summary);
  }
  if (data.owner !== undefined) {
    sets.push("owner = ?");
    params.push(data.owner);
  }
  if (data.title !== undefined) {
    sets.push("title = ?");
    params.push(data.title);
  }
  params.push(id);
  db()
    .prepare(`UPDATE artifacts SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
  return getArtifact(id);
}

/** Record an error from reading an artifact. */
export function saveError(id: string, error: ArtifactError, errorText: string): Artifact | null {
  db()
    .prepare("UPDATE artifacts SET error = ?, error_text = ? WHERE id = ?")
    .run(error, errorText, id);
  return getArtifact(id);
}
