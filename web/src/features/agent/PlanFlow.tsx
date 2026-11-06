/**
 * Plan mode's pieces for the status slot above the composer (StatusSlot): the questionnaire card and the plan-ready
 * row, plus the "Plan ready" chip the thread shows where a plan landed.
 *
 * The agent asks one question at a time (with options, a recommendation, a written answer) through `plan_ask`,
 * then hands in a plan with `plan_submit`. The operator answers here, reviews earlier answers, and decides on the
 * plan in its own tab (PlanViewer): it is a markdown file in the workspace, opened as soon as it lands.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronRight, ClipboardList, ExternalLink, Hammer, SkipForward } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanOption, PlanQuestion, PlanRecord, PlanState, SessionView } from "@/lib/types";
import { useUi } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";
import { Kbd } from "@/components/ui/misc";
import { usePlanActions, usePlanApprove, usePlanDecisions, usePlanState } from "./plan-data";
import {
  answerPayload,
  answeredQuestions,
  answerSummary,
  approveLabel,
  canAnswer,
  chipLabel,
  defaultSelection,
  optionForKey,
  planTab,
  reviewBack,
  reviewForward,
  shouldAutoOpen,
  stepLabel,
  toggleChoice,
} from "./plan-logic";

/** Which plans already opened their tab, so a reload does not reopen a tab the operator closed. Best effort: storage can be blocked. */
const OPENED_KEY = "trb.plan.opened.v1";
function loadOpened(): Set<string> {
  try {
    return new Set<string>(JSON.parse(sessionStorage.getItem(OPENED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
function saveOpened(set: Set<string>): void {
  try {
    sessionStorage.setItem(OPENED_KEY, JSON.stringify([...set].slice(-60)));
  } catch {}
}

/** Open (and focus) a plan's tab. A plan from before plan files gets its file written first. */
export function useOpenPlan(session: Pick<SessionView, "id">) {
  const { root } = useWorkspace();
  const openTab = useUi((s) => s.openTab);
  const dec = usePlanDecisions(session.id, root);
  return async (plan: PlanRecord) => {
    const p = plan.path ? plan : (await dec.materialize.mutateAsync(plan.id)).plan;
    openTab(planTab(p, root, session.id));
  };
}

/** The compact "Plan ready: open" chip, for the dock and the thread. */
export function PlanChip({ plan, onOpen, className }: { plan: Pick<PlanRecord, "title" | "version" | "status" | "path" | "edited">; onOpen: () => void; className?: string }) {
  const approved = plan.status === "approved";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-plan-chip={plan.status}
      title={plan.path ? `Open ${plan.path}` : "Open the plan"}
      className={cn("group flex w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] outline-none transition-colors focus-visible:border-violet/60", approved ? "border-line bg-panel/60 text-fg-muted hover:bg-hover" : "border-violet/40 bg-violet/10 text-fg hover:bg-violet/15", className)}
    >
      {approved ? <Check className="size-3.5 shrink-0 text-green" strokeWidth={2.6} /> : <ClipboardList className="size-3.5 shrink-0 text-violet" />}
      <span className="min-w-0 flex-1 truncate">
        <span className={cn("font-medium", approved ? "text-fg" : "text-violet")}>{chipLabel(plan).split(": ")[0]}:</span> {plan.title}
        {plan.edited && <span className="ml-1.5 text-[10.5px] text-amber">edited</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-fg-muted group-hover:text-fg">
        {approved ? "Open" : "Review"} <ExternalLink className="size-3" />
      </span>
    </button>
  );
}

/** The chip the thread shows where a plan landed: it follows the plan's current state and opens its tab. */
export function PlanThreadChip({ sessionId, item }: { sessionId: string; item: { version: number; title: string; path: string | null } }) {
  const state = usePlanState(sessionId, true);
  const open = useOpenPlan({ id: sessionId });
  const live = state.data?.plans.find((p) => (item.path ? p.path === item.path : true) && p.version === item.version) ?? null;
  if (!live) return null;
  return <PlanChip plan={live} onOpen={() => void open(live)} />;
}

/** A plan that has just landed opens in its own tab, once. Mounted by the status slot for as long as the session shows. */
export function usePlanAutoOpen(session: SessionView, plan: PlanRecord | null) {
  const open = useOpenPlan(session);
  const openedRef = useRef<Set<string> | null>(null);
  const inPlan = session.mode === "plan";
  useEffect(() => {
    if (!plan?.path || !inPlan) return;
    openedRef.current ??= loadOpened();
    if (!shouldAutoOpen(plan, openedRef.current)) return;
    openedRef.current.add(plan.id);
    saveOpened(openedRef.current);
    void open(plan);
  }, [plan?.id, plan?.path, inPlan]);
}

/**
 * The one row above the composer once a plan is written: Open it, skip it, or approve it. The plan tab's bar has the
 * same buttons on the same state; both only exist for a draft plan whose turn is over.
 */
export function PlanReadyRow({ session, plan }: { session: SessionView; plan: PlanRecord }) {
  const { root } = useWorkspace();
  const open = useOpenPlan(session);
  const dec = usePlanDecisions(session.id, root);
  const approver = usePlanApprove(session.id, root);
  const busy = approver.pending || dec.skip.isPending;
  return (
    <div data-plan-row data-plan-id={plan.id} className="flex items-center gap-2 rounded-lg border border-violet/40 bg-violet/10 px-2.5 py-1.5 text-[12px]">
      <ClipboardList className="size-3.5 shrink-0 text-violet" />
      <span className="min-w-0 flex-1 truncate" title={plan.path ? `Open ${plan.path}` : undefined}>
        <span className="font-medium text-violet">Plan{plan.version > 1 ? ` v${plan.version}` : ""}:</span> {plan.title}
        {plan.edited && <span className="ml-1.5 text-[10.5px] text-amber">edited</span>}
      </span>
      <Button size="icon-xs" variant="ghost" data-plan-row-open aria-label="Open the plan in its own tab" onClick={() => void open(plan)} title="Open the plan in its own tab">
        <ExternalLink />
      </Button>
      <Button size="xs" variant="ghost" data-plan-row-skip disabled={busy} onClick={() => dec.skip.mutate(plan.id)} title="Leave plan mode and let the agent carry on without the plan">
        Skip plan
      </Button>
      <Button size="xs" variant="primary" data-plan-row-approve disabled={busy} onClick={() => approver.approve(plan)} title={plan.depth === "spec" ? "Approve the spec and plan, then continue in Specs" : "Leave plan mode and tell the agent to build this plan"}>
        <Hammer /> {approveLabel(plan)}
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Questions                                                                  */
/* -------------------------------------------------------------------------- */

function CardHeader({ icon, title, right }: { icon?: React.ReactNode; title: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-violet/15 px-3 py-1.5 text-[11.5px]">
      {icon ?? <ClipboardList className="size-3.5 shrink-0 text-violet" />}
      <span className="font-medium text-violet">{title}</span>
      <span className="ml-auto flex items-center gap-1.5">{right}</span>
    </div>
  );
}

function Dots({ done, total, current }: { done: number; total: number; current: number | null }) {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cn("size-1.5 rounded-full transition-colors", i < done ? "bg-violet" : "bg-violet/25", current === i && "ring-2 ring-violet/40")} />
      ))}
    </span>
  );
}

function OptionRow({ index, option, selected, multi, readOnly, onPick }: { index: number; option: PlanOption; selected: boolean; multi: boolean; readOnly: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={readOnly}
      onClick={onPick}
      data-plan-option={option.label}
      data-selected={selected || undefined}
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-md border px-2.5 py-1.5 text-left outline-none transition-[background,border-color] duration-100 disabled:cursor-default",
        selected ? "border-violet/60 bg-violet/10" : "border-line bg-panel/60 enabled:hover:border-line-strong enabled:hover:bg-hover focus-visible:border-violet/50",
      )}
    >
      <span className={cn("mt-px flex size-4 shrink-0 items-center justify-center rounded border font-mono text-[10px]", selected ? "border-violet bg-violet text-white" : "border-line-strong text-fg-faint", multi ? "rounded" : "rounded-full")}>
        {selected ? <Check className="size-2.5" strokeWidth={3} /> : index + 1}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium text-fg">
          {option.label}
          {option.recommended && <span className="rounded bg-violet/15 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-violet">Recommended</span>}
        </span>
        {option.description && <span className="mt-px block text-[11.5px] leading-snug text-fg-muted">{option.description}</span>}
        {option.recommended && option.reason && <span className="mt-0.5 block text-[11px] leading-snug text-violet/90">Why: {option.reason}</span>}
      </span>
    </button>
  );
}

export function QuestionnaireCard({ session, state, question }: { session: SessionView; state: PlanState; question: PlanQuestion }) {
  const actions = usePlanActions(session.id);
  const answered = useMemo(() => answeredQuestions(state), [state]);
  const [choices, setChoices] = useState<string[]>(() => defaultSelection(question));
  const [custom, setCustom] = useState("");
  const [review, setReview] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const customRef = useRef<HTMLTextAreaElement>(null);
  const reviewing = review !== null ? answered[review] : null;
  const shown = reviewing ?? question;
  const draft = { choices, custom };
  const sending = actions.answer.isPending;

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  const submit = () => {
    if (reviewing || sending || !canAnswer(question, draft)) return;
    actions.answer.mutate(answerPayload(question, draft));
  };
  const skip = () => {
    if (!reviewing && !sending) actions.answer.mutate({ question_id: question.id, skip: true });
  };

  // 1-9 pick an option, Enter confirms. Typing in the composer or any other field is never ours.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing && !root.current?.contains(t)) return;
      if (typing && t === customRef.current) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
        return;
      }
      if (reviewing) return;
      const opt = optionForKey(e.key, question.options);
      if (opt) {
        e.preventDefault();
        setChoices((c) => toggleChoice(question, c, opt.label));
        if (!question.multi) setCustom("");
      } else if (e.key === "Enter" && canAnswer(question, draft)) {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  return (
    <div ref={root} tabIndex={-1} data-plan-question={question.id} className="outline-none">
      <CardHeader
        title={reviewing ? `Question ${reviewing.seq} (answered)` : stepLabel(question, state.expected_total)}
        right={
          <>
            <Dots done={answered.length} total={Math.max(state.expected_total, question.seq)} current={reviewing ? review : answered.length} />
            {answered.length > 0 && (
              <>
                <button type="button" onClick={() => setReview(reviewBack(review, answered.length))} disabled={review === 0} className="flex items-center gap-0.5 rounded px-1 text-fg-muted outline-none hover:text-fg focus-visible:text-fg disabled:opacity-40" data-plan-back>
                  <ArrowLeft className="size-3" /> Back
                </button>
                {reviewing && (
                  <button type="button" onClick={() => setReview(reviewForward(review, answered.length))} className="flex items-center gap-0.5 rounded px-1 text-fg-muted outline-none hover:text-fg focus-visible:text-fg">
                    {review !== null && review + 1 >= answered.length ? "Current question" : "Next"} <ArrowRight className="size-3" />
                  </button>
                )}
              </>
            )}
          </>
        }
      />
      <div className="flex flex-col gap-2 px-3 py-2.5">
        {!reviewing && answered.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {answered.map((q, i) => (
              <li key={q.id}>
                <button type="button" onClick={() => setReview(i)} className="flex w-full min-w-0 items-center gap-1.5 rounded text-left text-[11.5px] text-fg-muted outline-none hover:text-fg focus-visible:text-fg" data-plan-answered={q.id}>
                  <Check className="size-3 shrink-0 text-green" strokeWidth={2.6} />
                  <span className="truncate">{q.question}</span>
                  <ChevronRight className="size-3 shrink-0 text-fg-faint" />
                  <span className="max-w-[45%] shrink-0 truncate font-medium text-fg">{answerSummary(q.answer)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-[13px] font-semibold leading-snug text-fg">{shown.question}</p>

        <div role={shown.multi ? "group" : "radiogroup"} className="flex flex-col gap-1.5">
          {shown.options.map((o, i) => (
            <OptionRow
              key={o.label}
              index={i}
              option={o}
              multi={shown.multi}
              readOnly={!!reviewing}
              selected={reviewing ? (reviewing.answer?.choices ?? []).includes(o.label) : choices.includes(o.label)}
              onPick={() => {
                setChoices((c) => toggleChoice(question, c, o.label));
                if (!question.multi) setCustom("");
              }}
            />
          ))}
        </div>

        {shown.allow_custom &&
          (reviewing ? (
            reviewing.answer?.custom && <p className="rounded-md border border-violet/40 bg-violet/10 px-2.5 py-1.5 text-[12px] text-fg">{reviewing.answer.custom}</p>
          ) : (
            <Textarea
              ref={customRef}
              rows={custom ? 2 : 1}
              value={custom}
              placeholder="Something else…"
              data-plan-custom
              onChange={(e) => {
                setCustom(e.target.value);
                if (e.target.value && !question.multi) setChoices([]);
              }}
              className="min-h-0 resize-none px-2.5 py-1.5 text-[12.5px]"
            />
          ))}
        {reviewing?.answer?.skipped && <p className="text-[11.5px] text-fg-faint">You skipped this one.</p>}

        {!reviewing && (
          <div className="flex items-center gap-2 pt-0.5">
            <Button size="sm" variant="primary" onClick={submit} disabled={!canAnswer(question, draft) || sending} data-plan-answer>
              {sending ? "Sending…" : "Answer"} <Kbd className="border-white/30 bg-white/15 text-accent-fg">↵</Kbd>
            </Button>
            <Button size="sm" variant="ghost" onClick={skip} disabled={sending} data-plan-skip title="Let the agent use its recommendation">
              <SkipForward /> Skip
            </Button>
            <span className="ml-auto text-[10.5px] text-fg-faint">
              <Kbd>1</Kbd>–<Kbd>{Math.min(9, question.options.length)}</Kbd> to pick
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
