/** Pure rules behind the plan questionnaire and the plan card. No React, so they are unit-tested directly. */
import type { PlanAnswer, PlanOption, PlanQuestion, PlanRecord, PlanState } from "@/lib/types";
import type { NewTab } from "@/lib/store";

/* ------------------------------------------------------------------ questions */

/** The answered (or skipped) questions of the current round, in the order asked. */
export const answeredQuestions = (st: Pick<PlanState, "questions">): PlanQuestion[] => st.questions.filter((q) => q.status === "answered");

/** "Question 2 of ~4": the total is an estimate until the plan lands, so it says so. */
export function stepLabel(q: Pick<PlanQuestion, "seq">, expectedTotal: number): string {
  return `Question ${q.seq} of ~${Math.max(expectedTotal, q.seq)}`;
}

/** The option a bare Enter picks: the recommended one, else none (the operator must choose). */
export function defaultSelection(q: Pick<PlanQuestion, "options">): string[] {
  const rec = q.options.find((o) => o.recommended);
  return rec ? [rec.label] : [];
}

/** Toggle an option. Single-choice replaces, multi adds and removes. Picking an option clears written text. */
export function toggleChoice(q: Pick<PlanQuestion, "multi">, current: string[], label: string): string[] {
  if (!q.multi) return [label];
  return current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
}

/** Keys 1-9 pick the Nth option; anything else (or out of range) is not ours. */
export function optionForKey(key: string, options: PlanOption[]): PlanOption | null {
  if (!/^[1-9]$/.test(key)) return null;
  return options[Number(key) - 1] ?? null;
}

export interface AnswerDraft {
  choices: string[];
  custom: string;
}

export function canAnswer(q: Pick<PlanQuestion, "allow_custom">, d: AnswerDraft): boolean {
  return d.choices.length > 0 || (q.allow_custom && d.custom.trim().length > 0);
}

/** What `POST …/plan/answer` takes. A written answer wins over a leftover selection, as it does on screen. */
export function answerPayload(q: Pick<PlanQuestion, "id" | "multi">, d: AnswerDraft): { question_id: string; choices?: string[]; choice?: string; custom?: string } {
  const custom = d.custom.trim();
  if (custom && d.choices.length === 0) return { question_id: q.id, custom };
  if (custom) return { question_id: q.id, choices: d.choices, custom };
  return q.multi ? { question_id: q.id, choices: d.choices } : { question_id: q.id, choice: d.choices[0] };
}

/** A one-line account of an answer, for the collapsed history. */
export function answerSummary(a: PlanAnswer | null): string {
  if (!a) return "";
  if (a.skipped) return "skipped";
  return [...a.choices, a.custom].filter(Boolean).join("; ");
}

/** Moving through reviewed answers: `null` is the live question. Back goes to the previous answered one. */
export function reviewBack(current: number | null, answeredCount: number): number | null {
  if (answeredCount === 0) return null;
  if (current === null) return answeredCount - 1;
  return Math.max(0, current - 1);
}

export function reviewForward(current: number | null, answeredCount: number): number | null {
  if (current === null) return null;
  return current + 1 >= answeredCount ? null : current + 1;
}

/* ------------------------------------------------------------------ what the dock shows */

export type PlanDock = { kind: "none" } | { kind: "question"; question: PlanQuestion } | { kind: "plan"; plan: PlanRecord } | { kind: "approved"; plan: PlanRecord };

/**
 * One thing at a time: an open question first (the agent is blocked on it), then a plan waiting for a decision.
 * An approved plan stays as a quiet record once building starts.
 */
export function dockFor(st: PlanState | undefined): PlanDock {
  if (!st) return { kind: "none" };
  if (st.pending) return { kind: "question", question: st.pending };
  if (st.plan?.status === "draft") return { kind: "plan", plan: st.plan };
  if (st.plan?.status === "approved") return { kind: "approved", plan: st.plan };
  return { kind: "none" };
}

/** The agent is still finishing the turn that called plan_submit: approving now would be refused. */
export const planDecisionReady = (sessionStatus: string): boolean => sessionStatus !== "running";

/* ------------------------------------------------------------------ the plan file and its viewer tab */

/** The viewer tab for a plan. The id follows the file, so a revision (the same file, version N+1) reuses the tab. */
export function planTab(plan: Pick<PlanRecord, "id" | "path" | "title">, root: string, sessionId: string): NewTab {
  return { kind: "plan", root, sessionId, planId: plan.id, path: plan.path, title: planTabTitle(plan.title) };
}

export const planTabTitle = (title: string): string => `Plan: ${title.length > 26 ? `${title.slice(0, 25)}…` : title}`;

/** A plan that just landed opens its tab once; reopening it is the operator's choice. */
export const shouldAutoOpen = (plan: Pick<PlanRecord, "id" | "status">, opened: ReadonlySet<string>): boolean => plan.status === "draft" && !opened.has(plan.id);

/** The newest plan on the tab's file (or, for a plan with no file yet, the plan itself). */
export function planForTab(state: Pick<PlanState, "plans"> & { plan?: PlanRecord | null } | undefined, tab: { planId: string; path: string | null }): PlanRecord | null {
  if (!state) return null;
  const same = state.plans.filter((p) => (tab.path ? p.path === tab.path : p.id === tab.planId));
  const found = same.length ? same[same.length - 1] : (state.plans.find((p) => p.id === tab.planId) ?? null);
  // The current plan carries what only the file can say (edited, missing): prefer that copy.
  return found && state.plan && state.plan.id === found.id ? state.plan : found;
}

export type PlanBar =
  | { kind: "decide"; canDecide: boolean; reason: string | null }
  | { kind: "approved" }
  | { kind: "superseded"; skipped: boolean; revising: boolean }
  | { kind: "gone" };

/** What the sticky bar on the plan tab offers for a plan in this state. */
export function planBar(plan: PlanRecord | null, state: Pick<PlanState, "plans"> | undefined, sessionStatus: string): PlanBar {
  if (!plan) return { kind: "gone" };
  if (plan.status === "draft") {
    const ready = planDecisionReady(sessionStatus);
    return { kind: "decide", canDecide: ready, reason: ready ? null : "The agent is wrapping up its turn. You can decide in a moment." };
  }
  if (plan.status === "approved") return { kind: "approved" };
  const skipped = plan.note === "skipped";
  // Sent back for changes and nothing newer yet: the agent is revising this same file.
  const revising = !skipped && !!state && state.plans[state.plans.length - 1]?.id === plan.id;
  return { kind: "superseded", skipped, revising };
}

export const approveLabel = (plan: Pick<PlanRecord, "depth">): string => (plan.depth === "spec" ? "Approve spec" : "Approve and build");

export function statusLabel(plan: Pick<PlanRecord, "status" | "note" | "version">, bar: PlanBar): string {
  if (bar.kind === "decide") return `v${plan.version} · waiting for you`;
  if (bar.kind === "approved") return `v${plan.version} · approved`;
  if (bar.kind === "superseded") return bar.skipped ? `v${plan.version} · skipped` : bar.revising ? `v${plan.version} · sent back, being revised` : `v${plan.version} · replaced by a newer version`;
  return "plan not found";
}

/** The compact chip in the dock and the thread: "Plan ready: Add a cache". */
export function chipLabel(plan: Pick<PlanRecord, "title" | "version" | "status">): string {
  const v = plan.version > 1 ? ` v${plan.version}` : "";
  return plan.status === "approved" ? `Approved plan${v}: ${plan.title}` : `Plan${v} ready: ${plan.title}`;
}

/** `plan v2 ready: Add a cache (3 steps) → plans/2026-10-08-add-a-cache.md`, as the daemon logs it (the transcript already drops the `[plan] ` tag). */
export function parsePlanReadyLine(text: string): { version: number; title: string; steps: number; path: string | null } | null {
  const m = /^(?:\[plan\] )?plan v(\d+) ready: (.*?) \((\d+) steps?\)(?: → (\S+))?\s*$/.exec(text.trim());
  return m ? { version: Number(m[1]), title: m[2], steps: Number(m[3]), path: m[4] ?? null } : null;
}

/** The markdown below the front matter, which is what the viewer renders. */
export function planBody(text: string): string {
  const m = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length).replace(/^\s*\n/, "") : text;
}
