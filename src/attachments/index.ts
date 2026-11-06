/**
 * What a session has attached, as one thing: specs, plans and documentation pages.
 *
 * Specs and plans live in `session_specs` (a plan is just a file under the plans folder, which the specs
 * module already knows how to point at), documentation pages in `session_docs`. Those two modules keep
 * their own rules (what a path may be, how a page is judged stale). This one sits on top: it decides which
 * of them a path belongs to, lists everything together, builds the single block a turn receives, and costs
 * it. Nothing else should need to know there are two tables.
 */
import fs from "fs";
import path from "path";
import { getSession, type SessionRecord } from "../sessions/manager";
import { plansDirOf } from "../sessions/plansdir";
import { UserError } from "../util";
import * as docs from "../docs/attach";
import * as specs from "../specs/attach";

export type AttachKind = "spec" | "plan" | "doc";
export type AttachMode = "ref" | "inline";

export interface Attachment {
  path: string;
  kind: AttachKind;
  mode: AttachMode;
  purpose: string;
  delivered: boolean;
}

/** Which kind a workspace path is, by where it lives. Docs are everything else a session may point at. */
export function kindOf(s: Pick<SessionRecord, "base_cwd">, rel: string): AttachKind {
  const p = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const plans = plansDirOf(s.base_cwd);
  if (p === plans || p.startsWith(`${plans}/`)) return "plan";
  if (p === "specs" || p.startsWith("specs/") || p === ".specify" || p.startsWith(".specify/")) return "spec";
  return "doc";
}

const asMode = (m: unknown): AttachMode => (m === "inline" ? "inline" : "ref");

function session(sessionId: string): SessionRecord {
  const s = getSession(sessionId);
  if (!s) throw new UserError(`No session "${sessionId}".`);
  return s;
}

export function listAll(sessionId: string): Attachment[] {
  const s = getSession(sessionId);
  if (!s) return [];
  const out: Attachment[] = [];
  for (const a of specs.listAttached(sessionId)) {
    if (a.purpose === "architecture") continue; // that discussion belongs to its session
    out.push({ path: a.spec_path, kind: kindOf(s, a.spec_path) === "plan" ? "plan" : "spec", mode: a.mode, purpose: a.purpose, delivered: a.delivered });
  }
  for (const a of docs.listAttached(sessionId)) if (a.purpose === "context") out.push({ path: a.doc_path, kind: "doc", mode: a.mode, purpose: a.purpose, delivered: a.delivered });
  return out;
}

export function attachAny(sessionId: string, rel: string, opts: { mode?: AttachMode | string | null; delivered?: boolean } = {}): Attachment {
  const s = session(sessionId);
  const mode = asMode(opts.mode);
  const kind = kindOf(s, rel);
  if (kind === "doc") docs.attach(sessionId, rel, { mode, delivered: opts.delivered });
  else specs.attach(sessionId, rel, { mode, purpose: "context", delivered: opts.delivered });
  const p = String(rel).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return listAll(sessionId).find((a) => a.path === p) ?? { path: p, kind, mode, purpose: "context", delivered: !!opts.delivered };
}

export function detachAny(sessionId: string, rel: string): boolean {
  const a = specs.detach(sessionId, rel);
  const b = docs.detach(sessionId, rel);
  return a || b;
}

/** A handoff carries the attachments over; `delivered`: the new session was already told about them. */
export function copyAll(fromId: string, toId: string, delivered = true): number {
  return docs.copyAttachments(fromId, toId, delivered) + specs.copyAttachments(fromId, toId, delivered);
}

export function markDelivered(sessionId: string): void {
  specs.markDelivered(sessionId);
  docs.markDelivered(sessionId);
}

/**
 * The one block a turn receives for everything attached and not yet delivered (or all of it with `all`),
 * or null when there is nothing to say. Pointers first, grouped by kind; pasted files after.
 */
export async function attachmentsBlock(sessionId: string, opts: { all?: boolean } = {}): Promise<string | null> {
  const s = getSession(sessionId);
  if (!s) return null;
  const sp = specs.specsItems(sessionId, opts);
  const dc = await docs.docsItems(sessionId, opts);
  if (!sp.length && !dc.length) return null;
  const group = (label: string, texts: string[]) => (texts.length ? [`${label}:`, ...texts, ""] : []);
  const refs = [
    ...group("Specifications", sp.filter((i) => i.kind === "spec" && i.mode !== "inline").map((i) => i.text)),
    ...group("Plans", sp.filter((i) => i.kind === "plan" && i.mode !== "inline").map((i) => i.text)),
    ...group("Documentation", dc.filter((i) => i.mode !== "inline").map((i) => i.text)),
  ];
  const inline = [...sp.filter((i) => i.mode === "inline"), ...dc.filter((i) => i.mode === "inline")].map((i) => i.text);
  const parts = ["# Attached project files", ""];
  const what = [sp.some((i) => i.kind === "spec") && "specifications", sp.some((i) => i.kind === "plan") && "plans", dc.length > 0 && "documentation pages"].filter(Boolean).join(", ");
  parts.push(`These ${what} are attached to this session. Specifications and approved plans are the source of truth for what to build: follow them, and if the code or the request contradicts them, say so instead of picking silently. Documentation describes the project and is a starting point: where a page is marked stale or drifting, or the code contradicts it, believe the code and say so.`);
  if (refs.length) parts.push("", "Read the ones you need with your file tools, they are not pasted here:", "", ...refs.slice(0, -1));
  if (inline.length) parts.push("", "Pasted in full:", "", ...inline);
  return parts.join("\n");
}

/** One line per kind for a handoff summary. */
export function attachedLines(sessionId: string): string[] {
  const items = listAll(sessionId);
  const list = (kind: AttachKind) => items.filter((a) => a.kind === kind).map((a) => `\`${a.path}\``).join(", ");
  const out: string[] = [];
  if (items.some((a) => a.kind === "spec")) out.push(`Attached specifications (read them from the repository): ${list("spec")}.`);
  if (items.some((a) => a.kind === "plan")) out.push(`Attached plans (read them from the repository): ${list("plan")}.`);
  if (items.some((a) => a.kind === "doc")) out.push(`Attached documentation (read the pages from the repository): ${list("doc")}.`);
  return out;
}

export async function estimatePathAny(s: Pick<SessionRecord, "base_cwd"> & { id?: string }, rel: string, mode: AttachMode, docsDir: string): Promise<{ tokens: number; truncated: boolean; kind: AttachKind }> {
  const kind = kindOf(s, rel);
  if (kind === "doc") return { ...(await docs.estimatePath(s.base_cwd, rel, mode, docsDir)), kind };
  return { ...specs.estimatePath(s.base_cwd, rel, mode), kind };
}

export async function estimateSessionAny(sessionId: string): Promise<{ tokens: number; items: Array<{ path: string; kind: AttachKind; mode: AttachMode; tokens: number }> }> {
  const s = getSession(sessionId);
  const items: Array<{ path: string; kind: AttachKind; mode: AttachMode; tokens: number }> = [];
  if (s) {
    const docsDir = docs.docsDirForSession(s);
    for (const a of listAll(sessionId)) {
      try {
        items.push({ path: a.path, kind: a.kind, mode: a.mode, tokens: (await estimatePathAny(s, a.path, a.mode, docsDir)).tokens });
      } catch {
        items.push({ path: a.path, kind: a.kind, mode: a.mode, tokens: 0 });
      }
    }
  }
  return { tokens: items.reduce((n, i) => n + i.tokens, 0), items };
}

/** A plan file's title and status, read from its front matter (the first lines of the file). */
export function planSummary(rootDir: string, rel: string): { title: string; status: string | null } {
  let head = "";
  try {
    head = fs.readFileSync(path.join(rootDir, rel), "utf-8").slice(0, 1500);
  } catch {}
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? "";
  const val = (k: string) => new RegExp(`^${k}:\\s*"?(.+?)"?\\s*$`, "m").exec(fm)?.[1] ?? null;
  return { title: val("title") ?? /^#\s+(.+)$/m.exec(head)?.[1] ?? path.basename(rel, ".md"), status: val("status") };
}
