import { Fragment } from "react";
import { ArrowUpRight, ChevronRight, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form";
import { SegTabs } from "@/components/ui/misc";
import { openSession } from "@/features/agent/agent-commands";
import { STAGES } from "./api";
import type { Batching, PipelineView, Stage, StageState } from "./api";
import { jobUnits, notableJobs, stageLine, STAGE_LABEL, toggleStage, type RunForm, type Tone } from "./logic";
import { Dot } from "./Status";

const STATE_TONE: Record<StageState, Tone> = { done: "ok", current: "run", held: "warn", next: "idle", skipped: "idle" };

const BATCHING: Array<{ value: Batching; label: string }> = [
  { value: "each", label: "Each" },
  { value: "together", label: "Together" },
];

/** The four stages in run order. Idle, each is a switch (with its batching for plan, test and fix); while a pipeline is in flight it shows the live progress. */
export function PipelineStrip({ pipeline, editable, form, setForm }: { pipeline: PipelineView | null; editable: boolean; form: RunForm; setForm: (f: RunForm) => void }) {
  const jobs = pipeline ? notableJobs(pipeline.jobs) : [];
  return (
    <div className="flex flex-col border-b border-line">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2" role="group" aria-label="Pipeline stages">
        {editable ? (
          <EditableStages form={form} setForm={setForm} />
        ) : (
          (pipeline?.stages ?? [])
            .filter((s) => s.state !== "skipped")
            .map((s, i) => (
              <Fragment key={s.stage}>
                {i > 0 && <ChevronRight className="size-3 text-fg-faint" aria-hidden />}
                <span className="flex h-7 items-center gap-2 px-2 text-xs" data-stage={s.stage} data-stage-state={s.state}>
                  <Dot tone={s.problems > 0 && s.state === "done" ? "warn" : STATE_TONE[s.state]} label={s.problems > 0 && s.state === "done" ? "done with problems" : s.state} />
                  <span className={s.state === "next" ? "font-mono text-fg-muted" : "font-mono text-fg"}>{stageLine(s)}</span>
                </span>
              </Fragment>
            ))
        )}
      </div>
      {jobs.length > 0 && (
        <ul className="flex flex-col border-t border-line px-3 py-1" aria-label="Sessions that need a look">
          {jobs.map((j) => {
            const bad = j.problem !== null || j.error !== null;
            return (
              <li key={j.id} className="flex h-6 items-center gap-2 text-xs">
                <Dot tone={bad ? "bad" : "run"} label={bad ? "problem" : j.state} />
                <span className="shrink-0 font-mono text-label text-fg">{jobUnits(j)}</span>
                {j.pair && <Network className="size-3 shrink-0 text-violet" aria-label="Hydra pair" />}
                {j.state === "merging" && <span className="shrink-0 text-fg-muted">merging</span>}
                {bad ? (
                  <span className="min-w-0 flex-1 truncate text-red" title={j.problem ?? j.error ?? undefined}>
                    {j.problem ?? j.error}
                  </span>
                ) : (
                  <span className="flex-1" />
                )}
                {j.sessionId && (
                  <Button size="xs" variant="ghost" onClick={() => openSession(j.sessionId!)} aria-label={`Open the session of ${jobUnits(j)}`}>
                    <ArrowUpRight /> Open
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function EditableStages({ form, setForm }: { form: RunForm; setForm: (f: RunForm) => void }) {
  return (
    <>
      {STAGES.map((s: Stage) => {
        const on = form.stages.includes(s);
        return (
          <Fragment key={s}>
            <div className="flex items-center gap-2" data-stage={s}>
              <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-xs font-medium hover:bg-hover">
                <Checkbox checked={on} label={STAGE_LABEL[s]} onChange={() => setForm({ ...form, stages: toggleStage(form.stages, s) })} />
                <span className={on ? "text-fg" : "text-fg-muted"}>{STAGE_LABEL[s]}</span>
              </label>
              {on && s !== "map" && (
                <span title={`${STAGE_LABEL[s]}: one session per unit (each) or one session for all of them (together)`}>
                  <SegTabs value={form.batching[s]} onChange={(v) => setForm({ ...form, batching: { ...form.batching, [s]: v } })} items={BATCHING} className="w-32" />
                </span>
              )}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
