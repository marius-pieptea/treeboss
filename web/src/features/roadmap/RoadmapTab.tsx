import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileText, Kanban, Plus, RefreshCw, Search as SearchIcon, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { ask } from "@/components/ui/dialogs";
import { Input, Select } from "@/components/ui/form";
import { Empty, SegTabs, Skeleton, Spinner } from "@/components/ui/misc";
import { openSession } from "@/features/agent/agent-commands";
import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { Board } from "./Board";
import { rmKey, useRoadmap, useRoadmapActions, type RoadmapState } from "./data";
import { ItemDrawer } from "./ItemDrawer";
import { ListView } from "./ListView";
import { Timeline } from "./Timeline";
import { allItems, allTags, applyMove, filterLanes, isFiltering, NO_FILTER, STATUS_LABEL, type Filter } from "./logic";

type View = "board" | "list" | "timeline";
const VIEW_KEY = "trb.roadmap.view";

function readView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "board" || v === "list" || v === "timeline") return v;
  } catch {}
  return "board";
}

/** The roadmap: ROADMAP.md as a board, a list or a timeline. The file is the data; this tab is a lens over it. */
export function RoadmapTab() {
  const { root } = useWorkspace();
  const qc = useQueryClient();
  const openTab = useUi((s) => s.openTab);
  const q = useRoadmap(root);
  const [view, setViewState] = useState<View>(readView);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const rekey = useCallback((from: string, to: string) => setSelected((s) => (s === from ? to : s)), []);
  const actions = useRoadmapActions(root, rekey);
  const state = q.data;

  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

  const optimistic = useCallback(
    (key: string, lane: string, index: number | null) => qc.setQueryData<RoadmapState>(rmKey(root), (old) => (old ? { ...old, lanes: applyMove(old.lanes, key, lane, index) } : old)),
    [qc, root],
  );

  const lanes = state?.lanes ?? [];
  const shown = useMemo(() => filterLanes(lanes, filter), [lanes, filter]);
  const tags = useMemo(() => allTags(lanes), [lanes]);
  const item = useMemo(() => (selected ? allItems(lanes).find((i) => i.key === selected || i.id === selected) ?? null : null), [lanes, selected]);

  // A selected item that is gone (deleted, or edited out from under us) closes its drawer.
  useEffect(() => {
    if (selected && state?.exists && !item && !q.isFetching) setSelected(null);
  }, [selected, item, state?.exists, q.isFetching]);

  const newItem = useCallback(() => {
    const first = state?.lanes[0]?.name;
    if (first) {
      if (view === "timeline") setView("board");
      setAdding(first);
    }
  }, [state?.lanes, view]);
  useEffect(() => bus.on("roadmap-new-item", newItem), [newItem]);

  // Escape: leave a field (which saves it), then close the drawer. Open menus and dialogs have their own Escape.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea")) return void t.blur();
      if (document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]')) return;
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const filtering = isFiltering(filter);
  const onSession = (id: string) => openSession(id);
  const openFile = () => state && openTab({ kind: "file", root, path: state.path, title: state.path.split("/").pop() ?? state.path });

  const changePath = async () => {
    const p = await ask({ title: "Roadmap file", description: "Where the roadmap lives, relative to this project. It must be a .md file.", initial: state?.path ?? "ROADMAP.md", confirmLabel: "Use this file" });
    if (p && p.trim()) actions.setPath.mutate(p.trim());
  };

  let body: React.ReactNode;
  if (q.isLoading) {
    body = (
      <div className="flex gap-3 p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="w-[288px] space-y-2 rounded-xl border border-line p-3">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    );
  } else if (q.error && !state) {
    body = <Empty icon={<AlertTriangle />} title="Could not read the roadmap" hint={q.error instanceof Error ? q.error.message : undefined} action={<Button onClick={() => void q.refetch()}>Try again</Button>} />;
  } else if (state && !state.exists) {
    body = (
      <Empty
        className="mx-auto max-w-sm"
        icon={<Kanban />}
        title="No roadmap yet"
        hint={`This creates ${state.path} with Now, Next and Later lanes and a short note on the format. Nothing is written until you click.`}
        action={
          <div className="flex flex-col items-center gap-2">
            <Button variant="primary" size="md" data-roadmap-create disabled={actions.create.isPending} onClick={() => actions.create.mutate(undefined)}>
              {actions.create.isPending ? <Spinner /> : <Plus />} Create {state.path.split("/").pop()}
            </Button>
            <button type="button" onClick={() => void changePath()} className="text-[11.5px] text-fg-faint underline-offset-2 outline-none hover:text-fg-muted hover:underline focus-visible:underline">
              Use a different file
            </button>
          </div>
        }
      />
    );
  } else if (state && state.lanes.length === 0) {
    body = <Empty icon={<Kanban />} title="No lanes in this file" hint="A lane is an H2 heading, like ## Now. Add one and the board comes to life." action={<Button variant="primary" onClick={() => actions.addLane.mutate("Now")}>Add a "Now" lane</Button>} />;
  } else if (state) {
    const common = { selected, onOpen: setSelected, onSession, adding, onAdding: setAdding, actions };
    body =
      view === "board" ? (
        <Board lanes={shown} allLanes={lanes} filtering={filtering} optimistic={optimistic} {...common} />
      ) : view === "list" ? (
        <ListView lanes={shown} {...common} />
      ) : (
        <Timeline lanes={shown} selected={selected} onOpen={setSelected} />
      );
  }

  const count = allItems(lanes).length;
  return (
    <div data-roadmap-tab className="relative flex h-full min-w-0 flex-col bg-panel">
      <header className="border-b border-line">
        <div className="flex items-center gap-3 px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Kanban className="size-4 shrink-0 text-accent" />
            <h2 className="truncate text-[13px] font-semibold text-fg">{state?.heading ?? "Roadmap"}</h2>
            {state?.exists && (
              <button type="button" onClick={openFile} title="Open the file" className="truncate rounded px-1 font-mono text-[10.5px] text-fg-faint outline-none hover:bg-hover hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-accent/40">
                {state.path}
              </button>
            )}
            {state && state.broken > 0 && (
              <span data-roadmap-broken-count className="flex shrink-0 items-center gap-1 text-[11px] text-amber" title="Items whose spec or docs link points at something that is not there">
                <AlertTriangle className="size-3" /> {state.broken} broken link{state.broken === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {state?.exists && state.lanes.length > 0 && (
            <SegTabs<View>
              value={view}
              onChange={setView}
              items={[
                { value: "board", label: "Board" },
                { value: "list", label: "List" },
                { value: "timeline", label: "Timeline" },
              ]}
              className="w-[220px] shrink-0"
            />
          )}
          <span className="flex-1" />
          {state?.exists && (
            <>
              <span className="shrink-0 font-mono text-[10.5px] text-fg-faint">{filtering ? `${allItems(shown).length} of ${count}` : `${count} item${count === 1 ? "" : "s"}`}</span>
              <IconButton label="Reload from the file" size="icon-sm" onClick={() => void q.refetch()}>
                <RefreshCw className={cn(q.isFetching && "animate-spin")} />
              </IconButton>
              <IconButton label="Open ROADMAP.md" size="icon-sm" onClick={openFile}>
                <FileText />
              </IconButton>
              <Button variant="primary" size="sm" data-roadmap-new disabled={state.lanes.length === 0} onClick={newItem}>
                <Plus /> New item
              </Button>
            </>
          )}
        </div>
        {state?.exists && state.lanes.length > 0 && (
          <div className="flex items-center gap-2 px-4 pb-2">
            <div className="relative min-w-[120px] max-w-[220px] flex-1">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
              <Input value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} placeholder="Filter" aria-label="Filter items" data-roadmap-filter className="h-7 pl-7 text-[12px]" />
            </div>
            <Select value={filter.tag} onChange={(tag) => setFilter({ ...filter, tag })} options={[{ value: "", label: "Any tag" }, ...tags.map((t) => ({ value: t, label: t }))]} size="sm" className="w-[104px]" aria-label="Filter by tag" />
            <Select value={filter.status} onChange={(status) => setFilter({ ...filter, status: status as Filter["status"] })} options={[{ value: "", label: "Any status" }, ...(["not_started", "in_progress", "shipped"] as const).map((s) => ({ value: s, label: STATUS_LABEL[s] }))]} size="sm" className="w-[118px]" aria-label="Filter by status" />
            <Select value={filter.lane} onChange={(lane) => setFilter({ ...filter, lane })} options={[{ value: "", label: "All lanes" }, ...lanes.map((l) => ({ value: l.name, label: l.name }))]} size="sm" className="w-[104px]" aria-label="Filter by lane" />
            {filtering && (
              <Button size="xs" variant="ghost" onClick={() => setFilter(NO_FILTER)}>
                <X /> Clear
              </Button>
            )}
          </div>
        )}
      </header>
      <div className="relative min-h-0 flex-1">
        <div className="h-full transition-[padding] duration-200" style={{ paddingRight: item ? 372 : 0 }}>
          {body}
        </div>
        {item && state && <ItemDrawer key={item.key} root={root} item={item} lanes={lanes} roadmapPath={state.path} actions={actions} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
