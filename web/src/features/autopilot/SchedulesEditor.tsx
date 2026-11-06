/**
 * Scheduled jobs in a workspace: a cron expression and a kind per job. The list shows when each job is next due,
 * what its last run did, and whether it is on. Run now starts it without moving its slot.
 */
import { useState } from "react";
import { CalendarClock, Play, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Badge, Empty, Spinner } from "@/components/ui/misc";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { useSchedules, useScheduleChange, type ScheduleKind } from "./data";
import { CRON_HINT, KIND_LABEL, LENSES, lastResultText, when } from "./logic";

const KINDS: ScheduleKind[] = ["prompt", "deps_update", "verify", "lab_sweep", "signals_sync"];

export function SchedulesEditor({ workspaceId }: { workspaceId: string }) {
  const q = useSchedules(workspaceId);
  const change = useScheduleChange(workspaceId);
  const list = q.data ?? [];

  return (
    <div className="flex flex-col gap-3 p-3">
      <AddSchedule onAdd={(body) => change.mutateAsync({ kind: "create", body })} busy={change.isPending} />
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-[12px] text-fg-muted">
          <Spinner /> Loading schedules
        </div>
      ) : !list.length ? (
        <Empty icon={<CalendarClock />} title="No scheduled jobs" hint="A job runs on its cron schedule while the daemon is up: a prompt, a dependency update, a lab sweep or the project's checks." />
      ) : (
        <ul className="flex flex-col gap-1.5" aria-label="Scheduled jobs">
          {list.map((s) => {
            const last = lastResultText(s.last_result);
            return (
              <li key={s.id} data-schedule={s.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-fg">{s.name}</span>
                    <Badge>{KIND_LABEL[s.kind]}</Badge>
                  </div>
                  <span className="font-mono text-[11px] text-fg-muted">
                    {s.cron} · {s.enabled ? `next ${when(s.next_run_at)}` : "off"} · last {when(s.last_run_at)}
                  </span>
                  <span className={`text-[11px] ${last.tone === "red" ? "text-red" : last.tone === "green" ? "text-green" : "text-fg-faint"}`}>{last.text}</span>
                </div>
                <Switch checked={s.enabled} label={s.enabled ? "On" : "Off"} onChange={(enabled) => change.mutate({ kind: "patch", id: s.id, body: { enabled } })} disabled={change.isPending} />
                <Button variant="subtle" size="sm" disabled={change.isPending} onClick={() => change.mutate({ kind: "run", id: s.id })}>
                  <Play />
                  Run now
                </Button>
                <IconButton label={`Delete ${s.name}`} disabled={change.isPending} onClick={() => change.mutate({ kind: "delete", id: s.id })}>
                  <Trash2 />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AddSchedule({ onAdd, busy }: { onAdd: (body: Record<string, unknown>) => Promise<unknown>; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 9 * * 1");
  const [kind, setKind] = useState<ScheduleKind>("prompt");
  const [prompt, setPrompt] = useState("");
  const [lens, setLens] = useState<string>("review");
  const [enabled, setEnabled] = useState(true);

  if (!open) {
    return (
      <Button variant="subtle" size="sm" className="self-start" onClick={() => setOpen(true)}>
        <Plus />
        Add a scheduled job
      </Button>
    );
  }

  const payload = kind === "prompt" ? { prompt } : kind === "lab_sweep" ? { lens } : {};
  const ready = name.trim() && cron.trim() && (kind !== "prompt" || prompt.trim());
  const submit = async () => {
    await onAdd({ name: name.trim(), cron: cron.trim(), kind, payload, enabled });
    setName("");
    setPrompt("");
    setOpen(false);
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void submit();
      }}
    >
      <div className="grid gap-2 md:grid-cols-[1fr_180px]">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly dependency update" />
        </Field>
        <Field label="Kind">
          <Select
            aria-label="Kind"
            value={kind}
            onChange={(v) => setKind(v as ScheduleKind)}
            options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          />
        </Field>
      </div>
      <Field label="Cron" hint={CRON_HINT}>
        <Input value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono text-[12px]" />
      </Field>
      {kind === "prompt" && (
        <Field label="Prompt">
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="What the session should do" />
        </Field>
      )}
      {kind === "lab_sweep" && (
        <Field label="Lens">
          <Select aria-label="Lens" value={lens} onChange={setLens} options={LENSES.map((l) => ({ value: l, label: l }))} />
        </Field>
      )}
      <div className="flex items-center gap-3">
        <Switch checked={enabled} onChange={setEnabled} label={enabled ? "On" : "Off"} />
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={!ready || busy}>
            Add job
          </Button>
        </div>
      </div>
    </form>
  );
}
