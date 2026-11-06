/**
 * Verify-before-done: after a turn ends the daemon runs the project's checks. A failure goes back to the agent
 * as the next turn, at most `max_retries` times in a row; the session counts as done only when they pass.
 *
 * Order at the end of a turn (see sessions/manager.ts): specs ticks, docs, THIS, then the goal. When this sends a
 * fix turn it reports `continued: true` and the goal is judged when that turn ends instead.
 *
 * Never throws: a bug here must not take a session down with it.
 */
import { turnChangesOf } from "../checkpoints/changes";
import { db } from "../db";
import { practiceLine, practiceRun, practicesApplying } from "../practices/checks";
import { fingerprint } from "../sessions/goal";
import { Hub } from "../sessions/hub";
import { appendLog, getSession, isTurnLive, send, type SessionRecord } from "../sessions/manager";
import { isTreeboss } from "../treeboss/store";
import { detectVerifyCommands, type VerifyCommand } from "./detect";
import { runAll, type VerifyResult } from "./run";
import { finishRun, getSessionRow, lastRun, patchSession, recoverRuns, resolveConfig, startRun, type VerifyRun, type VerifyState } from "./store";

/** The name of the practice step's result in a run: the enabled packs' findings, checked like a command. */
export const PRACTICES_STEP = "Practices";

const running = new Map<string, AbortController>();

export function isVerifying(sessionId: string): boolean {
  return running.has(sessionId);
}

/** Stop a verification in progress (kills the running command's process group). */
export function stopVerify(sessionId: string): boolean {
  const c = running.get(sessionId);
  if (!c) return false;
  c.abort();
  return true;
}

function touch(s: Pick<SessionRecord, "id" | "root_id" | "status">): void {
  Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: getSession(s.id)?.status ?? s.status });
}

const note = (s: SessionRecord, text: string) => appendLog(s, s.last_turn_id, `[verify] ${text}`, "info");

/** The commands that apply: the workspace's own list, else what the project's files say. */
export function commandsFor(s: SessionRecord, configured: VerifyCommand[] | null): { commands: VerifyCommand[]; source: "settings" | "detected" } {
  if (configured && configured.length) return { commands: configured, source: "settings" };
  return { commands: detectVerifyCommands(s.cwd), source: "detected" };
}

const oneLine = (r: VerifyResult) => `\`${r.cmd}\` ${r.timed_out ? "timed out" : `exited ${r.exit}`}`;

/**
 * The practice step of a run: the enabled packs' findings over the files the turn changed, as one result. It fails in fix
 * mode when there is a finding, so the fix turn and the retries are the same as for a command; in warn mode it passes
 * and the findings stay in the result. Null when nothing applies: a treeboss session (its gate runs the packs), no check
 * on, enforce off, or a turn that changed no files. Never throws.
 */
export async function practicesStep(s: SessionRecord, turnId: string | null): Promise<VerifyResult | null> {
  try {
    // Treeboss mode runs the packs in its own gate: they run once, there.
    if (!turnId || isTreeboss(s.id)) return null;
    const applies = practicesApplying(s.base_cwd);
    if (!applies || applies.enforce === "off") return null;
    const turn = db().prepare("SELECT seq FROM turns WHERE id = ?").get(turnId) as { seq: number } | undefined;
    if (!turn) return null;
    const read = await turnChangesOf(s, turnId, turn.seq);
    if (typeof read === "string") {
      note(s, `practices not checked: ${read}`);
      return null;
    }
    if (!read.files.length) return null;
    const started = Date.now();
    const run = practiceRun(s.cwd, read.files, s.base_cwd);
    const failing = run.enforce === "fix" && run.findings.length > 0;
    return {
      name: PRACTICES_STEP,
      cmd: `practice checks (${run.enforce})`,
      exit: failing ? 1 : 0,
      ok: !failing,
      duration_ms: Date.now() - started,
      timed_out: false,
      output: run.findings.map(practiceLine).join("\n"),
    };
  } catch (err: any) {
    console.warn(`[trb] practices ${s.id}: ${err?.message ?? err}`);
    return null;
  }
}

/** What the agent is told when checks fail. The practice step has a section of its own, with each finding labelled by its pack. */
export function fixPrompt(results: VerifyResult[], attempt: number, max: number): string {
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const commands = failed.filter((r) => r.name !== PRACTICES_STEP);
  const practices = failed.find((r) => r.name === PRACTICES_STEP);
  const lines = [`## Verification failed after your last turn (automatic fix ${attempt} of ${max})`, ""];
  if (commands.length) lines.push("These project checks ran in your working directory and did not pass:");
  for (const r of commands) {
    lines.push("", `### ${r.name}: ${oneLine(r)}`, "", "```", r.output || "(no output)", "```");
  }
  if (practices) {
    lines.push("", "### Practices", "", "The enabled practice packs found these in the files your last turn changed (each line names its pack):", "", ...practices.output.split("\n").map((l) => `- ${l}`));
  }
  const passed = results.filter((r) => r.ok);
  if (passed.length) lines.push("", `Passed: ${passed.map((r) => r.name).join(", ")}.`);
  lines.push("", "Fix what they report, then stop; they run again after your reply. If a failure is not caused by your changes (it was failing before, or needs something outside the repository), say so in your reply and change nothing.");
  return lines.join("\n");
}

/** For the goal: is verification currently failing for this session's latest turn, and what to tell the agent. */
export function verifyGate(sessionId: string): { blocked: boolean; text: string } {
  try {
    const row = getSessionRow(sessionId);
    if (!row || row.state !== "failed") return { blocked: false, text: "" };
    const run = lastRun(sessionId);
    // A result from an earlier turn says nothing about this one.
    if (!run || run.turn_id !== getSession(sessionId)?.last_turn_id) return { blocked: false, text: "" };
    const failed = (run?.results ?? []).filter((r) => !r.ok && !r.skipped);
    if (!failed.length) return { blocked: true, text: "Verification is failing." };
    return { blocked: true, text: `Verification is failing: ${failed.map(oneLine).join("; ")}.\n\n${failed.map((r) => `${r.name}:\n${r.output.split("\n").slice(-25).join("\n")}`).join("\n\n")}` };
  } catch {
    return { blocked: false, text: "" };
  }
}

export interface VerifyOutcome {
  /** A fix turn was started: the session is working again. */
  continued: boolean;
  state: VerifyState;
}

interface RunOptions {
  trigger: VerifyRun["trigger"];
  /** Start a fix turn on failure (turn-triggered runs, within the retry budget). */
  autoFix: boolean;
  attempt: number;
}

async function execute(sessionId: string, opts: RunOptions): Promise<VerifyOutcome> {
  const s = getSession(sessionId);
  if (!s || s.status === "closed") return { continued: false, state: "unknown" };
  const cfg = resolveConfig(sessionId, s.base_cwd);
  const prev = getSessionRow(sessionId);
  const turnId = s.last_turn_id;
  // The practice step does not need verify commands: a session still gets its practice findings with verify off.
  const practice = await practicesStep(s, turnId);
  // The practice step reads git, so another run may have started meanwhile: that one stands.
  if (isVerifying(sessionId)) return { continued: false, state: prev?.state ?? "unknown" };
  const { commands, source } = cfg.enabled ? commandsFor(s, cfg.commands) : { commands: [] as VerifyCommand[], source: "settings" as const };

  if (!commands.length && !practice) {
    if (!cfg.enabled) {
      patchSession(sessionId, { state: "off", note: `verification is off (${cfg.enabled_from})`, auto_turn: 0, fix_attempts: 0 });
      touch(s);
      return { continued: false, state: "off" };
    }
    patchSession(sessionId, { state: "none", note: "no verify commands found for this project", auto_turn: 0, fix_attempts: 0 });
    touch(s);
    return { continued: false, state: "none" };
  }

  const fp = fingerprint(s.cwd);
  const before = lastRun(sessionId);
  // The same tree gives the same findings, but the mode or the switches can have changed since: the step's output must match too.
  const samePractice = (before?.results.find((r) => r.name === PRACTICES_STEP)?.output ?? null) === (practice ? practice.output : null);
  const unchanged = Boolean(prev && prev.last_fp === fp && before && before.state === "passed" && samePractice);

  // Nothing changed since the last green run: say so and carry the result over to this turn.
  if (unchanged && before) {
    const id = startRun(sessionId, turnId, opts.attempt, opts.trigger);
    finishRun(id, "passed", before.results, fp);
    patchSession(sessionId, { state: "passed", note: "no changes since the last passing run", auto_turn: 0, fix_attempts: 0, last_fp: fp });
    note(s, "no files changed since the last passing run; not run again.");
    touch(s);
    return { continued: false, state: "passed" };
  }

  const controller = new AbortController();
  running.set(sessionId, controller);
  const runId = startRun(sessionId, turnId, opts.attempt, opts.trigger);
  const names = [...commands.map((c) => c.name), ...(practice ? [PRACTICES_STEP] : [])];
  patchSession(sessionId, { state: "running", note: `running ${names.join(", ")}`, last_fp: prev?.last_fp ?? null });
  const ran = [...commands.map((c) => `\`${c.cmd}\` (${source})`), ...(practice ? [`practice checks (${practice.cmd})`] : [])];
  note(s, `running ${ran.join(", ")}`);
  touch(s);

  let results: VerifyResult[];
  try {
    const cmdResults = commands.length ? await runAll(commands, s.cwd, { timeoutMs: cfg.timeout_sec * 1000, signal: controller.signal }) : [];
    results = practice ? [...cmdResults, practice] : cmdResults;
  } finally {
    running.delete(sessionId);
  }

  const now = getSession(sessionId);
  const stopped = controller.signal.aborted;
  // The operator moved on while it ran, or closed the session: the result describes a tree that no longer exists.
  if (!now || now.status === "closed" || (opts.trigger === "turn" && isTurnLive(sessionId))) {
    finishRun(runId, "stale", results, fp);
    if (now && now.status !== "closed") patchSession(sessionId, { state: "unknown", note: "a newer turn started while verification ran", auto_turn: 0 });
    return { continued: false, state: "unknown" };
  }

  const ok = !stopped && results.every((r) => r.ok);
  finishRun(runId, ok ? "passed" : "failed", results, fp);
  const failed = results.filter((r) => !r.ok && !r.skipped);
  // Warn mode: the findings are in the run's results and this note, and nothing is sent back to the agent.
  const reported = practice?.output ? practice.output.split("\n").length : 0;
  if (ok && reported) note(s, `practices: ${reported} finding${reported === 1 ? "" : "s"}, reported and not sent back (warn).`);

  if (ok) {
    patchSession(sessionId, { state: "passed", note: `${results.map((r) => r.name).join(", ")} passed`, auto_turn: 0, fix_attempts: 0, last_fp: fp });
    note(s, `passed: ${results.map((r) => `${r.name} (${(r.duration_ms / 1000).toFixed(1)}s)`).join(", ")}.`);
    touch(s);
    return { continued: false, state: "passed" };
  }
  if (stopped) {
    patchSession(sessionId, { state: "unknown", note: "stopped", auto_turn: 0, last_fp: fp });
    note(s, "stopped.");
    touch(s);
    return { continued: false, state: "unknown" };
  }

  note(s, `failed: ${failed.map(oneLine).join("; ")}.`);
  const sameAsLast = Boolean(prev && prev.last_fp === fp && before?.state === "failed");
  let why: string | null = null;
  if (!opts.autoFix) why = "automatic fixes are not used for a manual run";
  else if (cfg.max_retries === 0) why = "automatic retries are off (max retries is 0)";
  else if (opts.attempt >= cfg.max_retries) why = `used all ${cfg.max_retries} automatic fix${cfg.max_retries === 1 ? "" : "es"}`;
  else if (opts.attempt > 0 && sameAsLast) why = "the last fix turn changed no files";
  if (why) {
    patchSession(sessionId, { state: "failed", note: why, auto_turn: 0, last_fp: fp });
    note(s, `not retrying: ${why}.`);
    touch(s);
    return { continued: false, state: "failed" };
  }

  const attempt = opts.attempt + 1;
  patchSession(sessionId, { state: "fixing", note: `automatic fix ${attempt} of ${cfg.max_retries}`, auto_turn: 1, fix_attempts: attempt, last_fp: fp });
  note(s, `sending the failures back to the agent (automatic fix ${attempt} of ${cfg.max_retries}).`);
  touch(s);
  try {
    send({ operator: true }, sessionId, fixPrompt(results, attempt, cfg.max_retries));
    return { continued: true, state: "fixing" };
  } catch (err: any) {
    patchSession(sessionId, { state: "failed", note: `could not start the fix turn: ${err?.message ?? err}`, auto_turn: 0 });
    touch(s);
    return { continued: false, state: "failed" };
  }
}

/** Called by the session manager when a turn ends. */
export async function verifyAfterTurn(sessionId: string, info: { interrupted: boolean; success: boolean; turnId?: string }): Promise<VerifyOutcome> {
  try {
    const s = getSession(sessionId);
    if (!s) return { continued: false, state: "unknown" };
    // Another turn started while the earlier hooks ran: this result would describe a tree that is already changing.
    if (info.turnId && s.last_turn_id !== info.turnId) return { continued: false, state: "unknown" };
    const prev = getSessionRow(sessionId);
    // A turn the daemon itself sent (a fix) keeps counting; any other turn starts the count over.
    const attempt = prev?.auto_turn === 1 ? prev.fix_attempts : 0;
    if (prev?.auto_turn === 1) patchSession(sessionId, { auto_turn: 0 });
    if (s.status === "closed" || s.depth > 0 || s.mode !== "build") return { continued: false, state: prev?.state ?? "unknown" };
    if (info.interrupted || !info.success) {
      // Nothing trustworthy to check, and a result from before this turn must not read as current.
      if (prev && prev.state !== "off") patchSession(sessionId, { state: "unknown", note: info.interrupted ? "the turn was interrupted" : "the turn failed", auto_turn: 0 });
      touch(s);
      return { continued: false, state: "unknown" };
    }
    return await execute(sessionId, { trigger: "turn", autoFix: true, attempt });
  } catch (err: any) {
    console.warn(`[trb] verify ${sessionId}: ${err?.message ?? err}`);
    try {
      patchSession(sessionId, { state: "unknown", note: `verification hit an error: ${err?.message ?? err}`, auto_turn: 0 });
    } catch {}
    running.delete(sessionId);
    return { continued: false, state: "unknown" };
  }
}

/** The operator asked for a run. Needs an idle session; never starts a fix turn on its own. */
export async function runVerifyNow(sessionId: string, opts: { fix?: boolean } = {}): Promise<VerifyOutcome> {
  const s = getSession(sessionId);
  if (!s) throw new Error(`No session "${sessionId}".`);
  if (s.status === "closed") throw new Error("This session is closed.");
  if (s.status === "running" || isTurnLive(sessionId)) throw new Error("The session is working. Verify after its turn ends.");
  if (isVerifying(sessionId)) throw new Error("Verification is already running.");
  return execute(sessionId, { trigger: "manual", autoFix: Boolean(opts.fix), attempt: 0 });
}

/* -------------------------------------------------------------------------- */
/* The session view                                                           */
/* -------------------------------------------------------------------------- */

export interface VerifyView {
  state: VerifyState;
  /** Verified and idle: the only time a session counts as done. */
  done: boolean;
  note: string | null;
  attempts: number;
  last: { turn_id: string | null; state: string; finished_at: string | null; results: Array<{ name: string; ok: boolean; exit: number; duration_ms: number }> } | null;
}

/** Database only (no files read): this is part of every session in a list. null when verification never ran. */
export function verifyView(s: SessionRecord): VerifyView | null {
  const row = getSessionRow(s.id);
  if (!row) return null;
  const last = lastRun(s.id);
  const current = Boolean(last && last.turn_id === s.last_turn_id);
  return {
    state: row.state,
    done: s.status === "idle" && row.state === "passed" && current,
    note: row.note,
    attempts: row.fix_attempts,
    last: last ? { turn_id: last.turn_id, state: last.state, finished_at: last.finished_at, results: last.results.map((r) => ({ name: r.name, ok: r.ok, exit: r.exit, duration_ms: r.duration_ms })) } : null,
  };
}

/** A new daemon: nothing is verifying. */
export function recoverVerify(): void {
  try {
    recoverRuns();
  } catch {}
}
