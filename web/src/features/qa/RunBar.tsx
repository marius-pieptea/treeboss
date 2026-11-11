import { Play, SlidersHorizontal, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch, Textarea } from "@/components/ui/form";
import { SegTabs, Spinner } from "@/components/ui/misc";
import { Popover } from "@/components/ui/overlay";
import type { Driver, Pace, PipelineView, Scope } from "./api";
import { DriverPicker } from "./DriverPicker";
import { NOTE_MAX, since, statusLine, type RunForm, type RunPhase } from "./logic";
import { LABEL } from "./Status";

const PACE: Array<{ value: Pace; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "step", label: "Step" },
];

/** One row: what a run covers, how it paces, who runs it, and the one primary action (Run when idle, Continue when held, none while running). */
export function RunBar(p: {
  phase: RunPhase;
  pipeline: PipelineView | null;
  scopeText: string;
  scope: Scope;
  pickedCount: number;
  onClearPicked: () => void;
  form: RunForm;
  setForm: (f: RunForm) => void;
  driver: Driver;
  setDriver: (d: Driver) => void;
  blocked: string | null;
  pending: boolean;
  onRun: () => void;
  onContinue: () => void;
  onStop: () => void;
}) {
  const editable = p.phase === "idle" || p.phase === "ended";
  const ended = p.pipeline?.control.kind === "ended" ? p.pipeline.control : null;
  const replan = p.form.replan ?? p.scope.kind === "features";
  const optionsSet = p.form.note.trim() !== "" || p.form.baseUrl.trim() !== "" || p.form.replan !== null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2" data-run-bar data-phase={p.phase}>
      {editable ? (
        <>
          <span className="font-mono text-xs text-fg" data-scope>
            {p.scopeText}
          </span>
          {p.pickedCount > 0 && (
            <Button size="xs" variant="ghost" onClick={p.onClearPicked}>
              <X /> Clear
            </Button>
          )}
          {p.pipeline && ended && (
            <span className="truncate text-xs text-fg-muted">
              Last run: {statusLine(p.pipeline)} · {since(ended.at, Date.now())}
            </span>
          )}
        </>
      ) : (
        p.pipeline && (
          <span className="text-xs text-fg" data-status>
            {statusLine(p.pipeline)}
          </span>
        )
      )}
      <div className="flex-1" />
      {editable && (
        <>
          <span className="flex items-center gap-2" title="Auto runs every stage. Step stops after each stage and waits for Continue.">
            <span className={LABEL}>Pace</span>
            <SegTabs value={p.form.pace} onChange={(pace) => p.setForm({ ...p.form, pace })} items={PACE} className="w-28" />
          </span>
          <DriverPicker driver={p.driver} onChange={p.setDriver} />
          <Popover
            align="end"
            width={344}
            trigger={
              <Button variant="ghost" size="sm" aria-label="Run options">
                <SlidersHorizontal /> Options
                {optionsSet && <span className="size-[7px] rounded-full bg-fg-muted" role="img" aria-label="options set" title="options set" />}
              </Button>
            }
          >
            <div className="flex flex-col gap-3 p-2">
              <Field label="App address" hint="Leave empty and the agent finds the running app.">
                <Input value={p.form.baseUrl} onChange={(e) => p.setForm({ ...p.form, baseUrl: e.target.value })} placeholder="http://localhost:3000" className="font-mono" />
              </Field>
              <Field label="Note for the agent">
                <Textarea value={p.form.note} maxLength={NOTE_MAX} onChange={(e) => p.setForm({ ...p.form, note: e.target.value })} placeholder="What to focus on, test data, logins…" />
              </Field>
              {p.form.stages.includes("plan") && (
                <label className="flex items-center justify-between gap-2">
                  <span>
                    Write plans again
                    <span className="block text-label text-fg-muted">Off keeps the plans that already have steps.</span>
                  </span>
                  <Switch checked={replan} onChange={(v) => p.setForm({ ...p.form, replan: v })} label="Write plans again" />
                </label>
              )}
            </div>
          </Popover>
        </>
      )}
      {p.phase === "running" && (
        <Button variant="outline" size="sm" onClick={p.onStop} disabled={p.pending}>
          <Square /> Stop
        </Button>
      )}
      {p.phase === "stopping" && (
        <span className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner /> Stopping
        </span>
      )}
      {p.phase === "held" && (
        <>
          <Button variant="ghost" size="sm" onClick={p.onStop} disabled={p.pending}>
            <Square /> Stop
          </Button>
          <Button variant="primary" size="sm" onClick={p.onContinue} disabled={p.pending}>
            {p.pending ? <Spinner className="text-accent-fg" /> : <Play />} Continue
          </Button>
        </>
      )}
      {editable && (
        <Button variant="primary" size="sm" onClick={p.onRun} disabled={!!p.blocked || p.pending} title={p.blocked ?? "Start the pipeline"}>
          {p.pending ? <Spinner className="text-accent-fg" /> : <Play />} Run
        </Button>
      )}
      {editable && p.blocked && (
        <span className="basis-full text-label text-fg-muted" role="status">
          {p.blocked}
        </span>
      )}
    </div>
  );
}
