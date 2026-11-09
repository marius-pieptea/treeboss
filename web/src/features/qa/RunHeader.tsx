import { Check, History, MoreHorizontal, Pencil, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Badge, Spinner } from "@/components/ui/misc";
import { DropdownMenu, type MenuEntry } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import type { OutcomeState, PlanSummary, QaSession, RunSummary } from "./api";
import { runLine, SESSION_LABEL, STATES, summaryProgress, type Progress } from "./logic";

const SEGMENT: Record<OutcomeState, string> = { pass: "bg-green", fail: "bg-red", blocked: "bg-amber", skip: "bg-fg-faint", pending: "bg-transparent" };

/** One bar, split by outcome in the order of STATES, so problems sit next to each other. */
export function ProgressBar({ progress }: { progress: Progress }) {
  const { counts, total, done } = progress;
  const label = STATES.filter((s) => s !== "pending" && counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(", ");
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Run progress" title={label || "Nothing marked yet"} className="flex h-1.5 w-full overflow-hidden rounded-full bg-active">
      {total > 0 &&
        STATES.map((s) => counts[s] > 0 && <span key={s} className={cn("h-full transition-[width] duration-200", SEGMENT[s])} style={{ width: `${(counts[s] / total) * 100}%` }} />)}
    </div>
  );
}


export interface RunHeaderProps {
  plans: PlanSummary[];
  slug: string | null;
  onSlug: (slug: string) => void;
  onNew: () => void;
  /** Oldest first, so a run's number is its position. */
  runs: RunSummary[];
  /** The run on screen, or null for the plan itself. */
  runId: string | null;
  progress: Progress | null;
  session: QaSession | null;
  onOpenSession: (id: string) => void;
  editing: boolean;
  proposals: number;
  canStart: boolean;
  canStartNew: boolean;
  /** The run a Resume would open: the newest one that still has pending steps. */
  resumeId: string | null;
  compact: boolean;
  onSuggest: () => void;
  onToggleEdit: () => void;
  onDelete: () => void;
  onStart: () => void;
  onStartNew: () => void;
  onOpenRun: (id: string | null) => void;
  onAcceptAll: () => void;
}

export function RunHeader(p: RunHeaderProps) {
  const number = p.runs.findIndex((r) => r.id === p.runId) + 1;
  const working = !!p.session?.running;
  const viewing = p.runId && p.runId !== p.runs.at(-1)?.id;
  const menu: MenuEntry[] = [
    { label: "Suggest missing steps", icon: <Sparkles />, onSelect: p.onSuggest, disabled: working },
    { label: p.editing ? "Done editing" : "Edit steps", icon: <Pencil />, onSelect: p.onToggleEdit },
    ...(p.runs.length > 0 ? [{ label: "Start a new run", icon: <Play />, onSelect: p.onStartNew, disabled: !p.canStartNew } satisfies MenuEntry] : []),
    { separator: true },
    { label: "Delete plan", icon: <Trash2 />, danger: true, onSelect: p.onDelete },
  ];
  const history: MenuEntry[] = [
    { label: "Plan", checked: p.runId === null, onSelect: () => p.onOpenRun(null) },
    ...p.runs
      .map((r, i): MenuEntry => ({ label: `${runLine(i + 1, summaryProgress(r.counts))} · ${new Date(r.startedAt).toLocaleDateString()}`, checked: r.id === p.runId, onSelect: () => p.onOpenRun(r.id) }))
      .reverse(),
  ];
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <Select size="sm" aria-label="Plan" value={p.slug ?? ""} onChange={p.onSlug} placeholder="No plans yet" disabled={p.plans.length === 0} options={p.plans.map((pl) => ({ value: pl.slug, label: pl.title, hint: `${pl.steps}` }))} />
        </div>
        <Button size="sm" variant="outline" onClick={p.onNew}>
          <Plus /> New plan
        </Button>
        {p.slug && (
          <DropdownMenu
            align="end"
            entries={menu}
            trigger={
              <IconButton label="Plan menu" size="icon">
                <MoreHorizontal />
              </IconButton>
            }
          />
        )}
      </div>
      {p.slug && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {p.session?.running && (
            <span className="flex items-center gap-1 text-xs text-fg-muted">
              <Spinner /> {SESSION_LABEL[p.session.kind]}
              <button type="button" onClick={() => p.onOpenSession(p.session!.sessionId)} className="text-fg underline underline-offset-2 outline-none hover:text-accent">
                Open session
              </button>
            </span>
          )}
          {p.progress && p.runId ? (
            <span className="font-mono text-xs text-fg">{runLine(number, p.progress)}</span>
          ) : (
            !working && <span className="text-xs text-fg-muted">{p.editing ? "Editing the plan" : "Not run yet"}</span>
          )}
          {viewing && <Badge>read only</Badge>}
          <span className="flex-1" />
          {p.proposals > 0 && !p.runId && (
            <Button size="xs" variant="outline" onClick={p.onAcceptAll}>
              <Check className="text-green" /> Accept all ({p.proposals})
            </Button>
          )}
          {p.canStart && (
            <Button size="xs" variant="primary" onClick={p.onStart}>
              <Play /> {p.resumeId ? "Resume" : "Start run"}
            </Button>
          )}
          {p.runs.length > 0 && (
            <DropdownMenu
              align="end"
              entries={history}
              trigger={
                <IconButton label="Run history" size="icon-sm">
                  <History />
                </IconButton>
              }
            />
          )}
        </div>
      )}
      {p.progress && p.runId && <ProgressBar progress={p.progress} />}
    </header>
  );
}
