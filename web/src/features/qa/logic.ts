/**
 * Pure logic of the QA panel: progress, which step is current, the bug draft a failed step becomes, the keyboard
 * map, and how a plan's steps and proposals line up as rows. No React and no fetching, so it is all unit-tested.
 */
import type { BatchView, BugDraft, Coverage, Outcome, OutcomeState, Plan, PlanSource, PlanStep, PlanSummary, Proposal, QaSession, Run, RunCounts, RunStep, RunSummary, StepHistory, StepPath } from "./api";

export const STATES: OutcomeState[] = ["pass", "fail", "skip", "blocked", "pending"];

export interface Progress {
  counts: Record<OutcomeState, number>;
  done: number;
  total: number;
}

export function progress(run: Pick<Run, "steps">): Progress {
  const counts: Record<OutcomeState, number> = { pending: 0, pass: 0, fail: 0, skip: 0, blocked: 0 };
  for (const s of run.steps) counts[s.outcome.state]++;
  return { counts, done: run.steps.length - counts.pending, total: run.steps.length };
}

export const currentStep = (run: Pick<Run, "steps">): RunStep | null => run.steps.find((s) => s.outcome.state === "pending") ?? null;

/** Whether choosing `id` moves off the open step. Choosing the open one must not restart its recording window or clear what was typed. */
export const switchesStep = (cursor: string | null, id: string | null): boolean => cursor !== id;

const neighbour = (run: Pick<Run, "steps">, id: string, by: 1 | -1): RunStep | null => {
  const i = run.steps.findIndex((s) => s.id === id);
  return i < 0 ? null : (run.steps[i + by] ?? null);
};
export const nextStep = (run: Pick<Run, "steps">, id: string) => neighbour(run, id, 1);
export const prevStep = (run: Pick<Run, "steps">, id: string) => neighbour(run, id, -1);

/** The bug a failed step becomes: every action up to and including it, then what the preview recorded since. */
export function bugDraftOf(run: Pick<Run, "steps">, stepId: string, recorded: string[]): BugDraft | null {
  const i = run.steps.findIndex((s) => s.id === stepId);
  if (i < 0) return null;
  const step = run.steps[i]!;
  return {
    title: step.action,
    kind: "functional",
    steps: [...run.steps.slice(0, i + 1).map((s) => s.action), ...recorded.map((l) => `${l} (recorded)`)],
    expected: step.expected,
    actual: step.outcome.state === "fail" ? step.outcome.actual : "",
    path: step.path,
  };
}

export type KeyAction = "pass" | "fail" | "skip" | "blocked" | "prev" | "next" | "go";

const KEYS: Record<string, KeyAction> = { p: "pass", f: "fail", s: "skip", b: "blocked", arrowup: "prev", arrowdown: "next", enter: "go" };

/** `editable` is true when the key went to a text field: typing "p" there is not a pass. */
export function keyFor(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; editable?: boolean }): KeyAction | null {
  if (e.editable || e.ctrlKey || e.metaKey || e.altKey) return null;
  return KEYS[e.key.toLowerCase()] ?? null;
}

/** The faint last-run marker of each step. The daemon's history is the newest mark across all runs, so what the run on screen marked itself is left out. */
export function markersOf(history: Record<string, StepHistory>, runId: string): Record<string, OutcomeState> {
  const out: Record<string, OutcomeState> = {};
  for (const [id, h] of Object.entries(history)) if (h.run !== runId) out[id] = h.outcome.state;
  return out;
}

export const summaryProgress = (counts: RunCounts): Progress => {
  const total = STATES.reduce((n, s) => n + counts[s], 0);
  return { counts, done: total - counts.pending, total };
};

const same = (a: PlanStep, b: PlanStep) => a.id === b.id && a.action === b.action && a.expected === b.expected && a.path === b.path;

/** True when the plan's steps are no longer the ones this run started with. */
export function planChanged(run: Pick<Run, "steps">, plan: Pick<Plan, "steps">): boolean {
  return run.steps.length !== plan.steps.length || run.steps.some((s, i) => !same(s, plan.steps[i]!));
}

export type Row = { kind: "step"; step: PlanStep; number: number } | { kind: "proposal"; proposal: Proposal };

/** Steps in order, each proposal right after the step it names. One naming a step that is gone goes last. */
export function rowsOf(steps: PlanStep[], proposals: Proposal[]): Row[] {
  const ids = new Set(steps.map((s) => s.id));
  const after = (key: string) => proposals.filter((p) => (p.after === "start" ? "start" : ids.has(p.after) ? p.after : "") === key).map((proposal): Row => ({ kind: "proposal", proposal }));
  return [...after("start"), ...steps.flatMap((step, i): Row[] => [{ kind: "step", step, number: i + 1 }, ...after(step.id)]), ...after("")];
}

const PROBLEMS: OutcomeState[] = ["fail", "blocked"];

/** "5/12 · 1 fail": only the states that need a look are named. */
export function countsLine(p: Progress): string {
  const bad = PROBLEMS.filter((s) => p.counts[s] > 0).map((s) => `${p.counts[s]} ${s}`);
  return [`${p.done}/${p.total}`, ...bad].join(" · ");
}

/** "Run 3 · 5/12 · 1 fail". */
export const runLine = (n: number, p: Progress): string => `Run ${n} · ${countsLine(p)}`;

export const lastRunLine = (run: RunSummary | null): string => (run ? countsLine(summaryProgress(run.counts)) : "Not run yet");

/** A plan's last touch is its newest edit or run, so a plan you just ran rises. */
const activityOf = (p: PlanSummary) => Math.max(p.updatedAt, p.lastRun?.startedAt ?? 0);

export const sortPlans = (plans: PlanSummary[]): PlanSummary[] => [...plans].sort((a, b) => activityOf(b) - activityOf(a) || a.title.localeCompare(b.title));

export const runsNewestFirst = (runs: RunSummary[]): RunSummary[] => [...runs].sort((a, b) => b.startedAt - a.startedAt);

/** The number of a run in a newest-first list: its place counted from the oldest, 0 when it is not there. */
export function runNumber(newestFirst: RunSummary[], id: string): number {
  const i = newestFirst.findIndex((r) => r.id === id);
  return i < 0 ? 0 : newestFirst.length - i;
}

/** What a step's outcome says in words: what actually happened for a failure, the note otherwise. */
export const outcomeDetail = (o: Outcome): string => (o.state === "fail" ? o.actual : o.state === "pending" ? "" : o.note);

export const bugOf = (o: Outcome): string | null => (o.state === "fail" ? o.bug : null);

/** The path of a preview URL, or null when it is not a page URL (about:blank, a typo). */
export function pathOf(url: string): StepPath | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.pathname : null;
  } catch {
    return null;
  }
}

export type FromKind = PlanSource["kind"];

/** What "Draft from" chose, as the plan source the daemon takes. Null when the choice still lacks its input, and for Blank, which drafts nothing. */
export function sourceOf(c: { kind: FromKind; page: StepPath | null; dir: string; base: string }): PlanSource | null {
  switch (c.kind) {
    case "page":
      return c.page ? { kind: "page", path: c.page } : null;
    case "spec":
      return c.dir ? { kind: "spec", dir: c.dir } : null;
    case "diff":
      return c.base ? { kind: "diff", base: c.base, head: "HEAD" } : null;
    case "text":
      return { kind: "text" };
    case "manual":
      return null;
  }
}

/** What a running QA session is doing, for the "…" marker next to a plan. */
export const SESSION_LABEL: Record<QaSession["kind"], string> = { draft: "Drafting…", suggest: "Suggesting…", explore: "Exploring…", run: "Agent running…", map: "Mapping features…" };

export const sessionLabel = (s: Pick<QaSession, "kind" | "running"> | null): string | null => (s?.running ? SESSION_LABEL[s.kind] : null);

/** A feature's coverage as a word and a badge tone: a status color always comes with the word. */
export const COVERAGE: Record<Coverage, { label: string; tone: "neutral" | "red" | "amber" | "green" }> = {
  "no-plan": { label: "no plan", tone: "neutral" },
  "not-run": { label: "not run", tone: "neutral" },
  failing: { label: "failing", tone: "red" },
  partial: { label: "partly tested", tone: "amber" },
  passing: { label: "passing", tone: "green" },
};

/** Worst first, so what needs attention is at the top; the map's own order breaks ties. */
const COVERAGE_ORDER: Coverage[] = ["failing", "partial", "not-run", "no-plan", "passing"];
export const sortFeatures = <T extends { coverage: Coverage }>(list: T[]): T[] => list.map((f, i) => ({ f, i })).sort((a, b) => COVERAGE_ORDER.indexOf(a.f.coverage) - COVERAGE_ORDER.indexOf(b.f.coverage) || a.i - b.i).map((x) => x.f);

/** The plans an end-to-end run of these features covers: each linked plan that exists and has steps, once. */
export function e2ePlansOf(features: Array<{ planInfo: Array<{ slug: string; exists: boolean; steps: number }> }>): string[] {
  const out: string[] = [];
  for (const f of features) for (const p of f.planInfo) if (p.exists && p.steps > 0 && !out.includes(p.slug)) out.push(p.slug);
  return out;
}

/** "2 of 5 plans · now: checkout-flow" for a batch going; a finished one says how it ended. */
export function batchLine(b: Pick<BatchView, "plans" | "next" | "current" | "running" | "cancelled" | "errors">): string {
  const skipped = b.errors.length ? ` · ${b.errors.length} could not start` : "";
  if (b.running && b.current) return `${b.next} of ${b.plans.length} plans · now: ${b.current}${skipped}`;
  if (b.cancelled) return `Cancelled after ${b.next} of ${b.plans.length} plans${skipped}`;
  return `Ran ${b.plans.length - b.errors.length} of ${b.plans.length} plans${skipped}`;
}
