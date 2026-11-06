/** Pure rules for the composer's chrome: which one thing the status slot shows, and what the Build|Plan control says. */
import type { GoalStatus, PlanRecord, PlanState, SessionView } from "@/lib/types";

/* ------------------------------------------------------------------ the status slot */

export type SlotKind = "question" | "plan" | "goal" | "shelf" | "none";

export interface SlotInputs {
  /** The agent is blocked on a plan question. */
  question: boolean;
  /** A plan that waits for a decision (see `planReady`). */
  plan: boolean;
  /** The session's goal: `active` while it works, `finished` once met/stopped/stalled/spent and not dismissed. */
  goal: "active" | "finished" | null;
  /** There is a lead/heads strip to show. */
  shelf: boolean;
}

/**
 * ONE item above the box, by urgency: a question the agent is blocked on, then a plan waiting for you, then a goal
 * that is working, then the heads. A finished goal is history, so it yields to the heads and only shows alone.
 */
export function slotKind(i: SlotInputs): SlotKind {
  if (i.question) return "question";
  if (i.plan) return "plan";
  if (i.goal === "active") return "goal";
  if (i.shelf) return "shelf";
  if (i.goal === "finished") return "goal";
  return "none";
}

/**
 * The plan to decide on, or null. "Ready" means a draft plan record exists (the agent called `plan_submit` and the
 * daemon wrote the file) and the turn that wrote it is over: a plain-text reply in plan mode is not a plan.
 */
export function planReady(state: Pick<PlanState, "plan"> | undefined, sessionStatus: SessionView["status"]): PlanRecord | null {
  const plan = state?.plan;
  if (!plan || plan.status !== "draft") return null;
  if (sessionStatus === "running" || sessionStatus === "closed") return null;
  return plan;
}

export function goalSlot(status: GoalStatus | undefined, dismissed: boolean): SlotInputs["goal"] {
  if (!status) return null;
  if (status === "active") return "active";
  return dismissed ? null : "finished";
}

/* ------------------------------------------------------------------ Build | Plan */

export type Mode = "build" | "plan" | "ask";
export type Depth = "quick" | "spec";

export interface ModeView {
  mode: Mode;
  depth: Depth;
  /** What the placeholder asks for: planning and building start from different sentences. */
  placeholder: (hasSession: boolean) => string;
  /** The Plan segment's tooltip: carries the depth, so the control's width never changes with it. */
  planTitle: string;
  /** The Ask segment's tooltip. */
  askTitle: string;
}

export function modeView(mode: Mode, depth: Depth): ModeView {
  const depthText = depth === "spec" ? "Spec it: the plan becomes a spec feature" : "Quick plan: the plan is a file in plans/";
  return {
    mode,
    depth,
    placeholder: (hasSession) =>
      mode === "plan"
        ? hasSession ? "Reply, or refine the plan…" : "Describe what to plan…"
        : mode === "ask"
          ? hasSession ? "Ask a follow-up…" : "Ask about this project…"
          : hasSession ? "Follow up…  (@ file, / command)" : "Describe what you want done…",
    askTitle: mode === "ask" ? "Ask mode: read-only questions, short answers, a cheap model. Nothing is written." : "Ask a quick question: read-only, short answer, a cheap model.",
    planTitle: mode === "plan" ? `Plan mode: the agent reads and proposes, nothing is written. ${depthText}.` : `Plan first: the agent proposes, you approve. ${depthText}.`,
  };
}

/** Build → Plan → Ask → Build: what Alt+P steps through. */
export const nextMode = (m: Mode): Mode => (m === "build" ? "plan" : m === "plan" ? "ask" : "build");

/** Alt+P steps Build → Plan → Ask from the box (Shift+Tab stays focus navigation: the box would otherwise trap it). */
export function isModeShortcut(e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; code: string }): boolean {
  return e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === "KeyP";
}

/* ------------------------------------------------------------------ the context ring's label */

/** The number beside the ring appears from half full; below that the ring and its tooltip are enough. */
export const showMeterLabel = (fill: number): boolean => fill >= 0.5;
