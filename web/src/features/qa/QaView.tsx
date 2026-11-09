import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Bug, ChevronRight, ClipboardCheck, Compass, Globe, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Badge, Empty, SegTabs, Skeleton, Spinner } from "@/components/ui/misc";
import { PaneSplitter, usePaneWidth } from "@/components/ui/splitter";
import { openSession } from "@/features/agent/agent-commands";
import { ago } from "@/features/specs/logic";
import { cn } from "@/lib/utils";
import { type PlanSummary, type PlanView, type QaActions, type RunSummary, type StepHistory, usePlan, usePlans, useQaActions, useRun } from "./api";
import { Banner } from "./Banner";
import { FeaturesView } from "./FeaturesView";
import { bugOf, countsLine, lastRunLine, outcomeDetail, runNumber, runsNewestFirst, sessionLabel, sortPlans, summaryProgress } from "./logic";
import { NewPlanDialog } from "./NewPlanDialog";
import { ProgressBar } from "./RunHeader";
import { OutcomeIcon } from "./StepRow";
import { SuggestDialog } from "./SuggestDialog";

export interface QaViewProps {
  root: string;
  /** Open the bug finding a failed step logged. Without it the step only says a bug is linked. */
  onOpenBug?: (findingId: string) => void;
  /** Open the browser tab with the QA panel on and this plan selected. Without it the button is not shown. */
  onRunInBrowser?: (slug: string) => void;
}

type Pane = "plans" | "features";

/** QA: the plans and their runs, and the feature map that says what each plan covers. */
export function QaView(props: QaViewProps) {
  const [pane, setPane] = React.useState<Pane>("plans");
  const [picked, setPicked] = React.useState<string | null>(null);
  const openPlan = (slug: string) => {
    setPicked(slug);
    setPane("plans");
  };
  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <SegTabs
          value={pane}
          onChange={setPane}
          items={[
            { value: "plans", label: "Plans" },
            { value: "features", label: "Features" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">{pane === "plans" ? <PlansPane {...props} picked={picked} setPicked={setPicked} /> : <FeaturesView root={props.root} onOpenPlan={openPlan} />}</div>
    </div>
  );
}

function PlansPane({ root, onOpenBug, onRunInBrowser, picked, setPicked }: QaViewProps & { picked: string | null; setPicked: (slug: string | null) => void }) {
  const plans = usePlans(root);
  const actions = useQaActions(root);
  const [dialog, setDialog] = React.useState<null | "new" | "suggest">(null);
  const listWidth = usePaneWidth("qa.list", 360);

  const sorted = React.useMemo(() => sortPlans(plans.data ?? []), [plans.data]);
  const slug = sorted.find((p) => p.slug === picked)?.slug ?? sorted[0]?.slug ?? null;
  const view = usePlan(root, slug);
  const session = view.data?.session ?? null;

  // The agent edits the plan file while it runs: the list (step and proposal counts) must be read again once it stops.
  const qc = useQueryClient();
  const running = !!session?.running;
  const wasRunning = React.useRef(false);
  React.useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: ["qa", root] });
    wasRunning.current = running;
  }, [running]);

  const remove = async (p: PlanSummary) => {
    if (!(await confirm({ title: `Delete “${p.title}”?`, description: "Its runs go with it.", confirmLabel: "Delete", danger: true }))) return;
    actions.remove.mutate(p.slug, { onSuccess: () => setPicked(null) });
  };

  const current = sorted.find((p) => p.slug === slug) ?? null;
  const empty = !plans.isPending && !plans.error && sorted.length === 0;

  return (
    <div className="flex h-full bg-bg text-fg">
      <div style={empty ? undefined : { width: listWidth }} className={cn("flex flex-col bg-panel", empty ? "min-w-0 flex-1" : "shrink-0")}>
        <header className="flex flex-col gap-2 border-b border-line p-3">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="size-4 text-accent" />
            <h1 className="flex-1 text-[15px] font-semibold">QA</h1>
            <Button size="sm" variant="outline" onClick={() => setDialog("new")}>
              <Plus /> New plan
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-fg-muted">Test plans, run by hand in the browser or by an agent, and how each run went.</p>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {plans.isPending ? (
            <div className="grid gap-2 p-3">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : plans.error ? (
            <div className="p-3 text-xs text-red">{(plans.error as Error).message}</div>
          ) : empty ? (
            <Empty
              icon={<ClipboardCheck />}
              title="No QA plans yet"
              hint="Draft one from a page, a spec or your changes, or let an agent explore the app. Run it by hand or with an agent; every run lands here."
              action={
                <Button size="sm" variant="primary" onClick={() => setDialog("new")}>
                  <Plus /> New plan
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-1 p-2">
              {sorted.map((p) => (
                <li key={p.slug}>
                  <PlanRow plan={p} selected={p.slug === slug} marker={p.slug === slug ? sessionLabel(session) : null} onSelect={() => setPicked(p.slug)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {!empty && <PaneSplitter paneKey="qa.list" fallback={360} min={260} max={560} />}

      <div className={cn("min-w-0 flex-1 overflow-auto", empty && "hidden")}>
        {current && view.data ? (
          <PlanDetail
            key={current.slug}
            root={root}
            summary={current}
            view={view.data}
            busy={actions.remove.isPending}
            actions={actions}
            onOpenBug={onOpenBug}
            onRunInBrowser={onRunInBrowser}
            onSuggest={() => setDialog("suggest")}
            onDelete={() => remove(current)}
          />
        ) : current ? (
          <div className="grid gap-2 p-4">
            <Skeleton className="h-8" />
            <Skeleton className="h-24" />
          </div>
        ) : (
          !plans.isPending && <Empty icon={<ClipboardCheck />} title="Select a plan" hint="Its steps, runs and results show here." className="h-full" />
        )}
      </div>

      <NewPlanDialog
        root={root}
        currentUrl={null}
        open={dialog === "new"}
        onOpenChange={(o) => !o && setDialog(null)}
        busy={actions.create.isPending}
        onSubmit={(input) =>
          actions.create.mutate(input, {
            onSuccess: (r) => {
              setDialog(null);
              setPicked(r.plan.slug);
            },
          })
        }
      />
      <SuggestDialog
        open={dialog === "suggest"}
        onOpenChange={(o) => !o && setDialog(null)}
        busy={actions.suggest.isPending}
        onSubmit={(focus, note) => slug && actions.suggest.mutate({ slug, focus, note }, { onSuccess: () => setDialog(null) })}
      />
    </div>
  );
}

function PlanRow({ plan, selected, marker, onSelect }: { plan: PlanSummary; selected: boolean; marker: string | null; onSelect: () => void }) {
  return (
    <button type="button" data-plan={plan.slug} aria-current={selected || undefined} onClick={onSelect} className={cn("flex w-full flex-col gap-1.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors", selected ? "border-line-strong bg-raised" : "border-transparent hover:bg-hover")}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{plan.title}</span>
        {plan.problem && (
          <Badge tone="red" title={plan.problem}>
            problem
          </Badge>
        )}
        {plan.proposals > 0 && (
          <Badge tone="violet" title="Suggested steps waiting for a decision">
            {plan.proposals} proposed
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <span>{plan.steps === 1 ? "1 step" : `${plan.steps} steps`}</span>
        {marker && (
          <span className="flex items-center gap-1">
            <Spinner /> {marker}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {plan.lastRun ? (
          <>
            <div className="w-20 shrink-0">
              <ProgressBar progress={summaryProgress(plan.lastRun.counts)} />
            </div>
            <span className="font-mono text-xs text-fg">{lastRunLine(plan.lastRun)}</span>
            <span className="flex-1" />
            <span className="text-[11px] text-fg-faint">{ago(plan.lastRun.startedAt)}</span>
          </>
        ) : (
          <span className="text-xs text-fg-faint">Not run yet</span>
        )}
      </div>
    </button>
  );
}

type Tab = "steps" | "runs";

interface DetailProps {
  root: string;
  summary: PlanSummary;
  view: PlanView;
  busy: boolean;
  actions: QaActions;
  onOpenBug?: (findingId: string) => void;
  onRunInBrowser?: (slug: string) => void;
  onSuggest: () => void;
  onDelete: () => void;
}

function PlanDetail({ root, summary, view, busy, actions, onOpenBug, onRunInBrowser, onSuggest, onDelete }: DetailProps) {
  const { plan, session } = view;
  const runs = React.useMemo(() => runsNewestFirst(view.runs), [view.runs]);
  const [tab, setTab] = React.useState<Tab>("steps");
  const marker = sessionLabel(session);
  const working = !!session?.running;
  // The run an agent is recording now: its results are read again as they come in.
  const liveRun = working && session?.kind === "run" ? session.runId : null;
  const starting = actions.startAgent.isPending || actions.explore.isPending;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{plan.title}</h2>
          {onRunInBrowser && (
            <Button size="sm" variant="primary" disabled={plan.steps.length === 0} onClick={() => onRunInBrowser(plan.slug)}>
              <Globe /> Run in browser
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={plan.steps.length === 0 || working || starting} title="An agent runs each step in its own browser, records the outcome and logs the bugs it finds" onClick={() => actions.startAgent.mutate({ slug: plan.slug }, { onSuccess: () => setTab("runs") })}>
            <Bot /> Run with agent
          </Button>
          <Button size="sm" variant="outline" disabled={working || starting} title="An agent uses the app around this plan, logs the bugs it finds and suggests the steps it took" onClick={() => actions.explore.mutate({ slug: plan.slug })}>
            <Compass /> Explore
          </Button>
          <Button size="sm" variant="outline" disabled={working} onClick={onSuggest}>
            <Sparkles /> Suggest missing steps
          </Button>
          <Button size="sm" variant="dangerGhost" disabled={busy} onClick={onDelete}>
            <Trash2 /> Delete plan
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span>{plan.steps.length === 1 ? "1 step" : `${plan.steps.length} steps`}</span>
          <span aria-hidden>·</span>
          <span>updated {ago(summary.updatedAt)}</span>
          {marker && session && (
            <span className="flex items-center gap-1">
              <Spinner /> {marker}
              <button type="button" onClick={() => openSession(session.sessionId)} className="text-fg underline underline-offset-2 outline-none hover:text-accent">
                Open session
              </button>
            </span>
          )}
        </div>
        {plan.intro && <p className="text-xs leading-relaxed text-fg-muted">{plan.intro}</p>}
        {plan.problem && <Banner tone="danger">{plan.problem}</Banner>}
        {plan.proposalsProblem && <Banner>{plan.proposalsProblem}</Banner>}
        {session?.problem && !session.running && <Banner>{session.problem}</Banner>}
        {plan.proposals.length > 0 && <Banner>{plan.proposals.length === 1 ? "1 suggested step is" : `${plan.proposals.length} suggested steps are`} waiting for a decision in the browser's QA panel.</Banner>}
      </header>
      <SegTabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "steps", label: "Steps" },
          { value: "runs", label: "Runs", badge: runs.length > 0 ? <span className="font-mono text-[10px] text-fg-faint">{runs.length}</span> : undefined },
        ]}
      />
      {tab === "steps" ? <StepsList view={view} runs={runs} /> : <RunsList root={root} runs={runs} liveRun={liveRun} onOpenBug={onOpenBug} />}
    </div>
  );
}

function StepsList({ view, runs }: { view: PlanView; runs: RunSummary[] }) {
  const { plan, lastOutcomes } = view;
  if (plan.steps.length === 0) return <Empty title="No steps yet" hint="Add steps in the browser's QA panel, or suggest some." />;
  return (
    <ol className="flex flex-col divide-y divide-line rounded-xl border border-line bg-panel">
      {plan.steps.map((s, i) => {
        const last: StepHistory | undefined = lastOutcomes[s.id];
        const detail = last ? outcomeDetail(last.outcome) : "";
        return (
          <li key={s.id} data-step={s.id} className="flex items-start gap-2 px-3 py-2">
            <span className="w-5 shrink-0 pt-px text-right font-mono text-[11px] leading-[18px] text-fg-muted">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] leading-snug">{s.action}</div>
              {s.expected && <div className="mt-1 text-xs leading-snug text-fg-muted">{s.expected}</div>}
              {detail && <div className="mt-1 text-xs leading-snug text-fg-muted">{detail}</div>}
              {last && (
                <div className="mt-1 text-[11px] text-fg-faint">
                  Run {runNumber(runs, last.run) || "?"} · {ago(last.at)}
                </div>
              )}
            </div>
            <OutcomeIcon state={last?.outcome.state ?? "pending"} className="mt-px" />
          </li>
        );
      })}
    </ol>
  );
}

function RunsList({ root, runs, liveRun, onOpenBug }: { root: string; runs: RunSummary[]; liveRun: string | null; onOpenBug?: (findingId: string) => void }) {
  const [open, setOpen] = React.useState<string | null>(liveRun);
  // An agent run that starts while the list is shown opens, so its steps can be watched as they are recorded.
  React.useEffect(() => {
    if (liveRun) setOpen(liveRun);
  }, [liveRun]);
  if (runs.length === 0) return <Empty title="No runs yet" hint="Run this plan in the browser, or with an agent. Each run is kept here." />;
  return (
    <ul className="flex flex-col gap-1">
      {runs.map((r) => {
        const isOpen = open === r.id;
        return (
          <li key={r.id} data-run={r.id} className="rounded-xl border border-line bg-panel">
            <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left outline-none hover:bg-hover">
              <ChevronRight className={cn("size-3.5 shrink-0 text-fg-muted transition-transform duration-150", isOpen && "rotate-90")} />
              <span className="w-12 shrink-0 text-[13px] font-medium">Run {runNumber(runs, r.id)}</span>
              <div className="w-24 shrink-0">
                <ProgressBar progress={summaryProgress(r.counts)} />
              </div>
              <span className="font-mono text-xs">{countsLine(summaryProgress(r.counts))}</span>
              {r.agentSession && (
                <Badge tone="violet" title="An agent walked this run in its own browser">
                  <Bot className="size-3" /> agent
                </Badge>
              )}
              {r.id === liveRun ? (
                <span className="flex items-center gap-1 text-xs text-fg-muted">
                  <Spinner /> running
                </span>
              ) : (
                !r.finished && <Badge>{r.agentSession ? "stopped early" : "in progress"}</Badge>
              )}
              <span className="flex-1" />
              <span className="text-[11px] text-fg-faint">{ago(r.startedAt)}</span>
            </button>
            {isOpen && <RunResults root={root} id={r.id} live={r.id === liveRun} onOpenBug={onOpenBug} />}
          </li>
        );
      })}
    </ul>
  );
}

function RunResults({ root, id, live, onOpenBug }: { root: string; id: string; live: boolean; onOpenBug?: (findingId: string) => void }) {
  const run = useRun(root, id, live);
  if (run.isPending) return <Skeleton className="m-3 h-16" />;
  if (!run.data) return <div className="px-3 pb-3 text-xs text-red">{(run.error as Error | null)?.message ?? "That run is gone."}</div>;
  return (
    <ol className="flex flex-col divide-y divide-line border-t border-line">
      {run.data.steps.map((s, i) => {
        const detail = outcomeDetail(s.outcome);
        const bug = bugOf(s.outcome);
        return (
          <li key={s.id} data-step={s.id} className="flex items-start gap-2 px-3 py-2">
            <span className="w-5 shrink-0 pt-px text-right font-mono text-[11px] leading-[18px] text-fg-muted">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] leading-snug">{s.action}</div>
              {detail && <div className="mt-1 text-xs leading-snug text-fg-muted">{detail}</div>}
              {s.outcome.state === "fail" &&
                (bug ? (
                  onOpenBug ? (
                    <Button size="xs" variant="outline" className="mt-1.5" onClick={() => onOpenBug(bug)}>
                      <Bug /> Open bug
                    </Button>
                  ) : (
                    <Badge tone="red" className="mt-1.5">
                      <Bug className="size-3" /> bug logged
                    </Badge>
                  )
                ) : (
                  <div className="mt-1 text-[11px] text-fg-faint">No bug logged</div>
                ))}
            </div>
            <OutcomeIcon state={s.outcome.state} className="mt-px" />
          </li>
        );
      })}
    </ol>
  );
}
