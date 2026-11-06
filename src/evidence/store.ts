/**
 * Evidence: what agents observed (a captured web page) and what they concluded from it (a note that cites
 * captures). Kept per project so a later session, or a different engine, starts from the proof instead of
 * from a re-crawl.
 *
 * One folder per item under `<trb home>/evidence/<id>/` holds the bulky parts as plain files; the `evidence`
 * table is only the index. It lives in the trb home, not in the checkout, on purpose: a capture of a
 * signed-in page can hold personal data, and nobody should commit that by accident. Items are append-only:
 * a recapture is a new item, so a citation never changes under whoever wrote it.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { db } from "../db";
import { paths } from "../paths";
import { getSetting } from "../settings";
import { newId, truncate, UserError } from "../util";

export type EvidenceKind = "page" | "note" | "bug";
/** A finding records one feature a product has, or one UI design it uses. */
export type FindingKind = "feature" | "ui";
export type FindingStatus = "new" | "planned" | "built" | "dismissed";
/** Where an item came from: the browser (a capture), REA or another tool's output, an agent's note, or the operator's. */
export type EvidenceSource = "browser" | "rea" | "agent" | "operator";

export const FINDING_KINDS: readonly FindingKind[] = ["feature", "ui"];
export const FINDING_STATUSES: readonly FindingStatus[] = ["new", "planned", "built", "dismissed"];
export const isFindingKind = (v: unknown): v is FindingKind => FINDING_KINDS.includes(v as FindingKind);
export const isFindingStatus = (v: unknown): v is FindingStatus => FINDING_STATUSES.includes(v as FindingStatus);

export interface EvidenceItem {
  id: string;
  workspace: string;
  session_id: string | null;
  kind: EvidenceKind;
  title: string;
  url: string | null;
  summary: string;
  /** Ids of the evidence this one cites. */
  refs: string[];
  /** Part name -> size in bytes. */
  files: Record<string, number>;
  bytes: number;
  sha: string | null;
  /** The investigation it was captured or saved in, or null. */
  investigation_id: string | null;
  /** Set on a note that records a feature or a UI design; null otherwise. */
  finding: FindingKind | null;
  finding_status: FindingStatus | null;
  source: EvidenceSource | null;
  created_at: string;
}

interface Row extends Omit<EvidenceItem, "refs" | "files"> {
  refs_json: string | null;
  files_json: string | null;
}

export const MAX_TITLE = 200;
export const MAX_SUMMARY = 2000;
export const MAX_NOTE_CHARS = 20_000;
export const MAX_REFS = 20;
/** Per workspace: past this, the oldest captures must be removed by hand. */
export const MAX_ITEMS = 500;

/** The setting that turns the evidence tools on for sessions. On by default; `trb config set evidence off` turns them off. */
export function evidenceEnabled(): boolean {
  return getSetting("evidence") === "on";
}

/** The workspace key of a directory: its real path, so a symlinked checkout and the real one share evidence. */
export function workspaceKey(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export const evidenceDir = (id: string): string => path.join(paths.evidence(), id);

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toItem(r: Row): EvidenceItem {
  const { refs_json, files_json, ...rest } = r;
  return { ...rest, refs: parse<string[]>(refs_json, []), files: parse<Record<string, number>>(files_json, {}) };
}

const COLS = "id, workspace, session_id, kind, title, url, summary, refs_json, files_json, bytes, sha, investigation_id, finding, finding_status, source, created_at";

export interface NewEvidence {
  workspace: string;
  sessionId?: string | null;
  kind: EvidenceKind;
  title: string;
  url?: string | null;
  summary?: string;
  refs?: string[];
  /** Part name (a plain file name) -> content. */
  files: Record<string, string | Buffer>;
  /** Must belong to the same project. */
  investigationId?: string | null;
  /** Only on a note. Its status starts as 'new'. */
  finding?: FindingKind | null;
  source?: EvidenceSource | null;
}

const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Add an item: the files first, then the row, so a row never points at nothing. */
export function addEvidence(input: NewEvidence): EvidenceItem {
  const workspace = workspaceKey(input.workspace);
  const title = truncate(input.title, MAX_TITLE) || "Untitled";
  const count = (db().prepare("SELECT COUNT(*) AS n FROM evidence WHERE workspace = ?").get(workspace) as { n: number }).n;
  if (count >= MAX_ITEMS) throw new UserError(`This project already holds ${MAX_ITEMS} pieces of evidence. Remove some (trb evidence rm <id>) before adding more.`);
  const refs = [...new Set((input.refs ?? []).map(String))].slice(0, MAX_REFS);
  for (const ref of refs) if (!getEvidence(ref, workspace)) throw new UserError(`Cannot cite "${ref}": no such evidence in this project.`);
  const investigationId = input.investigationId || null;
  if (investigationId && !db().prepare("SELECT 1 FROM investigations WHERE id = ? AND workspace = ?").get(investigationId, workspace)) throw new UserError(`No investigation "${investigationId}" in this project.`);
  if (input.finding && !isFindingKind(input.finding)) throw new UserError(`A finding is "feature" or "ui", not "${input.finding}".`);
  if (input.finding && input.kind !== "note") throw new UserError("Only a note can be a finding.");
  const finding = input.finding || null;

  const id = newId("e");
  const dir = evidenceDir(id);
  const hash = createHash("sha256");
  const files: Record<string, number> = {};
  let bytes = 0;
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const [name, content] of Object.entries(input.files)) {
      if (!PART.test(name)) throw new UserError(`Bad evidence part name "${name}".`);
      const buf = typeof content === "string" ? Buffer.from(content) : content;
      fs.writeFileSync(path.join(dir, name), buf);
      hash.update(name).update(buf);
      files[name] = buf.length;
      bytes += buf.length;
    }
    db()
      .prepare(`INSERT INTO evidence (id, workspace, session_id, kind, title, url, summary, refs_json, files_json, bytes, sha, investigation_id, finding, finding_status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, workspace, input.sessionId ?? null, input.kind, title, input.url ?? null, truncate(input.summary ?? "", MAX_SUMMARY), JSON.stringify(refs), JSON.stringify(files), bytes, hash.digest("hex"), investigationId, finding, finding ? "new" : null, input.source ?? null);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return getEvidence(id)!;
}

/** An item, or null. With `workspace`, only if it belongs to that project: an id from elsewhere is treated as missing. */
export function getEvidence(id: string, workspace?: string): EvidenceItem | null {
  const row = db().prepare(`SELECT ${COLS} FROM evidence WHERE id = ?`).get(id) as Row | undefined;
  if (!row) return null;
  if (workspace !== undefined && row.workspace !== workspaceKey(workspace)) return null;
  return toItem(row);
}

export interface ListOpts {
  query?: string | null;
  kind?: EvidenceKind | null;
  investigationId?: string | null;
  /** 'any': findings of either kind. */
  finding?: FindingKind | "any" | null;
  findingStatus?: FindingStatus | null;
  limit?: number;
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Newest first. `query` matches the title, url and summary (every word must appear). */
export function listEvidence(workspace: string, o: ListOpts = {}): EvidenceItem[] {
  const where = ["workspace = ?"];
  const args: Array<string | number> = [workspaceKey(workspace)];
  if (o.kind) {
    where.push("kind = ?");
    args.push(o.kind);
  }
  if (o.investigationId) {
    where.push("investigation_id = ?");
    args.push(o.investigationId);
  }
  if (o.finding === "any") where.push("finding IS NOT NULL");
  else if (o.finding) {
    where.push("finding = ?");
    args.push(o.finding);
  }
  if (o.findingStatus) {
    where.push("finding_status = ?");
    args.push(o.findingStatus);
  }
  for (const word of String(o.query ?? "").split(/\s+/).filter(Boolean).slice(0, 8)) {
    where.push("(title LIKE ? ESCAPE '\\' OR COALESCE(url, '') LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    const like = `%${likeEscape(word)}%`;
    args.push(like, like, like);
  }
  args.push(Math.min(Math.max(Math.floor(o.limit ?? 50), 1), 200));
  return (db().prepare(`SELECT ${COLS} FROM evidence WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args) as Row[]).map(toItem);
}

export function countEvidence(workspace: string): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM evidence WHERE workspace = ?").get(workspaceKey(workspace)) as { n: number }).n;
}

/** Everything held, across projects (the doctor's count). */
export function totalEvidence(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n;
}

/** One part's bytes, bounded. Null when the item has no such part (or its file is gone). */
export function readPart(item: EvidenceItem, part: string, maxBytes = 2_000_000): { buf: Buffer; truncated: boolean; size: number } | null {
  if (!(part in item.files) || !PART.test(part)) return null;
  const file = path.join(evidenceDir(item.id), part);
  try {
    const size = fs.statSync(file).size;
    if (size <= maxBytes) return { buf: fs.readFileSync(file), truncated: false, size };
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, 0);
      return { buf, truncated: true, size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function removeEvidence(id: string, workspace: string): boolean {
  if (!getEvidence(id, workspace)) return false;
  db().prepare("DELETE FROM evidence WHERE id = ?").run(id);
  fs.rmSync(evidenceDir(id), { recursive: true, force: true });
  return true;
}

/** Drop everything held for a workspace (the project was removed from trb), its investigations included. */
export function removeAllEvidence(workspace: string): number {
  const key = workspaceKey(workspace);
  const ids = (db().prepare("SELECT id FROM evidence WHERE workspace = ?").all(key) as Array<{ id: string }>).map((r) => r.id);
  db().prepare("DELETE FROM evidence WHERE workspace = ?").run(key);
  db().prepare("DELETE FROM investigations WHERE workspace = ?").run(key);
  for (const id of ids) fs.rmSync(evidenceDir(id), { recursive: true, force: true });
  return ids.length;
}

/** The line a session is told when it starts: how much is on file and what the newest items are. Null when there is none. */
export function evidenceHintLine(workspace: string): string | null {
  if (!workspace) return null;
  const total = countEvidence(workspace);
  if (!total) return null;
  const recent = listEvidence(workspace, { limit: 5 }).map((e) => `${e.id} "${truncate(e.title, 60)}"`);
  return `This project already holds ${total} piece${total === 1 ? "" : "s"} of evidence (newest: ${recent.join(", ")}). Check evidence_list before capturing a page again.`;
}

/** What a session is told about the evidence tools, once per conversation, plus what the project already holds. */
export function evidenceHint(workspace: string): string {
  const base =
    "Evidence tools are available: evidence_capture_page saves the page open in the browser (HTML, styles, assets, requests, screenshot) as evidence you can cite, evidence_note saves a conclusion with the captures it rests on, and evidence_list / evidence_read bring earlier evidence back. Capture only what the task needs. When you study or rebuild a UI, work from captured styles, not memory. When you reverse engineer something, start an investigation, save what you find (captures, REA results) into it, and record each feature or UI design as a finding.";
  return [base, evidenceHintLine(workspace)].filter(Boolean).join(" ");
}

/** An item as a Markdown page, for the docs folder: what it is, where it came from, and the findings it holds. */
export function evidenceMarkdown(item: EvidenceItem, workspace: string): string {
  const note = item.kind === "note" ? readPart(item, "note.md", 200_000)?.buf.toString("utf-8") ?? "" : "";
  const cited = item.refs.map((r) => getEvidence(r, workspace)).filter((e): e is EvidenceItem => Boolean(e));
  const lines = [`# ${item.title}`, "", `- Evidence: \`${item.id}\` (${item.kind})`, `- Captured: ${item.created_at}`];
  if (item.url) lines.push(`- Source: ${item.url}`);
  if (item.sha) lines.push(`- Fingerprint: \`${item.sha.slice(0, 16)}\``);
  if (item.summary) lines.push("", item.summary);
  if (note) lines.push("", note.trim());
  if (cited.length) lines.push("", "## Cites", "", ...cited.map((e) => `- \`${e.id}\` ${e.title}${e.url ? ` (${e.url})` : ""}`));
  return lines.join("\n") + "\n";
}
