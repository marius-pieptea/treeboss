import * as React from "react";
import { ChevronsUpDown, ClipboardCheck, Plus } from "lucide-react";
import { WhoPicker, useWho } from "@/components/agent-who";
import { Button, IconButton } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Banner } from "./Banner";
import { Empty, Kbd, Skeleton } from "@/components/ui/misc";
import { type BugDraft, type Outcome, type OutcomeInput, type PlanEdit, type PlanStep, usePlan, usePlans, useQaActions, useRun } from "./api";
import { openSession } from "@/features/agent/agent-commands";
import { useQaIntent } from "./intent";
import { NewPlanDialog } from "./NewPlanDialog";
import { ProposalRow } from "./ProposalRow";
import { RunHeader } from "./RunHeader";
import { StepEditor } from "./StepEditor";
import { type Ask, StepActions, StepRow } from "./StepRow";
import { SuggestDialog } from "./SuggestDialog";
import { bugDraftOf, currentStep, keyFor, markersOf, nextStep, pathOf, planChanged, prevStep, progress, rowsOf, switchesStep } from "./logic";

export interface QaPanelProps {
  root: string;
  currentUrl: string | null;
  onNavigate: (path: string) => void;
  /** The host files the bug and calls `done` with its id, or null when none was filed. */
  onFail: (draft: BugDraft, done: (bugId: string | null) => void) => void;
  /** What the preview recorded (console, network, clicks) since the step became current. */
  recordedSince: (stepStartedAt: number) => string[];
  /** Show the current step only, with an expander. The host sets it when the panel is docked as a strip. */
  compact: boolean;
}

const isField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
};

export function QaPanel({ root, currentUrl, onNavigate, onFail, recordedSince, compact }: QaPanelProps) {
  const plans = usePlans(root);
  const actions = useQaActions(root);
  const [who, setWho] = useWho();
  const [slug, setSlug] = React.useState<string | null>(null);
  const [runId, setRunId] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [dialog, setDialog] = React.useState<null | "new" | "suggest">(null);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    if (!slug || !plans.data?.some((p) => p.slug === slug)) setSlug(plans.data?.[0]?.slug ?? null);
  }, [plans.data, slug]);

  const wanted = useQaIntent((s) => s.slug);
  React.useEffect(() => {
    if (!wanted || !plans.data) return;
    if (plans.data.some((p) => p.slug === wanted)) pick(wanted);
    useQaIntent.getState().clear();
  }, [wanted, plans.data]);

  const view = usePlan(root, slug);
  const plan = view.data?.plan;
  const runs = React.useMemo(() => [...(view.data?.runs ?? [])].sort((a, b) => a.startedAt - b.startedAt), [view.data?.runs]);
  const latest = runs.at(-1) ?? null;
  const resumeId = latest && !latest.finished ? latest.id : null;
  const run = useRun(root, runId).data;
  const readOnly = !!run && run.id !== latest?.id;
  const last = React.useMemo(() => (run && !readOnly ? markersOf(view.data?.lastOutcomes ?? {}, run.id) : {}), [run, readOnly, view.data?.lastOutcomes]);

  const pick = (s: string) => {
    setSlug(s);
    setRunId(null);
    setEditing(false);
  };

  const [cursor, setCursor] = React.useState<string | null>(null);
  const [ask, setAsk] = React.useState<Ask>(null);
  const [note, setNote] = React.useState("");
  const [actual, setActual] = React.useState("");
  const startedAt = React.useRef(Date.now());
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [live, setLive] = React.useState(false);

  const select = React.useCallback(
    (id: string | null) => {
      setCursor(id);
      setAsk(null);
      startedAt.current = Date.now();
      const o = run?.steps.find((s) => s.id === id)?.outcome;
      setNote(o && o.state !== "pending" && o.state !== "fail" ? o.note : "");
      setActual(o?.state === "fail" ? o.actual : "");
    },
    [run],
  );
  const openedRun = run?.id;
  React.useEffect(() => {
    if (run) select((currentStep(run) ?? run.steps[0])?.id ?? null);
  }, [openedRun]);

  const start = async () => {
    if (!slug) return;
    if (resumeId) return setRunId(resumeId), void 0;
    startNew();
  };
  const startNew = () => slug && actions.start.mutate(slug, { onSuccess: (r) => setRunId(r.run.id) });

  const mark = (stepId: string, outcome: OutcomeInput) => {
    if (!run || readOnly) return;
    const next = nextStep(run, stepId)?.id ?? stepId;
    const saved = { runId: run.id, stepId, outcome };
    const since = startedAt.current;
    void actions.mark
      .mutateAsync(saved)
      .then(({ run: updated }) => {
        select(next);
        const at = document.activeElement;
        if (!at || at === document.body || rootRef.current?.contains(at)) rootRef.current?.focus({ preventScroll: true });
        if (outcome.state !== "fail") return;
        const draft = bugDraftOf(updated, stepId, recordedSince(since));
        if (draft) onFail(draft, (bug) => bug && void actions.mark.mutateAsync({ ...saved, outcome: { ...outcome, bug } }).catch(() => {}));
      })
      .catch(() => {});
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!run || !e.currentTarget.contains(e.target as Node)) return;
    const k = keyFor({ ...e, key: e.key, editable: isField(e.target) || (e.key === "Enter" && (e.target as HTMLElement).tagName === "BUTTON") });
    if (!k) return;
    const at = cursor ? run.steps.find((s) => s.id === cursor) : undefined;
    if (!at) return;
    e.preventDefault();
    if (k === "next" || k === "prev") {
      const to = (k === "next" ? nextStep(run, at.id) : prevStep(run, at.id))?.id ?? at.id;
      return switchesStep(cursor, to) ? select(to) : undefined;
    }
    if (k === "go") return at.path ? onNavigate(at.path) : undefined;
    if (readOnly) return;
    if (k === "fail") return setAsk("fail");
    if (k === "blocked") return note.trim() ? mark(at.id, { state: "blocked", note: note.trim() }) : setAsk("blocked");
    mark(at.id, { state: k, note: note.trim() });
  };

  const edit = (e: PlanEdit) => slug && actions.edit.mutate({ slug, edit: e });
  const accept = (pid: string | "all", decision: "accept" | "reject") => slug && actions.decide.mutate({ slug, pid, decision });
  const move = (steps: PlanStep[], i: number, dir: -1 | 1) => edit({ op: "move", id: steps[i]!.id, after: dir === -1 ? (steps[i - 2]?.id ?? "start") : steps[i + 1]!.id });
  const remove = async () => {
    if (!slug || !(await confirm({ title: `Delete “${plan?.title ?? slug}”?`, description: "Its runs go with it.", confirmLabel: "Delete", danger: true }))) return;
    actions.remove.mutate(slug, { onSuccess: () => setSlug(null) });
  };

  const session = view.data?.session ?? null;
  const drafting = !!session?.running;
  const pagePath = currentUrl ? pathOf(currentUrl) : null;
  const prog = run ? progress(run) : null;
  const rows = plan ? rowsOf(plan.steps, plan.proposals) : [];
  const collapsed = compact && !expanded;
  const cur = run?.steps.find((s) => s.id === cursor);

  const actionsFor = (s: { id: string; outcome: Outcome }) =>
    readOnly ? null : <StepActions outcome={s.outcome} ask={ask} note={note} actual={actual} onNote={setNote} onActual={setActual} onAsk={setAsk} onMark={(o) => mark(s.id, o)} />;

  let body: React.ReactNode;
  if (plans.isPending || (slug && view.isPending)) {
    body = (
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  } else if (!slug || !plan) {
    body = <Empty icon={<ClipboardCheck />} title="No QA plans yet" hint="Draft one from this page, a spec or your changes, then walk through it here." action={<Button variant="primary" size="sm" onClick={() => setDialog("new")}><Plus /> New plan</Button>} />;
  } else if (run && !editing) {
    body = collapsed ? (
      cur ? (
        <div className="p-3">
          <StepRow step={cur} number={run.steps.indexOf(cur) + 1} outcome={cur.outcome} last={last[cur.id]} current pagePath={pagePath} onSelect={() => {}} onNavigate={onNavigate}>
            {actionsFor(cur)}
          </StepRow>
        </div>
      ) : null
    ) : (
      <div className="flex flex-col gap-1 p-2">
        {planChanged(run, plan) && <Banner>Plan changed since this run started. This run keeps its own steps.</Banner>}
        {run.steps.map((s, i) => (
          <StepRow key={s.id} step={s} number={i + 1} outcome={s.outcome} last={last[s.id]} current={s.id === cursor} pagePath={pagePath} onSelect={() => switchesStep(cursor, s.id) && select(s.id)} onNavigate={onNavigate}>
            {actionsFor(s)}
          </StepRow>
        ))}
      </div>
    );
  } else {
    const steps = plan.steps;
    body = (
      <div className="flex flex-col gap-1 p-2">
        {plan.problem && <Banner tone="danger">{plan.problem}</Banner>}
        {plan.proposalsProblem && <Banner>{plan.proposalsProblem}</Banner>}
        {session?.problem && !drafting && <Banner>{session.problem}</Banner>}
        {plan.intro && !editing && <p className="px-2 pb-1 text-xs leading-relaxed text-fg-muted">{plan.intro}</p>}
        {steps.length === 0 && plan.proposals.length === 0 && !drafting && <Empty title="No steps yet" hint={editing ? undefined : "Edit the plan to add the first step."} />}
        {rows.map((r) =>
          r.kind === "proposal" ? (
            <ProposalRow key={r.proposal.id} proposal={r.proposal} busy={actions.decide.isPending} onDecide={(d) => accept(r.proposal.id, d)} />
          ) : editing ? (
            <StepEditor key={r.step.id} step={r.step} number={r.number} first={r.number === 1} last={r.number === steps.length} onUpdate={(fields) => edit({ op: "update", id: r.step.id, fields })} onMove={(d) => move(steps, r.number - 1, d)} onRemove={() => edit({ op: "remove", id: r.step.id })} />
          ) : (
            <StepRow key={r.step.id} step={r.step} number={r.number} current={false} pagePath={pagePath} onSelect={() => {}} onNavigate={onNavigate} />
          ),
        )}
        {editing && (
          <Button size="sm" variant="outline" className="self-start" onClick={() => edit({ op: "add", step: { action: "New step", expected: "", path: null }, after: steps.at(-1)?.id ?? "start" })}>
            <Plus /> Add step
          </Button>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} onFocus={(e) => setLive(!isField(e.target))} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setLive(false)} data-live={live || undefined} data-compact={compact || undefined} className="flex h-full min-h-0 flex-col bg-panel text-fg outline-none data-[live]:ring-[1.5px] data-[live]:ring-inset data-[live]:ring-accent">
      <RunHeader
        plans={plans.data ?? []}
        slug={slug}
        onSlug={pick}
        onNew={() => setDialog("new")}
        runs={runs}
        runId={editing ? null : (run?.id ?? runId)}
        progress={editing ? null : prog}
        session={session}
        onOpenSession={openSession}
        editing={editing}
        proposals={plan?.proposals.length ?? 0}
        canStart={!!plan && plan.steps.length > 0 && !editing && (!run || readOnly)}
        canStartNew={!!plan && plan.steps.length > 0 && !actions.start.isPending}
        resumeId={resumeId}
        compact={collapsed}
        onSuggest={() => setDialog("suggest")}
        onToggleEdit={() => (setRunId(null), setEditing((v) => !v))}
        onDelete={remove}
        onStart={start}
        onStartNew={startNew}
        onOpenRun={(id) => (setEditing(false), setRunId(id))}
        onAcceptAll={() => accept("all", "accept")}
      />
      {slug && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="text-label uppercase tracking-label text-fg-muted">Agent</span>
          <WhoPicker who={who} onChange={setWho} inline />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      {run && !editing && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5 text-[11px] text-fg-muted">
          {compact ? (
            <IconButton label={expanded ? "Show the current step only" : "Show all steps"} size="icon-sm" onClick={() => setExpanded((v) => !v)}>
              <ChevronsUpDown />
            </IconButton>
          ) : (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span><Kbd>P</Kbd> pass</span>
              <span><Kbd>F</Kbd> fail</span>
              <span><Kbd>S</Kbd> skip</span>
              <span><Kbd>B</Kbd> blocked</span>
              <span><Kbd>↑</Kbd><Kbd className="ml-0.5">↓</Kbd> move</span>
              <span><Kbd>↵</Kbd> open page</span>
            </span>
          )}
          {compact && <span>{expanded ? "All steps" : "Current step"}</span>}
        </footer>
      )}
      <NewPlanDialog
        root={root}
        currentUrl={currentUrl}
        open={dialog === "new"}
        onOpenChange={(o) => !o && setDialog(null)}
        busy={actions.create.isPending}
        onSubmit={(input) =>
          actions.create.mutate(input, {
            onSuccess: (r) => {
              setDialog(null);
              pick(r.plan.slug);
            },
          })
        }
      />
      <SuggestDialog
        open={dialog === "suggest"}
        onOpenChange={(o) => !o && setDialog(null)}
        busy={actions.suggest.isPending}
        onSubmit={(focus, n) => slug && actions.suggest.mutate({ slug, focus, note: n, ...who }, { onSuccess: () => setDialog(null) })}
      />
    </div>
  );
}
