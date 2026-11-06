/**
 * Where and how to run a spec step, an implement, one task or an architecture discussion: in a new session
 * (with the engine, model, agent and pair it should use) or in the one that is open.
 */
import { useEffect, useMemo, useState } from "react";
import { Play } from "lucide-react";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Field, Select, Switch, Textarea, Input } from "@/components/ui/form";
import { SegTabs } from "@/components/ui/misc";
import { EngineIcon } from "@/components/ui/engine-icon";
import { ModelSelect } from "@/components/ui/model-select";
import { useAgents, useEngines, usePairs, useSession } from "@/lib/queries";
import { useWs } from "@/lib/store";
import { emptyRun, type RunChoice } from "./logic";

export interface RunSpec {
  title: string;
  description: string;
  confirm: string;
  /** The label of the free-text field, or null for none. */
  inputLabel: string | null;
  inputPlaceholder?: string;
  /** implement: show the test command and the parallel switch. */
  implement?: boolean;
  /** one task: offer to open it as a head of the current session. */
  task?: boolean;
}

export function RunDialog({ open, onOpenChange, spec, busy, initial, onRun }: { open: boolean; onOpenChange: (o: boolean) => void; spec: RunSpec | null; busy?: boolean; initial?: Partial<RunChoice>; onRun: (c: RunChoice, sessionId: string | null) => void }) {
  const ws = useWs();
  const active = useSession(ws.activeSession);
  const engines = useEngines();
  const pairs = usePairs();
  const agents = useAgents();
  const [c, setC] = useState<RunChoice>(emptyRun());
  const current = active.data?.session && active.data.session.status !== "closed" ? active.data.session : null;

  useEffect(() => {
    if (open) setC({ ...emptyRun(), where: spec?.task && current ? "current" : "new", ...initial });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const installed = useMemo(() => (engines.data ?? []).filter((e) => e.installed), [engines.data]);
  const headsPairs = (pairs.data ?? []).filter((p) => p.mode === "heads");
  const set = (patch: Partial<RunChoice>) => setC((x) => ({ ...x, ...patch }));
  const useCurrent = c.where === "current" && !!current;

  if (!spec) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={500}
      title={
        <span className="flex items-center gap-2">
          <Play className="size-4 text-accent" /> {spec.title}
        </span>
      }
      description={spec.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" data-run-confirm disabled={busy} onClick={() => onRun(c, useCurrent ? current!.id : null)}>
            {spec.confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy && onRun(c, useCurrent ? current!.id : null)}>
        {!spec.implement || !c.parallel ? (
          <SegTabs
            value={c.where}
            onChange={(where) => set({ where, asHead: where === "new" ? false : c.asHead })}
            items={[
              { value: "new", label: "New session" },
              { value: "current", label: current ? `Current: ${current.title.slice(0, 24)}` : "Current session" },
            ]}
          />
        ) : null}
        {c.where === "current" && !current && <p className="text-xs text-amber">No session is open in this project. Start in a new one.</p>}

        {!useCurrent && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Engine">
              <Select
                aria-label="Engine"
                value={c.engine}
                onChange={(engine) => set({ engine, model: "" })}
                placeholder="Default"
                options={[{ value: "", label: "Default" }, ...installed.map((e) => ({ value: e.id, label: (<span className="flex items-center gap-1.5"><EngineIcon engine={e.id} className="size-3.5" />{e.label}</span>) }))]}
              />
            </Field>
            <Field label="Model">
              <ModelSelect engine={c.engine} value={c.model} onChange={(model) => set({ model })} disabled={!c.engine} disabledReason="Pick an engine first" />
            </Field>
            <Field label="Agent" hint="Its instructions and skills apply.">
              <Select aria-label="Agent" value={c.agent} onChange={(agent) => set({ agent })} placeholder="None" options={[{ value: "", label: "None" }, ...(agents.data ?? []).map((a) => ({ value: a.name, label: a.title || a.name }))]} />
            </Field>
            <Field label="Hydra pair" hint={spec.implement ? "Needed to run heads in parallel." : undefined}>
              <Select aria-label="Hydra pair" value={c.pairId} onChange={(pairId) => set({ pairId })} placeholder="None" options={[{ value: "", label: "None" }, ...(pairs.data ?? []).map((p) => ({ value: p.id, label: p.title }))]} />
            </Field>
          </div>
        )}

        {spec.implement && (
          <>
            <Field label="Check command (optional)" hint="Besides every box being ticked, this must exit 0 for the goal to count as met.">
              <Input value={c.test} onChange={(e) => set({ test: e.target.value })} placeholder="bun test" className="font-mono" spellCheck={false} data-run-test />
            </Field>
            <div className="flex items-start justify-between gap-4 rounded-lg border border-line bg-raised px-3 py-2">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium">Run the parallel tasks as heads</div>
                <p className="text-[11.5px] leading-relaxed text-fg-muted">
                  {headsPairs.length === 0 ? "No heads pair exists yet, so this would run one task after another. Create a pair under Settings." : "One head per group of [P] tasks in the first parallel run, under a lead that merges and carries on."}
                </p>
              </div>
              <Switch checked={c.parallel} onChange={(parallel) => set({ parallel, where: parallel ? "new" : c.where })} label="Parallel" />
            </div>
          </>
        )}

        {spec.task && useCurrent && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-raised px-3 py-2">
            <div className="text-[12.5px]">Open it as a head of the current session</div>
            <Switch checked={c.asHead} onChange={(asHead) => set({ asHead })} label="As a head" />
          </div>
        )}

        {spec.inputLabel && (
          <Field label={spec.inputLabel}>
            <Textarea data-run-input value={c.input} onChange={(e) => set({ input: e.target.value })} rows={3} placeholder={spec.inputPlaceholder} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
