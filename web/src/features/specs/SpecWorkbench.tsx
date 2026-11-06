import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Compass, Copy, FolderOpen, Gauge, MoreHorizontal, Paperclip, Play, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { useUi, useWs, type Tab } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { DropdownMenu, Tooltip } from "@/components/ui/overlay";
import { ApiError } from "@/lib/api";
import { FileTab } from "@/features/editor/FileTab";
import { useAttachActions, useFeature, useSpecActions, useSpecs } from "./data";
import { docTabs, pipeline, STEP_FOR_DOC, statusLabel, statusTone, type DocTab, type FeatureInfo, type StepView } from "./logic";
import { TasksChecklist } from "./TasksChecklist";
import { useRunner } from "./useRunner";

type SpecTabT = Extract<Tab, { kind: "spec" }>;

/** The seven steps of the workflow, each showing where the feature stands and starting its step on a click. */
function Stepper({ steps, onRun }: { steps: StepView[]; onRun: (s: StepView) => void }) {
  return (
    <ol className="@container flex items-stretch gap-0 overflow-x-auto px-4 pb-3 pt-1 [scrollbar-width:none]" aria-label="Workflow" data-stepper>
      {steps.map((s, i) => (
        <li key={s.id} className="flex min-w-fit flex-1 items-center">
          <Tooltip label={<span className="block max-w-[240px]">{s.hint}. <span className="text-fg-muted">{s.note}</span></span>}>
            <button
              data-step={s.id}
              data-state={s.state}
              disabled={s.state === "blocked"}
              onClick={() => onRun(s)}
              className={cn(
                "group relative flex min-w-fit flex-1 items-center gap-1.5 rounded-lg border px-1.5 py-1.5 text-left outline-none transition-[background,border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-accent/50",
                s.state === "done" && "border-green/30 bg-green/[0.06] hover:bg-green/10",
                s.state === "active" && "border-accent/60 bg-accent-soft shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_14%,transparent)] hover:brightness-110",
                s.state === "ready" && "border-line bg-raised hover:border-line-strong hover:bg-hover",
                s.state === "blocked" && "cursor-not-allowed border-line/60 bg-transparent opacity-50",
              )}
            >
              <span className={cn("flex size-[18px] shrink-0 items-center justify-center rounded-full border font-mono text-[10px] font-semibold transition-colors", s.state === "done" ? "border-green bg-green text-white" : s.state === "active" ? "border-accent bg-accent text-accent-fg" : "border-line-strong text-fg-muted")}>
                {s.state === "done" ? <Check className="size-3 animate-pop" strokeWidth={3} /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className="block whitespace-nowrap text-[12px] font-medium leading-tight">{s.label}</span>
                <span className="hidden max-w-[11ch] truncate text-[10.5px] leading-tight text-fg-faint @min-[900px]:block">{s.note}</span>
              </span>
              {(s.state === "active" || s.state === "ready") && <Play className="ml-auto size-3 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />}
            </button>
          </Tooltip>
          {i < steps.length - 1 && <span aria-hidden className={cn("mx-px h-px w-1.5 shrink-0 transition-colors", s.state === "done" ? "bg-green/50" : "bg-line")} />}
        </li>
      ))}
    </ol>
  );
}

function DocStrip({ docs, value, onChange, feature }: { docs: DocTab[]; value: DocTab["id"]; onChange: (d: DocTab["id"]) => void; feature: FeatureInfo }) {
  return (
    <div role="tablist" className="flex h-8 shrink-0 items-center gap-0.5 border-y border-line bg-bg px-3" data-doc-tabs>
      {docs.map((d) => (
        <button key={d.id} role="tab" aria-selected={value === d.id} data-doc={d.id} onClick={() => onChange(d.id)} className={cn("relative flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] outline-none transition-colors", value === d.id ? "bg-active text-fg" : d.exists ? "text-fg-muted hover:bg-hover hover:text-fg" : "text-fg-faint hover:bg-hover")}>
          {d.label}
          {d.id === "tasks" && feature.tasks.total > 0 && (
            <span className="font-mono text-[10px] text-fg-faint">
              {feature.tasks.done}/{feature.tasks.total}
            </span>
          )}
          {d.id === "contracts" && feature.files.contracts.length > 1 && <span className="font-mono text-[10px] text-fg-faint">{feature.files.contracts.length}</span>}
          {!d.exists && <span className="size-1 rounded-full bg-fg-faint/60" title="Not written yet" />}
        </button>
      ))}
    </div>
  );
}

function MissingDoc({ doc, onRun }: { doc: DocTab; onRun: (() => void) | null }) {
  return (
    <Empty
      icon={<ScrollText />}
      title={`No ${doc.label.toLowerCase()} yet`}
      hint={onRun ? "The workflow step above writes it. You can edit it by hand afterwards." : "Nothing has created this file."}
      action={
        onRun ? (
          <Button size="sm" variant="primary" data-run-missing onClick={onRun}>
            <Play /> Run the {STEP_FOR_DOC[doc.id]} step
          </Button>
        ) : undefined
      }
    />
  );
}

/** One feature: its workflow, and each of its files. The spec, plan and the rest open in the real editor. */
export function SpecWorkbench({ tab }: { tab: SpecTabT }) {
  const { root, feature: id } = tab;
  const ws = useWs();
  const ui = useUi();
  const specs = useSpecs(root);
  const q = useFeature(root, id);
  const actions = useSpecActions(root);
  const run = useRunner(root);
  const { attach } = useAttachActions(ws.activeSession);
  const [contract, setContract] = useState(0);

  const f = q.data?.feature ?? null;
  // The tab is named after the feature, and the Specify step rewrites its title.
  useEffect(() => {
    if (f && f.title !== tab.title) ui.updateTab(tab.id, { title: f.title } as Partial<Tab>);
  }, [f?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  const docs = useMemo(() => (f ? docTabs(f) : []), [f]);
  const steps = useMemo(() => pipeline(specs.data, f), [specs.data, f]);

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-12" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (q.error || !f) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return (
      <Empty
        icon={<AlertTriangle />}
        title={gone ? "This feature no longer exists" : "Could not open this feature"}
        hint={gone ? `specs/${id} is gone from the project.` : (q.error as Error)?.message}
        action={
          <Button size="sm" variant="subtle" onClick={() => ui.closeTab(tab.id)}>
            Close tab
          </Button>
        }
      />
    );
  }

  const doc = (docs.find((d) => d.id === (tab.doc as DocTab["id"])) ?? docs.find((d) => d.id === "spec"))!;
  const setDoc = (d: DocTab["id"]) => ui.updateTab(tab.id, { doc: d } as Partial<Tab>);
  const stepFor = (d: DocTab) => STEP_FOR_DOC[d.id];
  const hasTasks = f.files.tasks && f.tasks.total > 0;

  const onStep = (s: StepView) => (s.id === "implement" ? run.implement(f) : run.step(s.id, f));
  const filePath = doc.id === "contracts" ? `${f.dir}/${f.files.contracts[Math.min(contract, f.files.contracts.length - 1)] ?? ""}` : doc.path;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-spec-workbench={f.id}>
      <header className="flex shrink-0 items-start gap-3 px-4 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded bg-raised px-1.5 py-px font-mono text-[11px] text-fg-muted">{f.number.length > 3 ? f.number.slice(0, 8) : f.number}</span>
            <h1 className="min-w-0 truncate text-[15px] font-semibold leading-tight">{f.title}</h1>
            <Badge tone={statusTone(f.status)}>{statusLabel(f.status)}</Badge>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-fg-faint">{f.dir}/</div>
        </div>
        <Button size="sm" variant="primary" data-implement-top disabled={!hasTasks || f.status === "done"} title={hasTasks ? "Work through the tasks in a goal-mode session" : "Generate the tasks first"} onClick={() => run.implement(f)}>
          <Gauge /> Implement
        </Button>
        <DropdownMenu
          align="end"
          trigger={
            <Button size="icon" variant="subtle" aria-label="More">
              <MoreHorizontal />
            </Button>
          }
          entries={[
            { label: "Implement in parallel…", icon: <Gauge />, disabled: !hasTasks || f.status === "done", onSelect: () => run.implement(f, true) },
            { label: "Discuss architecture…", icon: <Compass />, onSelect: () => run.architecture(f) },
            { separator: true },
            { label: ws.activeSession ? "Attach to the open session" : "Attach to the open session (none open)", icon: <Paperclip />, disabled: !ws.activeSession, onSelect: () => attach.mutate({ path: f.dir, mode: "ref" }, { onSuccess: () => toast.success("Attached. The agent sees it on its next turn.") }) },
            { label: "Reveal in the explorer", icon: <FolderOpen />, onSelect: () => {
                ui.setActivity("explorer");
                const have = new Set(ws.expanded);
                for (const d of ["specs", f.dir]) if (!have.has(d)) ui.toggleExpanded(d);
              } },
            { label: "Copy folder path", icon: <Copy />, onSelect: () => void navigator.clipboard.writeText(f.dir) },
          ]}
        />
      </header>

      <Stepper steps={steps} onRun={onStep} />
      <DocStrip docs={docs} value={doc.id} onChange={setDoc} feature={f} />

      <div className="min-h-0 flex-1" key={`${doc.id}:${filePath}`}>
        {doc.id === "tasks" && f.files.tasks && q.data?.tasks ? (
          q.data.tasks.total > 0 ? (
            <TasksChecklist
              root={root}
              feature={f}
              parsed={q.data.tasks}
              onToggle={(t) => actions.toggleTask.mutate({ feature: f.id, line: t.line })}
              onRun={(t) => run.task(f, t)}
              onImplement={(p) => run.implement(f, p)}
            />
          ) : (
            <div className="flex h-full flex-col">
              <MissingDoc doc={{ ...doc, label: "tasks" }} onRun={() => run.step("tasks", f)} />
            </div>
          )
        ) : !doc.exists || !filePath ? (
          <MissingDoc doc={doc} onRun={stepFor(doc) && !(stepFor(doc) === "plan" && !f.files.spec) && !(stepFor(doc) === "tasks" && !f.files.plan) ? () => run.step(stepFor(doc)!, f) : null} />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {doc.id === "spec" && (f.specDraft || f.clarifications > 0) && (
              <div className="flex items-center gap-2 border-b border-line bg-amber/[0.06] px-4 py-1.5 text-[12px] text-fg-muted" data-spec-banner>
                <AlertTriangle className="size-3.5 shrink-0 text-amber" />
                <span className="min-w-0 flex-1 truncate">{f.specDraft ? "This is still the skeleton: the Specify step fills it in." : `${f.clarifications} open question${f.clarifications === 1 ? "" : "s"} marked [NEEDS CLARIFICATION].`}</span>
                <Button size="xs" variant="outline" onClick={() => run.step(f.specDraft ? "specify" : "clarify", f)}>
                  {f.specDraft ? "Specify" : "Clarify"}
                </Button>
              </div>
            )}
            {doc.id === "contracts" && f.files.contracts.length > 1 && (
              <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 py-1">
                {f.files.contracts.map((c, i) => (
                  <button key={c} onClick={() => setContract(i)} className={cn("rounded px-1.5 py-0.5 font-mono text-[11px] outline-none", i === contract ? "bg-active text-fg" : "text-fg-muted hover:bg-hover")}>
                    {c.replace(/^contracts\//, "")}
                  </button>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1">
              <FileTab tab={{ id: `file:${root}:${filePath}`, kind: "file", root, path: filePath!, title: filePath!.split("/").pop()! }} />
            </div>
          </div>
        )}
      </div>
      {run.dialog}
    </div>
  );
}
