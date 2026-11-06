import { useCallback, useState, type ReactNode } from "react";
import { useSpecActions } from "./data";
import { RunDialog, type RunSpec } from "./RunDialog";
import { runPayload, STEPS, stepInputLabel, type FeatureInfo, type SpecTask, type StepName } from "./logic";

type Pending =
  | { kind: "step"; step: StepName; feature: FeatureInfo | null }
  | { kind: "implement"; feature: FeatureInfo }
  | { kind: "task"; feature: FeatureInfo; task: SpecTask }
  | { kind: "architecture"; feature: FeatureInfo | null };

function specFor(p: Pending): RunSpec {
  switch (p.kind) {
    case "step": {
      const meta = STEPS.find((s) => s.id === p.step)!;
      return { title: p.feature ? `${meta.label}: ${p.feature.title}` : meta.label, description: meta.hint + ".", confirm: "Run", inputLabel: stepInputLabel(p.step), inputPlaceholder: p.step === "specify" ? "Add CSV export to the orders page, keeping the current filters" : undefined };
    }
    case "implement":
      return { title: `Implement: ${p.feature.title}`, description: "A build session in goal mode: it keeps working until every task in tasks.md is ticked, within its turn and time budget.", confirm: "Start", inputLabel: stepInputLabel("implement"), implement: true };
    case "task":
      return { title: `${p.task.id ?? "Task"}: ${p.task.text.slice(0, 60)}`, description: "Does this one task and ticks it when it is done.", confirm: "Run task", inputLabel: null, task: true };
    case "architecture":
      return { title: p.feature ? `Discuss architecture: ${p.feature.title}` : "Discuss architecture", description: "A read-only session that studies the code and asks you questions. Nothing is written until you approve its plan, and then only the spec files.", confirm: "Start", inputLabel: "What do you want to settle? (optional)", inputPlaceholder: "How should exports be queued? Where does the CSV get built?" };
  }
}

/**
 * The run dialog and what it starts, in one place for the sidebar and the workbench. `start(…)` opens the
 * dialog; confirming it posts the run and opens the session it made in the agent panel.
 */
export function useRunner(root: string): { dialog: ReactNode; step: (s: StepName, f: FeatureInfo | null) => void; implement: (f: FeatureInfo, parallel?: boolean) => void; task: (f: FeatureInfo, t: SpecTask) => void; architecture: (f: FeatureInfo | null) => void } {
  const actions = useSpecActions(root);
  const [pending, setPending] = useState<Pending | null>(null);
  const [open, setOpen] = useState(false);
  const [presetParallel, setPresetParallel] = useState(false);
  const start = useCallback((p: Pending, parallel = false) => {
    setPending(p);
    setPresetParallel(parallel);
    setOpen(true);
  }, []);

  const busy = actions.runStep.isPending || actions.implement.isPending || actions.runTask.isPending || actions.architecture.isPending;

  const run = (choice: Parameters<typeof runPayload>[0], sessionId: string | null) => {
    if (!pending) return;
    const body = runPayload(choice, sessionId);
    const done = { onSuccess: () => setOpen(false) };
    if (pending.kind === "step") {
      if (pending.step === "implement" && pending.feature) actions.implement.mutate({ feature: pending.feature.id, body }, done);
      else actions.runStep.mutate({ step: pending.step, feature: pending.feature?.id, body }, done);
    } else if (pending.kind === "implement") actions.implement.mutate({ feature: pending.feature.id, body }, done);
    else if (pending.kind === "task") actions.runTask.mutate({ feature: pending.feature.id, line: pending.task.line, body }, done);
    else actions.architecture.mutate({ feature: pending.feature?.id, topic: typeof body.input === "string" ? body.input : undefined, body: { ...body, input: undefined } }, done);
  };

  const dialog = (
    <RunDialog
      key={`${pending?.kind}-${presetParallel}`}
      open={open}
      onOpenChange={setOpen}
      spec={pending ? specFor(pending) : null}
      busy={busy}
      initial={presetParallel ? { parallel: true } : undefined}
      onRun={run}
    />
  );

  return {
    dialog,
    step: (s, f) => start({ kind: "step", step: s, feature: f }),
    implement: (f, parallel) => start({ kind: "implement", feature: f }, !!parallel),
    task: (f, t) => start({ kind: "task", feature: f, task: t }),
    architecture: (f) => start({ kind: "architecture", feature: f }),
  };
}
