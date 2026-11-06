/**
 * Handoff: carry a long session's state into a fresh one as a summary, so the new session starts with a
 * clean context window instead of the old one's history.
 *
 * Two ways to get the summary:
 *  - the model: the old session is resumed for one short turn with a fixed prompt, in its own cwd. That turn
 *    is not recorded as a session turn (the transcript the operator reads stays theirs), though the engine
 *    does keep it in its own history.
 *  - the transcript: when the session is busy, closed, never ran, or the model turn fails, a deterministic
 *    summary is built from what trb already stores: the first ask, the follow-ups, the last answers and the
 *    files that changed.
 */
import { approvedPlanText } from "./planq";
import { db } from "../db";
import { git } from "../git/worktree";
import { getEngine } from "../engines/registry";
import { clean, newId, UserError } from "../util";
import { createLead, currentTurnRunner, getSession, isTurnLive, SessionError, type SessionRecord } from "./manager";
import { attachedLines, copyAll } from "../attachments";
import { evidenceEnabled, evidenceHintLine } from "../evidence/store";

export interface HandoffSummary {
  summary: string;
  /** model: the engine wrote it. transcript: built from the stored log. */
  method: "model" | "transcript";
  /** Why the model path was skipped, when it was. */
  note?: string;
}

export const SUMMARY_PROMPT = `Write a handoff summary of this conversation for a fresh session that will continue the work without seeing it.
Do not use any tools and do not change any files. Answer in plain markdown, under 600 words, with exactly these sections:

## Goal
## Decisions
## Files touched
## Current state
## Open tasks
## Gotchas

Be concrete: real paths, commands, names, and numbers. Say what is done, what is half done, and what you would do next. Leave out pleasantries and anything the code already shows.`;

const MAX_SUMMARY_CHARS = 8000;
const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text);

interface TurnRow {
  seq: number;
  prompt: string;
  output: string | null;
  status: string;
}

function turnsOf(id: string): TurnRow[] {
  return db().prepare("SELECT seq, prompt, output, status FROM turns WHERE session_id = ? ORDER BY seq").all(id) as TurnRow[];
}

/** Files the session changed, from git: its branch against the base for a worktree, else the working tree. */
function changedFiles(s: SessionRecord): string {
  try {
    if (s.isolation === "worktree" && s.worktree_git_root && s.base_sha) {
      const tip = s.branch ? git(["rev-parse", s.branch], s.worktree_git_root).stdout.trim() : s.head_sha;
      if (tip && tip !== s.base_sha) return git(["diff", "--stat", s.base_sha, tip], s.worktree_git_root).stdout.trim();
    }
    if (git(["rev-parse", "--is-inside-work-tree"], s.cwd).ok) {
      const stat = git(["diff", "--stat", "HEAD"], s.cwd).stdout.trim();
      const untracked = git(["ls-files", "--others", "--exclude-standard"], s.cwd).stdout.trim().split("\n").filter(Boolean).slice(0, 20);
      return [stat, untracked.length ? `untracked:\n${untracked.map((f) => `  ${f}`).join("\n")}` : ""].filter(Boolean).join("\n");
    }
  } catch {}
  return "";
}

/** A summary built only from what trb stores. Always available, never as good as the model's own. */
export function transcriptSummary(s: SessionRecord): string {
  const turns = turnsOf(s.id);
  const parts: string[] = [];
  parts.push(`## Goal\n${cut((turns[0]?.prompt ?? s.brief ?? s.title).trim(), 2500)}`);
  const followUps = turns.slice(1).filter((t) => t.prompt.trim());
  if (followUps.length) {
    parts.push(`## Later requests\n${followUps.slice(-8).map((t) => `- (turn ${t.seq}) ${cut(t.prompt.replace(/\s+/g, " ").trim(), 220)}`).join("\n")}`);
  }
  const files = changedFiles(s);
  parts.push(`## Files touched\n${files ? "```\n" + cut(files, 1800) + "\n```" : "No uncommitted or branch changes found."}`);
  if (s.isolation === "worktree" && s.branch) parts.push(`Unmerged work lives on branch \`${s.branch}\`${s.worktree_root ? ` (worktree ${s.worktree_root})` : ""}.`);
  const answered = turns.filter((t) => t.output?.trim());
  const last = answered.slice(-2);
  parts.push(
    `## Current state\n${
      last.length
        ? last.map((t) => `Turn ${t.seq} ended ${t.status}:\n${cut(t.output!.trim(), 1800)}`).join("\n\n")
        : "No answer was recorded yet."
    }`,
  );
  if (s.last_error && s.status === "failed") parts.push(`## Gotchas\nThe last turn failed: ${cut(s.last_error, 600)}`);
  return cut(parts.join("\n\n"), MAX_SUMMARY_CHARS);
}

/** Ask the session itself, in a one-off resumed turn that leaves its recorded transcript alone. */
async function modelSummary(s: SessionRecord): Promise<string> {
  const def = getEngine(s.engine);
  if (!def?.resume || !s.cli_session_id) throw new UserError("this engine session cannot be resumed");
  const result = await currentTurnRunner()({
    engine: s.engine,
    key: `${s.id}-handoff-${Date.now().toString(36)}`,
    prompt: SUMMARY_PROMPT,
    cwd: s.cwd,
    model: s.model,
    effort: "low",
    resumeId: s.cli_session_id,
    mcp: {},
    maxTurns: s.engine === "claude" ? 3 : 0,
    strictMcp: true,
    timeoutSec: 180,
    idleMs: 120_000,
    ceilingMs: 180_000,
  });
  const text = (result.output || "").trim();
  if (!result.success || result.resumeRejected || text.length < 80) throw new UserError(result.resumeRejected ? "the engine no longer has this conversation" : "the model returned no usable summary");
  return cut(text, MAX_SUMMARY_CHARS);
}

/** The summary a handoff would carry. `useModel: false` skips the model and reads the transcript. */
export async function summarize(id: string, opts: { useModel?: boolean } = {}): Promise<HandoffSummary> {
  const s = getSession(id);
  if (!s) throw new SessionError(`No session "${id}".`);
  if (opts.useModel !== false) {
    if (isTurnLive(id)) {
      return { summary: transcriptSummary(s), method: "transcript", note: "The session is still working, so the summary comes from its log." };
    }
    if (s.status === "closed" || !s.cli_session_id) {
      return { summary: transcriptSummary(s), method: "transcript", note: s.status === "closed" ? "The session is closed." : "The session has no engine conversation to ask." };
    }
    try {
      return { summary: await modelSummary(s), method: "model" };
    } catch (err: any) {
      return { summary: transcriptSummary(s), method: "transcript", note: `The model could not summarize (${err?.message ?? err}); built from the log.` };
    }
  }
  return { summary: transcriptSummary(s), method: "transcript" };
}

/** The first prompt of the continuing session: the summary, framed so the agent treats it as a briefing. */
export function continuationPrompt(from: SessionRecord, summary: string, instructions?: string | null): string {
  const next = clean(instructions) ?? "Pick up where the previous session stopped: start with its open tasks.";
  return [
    `You are continuing work from an earlier session ("${from.title}", ${from.id}). Its conversation is not available to you. The summary below replaces it.`,
    "Treat it as a briefing, not ground truth: check the claims that matter against the repository before building on them.",
    "",
    "<handoff_summary>",
    summary.trim(),
    "</handoff_summary>",
    ...(approvedPlanText(from.id) ? ["", "<approved_plan>", approvedPlanText(from.id)!, "</approved_plan>"] : []),
    ...attachedLines(from.id).flatMap((l) => ["", l]),
    ...((evidenceEnabled() ? evidenceHintLine(from.base_cwd) : null) ? ["", evidenceHintLine(from.base_cwd)!] : []),
    "",
    "<next>",
    next,
    "</next>",
  ].join("\n");
}

export interface HandoffInput {
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  agent?: string | null;
  pairId?: string | null;
  instructions?: string | null;
  /** An edited summary from the preview. Absent: one is produced now. */
  summary?: string | null;
  /** false: build the summary from the log instead of asking the model. */
  useModel?: boolean;
}

export interface HandoffResult {
  session: SessionRecord;
  summary: string;
  method: "model" | "transcript" | "edited";
  handoffId: string;
}

export async function handoff(id: string, input: HandoffInput = {}): Promise<HandoffResult> {
  const from = getSession(id);
  if (!from) throw new SessionError(`No session "${id}".`);
  if (from.depth > 0) throw new SessionError("Only a lead session can be handed off. Open the handoff from the session that holds the conversation.");

  const given = clean(input.summary);
  const made = given ? null : await summarize(id, { useModel: input.useModel });
  const summary = (given ?? made!.summary).slice(0, MAX_SUMMARY_CHARS * 2);
  const method = given ? "edited" : made!.method;

  // Same place the old one worked. Engine and model default to the old session's own, or to its pair when it led one.
  const override = clean(input.engine);
  const switched = Boolean(override && override !== from.engine);
  const pairId = clean(input.pairId) ?? (override ? null : from.pair_id);
  const inherit = !pairId && !switched;
  const session = createLead({
    prompt: continuationPrompt(from, summary, input.instructions),
    title: `Continue: ${from.title}`.slice(0, 100),
    engine: pairId && !override ? null : (override ?? from.engine),
    model: clean(input.model) ?? (inherit ? from.model : null),
    effort: clean(input.effort) ?? (inherit ? from.effort : null),
    pairId,
    agent: clean(input.agent) ?? from.agent,
    cwd: from.base_cwd,
    subagents: Boolean(from.subagents),
  });
  // Straight after createLead, before its first turn has produced anything: the row exists, the turn runs async.
  db().prepare("UPDATE sessions SET handoff_from = ? WHERE id = ?").run(from.id, session.id);
  copyAll(from.id, session.id); // already named in the prompt above: delivered, but kept for the next turns' bookkeeping
  const handoffId = newId("h");
  db().prepare("INSERT INTO handoffs (id, from_session, to_session, summary, method) VALUES (?, ?, ?, ?, ?)").run(handoffId, from.id, session.id, summary, method);
  return { session: getSession(session.id)!, summary, method, handoffId };
}

/** What a session was told when it was started from a handoff, for its header and for audit. */
export function handoffInto(id: string): { id: string; from_session: string; summary: string; method: string; created_at: string } | null {
  return (db().prepare("SELECT id, from_session, summary, method, created_at FROM handoffs WHERE to_session = ? ORDER BY created_at DESC LIMIT 1").get(id) as any) ?? null;
}
