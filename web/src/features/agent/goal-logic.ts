/** Pure rules for the goal bar and the goal dialog. */
import type { GoalStatus, GoalView } from "@/lib/types";

export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_MAX_MINUTES = 60;

export interface GoalDraft {
  text: string;
  check: string;
  maxTurns: number;
  maxMinutes: number;
}

export const emptyDraft = (): GoalDraft => ({ text: "", check: "", maxTurns: DEFAULT_MAX_TURNS, maxMinutes: DEFAULT_MAX_MINUTES });

export function draftFromGoal(g: GoalView): GoalDraft {
  return { text: g.text, check: g.check_cmd ?? "", maxTurns: g.max_turns, maxMinutes: g.max_minutes };
}

/** What the daemon takes, whether in `POST /api/sessions` (as `goal`) or `PUT /api/sessions/:id/goal`. */
export function goalPayload(d: GoalDraft): { text: string; check?: string; max_turns: number; max_minutes: number } {
  const check = d.check.trim();
  return { text: d.text.trim(), ...(check ? { check } : {}), max_turns: d.maxTurns, max_minutes: d.maxMinutes };
}

export function draftProblems(d: GoalDraft): { text?: string; maxTurns?: string; maxMinutes?: string } {
  const out: { text?: string; maxTurns?: string; maxMinutes?: string } = {};
  if (!d.text.trim()) out.text = "Say what done looks like.";
  else if (d.text.length > 8000) out.text = "Keep it under 8000 characters.";
  if (!Number.isInteger(d.maxTurns) || d.maxTurns < 1 || d.maxTurns > 100) out.maxTurns = "1 to 100 turns.";
  if (!Number.isInteger(d.maxMinutes) || d.maxMinutes < 1 || d.maxMinutes > 720) out.maxMinutes = "1 to 720 minutes.";
  return out;
}

export type Tone = "accent" | "green" | "amber" | "neutral";
export const goalTone = (s: GoalStatus): Tone => (s === "active" ? "accent" : s === "met" ? "green" : s === "stalled" || s === "exhausted" ? "amber" : "neutral");

export const goalStatusLabel = (s: GoalStatus): string => ({ active: "working", met: "goal met", stalled: "stalled", exhausted: "budget spent", stopped: "stopped" })[s];

/** Turns used out of the budget, 0..1, for the bar. */
export function goalProgress(g: Pick<GoalView, "turns_used" | "max_turns">): number {
  return g.max_turns > 0 ? Math.min(1, Math.max(0, g.turns_used / g.max_turns)) : 0;
}

/** The last check in one phrase, or null when there is no check or it has not run yet. */
export function checkLabel(g: Pick<GoalView, "check_cmd" | "last_check_exit">): { text: string; ok: boolean } | null {
  if (!g.check_cmd || g.last_check_exit === null) return null;
  return g.last_check_exit === 0 ? { text: "check passed", ok: true } : { text: g.last_check_exit === 124 ? "check timed out" : `check failed (exit ${g.last_check_exit})`, ok: false };
}

/** A finished goal stays on the bar until dismissed; the key lets a new goal on the same session show again. */
export const goalKey = (g: Pick<GoalView, "session_id" | "started_at">): string => `${g.session_id}@${g.started_at}`;
