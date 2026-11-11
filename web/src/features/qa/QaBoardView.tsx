import { useEffect, useMemo, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { toast } from "sonner";
import { Empty, Spinner } from "@/components/ui/misc";
import { usePairs } from "@/lib/queries";
import { useQaActions, useQaBoard } from "./api";
import type { PipelineRequest, Stage } from "./api";
import { FeatureDetailPane } from "./FeatureDetailPane";
import { FeatureGrid } from "./FeatureGrid";
import type { RowAction } from "./FeatureRow";
import { bugFixRequest, defaultForm, findBug, isBusy, mapCell, phaseOf, pipelineRequest, prunePicked, rowRequest, runBlock, scopeLabel, scopeOf, since, type RunForm } from "./logic";
import { OrphanPlans } from "./OrphanPlans";
import { PipelineStrip } from "./PipelineStrip";
import { RunBar } from "./RunBar";
import { useQaDriver } from "./run-choice";
import { CellView } from "./Status";
import { UnsortedBugs } from "./UnsortedBugs";
import type { QaIntent } from "./open";

/** The whole QA view: the run bar and the stages on top, the features and their bugs below, one feature's pane beside them. */
export function QaBoardView({ root, intent, onIntentDone }: { root: string; intent: QaIntent | null; onIntentDone: () => void }) {
  const q = useQaBoard(root);
  const actions = useQaActions(root);
  const pairs = usePairs();
  const [driver, setDriver] = useQaDriver();
  const [edited, setEdited] = useState<RunForm | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [focusBug, setFocusBug] = useState<string | null>(null);
  const board = q.data;

  useEffect(() => {
    if (!intent || !board) return;
    if (intent.bug) {
      const hit = findBug(board, intent.bug);
      if (hit) {
        setOpen(hit.feature);
        setFocusBug(intent.bug);
      }
    } else if (intent.feature && board.features.some((f) => f.id === intent.feature)) {
      setOpen(intent.feature);
      setFocusBug(null);
    }
    onIntentDone();
  }, [intent, board, onIntentDone]);

  const form = useMemo(() => edited ?? defaultForm(!!board?.map.exists), [edited, board?.map.exists]);

  if (q.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-4" />
      </div>
    );
  }
  if (!board) return <Empty icon={<ClipboardCheck />} title="Could not load QA" hint={q.error instanceof Error ? q.error.message : "Try again in a moment."} />;

  const pipeline = board.pipeline;
  const phase = phaseOf(pipeline);
  const busy = isBusy(phase);
  const pending = actions.start.isPending || actions.cont.isPending || actions.stop.isPending;
  const pickedNow = prunePicked(picked, board.features);
  const scope = scopeOf(pickedNow, board.features);
  const driverMissing = driver.kind === "pair" && !!pairs.data && !pairs.data.some((p) => p.id === driver.pairId);
  const blockOf = (stages: readonly Stage[]) => runBlock({ stages, browser: board.browser, featureCount: board.features.length, driverMissing });
  const go = (req: PipelineRequest) => {
    const why = blockOf(Object.keys(req.stages) as Stage[]);
    if (why) toast.error(why);
    else actions.start.mutate(req);
  };
  const mapping = board.map.activity.kind === "working";
  const feature = open ? board.features.find((f) => f.id === open) : undefined;
  const choices = board.features.map((f) => ({ id: f.id, title: f.title }));
  const onStatus = (id: string, status: "new" | "dismissed" | "shipped") => actions.setBug.mutate({ id, status });

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-panel" data-qa-board>
      <RunBar
        phase={phase}
        pipeline={pipeline}
        scope={scope}
        scopeText={scopeLabel(scope, board.features.length)}
        pickedCount={pickedNow.length}
        onClearPicked={() => setPicked([])}
        form={form}
        setForm={setEdited}
        driver={driver}
        setDriver={setDriver}
        blocked={blockOf(form.stages)}
        pending={pending}
        onRun={() => go(pipelineRequest(form, scope, driver))}
        onContinue={() => pipeline && actions.cont.mutate(pipeline.id)}
        onStop={() => pipeline && actions.stop.mutate(pipeline.id)}
      />
      <PipelineStrip pipeline={pipeline} editable={!busy} form={form} setForm={setEdited} />
      <div className="flex min-h-0 flex-1 flex-col @[800px]:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {board.map.exists && (
            <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-3">
              <CellView cell={mapCell(board.map, board.features.length)} />
              {board.map.updatedAt && <span className="text-xs text-fg-muted">{since(board.map.updatedAt, Date.now())}</span>}
              {board.map.problem && (
                <span className="min-w-0 flex-1 truncate text-xs text-red" title={board.map.problem}>
                  {board.map.problem}
                </span>
              )}
            </div>
          )}
          {board.features.length === 0 ? (
            <Empty
              icon={mapping ? <Spinner className="size-5" /> : <ClipboardCheck />}
              title={mapping ? "Mapping the product" : board.map.exists ? "No features in the map" : "No feature map yet"}
              hint={mapping ? "An agent is writing lab/features.md." : board.map.exists ? (board.map.problem ?? "lab/features.md lists no features.") : "Run starts by mapping the features, then plans and tests each one."}
            />
          ) : (
            <FeatureGrid
              features={board.features}
              open={open}
              picked={pickedNow}
              busy={busy}
              onOpen={(id) => {
                setOpen(id);
                setFocusBug(null);
              }}
              onPick={(id, on) => setPicked(on ? [...pickedNow, id] : pickedNow.filter((x) => x !== id))}
              onPickAll={(on) => setPicked(on ? board.features.map((f) => f.id) : [])}
              onAction={(a: RowAction, id) => go(rowRequest(a, id, form, driver))}
            />
          )}
          <UnsortedBugs root={root} bugs={board.bugsWithoutFeature} features={choices} busy={busy} pending={pending} focusBug={focusBug} onFix={(id) => go(bugFixRequest(id, driver))} onStatus={onStatus} onFeature={(id, f) => actions.setBug.mutate({ id, feature: f })} />
          <OrphanPlans plans={board.plansWithoutFeature} pending={actions.deletePlan.isPending} onDelete={(slug) => actions.deletePlan.mutate(slug)} />
        </div>
        {feature && (
          <aside className="max-h-[50%] min-h-0 shrink-0 border-t border-line @[800px]:max-h-none @[800px]:w-90 @[800px]:border-t-0 @[800px]:border-l">
            <FeatureDetailPane root={root} feature={feature} busy={busy} pending={pending} focusBug={focusBug} onClose={() => setOpen(null)} onAction={(a) => go(rowRequest(a, feature.id, form, driver))} onFix={(id) => go(bugFixRequest(id, driver))} onStatus={onStatus} />
          </aside>
        )}
      </div>
    </div>
  );
}
