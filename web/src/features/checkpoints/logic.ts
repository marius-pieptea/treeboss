/** Pure rules for the checkpoints dialog and the verification strip. */
import type { SessionView, VerifyState, VerifyView } from "@/lib/types";

export interface CheckpointRow {
  id: string;
  kind: "base" | "turn" | "undo";
  turn_id: string | null;
  seq: number;
  ref: string;
  commit: string;
  changed: number;
  created_at: string;
}

export interface TurnBrief {
  id: string;
  seq: number;
  status: string;
  prompt: string;
  started_at: string;
  finished_at: string | null;
}

export interface TurnLine {
  turn: TurnBrief;
  /** The state before this turn exists (the end of the turn before it, or the base), so "rewind to before" works. */
  canRewind: boolean;
  /** The end of this turn was recorded, so a fork can start from it. */
  canFork: boolean;
  /** Files this turn changed, as recorded at its end (null: not recorded). */
  changed: number | null;
}

/** One line per turn, newest first, with what can be done to it. */
export function turnLines(turns: TurnBrief[], cps: CheckpointRow[]): TurnLine[] {
  const ends = new Map(cps.filter((c) => c.kind === "turn" && c.turn_id).map((c) => [c.turn_id!, c]));
  const hasBase = cps.some((c) => c.kind === "base");
  return [...turns]
    .sort((a, b) => b.seq - a.seq)
    .map((turn) => {
      const earlier = cps.some((c) => c.kind === "turn" && c.seq < turn.seq);
      return { turn, canRewind: turn.status !== "running" && (earlier || hasBase), canFork: ends.has(turn.id) && turn.status !== "running", changed: ends.get(turn.id)?.changed ?? null };
    });
}

export interface ActionState {
  enabled: boolean;
  /** Why it is off (or, when on, what it does): shown as the button's tooltip. */
  label: string;
}

export interface SessionGate {
  /** A turn is running right now. */
  running: boolean;
  closed: boolean;
}

export const REWIND_LABEL = "Rewind to before this message";
export const FORK_LABEL = "Fork from here";
const NO_CHECKPOINTS = "No checkpoint for this message: checkpoints are kept for sessions inside a git repository.";

/** The rewind button on a user message: files go back to before that message's turn. */
export function rewindState(line: TurnLine | undefined, gate: SessionGate): ActionState {
  if (gate.closed) return { enabled: false, label: "This session is closed: you can fork from a message, not rewind." };
  if (gate.running) return { enabled: false, label: "Stop the session to rewind: a turn is running." };
  if (!line) return { enabled: false, label: NO_CHECKPOINTS };
  if (!line.canRewind) return { enabled: false, label: "No checkpoint before this message to go back to." };
  return { enabled: true, label: REWIND_LABEL };
}

/** The fork button on an agent message: a new isolated lead from the files as that turn left them. */
export function forkState(line: TurnLine | undefined): ActionState {
  if (!line) return { enabled: false, label: NO_CHECKPOINTS };
  if (!line.canFork) return { enabled: false, label: "This turn has no recorded end yet, so there is nothing to fork from." };
  return { enabled: true, label: FORK_LABEL };
}

export const changedLabel = (n: number | null): string => (n === null ? "" : n === 0 ? "no file changes" : `${n} file${n === 1 ? "" : "s"} changed`);

export type Tone = "accent" | "green" | "amber" | "red" | "neutral";

export interface StripView {
  tone: Tone;
  label: string;
  detail: string | null;
}

/**
 * What the strip above the composer says, or null when it should not be there: only a session that has been
 * (or is being) verified, and only while it says something the operator needs.
 */
export function stripView(session: Pick<SessionView, "status" | "verify" | "done">): StripView | null {
  const v = session.verify;
  if (!v) return null;
  const failedNames = v.last?.results.filter((r) => !r.ok).map((r) => r.name) ?? [];
  switch (v.state) {
    case "running":
      return { tone: "accent", label: "Verifying…", detail: v.note };
    case "fixing":
      return { tone: "amber", label: "Checks failed: sending them back to the agent", detail: v.note };
    case "failed":
      return { tone: "red", label: failedNames.length ? `Checks failing: ${failedNames.join(", ")}` : "Checks failing", detail: v.note };
    case "passed":
      return session.done ? { tone: "green", label: "Done: checks passed", detail: v.note } : { tone: "neutral", label: "Checks passed", detail: v.note };
    default:
      return null;
  }
}

export const verifyBusy = (s: VerifyState | undefined): boolean => s === "running" || s === "fixing";

export function durationLabel(ms: number): string {
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

/** The workspace commands textarea: one `name: command` per line (a bare line is named after its position). */
export function commandsToText(commands: Array<{ name: string; cmd: string }> | null): string {
  return (commands ?? []).map((c) => `${c.name}: ${c.cmd}`).join("\n");
}

export function textToCommands(text: string): Array<{ name: string; cmd: string }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const m = /^([A-Za-z][\w .-]{0,38}):\s+(.+)$/.exec(line);
      return m ? { name: m[1].trim(), cmd: m[2].trim() } : { name: `check ${i + 1}`, cmd: line };
    });
}

/** What one scope (global, or a workspace) sets; null means "not set here" and inherits. */
export interface VerifyScopeConfig {
  enabled: boolean | null;
  commands: Array<{ name: string; cmd: string }> | null;
  max_retries: number | null;
  timeout_sec: number | null;
}

export const tri = (v: boolean | null): "inherit" | "on" | "off" => (v === null ? "inherit" : v ? "on" : "off");
export const fromTri = (v: string): boolean | null => (v === "inherit" ? null : v === "on");

export type { VerifyView };
