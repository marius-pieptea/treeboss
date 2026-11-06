/**
 * "Save as doc" under an ask answer: turn the question and its answer into a managed docs page.
 * The page is written only when the operator clicks, with a path they can edit first. Front matter is
 * generated here (title from the question, `covers` from the files the answer cites, HEAD as the commit),
 * so the page starts out with a freshness the Docs view can track.
 */
import fs from "fs";
import { db } from "../db";
import { workspaceIdFor } from "../codegraph/prefs";
import { safeJoin } from "../workspaces";
import { setKey, setGenerated } from "../docs/frontmatter";
import { headSha } from "../docs/staleness";
import { createPage, docsDirOf } from "../docs/store";
import { slugify } from "../docs/templates";
import { UserError } from "../util";
import { getSession, SessionError } from "./manager";
import { questionOf } from "./ask";

export interface AskDocPreview {
  turnId: string;
  path: string;
  title: string;
  question: string;
  covers: string[];
  content: string;
}

interface TurnRow {
  id: string;
  prompt: string;
  output: string | null;
  mode: string | null;
}

function pickTurn(sessionId: string, turnId?: string | null): TurnRow {
  const rows = db()
    .prepare("SELECT id, prompt, output, mode FROM turns WHERE session_id = ? AND status = 'completed' ORDER BY seq DESC")
    .all(sessionId) as TurnRow[];
  const row = turnId ? rows.find((r) => r.id === turnId) : rows.find((r) => r.mode === "ask" && r.output);
  if (!row) throw new SessionError(turnId ? `Turn ${turnId} has no finished answer.` : "There is no finished ask answer to save yet.");
  if (!row.output?.trim()) throw new SessionError("That turn has no answer text to save.");
  return row;
}

const CITED = /(?:^|[\s`'"(\[])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8})(?::\d+(?:-\d+)?)?(?=$|[\s`'")\],.;:!?])/gm;

/** Files an answer cites (`src/a.ts:12`) that exist in the project. At most 12, in order of first mention. */
export function citedFiles(output: string, rootDir: string): string[] {
  const out: string[] = [];
  for (const m of output.matchAll(CITED)) {
    const rel = m[1].replace(/^\.\//, "");
    if (rel.startsWith("../") || out.includes(rel)) continue;
    try {
      if (fs.statSync(safeJoin(rootDir, rel)).isFile()) out.push(rel);
    } catch {}
    if (out.length >= 12) break;
  }
  return out;
}

const titleOf = (question: string): string => {
  const one = question.split("\n")[0].replace(/\s+/g, " ").trim().replace(/[?？]+$/, "");
  const t = one.length > 80 ? one.slice(0, 79).trimEnd() + "…" : one;
  return t ? t[0].toUpperCase() + t.slice(1) : "Answer";
};

export async function previewAskDoc(sessionId: string, turnId?: string | null): Promise<AskDocPreview> {
  const s = getSession(sessionId);
  if (!s) throw new SessionError(`No session "${sessionId}".`);
  const turn = pickTurn(sessionId, turnId);
  const question = questionOf(turn.prompt);
  const rootDir = s.base_cwd;
  const title = titleOf(question);
  const covers = citedFiles(turn.output!, rootDir);
  const { dir } = docsDirOf(workspaceIdFor(s.base_cwd));
  const quoted = question.split("\n").map((l) => `> ${l}`).join("\n");
  let content = `# ${title}\n\n${quoted}\n\n${turn.output!.trim()}\n`;
  content = setKey(content, "title", title);
  content = setKey(content, "covers", covers);
  content = setGenerated(content, { commit: await headSha(rootDir), by: `${s.engine}/${s.model ?? "default"} (ask)` });
  content = setKey(content, "status", "draft");
  return { turnId: turn.id, path: `${dir}/${slugify(title) || "answer"}.md`, title, question, covers, content };
}

export async function saveAskDoc(sessionId: string, opts: { turnId?: string | null; path?: string | null; title?: string | null }): Promise<{ path: string; title: string }> {
  const s = getSession(sessionId)!;
  const preview = await previewAskDoc(sessionId, opts.turnId);
  const { dir } = docsDirOf(workspaceIdFor(s.base_cwd));
  const given = (opts.path ?? "").trim();
  if (opts.path !== undefined && opts.path !== null && !given) throw new UserError("Give the page a path.");
  return createPage(s.base_cwd, dir, { path: given || preview.path, title: opts.title?.trim() || preview.title, content: preview.content });
}
