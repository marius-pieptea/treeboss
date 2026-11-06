import { useEffect, useRef, useState } from "react";
import { Camera, Fingerprint, Globe, StickyNote } from "lucide-react";
import { prefillNewSession } from "@/features/agent/prefill";
import { Button, IconButton } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Empty, SegTabs, Skeleton } from "@/components/ui/misc";
import { bus } from "@/lib/bus";
import { useWorkspace } from "@/lib/workspace";
import { useWs } from "@/lib/store";
import { PaneSplitter, usePaneWidth } from "@/components/ui/splitter";
import { cn } from "@/lib/utils";
import { Detail } from "./Detail";
import { FindingsSection } from "./Findings";
import { ALL, InvestigationBar, InvestigationsColumn } from "./Investigations";
import { takePendingNewInvestigation } from "./open";
import { useEvidence, useEvidenceActions, useEvidenceSwitches, type CreatedInvestigation, type EvidenceItem, type FindingKind, type Investigation } from "./data";

const FINDING_OPTIONS = [
  { value: "", label: "Plain note" },
  { value: "feature", label: "Feature" },
  { value: "ui", label: "UI design" },
];

function NoteForm({ root, investigation, onSaved }: { root: string; investigation: Investigation | null; onSaved: () => void }) {
  const act = useEvidenceActions(root);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [finding, setFinding] = useState<"" | FindingKind>("");
  const save = () =>
    act.note.mutate(
      { title, text, refs: [], finding: finding || undefined, investigation_id: investigation?.id },
      {
        onSuccess: () => {
          setTitle("");
          setText("");
          setFinding("");
          onSaved();
        },
      },
    );
  return (
    <div className="flex flex-col gap-2 border-t border-line p-3">
      <p className="text-xs text-fg-muted">{investigation ? `Filed under ${investigation.title}.` : "Not filed under an investigation. Pick one on the left first to file it there."}</p>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A finding, e.g. The cards use a 12px radius" aria-label="Note title" />
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="What you saw, and how you know." aria-label="Note text" />
      <div className="flex items-center gap-2">
        <Select size="sm" value={finding} onChange={(v) => setFinding(v as "" | FindingKind)} options={FINDING_OPTIONS} aria-label="Kind" className="w-32" />
        <div className="flex-1" />
        <Button variant="primary" onClick={save} disabled={!title.trim() || !text.trim() || act.note.isPending}>
          <StickyNote /> Save note
        </Button>
      </div>
    </div>
  );
}

/** Evidence: investigations (what is being studied), and the pages, notes, findings and REA results filed under them. */
export function EvidenceTab() {
  const listW = usePaneWidth("evidence.list", 360);
  const { root } = useWorkspace();
  const activeSession = useWs().activeSession;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "page" | "note">("all");
  const [scope, setScope] = useState(ALL);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(() => takePendingNewInvestigation());
  // A run that could not start, per investigation id: shown under that investigation's header until a run starts.
  const [runErrors, setRunErrors] = useState<Record<string, string | null>>({});
  const setRunError = (id: string, message: string | null) => setRunErrors((m) => ({ ...m, [id]: message }));
  // The investigation just created: selected before the list has refetched it, so the reset below must not drop it.
  const pendingId = useRef<string | null>(null);
  const investigationId = scope === ALL ? undefined : scope;
  const q = useEvidence(root, { q: query, kind, investigation: investigationId });
  const act = useEvidenceActions(root);
  const { set } = useEvidenceSwitches();
  const items = q.data?.items ?? [];
  const investigations = q.data?.investigations ?? [];
  const inv = investigations.find((i) => i.id === scope) ?? null;
  const current = items.find((i) => i.id === selected) ?? null;
  const findings = items.filter((i) => i.finding);
  const evidence = items.filter((i) => !i.finding);

  const pickScope = (id: string) => {
    setScope(id);
    setSelected(null);
    setChecked([]);
  };
  // The investigation is gone (deleted here or elsewhere): fall back to all evidence.
  useEffect(() => {
    if (inv) pendingId.current = null;
    if (q.data && scope !== ALL && !inv && scope !== pendingId.current) {
      setScope(ALL);
      setSelected(null);
      setChecked([]);
    }
  }, [q.data, scope, inv]);

  // The palette's "Evidence: new investigation…" when the tab is already open.
  useEffect(() => bus.on("evidence-new-investigation", () => setCreating(true)), []);

  // Findings go to a new session's composer as a build brief; the ones not yet built are marked planned, since the
  // brief is now the plan. Built ones keep their status.
  const build = (ids: string[]) =>
    act.build.mutate(ids, {
      onSuccess: (r) => {
        prefillNewSession(r.prompt);
        const planned = items.filter((i) => r.ids.includes(i.id) && i.finding_status !== "built").map((i) => i.id);
        if (planned.length) act.markPlanned.mutate(planned);
        setChecked([]);
      },
    });
  const toggle = (id: string, on: boolean) => setChecked((c) => (on ? [...c.filter((x) => x !== id), id] : c.filter((x) => x !== id)));

  // A new investigation is selected at once, so its result is in view; a run that did not start stays under its header.
  const created = (r: CreatedInvestigation) => {
    const id = r.investigation.id;
    pendingId.current = id;
    setCreating(false);
    pickScope(id);
    if (r.runError) setRunError(id, r.runError);
  };

  return (
    <div className="flex h-full bg-bg">
      <InvestigationsColumn root={root} investigations={investigations} scope={scope} onScope={pickScope} creating={creating} onCreating={setCreating} onCreated={created} />

      <div style={{ width: listW }} className="flex shrink-0 flex-col bg-panel">
        <div className="flex flex-col gap-2 border-b border-line p-3">
          <div className="flex items-center gap-2">
            <Fingerprint className="size-4 text-accent" />
            <h1 className="flex-1 text-[15px] font-semibold">Evidence</h1>
            <Button variant="ghost" onClick={() => activeSession && act.capture.mutate({ sessionId: activeSession, investigation_id: investigationId })} disabled={!q.data?.enabled || !q.data?.browser || !activeSession || act.capture.isPending} title={activeSession ? "Capture the page open in this session's browser" : "Open a session with a browser page first"}>
              <Camera /> Capture
            </Button>
            <IconButton label="Add a note" onClick={() => setAdding((v) => !v)}>
              <StickyNote />
            </IconButton>
          </div>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, URL, summary" aria-label="Search evidence" />
          <SegTabs
            value={kind}
            onChange={setKind}
            items={[
              { value: "all", label: "All" },
              { value: "page", label: "Pages" },
              { value: "note", label: "Notes" },
            ]}
          />
        </div>

        {inv && <InvestigationBar root={root} inv={inv} onGone={() => pickScope(ALL)} runError={runErrors[inv.id] ?? null} onRunError={setRunError} />}

        {q.data && !q.data.enabled && (
          <div className="flex items-center gap-2 border-b border-line bg-raised/40 p-3 text-xs text-fg-muted">
            <span className="flex-1">Agents cannot capture or save evidence until you turn it on. Existing items stay readable.</span>
            <Button variant="primary" onClick={() => set.mutate({ key: "evidence", on: true })}>
              Turn on
            </Button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {q.isLoading ? (
            <div className="grid gap-2 p-3">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : q.error ? (
            <div className="p-3 text-xs text-red">{(q.error as Error).message}</div>
          ) : !items.length ? (
            <Empty
              icon={<Fingerprint />}
              title={inv ? "Nothing in this investigation yet" : query || kind !== "all" ? "Nothing matches" : "No evidence yet"}
              hint={inv ? "Capture the page open in a session's browser, or add a note: it is filed under this investigation." : "Agents add evidence with evidence_capture_page while they study a site. You can capture the page open in a session's browser too."}
              className="m-3 rounded-xl border border-dashed border-line"
            />
          ) : (
            <>
              <FindingsSection
                items={findings}
                selected={checked}
                selectedId={selected}
                onToggle={toggle}
                onOpen={setSelected}
                onStatus={(id, status) => act.setFindingStatus.mutate({ id, status })}
                onBuild={() => build(checked)}
                building={act.build.isPending}
              />
              {evidence.length > 0 && <EvidenceList items={evidence} selectedId={selected} onOpen={setSelected} />}
            </>
          )}
        </div>
        {adding && <NoteForm root={root} investigation={inv} onSaved={() => setAdding(false)} />}
        {q.data?.rea.enabled && (
          <div className="border-t border-line px-3 py-2 text-xs text-fg-muted">
            REA {q.data.rea.version} {q.data.rea.available ? "is offered to sessions" : "is on but cannot start (npx not found)"}.
          </div>
        )}
      </div>
      <PaneSplitter paneKey="evidence.list" fallback={360} min={260} max={720} />

      <div className="min-w-0 flex-1 overflow-auto">
        {current ? (
          <Detail root={root} item={current} onGone={() => setSelected(null)} onBuild={build} building={act.build.isPending} />
        ) : (
          <Empty icon={<Fingerprint />} title="Select an item" hint="Pages show what was measured; notes show what was concluded and what it cites." className="h-full" />
        )}
      </div>
    </div>
  );
}

function EvidenceList({ items, selectedId, onOpen }: { items: EvidenceItem[]; selectedId: string | null; onOpen: (id: string) => void }) {
  return (
    <section aria-label="Evidence" className="flex flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">Evidence</span>
        <span className="font-mono text-xs text-fg-muted">{items.length}</span>
      </div>
      <ul className="flex flex-col">
        {items.map((i) => (
          <li key={i.id}>
            <button onClick={() => onOpen(i.id)} className={cn("flex w-full items-start gap-2 border-b border-line px-3 py-2 text-left hover:bg-hover", selectedId === i.id && "bg-primary-soft")}>
              {i.kind === "page" ? <Globe className="mt-0.5 size-3.5 shrink-0 text-blue" /> : <StickyNote className="mt-0.5 size-3.5 shrink-0 text-fg-muted" />}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{i.title}</span>
                  {i.source === "rea" && <Badge title="Produced by REA">REA</Badge>}
                </span>
                <span className="block truncate font-mono text-xs text-fg-muted">{i.url ?? i.summary}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
