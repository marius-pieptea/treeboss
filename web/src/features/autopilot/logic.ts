import type { Who } from "@/components/agent-who";
import type { RunStatus, ScheduleKind } from "./data";

type Tone = "neutral" | "accent" | "green" | "red" | "amber" | "violet" | "blue";

/** What the operator reads for a run status. Status colour always comes with the word. */
export const RUN_LABEL: Record<RunStatus, string> = {
  running: "running",
  paused: "paused",
  awaiting_approval: "needs approval",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

export const RUN_TONE: Record<RunStatus, Tone> = {
  running: "accent",
  paused: "neutral",
  awaiting_approval: "amber",
  done: "green",
  failed: "red",
  stopped: "neutral",
};

export const KIND_LABEL: Record<ScheduleKind, string> = {
  prompt: "prompt",
  deps_update: "update dependencies",
  lab_sweep: "lab sweep",
  verify: "checks",
  signals_sync: "signals sync",
};

export const LENSES = ["features", "ui", "ai", "perf", "dx", "review"] as const;

/** A run that is still moving (its tasks are being worked, or it is paused with work in flight). */
export const isLive = (s: RunStatus): boolean => s === "running" || s === "paused" || s === "awaiting_approval";

/** Whether the list should poll quickly: something is working or waiting on the operator. */
export const needsFastPoll = (runs: Array<{ status: RunStatus }>): boolean => runs.some((r) => r.status === "running" || r.status === "awaiting_approval");

export const money = (usd: number | null | undefined): string => (usd === null || usd === undefined ? "no limit" : `$${usd.toFixed(2)}`);

export const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "never");

/** The one line that says what a schedule's last run did. */
export function lastResultText(r: Record<string, any> | null): { text: string; tone: Tone } {
  if (!r) return { text: "never run", tone: "neutral" };
  if (r.ok === true) return { text: "last run ok", tone: "green" };
  if (r.ok === false) return { text: `last run failed${r.error ? `: ${r.error}` : ""}`, tone: "red" };
  return { text: "started", tone: "neutral" };
}

/** Cron, as the schedule list shows it: the expression, kept whole, in mono. */
export const CRON_HINT = "minute hour day month weekday, e.g. 0 9 * * 1 for Mondays at 09:00";

/** The runs that wait on the operator, in list order. */
export const gatedRuns = <R extends { status: RunStatus; gate: unknown }>(runs: R[]): R[] => runs.filter((r) => r.status === "awaiting_approval" && !!r.gate);

export interface ScheduleDraft extends Who {
  name: string;
  cron: string;
  kind: ScheduleKind;
  prompt?: string;
  lens?: string;
  enabled: boolean;
}

/**
 * The create body for a scheduled job. The engine is a column on the schedule; the model rides in its payload, which is
 * where the scheduler reads it. A prompt job sends both; other kinds keep their own payload shape.
 */
export function scheduleCreateBody(d: ScheduleDraft): Record<string, unknown> {
  const payload = d.kind === "prompt" ? { prompt: d.prompt, ...(d.model ? { model: d.model } : {}) } : d.kind === "lab_sweep" ? { lens: d.lens } : {};
  return { name: d.name, cron: d.cron, kind: d.kind, payload, enabled: d.enabled, ...(d.engine ? { engine: d.engine } : {}) };
}
