import { useState } from "react";
import { Archive, ArrowUpRight, Play, Plus, Trash2, Undo2 } from "lucide-react";
import { WhoPicker, useWho } from "@/components/agent-who";
import { Button, IconButton } from "@/components/ui/button";
import { ask } from "@/components/ui/dialogs";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge, Spinner, StatusDot } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { openSession } from "@/features/agent/agent-commands";
import { cn } from "@/lib/utils";
import { ago } from "./Detail";
import { useEvidenceActions, useRunInvestigation, type CreatedInvestigation, type Investigation, type RunStatus, type TargetKindChoice } from "./data";

/** The scope value for "all evidence" (no investigation). */
export const ALL = "all";

const KIND_OPTIONS: Array<{ value: TargetKindChoice; label: string }> = [
  { value: "auto", label: "Auto-detect" },
  { value: "web", label: "Web" },
  { value: "electron", label: "Electron" },
  { value: "binary", label: "Binary" },
  { value: "android", label: "Android" },
  { value: "other", label: "Other" },
];

/** A run's status as the word the operator reads. The dot carries the same status. */
const RUN_WORD: Record<RunStatus, string> = { running: "running", idle: "finished", failed: "failed", closed: "closed", gone: "gone" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 findings · 2 captures", with notes only when there are some. */
export function countsLine(inv: Investigation): string {
  const c = inv.counts;
  return [plural(c.findings, "finding"), plural(c.pages, "capture"), ...(c.notes ? [plural(c.notes, "note")] : [])].join(" · ");
}

/** What a target means depends on its kind: a URL for the web, a path or package for the rest (read by REA). Auto reads either. */
const targetHint = (kind: TargetKindChoice) => {
  if (kind === "auto") return "Paste a URL or a path; the kind is worked out (Electron, native app, APK, binary)";
  return kind === "web" ? "A URL; the agent browses it" : "A path on this computer (e.g. /Applications/App.app) or a package; uses REA";
};

const targetPlaceholder = (kind: TargetKindChoice) => (kind === "web" ? "https://example.com" : kind === "auto" ? "https://example.com or /Applications/App.app" : "/Applications/App.app");

/** The run state: running while an agent works on it, else the latest run's outcome. A dot and a word, never color alone. */
function RunState({ inv }: { inv: Investigation }) {
  const latest = inv.runs[0];
  if (!inv.running && !latest) return <span>not run</span>;
  const status = inv.running ? "running" : latest.status;
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot status={status} /> {RUN_WORD[status]}
    </span>
  );
}

function NewInvestigation({ root, onCreated, onCancel }: { root: string; onCreated: (r: CreatedInvestigation) => void; onCancel: () => void }) {
  const act = useEvidenceActions(root);
  const [who, setWho] = useWho();
  const [title, setTitle] = useState("");
  const [targetKind, setTargetKind] = useState<TargetKindChoice>("auto");
  const [target, setTarget] = useState("");
  const [focus, setFocus] = useState("");
  const busy = act.createInvestigation.isPending;
  const create = (run: boolean) =>
    act.createInvestigation.mutate({ title: title.trim(), target: target.trim() || undefined, target_kind: targetKind, run, note: focus.trim() || undefined, ...who }, { onSuccess: onCreated });
  return (
    <form
      className="flex flex-col gap-2 border-b border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && !busy) create(true);
      }}
    >
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Checkout redesign" autoFocus />
      </Field>
      <Field label="Kind">
        <Select value={targetKind} onChange={(v) => setTargetKind(v as TargetKindChoice)} options={KIND_OPTIONS} aria-label="Target kind" />
      </Field>
      <Field label="Target" hint={targetHint(targetKind)}>
        <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={targetPlaceholder(targetKind)} className="font-mono" />
      </Field>
      <Field label="Focus">
        <Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Optional, e.g. the checkout flow" />
      </Field>
      <WhoPicker who={who} onChange={setWho} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="subtle" onClick={() => create(false)} disabled={!title.trim() || busy}>
          Create only
        </Button>
        <Button type="submit" variant="primary" disabled={!title.trim() || busy}>
          Create and run
        </Button>
      </div>
    </form>
  );
}

/** The left column: all evidence, then each investigation with its run state and counts. */
export function InvestigationsColumn({ root, investigations, scope, onScope, creating, onCreating, onCreated }: { root: string; investigations: Investigation[]; scope: string; onScope: (id: string) => void; creating: boolean; onCreating: (v: boolean) => void; onCreated: (r: CreatedInvestigation) => void }) {
  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-3">
        <span className="flex-1 text-xs font-medium uppercase tracking-wider text-fg-muted">Investigations</span>
        <IconButton label="New investigation" onClick={() => onCreating(!creating)} aria-pressed={creating}>
          <Plus />
        </IconButton>
      </div>
      {creating && <NewInvestigation root={root} onCreated={onCreated} onCancel={() => onCreating(false)} />}
      <ul className="min-h-0 flex-1 overflow-auto">
        <li>
          <button onClick={() => onScope(ALL)} className={cn("flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-[13px] font-medium hover:bg-hover", scope === ALL && "bg-primary-soft")}>
            All evidence
          </button>
        </li>
        {investigations.map((inv) => (
          <li key={inv.id}>
            <button onClick={() => onScope(inv.id)} className={cn("flex w-full flex-col gap-1 border-b border-line px-3 py-2 text-left hover:bg-hover", scope === inv.id && "bg-primary-soft")}>
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{inv.title}</span>
                <Badge>{inv.status}</Badge>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
                <Badge>{inv.target_kind}</Badge>
                <span className="min-w-0 truncate font-mono">{inv.target ?? "no target"}</span>
              </span>
              <span className="text-xs text-fg-muted">
                <RunState inv={inv} />
              </span>
              <span className="text-xs text-fg-muted">{countsLine(inv)}</span>
            </button>
          </li>
        ))}
      </ul>
      {investigations.length === 0 && !creating && <p className="px-3 py-2 text-xs leading-relaxed text-fg-muted">Start one for a site or app you are studying. Its findings and captures collect under it.</p>}
    </div>
  );
}

/** The header of the selected investigation: its target, its runs, and close, reopen and delete. */
export function InvestigationBar({ root, inv, onGone, runError, onRunError }: { root: string; inv: Investigation; onGone: () => void; runError: string | null; onRunError: (id: string, message: string | null) => void }) {
  const act = useEvidenceActions(root);
  const run = useRunInvestigation(root);
  const [who, setWho] = useWho();
  const [deleting, setDeleting] = useState(false);
  const latest = inv.runs[0];
  const start = () => run.mutate({ id: inv.id, ...who }, { onSuccess: () => onRunError(inv.id, null) });
  const close = async () => {
    const summary = await ask({
      title: `Close "${inv.title}"`,
      description: "The evidence and findings stay. Add a line on what the investigation settled, if you like.",
      label: "Summary",
      placeholder: "What it settled, in a sentence",
      confirmLabel: "Close investigation",
    });
    if (summary === null) return;
    act.updateInvestigation.mutate({ id: inv.id, status: "closed", summary: summary.trim() || undefined });
  };
  const remove = (withEvidence: boolean) => act.removeInvestigation.mutate({ id: inv.id, withEvidence }, { onSuccess: () => (setDeleting(false), onGone()) });
  return (
    <div className="flex flex-col gap-1.5 border-b border-line p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold leading-tight">{inv.title}</h2>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
            <Badge>{inv.status}</Badge>
            <Badge>{inv.target_kind}</Badge>
            {inv.target && <span className="min-w-0 truncate font-mono">{inv.target}</span>}
          </div>
          {inv.kind_reason && <p className="mt-1 text-xs leading-relaxed text-fg-muted">Detected from the target: {inv.kind_reason}</p>}
        </div>
        {inv.status === "open" ? (
          <Button variant="ghost" onClick={() => void close()} disabled={act.updateInvestigation.isPending}>
            <Archive /> Close
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => act.updateInvestigation.mutate({ id: inv.id, status: "open" })} disabled={act.updateInvestigation.isPending}>
            <Undo2 /> Reopen
          </Button>
        )}
        <IconButton label="Delete investigation" onClick={() => setDeleting(true)}>
          <Trash2 />
        </IconButton>
      </div>

      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <span className="min-w-0 flex-1 truncate">
          <RunState inv={inv} />
        </span>
        {latest && (
          <Button variant="subtle" onClick={() => openSession(latest.session_id)} disabled={latest.status === "gone"} title="Show the latest run's session in the agent panel">
            <ArrowUpRight /> Open session
          </Button>
        )}
        <WhoPicker who={who} onChange={setWho} inline />
        <Button variant={latest ? "subtle" : "primary"} onClick={start} disabled={run.isPending || inv.running} title={inv.running ? "A run is already going" : "Start an agent session that studies the target"}>
          {run.isPending ? <Spinner /> : <Play />} {latest ? "Run again" : "Run"}
        </Button>
      </div>

      {runError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-line bg-raised p-2 text-xs">
          <p className="flex min-w-0 flex-1 flex-col gap-0.5 leading-relaxed">
            <span className="flex items-center gap-1.5 font-medium text-fg">
              <StatusDot status="failed" /> Run did not start
            </span>
            <span className="text-fg-muted">{runError}</span>
          </p>
          <Button variant="subtle" onClick={start} disabled={run.isPending}>
            Run again
          </Button>
        </div>
      )}

      {inv.runs.length > 0 && (
        <ul aria-label="Past runs" className="flex max-h-32 flex-col overflow-auto rounded-lg border border-line">
          {inv.runs.map((r) => (
            <li key={r.id} className="flex items-center gap-2 border-b border-line px-2 py-1 text-xs last:border-b-0">
              <span className="min-w-0 flex-1 truncate font-mono text-fg-muted">{ago(r.created_at)}</span>
              <span className="inline-flex items-center gap-1.5 text-fg-muted">
                <StatusDot status={r.status} size={6} /> {RUN_WORD[r.status]}
              </span>
              <Button variant="ghost" size="xs" onClick={() => openSession(r.session_id)} disabled={r.status === "gone"} title="Open this run's session in the agent panel">
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}

      {inv.status === "closed" && inv.summary && <p className="text-[13px] leading-relaxed text-fg-muted">{inv.summary}</p>}

      <Dialog
        open={deleting}
        onOpenChange={(o) => !o && setDeleting(false)}
        title={`Delete "${inv.title}"?`}
        description="Keep the evidence to leave its captures and findings in All evidence, or delete them too. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button onClick={() => remove(false)} disabled={act.removeInvestigation.isPending}>
              Keep evidence
            </Button>
            <Button variant="danger" onClick={() => remove(true)} disabled={act.removeInvestigation.isPending}>
              Delete with evidence
            </Button>
          </>
        }
      />
    </div>
  );
}
