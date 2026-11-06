/**
 * Goal mode: a goal attached to a session, and the loop that keeps the session working until it is met.
 *
 * After every turn the daemon asks one question: is the goal met? With a check command, the answer is its
 * exit code (the command is the truth, whatever the agent claims). Without one, the agent must end its
 * reply with `GOAL_STATUS: DONE` or `GOAL_STATUS: CONTINUE` plus what remains. Not met, and inside the
 * budget, means the next turn is sent automatically with the failing output in front of the agent.
 *
 * It stops, for a reason that is always written to the log, when the goal is met, the turn or time budget
 * is spent, two turns in a row change nothing and report the same result, the operator interrupts or
 * closes the session, or a turn fails. It never loops past an interrupt.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { Hub } from "./hub";
import { appendLog, getSession, isTurnLive, send, SessionError } from "./manager";
import { verifyGate } from "../verify/loop";

export type GoalStatus = "active" | "met" | "stopped" | "exhausted" | "stalled";

export interface Goal {
  session_id: string;
  text: string;
  check_cmd: string | null;
  max_turns: number;
  max_minutes: number;
  status: GoalStatus;
  turns_used: number;
  started_at: string;
  ended_at: string | null;
  last_check_exit: number | null;
  last_check_output: string | null;
  last_note: string | null;
}

export interface GoalInput {
  text: string;
  check?: string | null;
  maxTurns?: number | null;
  maxMinutes?: number | null;
}

export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_MAX_MINUTES = 60;
const CHECK_TIMEOUT_MS = () => Number(process.env.TRB_GOAL_CHECK_TIMEOUT_MS) || 120_000;
const OUTPUT_TAIL = 3000;
const STALL_AT = 2;

const prepared = new WeakSet<Database>();
function table(): Database {
  const conn = db();
  if (!prepared.has(conn)) {
    conn.exec(`CREATE TABLE IF NOT EXISTS session_goals (
      session_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      check_cmd TEXT,
      max_turns INTEGER NOT NULL,
      max_minutes INTEGER NOT NULL,
      status TEXT NOT NULL,
      turns_used INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      last_check_exit INTEGER,
      last_check_output TEXT,
      last_note TEXT,
      fingerprint TEXT,
      prev_output_hash TEXT,
      stall_count INTEGER NOT NULL DEFAULT 0
    )`);
    prepared.add(conn);
  }
  return conn;
}

const PUBLIC = "session_id, text, check_cmd, max_turns, max_minutes, status, turns_used, started_at, ended_at, last_check_exit, last_check_output, last_note";

export function getGoal(sessionId: string): Goal | null {
  return (table().prepare(`SELECT ${PUBLIC} FROM session_goals WHERE session_id = ?`).get(sessionId) as Goal | undefined) ?? null;
}

/** Validated and defaulted, so a bad goal is refused before a session is created around it. */
export function normalizeGoal(input: GoalInput): Required<GoalInput> {
  const text = String(input?.text ?? "").trim();
  if (!text) throw new SessionError("A goal needs text.");
  if (text.length > 8000) throw new SessionError("The goal is too long (8000 characters at most).");
  const check = String(input.check ?? "").trim() || null;
  if (check && check.length > 2000) throw new SessionError("The check command is too long.");
  const int = (v: unknown, def: number, lo: number, hi: number, label: string) => {
    if (v === undefined || v === null || v === "") return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new SessionError(`${label} must be a whole number from ${lo} to ${hi}.`);
    return n;
  };
  return {
    text,
    check,
    maxTurns: int(input.maxTurns, DEFAULT_MAX_TURNS, 1, 100, "max turns"),
    maxMinutes: int(input.maxMinutes, DEFAULT_MAX_MINUTES, 1, 720, "max minutes"),
  };
}

function touch(sessionId: string): void {
  const s = getSession(sessionId);
  if (s) Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: s.status });
}

function note(sessionId: string, text: string): void {
  const s = getSession(sessionId);
  if (s) appendLog(s, s.last_turn_id, text, "info");
}

/** What the agent is told when the goal starts: appended to the first turn, or sent on its own mid-session. */
export function goalBlock(g: Pick<Goal, "text" | "check_cmd" | "max_turns" | "max_minutes">): string {
  const lines = ["## Goal", "", g.text, ""];
  if (g.check_cmd) {
    lines.push(`The goal is met when this command exits 0 in the working directory: \`${g.check_cmd}\`. It runs after every turn.`);
  } else {
    lines.push("End every reply with a line `GOAL_STATUS: DONE` when the goal is fully achieved, or `GOAL_STATUS: CONTINUE` followed by what remains.");
  }
  lines.push(`Keep going without stopping to ask: make reasonable assumptions and note them. Budget: ${g.max_turns} turns or ${g.max_minutes} minutes.`);
  return lines.join("\n");
}

/** Attach a goal to a session, replacing any earlier one. `kickoff` (default true) starts a turn now if the session is idle. */
export function setGoal(sessionId: string, input: GoalInput, opts: { kickoff?: boolean } = {}): Goal {
  const s = getSession(sessionId);
  if (!s) throw new SessionError(`No session "${sessionId}".`);
  if (s.status === "closed") throw new SessionError(`Session ${sessionId} is closed.`);
  const g = normalizeGoal(input);
  table()
    .prepare(
      `INSERT OR REPLACE INTO session_goals (session_id, text, check_cmd, max_turns, max_minutes, status, turns_used, started_at, fingerprint)
       VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
    )
    .run(sessionId, g.text, g.check, g.maxTurns, g.maxMinutes, new Date().toISOString(), fingerprint(s.cwd));
  note(sessionId, `[goal] set: ${g.text.split("\n")[0].slice(0, 120)}${g.check ? ` · check: ${g.check}` : " · the agent reports DONE"} · up to ${g.maxTurns} turns, ${g.maxMinutes} min`);
  touch(sessionId);
  const goal = getGoal(sessionId)!;
  if ((opts.kickoff ?? true) && s.status !== "running" && !isTurnLive(sessionId)) {
    send({ operator: true }, sessionId, goalBlock(goal));
  }
  return goal;
}

/** End the goal for a stated reason. A no-op when it is already over. */
export function stopGoal(sessionId: string, reason: string, status: Exclude<GoalStatus, "active"> = "stopped"): Goal | null {
  const g = getGoal(sessionId);
  if (!g || g.status !== "active") return g;
  table().prepare("UPDATE session_goals SET status = ?, ended_at = ?, last_note = ? WHERE session_id = ?").run(status, new Date().toISOString(), reason, sessionId);
  note(sessionId, `[goal] ${status}: ${reason}`);
  touch(sessionId);
  return getGoal(sessionId);
}

/** A daemon restart leaves no loop running, so an "active" goal found at startup is not. */
export function recoverGoals(): number {
  const rows = table().prepare("SELECT session_id FROM session_goals WHERE status = 'active'").all() as Array<{ session_id: string }>;
  for (const r of rows) {
    table().prepare("UPDATE session_goals SET status = 'stopped', ended_at = ?, last_note = ? WHERE session_id = ?").run(new Date().toISOString(), "the daemon restarted; set the goal again to resume", r.session_id);
  }
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const tail = (s: string, n = OUTPUT_TAIL) => (s.length > n ? `…${s.slice(-n)}` : s);

/** The last `GOAL_STATUS:` line in an answer, or null when the agent did not say. */
export function parseGoalStatus(output: string | null | undefined): "DONE" | "CONTINUE" | null {
  const all = [...String(output ?? "").matchAll(/^\s*\**GOAL_STATUS:\s*(DONE|CONTINUE)\b/gim)];
  return all.length ? (all[all.length - 1][1].toUpperCase() as "DONE" | "CONTINUE") : null;
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "target", ".venv", "__pycache__"]);

/** A cheap hash of the working tree: it changes when any file does. Git when available, a bounded walk otherwise. */
export function fingerprint(cwd: string): string {
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const status = run(["status", "--porcelain=v1", "-uall"]);
  if (status.exitCode === 0) {
    const head = run(["rev-parse", "HEAD"]);
    const parts = [head.exitCode === 0 ? head.stdout.toString().trim() : "no-head"];
    for (const line of status.stdout.toString().split("\n").filter(Boolean)) {
      let stat = "gone";
      try {
        const st = fs.statSync(path.join(cwd, line.slice(3).replace(/^"|"$/g, "")));
        stat = `${st.size}:${st.mtimeMs}`;
      } catch {}
      parts.push(`${line}|${stat}`);
    }
    return sha(parts.join("\n"));
  }
  const parts: string[] = [];
  const walk = (dir: string) => {
    if (parts.length > 4000) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          const st = fs.statSync(p);
          parts.push(`${path.relative(cwd, p)}|${st.size}:${st.mtimeMs}`);
        } catch {}
      }
    }
  };
  walk(cwd);
  return sha(parts.sort().join("\n"));
}

export async function runCheck(cmd: string, cwd: string): Promise<{ exit: number; output: string; timedOut: boolean }> {
  const env: Record<string, string | undefined> = { ...process.env, CI: "true", FORCE_COLOR: "0" };
  delete env.TRB_TOKEN;
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, CHECK_TIMEOUT_MS());
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exit = await proc.exited;
    const output = `${out}${err ? `${out && !out.endsWith("\n") ? "\n" : ""}${err}` : ""}`.trim();
    return { exit: timedOut ? 124 : exit, output: timedOut ? `${tail(output)}\n[the check timed out after ${Math.round(CHECK_TIMEOUT_MS() / 1000)}s]`.trim() : tail(output), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** The approved plan's file, when the session has one: goal turns point at it instead of repeating the plan. */
function approvedPlanFile(sessionId: string): string | null {
  try {
    const row = db().prepare("SELECT path FROM plans WHERE session_id = ? AND status = 'approved' AND path IS NOT NULL ORDER BY version DESC LIMIT 1").get(sessionId) as { path: string } | undefined;
    const s = getSession(sessionId);
    return row && s && fs.existsSync(path.join(s.base_cwd, row.path)) ? row.path : null;
  } catch {
    return null;
  }
}

function continuePrompt(g: Goal, left: { turns: number; minutes: number }, why: { check: boolean; marker: boolean }, plan: string | null = null, verify: string | null = null): string {
  const lines = [`## Goal: turn ${g.turns_used + 1} of ${g.max_turns}, about ${Math.max(1, left.minutes)} min left`, "", g.text, ...(plan ? ["", `The approved plan is in \`${plan}\`: follow it, and re-read it if you are unsure what is left.`] : []), "", "Not done yet."];
  if (g.check_cmd) {
    lines.push("", `The check \`${g.check_cmd}\` exited ${g.last_check_exit}${g.last_check_output ? ":" : "."}`);
    if (g.last_check_output) lines.push("", "```", g.last_check_output, "```");
    lines.push("", "Fix what it reports, then stop. It runs again after your reply.");
  } else if (why.marker) {
    lines.push("", "Your last reply did not end with a GOAL_STATUS line. End this one with `GOAL_STATUS: DONE` or `GOAL_STATUS: CONTINUE` and what remains.");
  } else {
    lines.push("", "Continue with what remains, then end with `GOAL_STATUS: DONE` or `GOAL_STATUS: CONTINUE` and what is left.");
  }
  // The project's own checks are failing too: the goal is not met until they pass.
  if (verify) lines.push("", "The project's verification is also failing, and the goal is not met until it passes:", "", "```", verify, "```");
  return lines.join("\n");
}

/**
 * Called by the session manager when a turn ends. Decides: met, over, or another turn. Never throws: a bug
 * here must not take a session down with it.
 */
export async function afterTurn(sessionId: string, info: { interrupted: boolean; success: boolean; turnId?: string }): Promise<void> {
  try {
    await evaluate(sessionId, info);
  } catch (err: any) {
    console.warn(`[trb] goal ${sessionId}: ${err?.message ?? err}`);
    stopGoal(sessionId, `the goal loop hit an error: ${err?.message ?? err}`);
  }
}

async function evaluate(sessionId: string, info: { interrupted: boolean; success: boolean; turnId?: string }): Promise<void> {
  const row = table().prepare("SELECT * FROM session_goals WHERE session_id = ?").get(sessionId) as (Goal & { fingerprint: string | null; prev_output_hash: string | null; stall_count: number }) | undefined;
  if (!row || row.status !== "active") return;
  const s = getSession(sessionId);
  if (!s || s.status === "closed") return void stopGoal(sessionId, "the session was closed");
  // This evaluation is for a turn that is no longer the latest (another started while the after-turn hooks ran): that turn is judged when it ends.
  if (info.turnId && s.last_turn_id !== info.turnId) return;
  if (info.interrupted) return void stopGoal(sessionId, "interrupted");
  if (!info.success) return void stopGoal(sessionId, `the turn failed${s.last_error ? `: ${s.last_error.split("\n")[0].slice(0, 160)}` : ""}`);

  const turns = row.turns_used + 1;
  table().prepare("UPDATE session_goals SET turns_used = ? WHERE session_id = ?").run(turns, sessionId);

  let met = false;
  let markerMissing = false;
  let exit: number | null = null;
  let resultText: string;
  if (row.check_cmd) {
    const r = await runCheck(row.check_cmd, s.cwd);
    exit = r.exit;
    resultText = r.output;
    met = r.exit === 0;
    table().prepare("UPDATE session_goals SET last_check_exit = ?, last_check_output = ? WHERE session_id = ?").run(r.exit, r.output || null, sessionId);
  } else {
    const verdict = parseGoalStatus(s.last_output);
    met = verdict === "DONE";
    markerMissing = verdict === null;
    resultText = tail(String(s.last_output ?? ""));
    table().prepare("UPDATE session_goals SET last_check_exit = NULL, last_check_output = ? WHERE session_id = ?").run(null, sessionId);
  }

  // The operator may have stopped, closed or taken over while the check ran.
  const live = getGoal(sessionId);
  if (!live || live.status !== "active") return;
  const now = getSession(sessionId);
  if (!now || now.status === "closed") return void stopGoal(sessionId, "the session was closed");

  // The goal's own test (the check, or the agent saying DONE) is not enough while the project's checks fail.
  const gate = verifyGate(sessionId);
  if (met && gate.blocked) {
    met = false;
    resultText = `${resultText}\n${gate.text}`;
  }

  if (met) {
    return void stopGoal(sessionId, row.check_cmd ? `\`${row.check_cmd}\` passed after ${turns} turn${turns === 1 ? "" : "s"}` : `the agent reported DONE after ${turns} turn${turns === 1 ? "" : "s"}`, "met");
  }

  const fp = fingerprint(s.cwd);
  const outHash = sha(resultText);
  const same = fp === row.fingerprint && outHash === row.prev_output_hash;
  const stall = same ? row.stall_count + 1 : 0;
  table().prepare("UPDATE session_goals SET fingerprint = ?, prev_output_hash = ?, stall_count = ? WHERE session_id = ?").run(fp, outHash, stall, sessionId);

  const elapsedMin = (Date.now() - Date.parse(row.started_at)) / 60_000;
  const detail = (row.check_cmd ? `check exited ${exit}` : markerMissing ? "no GOAL_STATUS line" : "the agent reported CONTINUE") + (gate.blocked ? "; verification is failing" : "");
  if (turns >= row.max_turns) return void stopGoal(sessionId, `used all ${row.max_turns} turns without meeting the goal (${detail})`, "exhausted");
  if (elapsedMin >= row.max_minutes) return void stopGoal(sessionId, `used the ${row.max_minutes} minute budget without meeting the goal (${detail})`, "exhausted");
  if (stall >= STALL_AT) return void stopGoal(sessionId, `${stall} turns in a row changed no files and gave the same result (${detail})`, "stalled");

  if (isTurnLive(sessionId)) return; // the operator sent a message of their own; the goal is judged again when it ends
  note(sessionId, `[goal] turn ${turns}/${row.max_turns}: ${detail}; continuing`);
  const fresh = getGoal(sessionId)!;
  const prompt = continuePrompt({ ...fresh, turns_used: turns }, { turns: row.max_turns - turns, minutes: Math.round(row.max_minutes - elapsedMin) }, { check: Boolean(row.check_cmd), marker: markerMissing }, approvedPlanFile(sessionId), gate.blocked ? gate.text : null);
  touch(sessionId);
  try {
    send({ operator: true }, sessionId, prompt);
  } catch (err: any) {
    stopGoal(sessionId, `could not start the next turn: ${err?.message ?? err}`);
  }
}
