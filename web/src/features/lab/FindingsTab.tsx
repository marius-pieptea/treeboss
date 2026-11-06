import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, Check, FlaskConical, Hammer, Kanban, Layers, Palette, Play, ScrollText, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Empty, SegTabs, Skeleton, Spinner, StatusDot } from "@/components/ui/misc";
import { confirm } from "@/components/ui/dialogs";
import { Dialog } from "@/components/ui/overlay";
import { openSession } from "@/features/agent/agent-commands";
import { useSessions } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { bus } from "@/lib/bus";
import { cn } from "@/lib/utils";
import { useModules, useSweepPlan, type Actions, type Finding, type Lens, type LabRun, type Who } from "./data";
import { openChecklists, openFindings } from "./open";
import { takePendingFindings } from "./views";
import { LabGate, LabPage, SweepRow, WhoPicker, useLabView, useWho } from "./shared";
import { applyFilter, checklistRef, countByStatus, EFFORT_LABEL, IMPACT_TONE, isBug, NO_FILTER, splitEvidence, tokensLabel, type Filter, type StatusFilter } from "./logic";

const SCOPE_PROJECT = "project";
const SCOPE_DIFF = "diff";

/** Evidence as a link that opens the file at the line. */
function EvidenceLink({ root, value }: { root: string; value: string }) {
  const openTab = useUi((s) => s.openTab);
  const ev = splitEvidence(value);
  if (!ev) return <span className="font-mono text-[11px] text-fg-faint">{value}</span>;
  return (
    <button type="button" onClick={() => openTab({ kind: "file", root, path: ev.path, title: ev.path.split("/").pop() ?? ev.path, line: ev.line ?? undefined })} className="max-w-full truncate rounded px-1 font-mono text-[11px] text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40">
      {value}
    </button>
  );
}

function FindingCard({ root, f, actions, busy, fixBlocked, onOpenSession, focused }: { root: string; f: Finding; actions: Actions; busy: boolean; fixBlocked: string | null; onOpenSession: (id: string) => void; focused: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const closed = f.status === "dismissed" || f.status === "shipped";
  const go = (p: Promise<{ session?: { id: string } }>) => void p.then((r) => r.session && onOpenSession(r.session.id)).catch(() => {});
  const openTab = useUi((s) => s.openTab);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  return (
    <article ref={ref} data-finding={f.id} data-status={f.status} className={cn("flex flex-col gap-2 rounded-xl border border-line bg-panel px-3 py-2.5", closed && "opacity-60")}>
      <header className="flex items-start gap-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <h3 className="text-[13px] font-semibold leading-snug">{f.title}</h3>
          {!open && f.summary && <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-fg-muted">{f.summary}</p>}
        </button>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {f.lens && <Badge tone="accent">{f.lens}</Badge>}
          <Badge tone={IMPACT_TONE[f.impact]} title="Impact">
            {f.impact}
          </Badge>
          <Badge title="Effort">{EFFORT_LABEL[f.effort]}</Badge>
          {f.unmeasured && (
            <Badge tone="amber" title="A reading of the code: no number behind it yet">
              unmeasured
            </Badge>
          )}
          {f.status !== "new" && <Badge tone={f.status === "shipped" ? "green" : "neutral"}>{f.status}</Badge>}
        </div>
      </header>

      {f.checklist && (
        <p className="flex items-center gap-1.5 text-sm text-fg-muted" data-finding-checklist>
          Checklist item <span className="font-mono">{f.checklist}</span>
          <Button variant="ghost" size="sm" onClick={() => openChecklists(checklistRef(f.checklist))}>
            Open checklist
          </Button>
        </p>
      )}
      {f.problem && <p className="text-[11.5px] text-amber">{f.problem}</p>}
      {f.drifted.length > 0 && (
        <p className="flex items-center gap-1.5 text-sm text-amber" data-finding-drift>
          <AlertTriangle className="size-3.5 shrink-0" /> The line this cites changed since the run that wrote it: {f.drifted.join(", ")}. Check it still applies.
        </p>
      )}
      {f.missing.length > 0 && (
        <p className="flex items-center gap-1.5 text-[11.5px] text-amber" data-finding-stale>
          <AlertTriangle className="size-3.5 shrink-0" /> The code this points at has changed: {f.missing.join(", ")} no longer exists. Check it still applies.
        </p>
      )}
      {open && f.body && <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg-muted">{f.body}</p>}

      {(f.scope || f.evidence.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
          {f.scope && <span className="font-mono text-[11px] text-fg-faint">{f.scope}</span>}
          {(open ? f.evidence : f.evidence.slice(0, 2)).map((e) => (
            <EvidenceLink key={e} root={root} value={e} />
          ))}
          {!open && f.evidence.length > 2 && <span className="text-[11px] text-fg-faint">+{f.evidence.length - 2}</span>}
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-1.5">
        {f.session && (
          <Button size="xs" variant="ghost" onClick={() => onOpenSession(f.session!)} title="The session that wrote or last changed this finding">
            <ArrowUpRight /> Open session
          </Button>
        )}
        {f.scope && f.lens && f.lens !== "checklist" && (
          <Button size="xs" variant="ghost" onClick={() => openFindings({ lens: f.lens ?? undefined, scope: f.scope ?? undefined })} title="Run this lens again on this scope">
            <FlaskConical /> Run again here
          </Button>
        )}
        {!closed && (
          <>
            {f.roadmap ? (
              <Button size="xs" variant="ghost" onClick={() => openTab({ kind: "roadmap", title: "Roadmap" })}>
                <Kanban /> On roadmap {f.roadmap}
              </Button>
            ) : (
              <Button size="xs" disabled={busy} onClick={() => actions.toRoadmap.mutate(f.id)}>
                <Kanban /> Roadmap
              </Button>
            )}
            <Button size="xs" disabled={busy || !!f.spec} onClick={() => go(actions.toSpec.mutateAsync(f.id))} title={f.spec ? `Spec: ${f.spec}` : "Add to the roadmap and start its spec"}>
              <ScrollText /> {f.spec ? "Has spec" : "Spec"}
            </Button>
            <Button size="xs" variant="primary" disabled={busy || !!fixBlocked} onClick={() => go(actions.fix.mutateAsync(f.id))} title={fixBlocked ?? "Start a session that fixes this"}>
              <Hammer /> {f.fixRunning ? "Fix running" : "Fix now"}
            </Button>
            {(f.lens === "ui" || f.lens === "ux") && (
              <Button size="xs" disabled={busy} onClick={() => go(actions.design.mutateAsync(f.id))}>
                <Palette /> Design review
              </Button>
            )}
          </>
        )}
        <div className="flex-1" />
        {f.status === "shipped" || f.status === "dismissed" ? (
          <>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => actions.setStatus.mutate({ id: f.id, status: "new" })}>
              <Undo2 /> Reopen
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void confirm({ title: "Delete this finding?", description: `${f.path} is removed. A dismissed finding is kept so later runs do not propose it again; delete it only if you want it forgotten.`, confirmLabel: "Delete", danger: true }).then((yes) => yes && actions.remove.mutate(f.id))}>
              <Trash2 /> Delete
            </Button>
          </>
        ) : (
          <>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => actions.setStatus.mutate({ id: f.id, status: "shipped" })}>
              <Check /> Shipped
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => actions.setStatus.mutate({ id: f.id, status: "dismissed" })} title="Later runs will not propose it again">
              <X /> Dismiss
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}


/** What a sweep would cover and read, before it starts. */
function SweepDialog({ root, lens, who, onWho, open, onOpenChange, actions }: { root: string; lens: Lens; who: Who; onWho: (w: Who) => void; open: boolean; onOpenChange: (o: boolean) => void; actions: Actions }) {
  const [limit, setLimit] = useState(6);
  const [parallel, setParallel] = useState(3);
  const q = useSweepPlan(root, lens, limit, open);
  const plan = q.data;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sweep the modules"
      description="One pass per module, a few at a time. Each only writes to lab/findings/, and the findings from all of them land in one list."
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!plan || actions.sweep.isPending}
            onClick={() => plan && actions.sweep.mutate({ lens, scopes: plan.modules.map((m) => m.path), limit, parallel, ...who }, { onSuccess: () => onOpenChange(false) })}
          >
            {actions.sweep.isPending ? <Spinner className="size-3.5" /> : <Play />} Start {plan?.modules.length ?? ""} sessions
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Modules to cover" hint="The biggest first.">
            <Select aria-label="Modules to cover" value={String(limit)} onChange={(v) => setLimit(Number(v))} options={[3, 6, 10, 20].map((n) => ({ value: String(n), label: `Up to ${n}` }))} />
          </Field>
          <Field label="At the same time" hint="The rest wait their turn.">
            <Select aria-label="At the same time" value={String(parallel)} onChange={(v) => setParallel(Number(v))} options={[1, 2, 3, 4, 6].map((n) => ({ value: String(n), label: String(n) }))} />
          </Field>
        </div>
        <WhoPicker who={who} onChange={onWho} />
        {q.isLoading && <Skeleton className="h-24" />}
        {q.error && <p className="text-[12px] text-red">{(q.error as Error).message}</p>}
        {plan && (
          <>
            <ul className="flex max-h-56 flex-col divide-y divide-line overflow-auto rounded-lg border border-line" data-sweep-modules>
              {plan.modules.map((m) => (
                <li key={m.path} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                  <span className="min-w-0 flex-1 truncate font-mono">{m.path}</span>
                  <span className="shrink-0 text-fg-faint">{m.files} {m.files === 1 ? "file" : "files"}</span>
                  <span className="w-20 shrink-0 text-right text-fg-faint">{tokensLabel(m.tokens)}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11.5px] text-fg-muted">
              About {tokensLabel(plan.tokens)} to read in full: a ceiling, since each run reads what it needs. {plan.skipped.length > 0 && `${plan.skipped.length} more module${plan.skipped.length === 1 ? "" : "s"} left out.`}
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}


function RunRow({ run, title, status, onOpen }: { run: LabRun; title: string; status: string; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/40">
        <StatusDot status={status} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {run.touched.length > 0 && (
          <Badge tone="amber" title={`Files outside lab/ changed during this run: ${run.touched.slice(0, 8).join(", ")}${run.touched.length > 8 ? ", …" : ""}. Other sessions' edits in the same window count too.`}>
            <AlertTriangle className="size-3" /> {run.touched.length} file{run.touched.length === 1 ? "" : "s"} changed · may include other sessions
          </Badge>
        )}
        {run.sweepId && <Badge title="Part of a sweep">sweep</Badge>}
        <ArrowUpRight className="size-3.5 shrink-0 text-fg-faint" />
      </button>
    </li>
  );
}


/** Findings: ask where a project could be better, then act on the answers. The findings are files in lab/findings/; this tab is a lens over them. */
export function FindingsTab() {
  const { root, q, state, actions, busy, fixBlockOf } = useLabView();
  const [lens, setLens] = useState<Lens>("features");
  const [scope, setScope] = useState(SCOPE_PROJECT);
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [who, setWho] = useWho();

  // A palette command or another module asked for a particular pass: set it up, and open the sweep dialog when asked.
  useEffect(() => {
    const take = () => {
      const i = takePendingFindings();
      if (!i) return;
      if (i.lens) setLens(i.lens);
      if (i.scope) setScope(i.scope);
      if (i.sweep) setSweeping(true);
      if (i.finding) {
        setFilter({ status: "all", lens: "checklist" });
        setFocusId(i.finding);
      }
    };
    take();
    return bus.on("findings-open", take);
  }, []);

  const listed = useMemo(() => (state?.findings ?? []).filter((f) => !isBug(f)), [state?.findings]);
  const shown = useMemo(() => applyFilter(listed, filter), [listed, filter]);
  const counts = useMemo(() => countByStatus(listed), [listed]);

  const modulesQ = useModules(root);
  const scopeOptions = [
    { value: SCOPE_PROJECT, label: "Whole project" },
    { value: SCOPE_DIFF, label: "Current changes" },
    ...(modulesQ.data ?? []).map((m) => ({ value: m.path, label: m.path, hint: `${m.files} files` })),
  ];
  const lensInfo = state?.lenses.find((l) => l.id === lens);

  const start = () => {
    actions.run.mutate({ lens, scope, note: note.trim() || undefined, ...who }, { onSuccess: (r) => (setNote(""), openSession(r.session.id)) });
  };

  if (!state) return <LabGate q={q} icon={<FlaskConical />} title="Findings" />;

  return (
    <LabPage icon={<FlaskConical />} title="Findings" hint="Find what to improve, then turn it into roadmap items, specs and fixes.">
      <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3" aria-label="Start a pass">
        <SegTabs value={lens} onChange={setLens} items={state.lenses.filter((l) => l.runnable).map((l) => ({ value: l.id, label: l.label }))} />
        {lensInfo && <p className="text-[12px] text-fg-muted">{lensInfo.hint}</p>}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Scope" className="min-w-52 flex-1" hint="A folder or a file in the project, or pick a module">
            <Input list="lab-scopes" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="project, diff, or a path" aria-label="Scope" />
            <datalist id="lab-scopes">
              {scopeOptions.map((o) => (
                <option key={o.value} value={o.value} label={o.label} />
              ))}
            </datalist>
          </Field>
          <Button variant="primary" size="md" disabled={actions.run.isPending} onClick={start}>
            {actions.run.isPending ? <Spinner className="size-4" /> : <Play />} Run
          </Button>
          <Button size="md" onClick={() => setSweeping(true)} title="Run this lens over each module">
            <Layers /> Sweep modules
          </Button>
        </div>
        <WhoPicker who={who} onChange={setWho} />
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Optional: what to focus on (“checkout flow”, “startup time”)" aria-label="Focus" />
      </section>

      {state.sweeps.some((s) => s.kind !== "fix" && (s.running > 0 || s.queued > 0)) && (
        <section className="flex flex-col gap-2" aria-label="Sweeps in progress">
          {state.sweeps
            .filter((s) => s.kind !== "fix" && (s.running > 0 || s.queued > 0))
            .map((s) => (
              <SweepRow key={s.id} sweep={s} onCancel={() => actions.cancelSweep.mutate(s.id)} />
            ))}
        </section>
      )}

      <section className="flex flex-col gap-3" aria-label="Findings">
        <div className="flex flex-wrap items-center gap-2">
          <SegTabs<StatusFilter>
            value={filter.status}
            onChange={(status) => setFilter((f) => ({ ...f, status }))}
            items={(["open", "dismissed", "shipped", "all"] as const).map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1), badge: counts[s] ? <span className="text-fg-faint">{counts[s]}</span> : undefined }))}
          />
          <div className="flex-1" />
          <Select
            size="sm"
            value={filter.lens}
            onChange={(lens) => setFilter((f) => ({ ...f, lens: lens as Filter["lens"] }))}
            options={[{ value: "all", label: "All lenses" }, ...state.lenses.filter((l) => l.id !== "bug").map((l) => ({ value: l.id, label: l.label }))]}
            aria-label="Lens filter"
            className="w-40"
          />
        </div>
        {shown.length === 0 ? (
          <Empty
            icon={<FlaskConical />}
            title={listed.length === 0 ? "No findings yet" : "Nothing matches"}
            hint={listed.length === 0 ? "Pick a lens and a scope, then run a pass. Each finding is written to lab/findings/." : "Change the filter to see the others."}
          />
        ) : (
          shown.map((f) => <FindingCard key={f.id} root={root} f={f} actions={actions} busy={busy} fixBlocked={fixBlockOf(f.id)} onOpenSession={openSession} focused={f.id === focusId} />)
        )}
      </section>

      {state.runs.length > 0 && <RunsList runs={state.runs} />}
      <SweepDialog root={root} lens={lens} who={who} onWho={setWho} open={sweeping} onOpenChange={setSweeping} actions={actions} />
    </LabPage>
  );
}

function RunsList({ runs }: { runs: LabRun[] }) {
  // Titles and live status come from the sessions the runs started; the list is a pointer to them.
  const ws = useUi((s) => s.current);
  const list = useSessions(ws).data;
  const sessions = useMemo(() => new Map((list ?? []).map((x) => [x.id, x])), [list]);
  return (
    <section className="flex flex-col gap-1" aria-label="Recent runs">
      <h2 className="px-2 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Recent runs</h2>
      <ul>
        {runs.slice(0, 12).map((r) => (
          <RunRow key={r.sessionId} run={r} title={sessions.get(r.sessionId)?.title ?? `${r.lens} · ${r.scope}`} status={sessions.get(r.sessionId)?.status ?? "idle"} onOpen={() => openSession(r.sessionId)} />
        ))}
      </ul>
    </section>
  );
}
