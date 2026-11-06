/**
 * Autopilot in a workspace: start a run on a spec, watch the runs live, and answer their approval gates.
 *
 * The approval banner sits above everything else while a run waits for the operator: the gate's text, and
 * Approve or Reject. It shows the first waiting run; the detail of any waiting run carries the same controls. Runs poll while they work (see data.ts), so the list and the log keep up without a reload.
 */
import { useEffect, useMemo, useState } from "react";
import { Bot, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Empty, Spinner } from "@/components/ui/misc";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { ago, cn } from "@/lib/utils";
import { useAutopilotRun, useAutopilotRuns, useRunAction, useStartRun, type AutopilotRun, type RunAction } from "./data";
import { gatedRuns, isLive, money, RUN_LABEL, RUN_TONE, when } from "./logic";

export function AutopilotPanel({ workspaceId }: { workspaceId: string }) {
  const runs = useAutopilotRuns(workspaceId);
  const [selected, setSelected] = useState<string | null>(null);
  const act = useRunAction(workspaceId);
  const list = runs.data ?? [];
  const waiting = gatedRuns(list)[0];

  useEffect(() => {
    if (!selected && list.length) setSelected(list[0].id);
  }, [list, selected]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      {waiting && <ApprovalBanner run={waiting} busy={act.isPending} onAct={(action) => act.mutate({ id: waiting.id, action })} />}
      <StartRun workspaceId={workspaceId} onStarted={(id) => setSelected(id)} />
      {runs.isLoading ? (
        <div className="flex items-center gap-2 text-[12px] text-fg-muted">
          <Spinner /> Loading runs
        </div>
      ) : !list.length ? (
        <Empty icon={<Bot />} title="No autopilot runs yet" hint="Start one on a spec. It works through the open tasks, checks each one, and stops for you at the gates you set." />
      ) : (
        <div className="grid min-h-0 gap-3 md:grid-cols-[minmax(200px,260px)_1fr]">
          <ul className="flex flex-col gap-1" aria-label="Autopilot runs">
            {list.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  aria-pressed={selected === r.id}
                  data-autopilot-run={r.id}
                  onClick={() => setSelected(r.id)}
                  className={cn("flex w-full flex-col gap-1 rounded-md border border-transparent px-2 py-1.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/40", selected === r.id && "border-line bg-raised")}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[12px] text-fg">{r.spec_dir}</span>
                    <Badge tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status]}</Badge>
                  </span>
                  <span className="text-[11px] text-fg-muted">
                    {r.done} done · {money(r.spent_usd)}
                    {r.budget_usd !== null ? ` of ${money(r.budget_usd)}` : ""} · {ago(r.updated_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && <RunDetail id={selected} workspaceId={workspaceId} />}
        </div>
      )}
    </div>
  );
}

/** Approve carries on; Reject stops the run before the gated work. */
function GateButtons({ busy, onAct }: { busy?: boolean; onAct: (a: RunAction) => void }) {
  return (
    <div className="flex shrink-0 gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onAct("reject")}>
        Reject
      </Button>
      <Button variant="primary" size="sm" disabled={busy} onClick={() => onAct("approve")}>
        Approve
      </Button>
    </div>
  );
}

/** The gate of a run that waits for the operator. */
export function ApprovalBanner({ run, busy, onAct }: { run: AutopilotRun; busy?: boolean; onAct: (a: RunAction) => void }) {
  return (
    <div role="alert" data-autopilot-approval={run.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line-strong bg-raised px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12px] font-medium text-amber">Waiting for your approval · {run.spec_dir}</span>
        <span className="text-[13px] text-fg">{run.gate?.text}</span>
      </div>
      <GateButtons busy={busy} onAct={onAct} />
    </div>
  );
}

function StartRun({ workspaceId, onStarted }: { workspaceId: string; onStarted: (id: string) => void }) {
  const [spec, setSpec] = useState("");
  const [budget, setBudget] = useState("");
  const [maxTasks, setMaxTasks] = useState("");
  const [concurrency, setConcurrency] = useState("1");
  const [every, setEvery] = useState("");
  const [merge, setMerge] = useState(false);
  const [tagged, setTagged] = useState(true);
  const start = useStartRun(workspaceId);
  const ok = spec.trim().length > 0 && !start.isPending;

  const submit = async () => {
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const r = await start.mutateAsync({
      spec: spec.trim(),
      budget_usd: num(budget),
      max_tasks: num(maxTasks),
      concurrency: Math.max(1, Math.min(4, Number(concurrency) || 1)),
      approval_policy: { merge, tagged, every: num(every) },
    });
    setSpec("");
    onStarted(r.run.id);
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) void submit();
      }}
    >
      <div className="text-label font-medium uppercase tracking-label text-fg-muted">Start on a spec</div>
      <div className="grid gap-2 md:grid-cols-[1fr_120px_120px]">
        <Field label="Spec folder">
          <Input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="001-checkout" className="font-mono text-[12px]" />
        </Field>
        <Field label="Budget (USD)">
          <Input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="no limit" className="font-mono text-[12px]" />
        </Field>
        <Field label="Task limit">
          <Input inputMode="numeric" value={maxTasks} onChange={(e) => setMaxTasks(e.target.value)} placeholder="all" className="font-mono text-[12px]" />
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Parallel tasks">
          <Input inputMode="numeric" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} className="w-20 font-mono text-[12px]" />
        </Field>
        <Field label="Approve every N tasks">
          <Input inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value)} placeholder="never" className="w-28 font-mono text-[12px]" />
        </Field>
        <label className="flex cursor-pointer items-center gap-1 pb-2 text-[12px] text-fg-muted select-none">
          <Checkbox checked={tagged} onChange={setTagged} label="Stop before [APPROVE] tasks" />
          Stop before [APPROVE] tasks
        </label>
        <label className="flex cursor-pointer items-center gap-1 pb-2 text-[12px] text-fg-muted select-none">
          <Checkbox checked={merge} onChange={setMerge} label="Stop before merging parallel work" />
          Stop before merging parallel work
        </label>
        <Button type="submit" variant="primary" size="sm" disabled={!ok} className="ml-auto">
          <Play />
          {start.isPending ? "Starting" : "Start autopilot"}
        </Button>
      </div>
    </form>
  );
}

function RunDetail({ id, workspaceId }: { id: string; workspaceId: string }) {
  const q = useAutopilotRun(id);
  const act = useRunAction(workspaceId);
  const run = q.data;
  const log = useMemo(() => (run ? run.log.slice(-200) : []), [run]);
  if (!run) return <div className="flex items-center gap-2 text-[12px] text-fg-muted">{q.isLoading ? <Spinner /> : "This run is gone."}</div>;

  const live = isLive(run.status);
  const go = (action: RunAction) => act.mutate({ id: run.id, action });
  return (
    <section aria-label="Run detail" className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-panel p-3">
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] text-fg">{run.spec_dir}</span>
        <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge>
        <span className="text-[11px] text-fg-muted">
          {run.done} done · {money(run.spent_usd)}
          {run.budget_usd !== null ? ` of ${money(run.budget_usd)}` : ""}
          {run.max_tasks ? ` · limit ${run.max_tasks}` : ""} · started {when(run.created_at)}
        </span>
        <div className="ml-auto flex gap-1.5">
          {run.status === "running" && (
            <Button variant="subtle" size="sm" disabled={act.isPending} onClick={() => go("pause")}>
              <Pause />
              Pause
            </Button>
          )}
          {run.status === "paused" && (
            <Button variant="subtle" size="sm" disabled={act.isPending} onClick={() => go("resume")}>
              <Play />
              Resume
            </Button>
          )}
          {live && (
            <Button variant="dangerGhost" size="sm" disabled={act.isPending} onClick={() => go("stop")}>
              <Square />
              Stop
            </Button>
          )}
        </div>
      </header>
      {run.status === "awaiting_approval" && run.gate && (
        <div data-autopilot-gate={run.id} className="flex flex-wrap items-center gap-3 rounded-md border border-line-strong bg-raised px-3 py-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[12px] font-medium text-amber">Waiting for your approval</span>
            <span className="text-[13px] text-fg">{run.gate.text}</span>
          </div>
          <GateButtons busy={act.isPending} onAct={go} />
        </div>
      )}
      {run.current_task && <div className="text-[12px] text-fg-muted">Working on <span className="font-mono text-fg">{run.current_task}</span></div>}
      {run.reason && run.status !== "awaiting_approval" && <div className={cn("text-[12px]", run.status === "failed" ? "text-red" : "text-fg-muted")}>{run.reason}</div>}
      <ol className="flex max-h-[360px] flex-col gap-1 overflow-auto rounded-md bg-raised p-2 font-mono text-[11px]" aria-label="Run log">
        {log.map((l, i) => (
          <li key={`${l.at}-${i}`} className={cn("flex gap-2", l.kind === "error" && "text-red", l.kind === "gate" && "text-amber", l.kind === "task" && "text-fg")}>
            <span className="shrink-0 text-fg-faint">{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className="min-w-0 break-words">{l.text}</span>
          </li>
        ))}
        {!log.length && <li className="text-fg-faint">Nothing logged yet.</li>}
      </ol>
    </section>
  );
}
