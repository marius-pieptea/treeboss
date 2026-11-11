import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy, Download, History, MessageSquarePlus, Network, Pencil, Pin, PinOff, Search, Square, Trash2, UserRoundCog, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, post, url } from "@/lib/api";
import { qk, useClosedCount, useClosedSessions, usePairs, usePinnedSessions, useSessions } from "@/lib/queries";
import { useUi, useWs } from "@/lib/store";
import { useDraftedSessions, useNewSessionDraft } from "@/lib/use-drafts";
import type { PinnedSession, SessionView } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";
import { ago, cn, money } from "@/lib/utils";
import { IconButton } from "@/components/ui/button";
import { ContextMenu, type MenuEntry } from "@/components/ui/overlay";
import { Badge, Empty, Section, Skeleton, StatusDot } from "@/components/ui/misc";
import { ask, confirm } from "@/components/ui/dialogs";
import { bus } from "@/lib/bus";
import { openSessionIn, startNewSession } from "@/features/agent/agent-commands";
import { ContextBar } from "@/features/agent/ContextMeter";
import { WaitingChip } from "@/features/agent/WaitingChip";
import { ensureTurnWatcher } from "@/features/agent/turn-watcher";
import { groupSessions, headCounts } from "./sessions-logic";
import { SearchControls, SessionSearchResults } from "./SessionSearch";
import { exportUrl, NO_FILTERS, type Filters } from "../transcripts/logic";
import { openReplay } from "../transcripts/open";
import { EngineIcon, ModelIcon } from "@/components/ui/engine-icon";
import { ModeBadge } from "@/features/agent/ModeBadge";
import { showsModelMark } from "@/lib/models-logic";

/** Download the redacted, self-contained HTML of a session. */
function exportSession(id: string): void {
  const a = document.createElement("a");
  a.href = exportUrl(id);
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function Row({ s, active, drafted, updated, heads, pairTitle, workspaceName, open, onAction }: { s: SessionView; active: boolean; drafted?: boolean; updated?: string; heads?: { total: number; running: number }; pairTitle?: string; workspaceName?: string; open: () => void; onAction: (a: "interrupt" | "close" | "rename" | "delete" | "copy" | "pin") => void }) {
  const entries: MenuEntry[] = [
    { label: "Open", onSelect: open },
    { label: s.pinned ? "Unpin" : "Pin to top", icon: s.pinned ? <PinOff /> : <Pin />, onSelect: () => onAction("pin") },
    { label: "Stop the running turn", icon: <Square />, onSelect: () => onAction("interrupt"), disabled: s.status !== "running" },
    { separator: true },
    { label: "Rename…", icon: <Pencil />, onSelect: () => onAction("rename") },
    { label: "Copy session id", icon: <ClipboardCopy />, onSelect: () => onAction("copy") },
    { label: "Replay (read-only)", icon: <History />, onSelect: () => openReplay(s.id, null, s.title) },
    { label: "Export HTML", icon: <Download />, onSelect: () => exportSession(s.id) },
    { separator: true },
    { label: "Close session", icon: <XCircle />, onSelect: () => onAction("close"), disabled: s.status === "closed" },
    { label: "Delete…", icon: <Trash2 />, danger: true, onSelect: () => onAction("delete"), disabled: s.status !== "closed" },
  ];
  return (
    <ContextMenu entries={entries}>
      <button
        onClick={open}
        aria-current={active}
        className={cn("group relative flex w-full flex-col gap-1 [contain-intrinsic-size:auto_52px] [content-visibility:auto] rounded-lg px-2.5 py-2 text-left outline-none transition-colors animate-slide-up", active ? "bg-active" : "hover:bg-hover focus-visible:bg-hover", s.status === "closed" && "opacity-60")}
      >
        {active && <span className="absolute inset-y-2 left-0 w-[2px] rounded-r bg-accent" />}
        <div className="flex items-center gap-2">
          <StatusDot status={s.status} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{s.title}</span>
          {drafted && <DraftBadge />}
          <span className="shrink-0 font-mono text-[10px] text-fg-faint">{s.status === "running" ? "now" : ago(updated)}</span>
        </div>
        <div className="flex items-center gap-1.5 pl-[15px]">
          <span className="flex min-w-0 items-center gap-1 truncate font-mono text-[10.5px] text-fg-muted">
            <EngineIcon engine={s.engine} className="size-3" />
            {showsModelMark(s.engine, s.model) && <ModelIcon model={s.model} engine={s.engine} className="size-3" />}
            <span className="truncate">
              {s.engine}
              {s.model ? ` · ${s.model.replace(/^claude-/, "")}` : ""}
            </span>
          </span>
          {(s.mode === "ask" || s.mode === "plan") && <ModeBadge mode={s.mode} />}
          {s.agent && (
            <Badge tone="blue" title={`Runs as the agent “${s.agent}”`} className="max-w-[84px]">
              <UserRoundCog className="size-2.5 shrink-0" />
              <span className="truncate">{s.agent}</span>
            </Badge>
          )}
          {pairTitle && (
            <Badge tone="violet" title={`Hydra pair: ${pairTitle}`} className="max-w-[90px]">
              <Network className="size-2.5 shrink-0" />
              <span className="truncate">{pairTitle}</span>
            </Badge>
          )}
          {workspaceName && (
            <Badge tone="neutral" title={`In workspace ${workspaceName}`} className="max-w-[90px]">
              <span className="truncate">{workspaceName}</span>
            </Badge>
          )}
          {heads && heads.total > 0 && (
            <Badge tone={heads.running > 0 ? "accent" : "neutral"} title={`${heads.total} head(s), ${heads.running} working`}>
              {heads.running > 0 ? `${heads.running}/${heads.total}` : heads.total} head{heads.total === 1 ? "" : "s"}
            </Badge>
          )}
          {s.waiting_on?.length ? <WaitingChip session={s} compact /> : null}
          <span className="flex-1" />
          {s.changes && (
            <span className="shrink-0 font-mono text-[10px]">
              <span className="text-green">+{s.changes.insertions}</span> <span className="text-red">−{s.changes.deletions}</span>
            </span>
          )}
          <ContextBar session={s} />
          {s.cost_usd ? <span className="shrink-0 font-mono text-[10px] text-fg-faint">{money(s.cost_usd)}</span> : null}
        </div>
      </button>
    </ContextMenu>
  );
}

/** The session has a message typed but not sent. */
function DraftBadge() {
  return (
    <Badge tone="neutral" title="Unsent message in the composer">
      <Pencil className="size-2.5" />
      draft
    </Badge>
  );
}

/** The workspace's not-yet-started session has a message typed: a row for it, so it is not forgotten. */
function NewSessionDraftRow({ active }: { active: boolean }) {
  return (
    <button
      onClick={startNewSession}
      aria-current={active}
      className={cn("relative mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition-colors", active ? "bg-active" : "hover:bg-hover focus-visible:bg-hover")}
    >
      {active && <span className="absolute inset-y-2 left-0 w-[2px] rounded-r bg-accent" />}
      <MessageSquarePlus className="size-3.5 shrink-0 text-fg-faint" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg-muted">New session</span>
      <DraftBadge />
    </button>
  );
}

const NO_PINS: PinnedSession[] = [];

export function SessionsSidebar() {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const ws = useWs();
  // Open sessions only: closed ones are paged in when their group is opened, so history never slows the list.
  const list = useSessions(workspace.id, { all: true });
  const pinned = usePinnedSessions();
  const pinnedList = pinned.data ?? NO_PINS;
  const pinnedById = useMemo(() => new Map(pinnedList.map((p) => [p.id, p])), [pinnedList]);
  const pairs = usePairs();
  const drafted = useDraftedSessions();
  const newDraft = useNewSessionDraft(workspace.id);
  const [query, setQuery] = useState("");
  const [closedOpen, setClosedOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setNeedle(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const [advanced, setAdvanced] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const input = useRef<HTMLInputElement>(null);

  // Palette: "Search past sessions…" lands here with the toggle on.
  useEffect(
    () =>
      bus.on("sessions-search", () => {
        setAdvanced(true);
        setTimeout(() => input.current?.focus(), 0);
      }),
    [],
  );

  useEffect(() => ensureTurnWatcher(), []);

  const all = list.data ?? [];
  const groups = useMemo(() => groupSessions(all, query, pinnedList), [all, query, pinnedList]);
  const closedCount = useClosedCount(workspace.id);
  const closedShown = closedOpen || !!needle;
  const closed = useClosedSessions(workspace.id, needle, closedShown);
  const closedItems = useMemo(() => closed.data?.pages.flatMap((p) => p.sessions) ?? [], [closed.data]);
  // With a filter typed, the header counts matches; otherwise every closed lead.
  const closedTotal = needle ? (closed.data?.pages[0]?.total ?? 0) : (closedCount.data ?? 0);
  const heads = useMemo(() => headCounts(all), [all]);
  const pairTitle = (id: string | null) => (id ? pairs.data?.find((p) => p.id === id)?.title : undefined);

  const refresh = () => void qc.invalidateQueries({ queryKey: qk.sessionsAll });

  /** A row: a pinned lead from another workspace switches there; anything else opens in place. */
  const rowFor = (s: SessionView) => {
    const home = pinnedById.get(s.id);
    const elsewhere = home?.workspace_id && home.workspace_id !== workspace.id ? home : null;
    return (
      <Row
        key={s.id}
        s={s}
        active={ws.activeSession === s.id}
        drafted={drafted.has(s.id)}
        updated={s.updated_at}
        heads={heads[s.id]}
        pairTitle={pairTitle(s.pair)}
        workspaceName={elsewhere ? (elsewhere.workspace_name ?? undefined) : undefined}
        open={() => openSessionIn(elsewhere?.workspace_id, s.id)}
        onAction={(a) => void act(s, a)}
      />
    );
  };

  const act = async (s: SessionView, a: "interrupt" | "close" | "rename" | "delete" | "copy" | "pin") => {
    try {
      if (a === "copy") {
        await navigator.clipboard.writeText(s.id);
        return void toast.success(`Copied ${s.id}`);
      }
      if (a === "pin") await api("PATCH", url.session(s.id), { pinned: !s.pinned });
      if (a === "interrupt") await post(url.session(s.id, "interrupt"));
      if (a === "close") {
        const n = heads[s.id]?.total ?? 0;
        const ok = await confirm({ title: `Close "${s.title}"?`, description: n ? `Its ${n} head${n === 1 ? "" : "s"} will be closed too. Unmerged work stays on its branch.` : "Unmerged work in a worktree stays on its branch.", confirmLabel: "Close session" });
        if (!ok) return;
        await post(url.session(s.id, "close"));
      }
      if (a === "rename") {
        const title = await ask({ title: "Rename session", label: "Title", initial: s.title, confirmLabel: "Rename", validate: (v) => (v.trim() ? null : "A title is required") });
        if (title === null) return;
        await api("PATCH", url.session(s.id), { title });
      }
      if (a === "delete") {
        const ok = await confirm({ title: `Delete "${s.title}"?`, description: "Its transcript and records are removed. This cannot be undone.", confirmLabel: "Delete", danger: true });
        if (!ok) return;
        await api("DELETE", url.session(s.id));
        if (ws.activeSession === s.id) useUi.getState().setActiveSession(null);
      }
      refresh();
      void qc.invalidateQueries({ queryKey: qk.session(s.id) });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-muted">
        Sessions
        <IconButton label="New session" size="icon-sm" onClick={startNewSession}>
          <MessageSquarePlus />
        </IconButton>
      </div>

      <div className="flex items-center gap-1 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder={advanced ? "Search inside conversations" : "Filter sessions"}
            aria-label="Filter sessions"
            className="h-7 w-full rounded-md border border-line bg-raised pl-7 pr-7 text-xs outline-none transition-colors placeholder:text-fg-faint hover:border-line-strong focus:border-accent/60"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear filter" className="absolute right-1.5 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded text-fg-faint hover:text-fg">
              <X className="size-3" />
            </button>
          )}
        </div>
        <SearchControls advanced={advanced} onAdvanced={setAdvanced} filters={filters} onFilters={setFilters} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {advanced ? (
          <SessionSearchResults query={query} filters={filters} />
        ) : list.isLoading ? (
          <div className="flex flex-col gap-2 p-1.5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[52px] w-full" />
            ))}
          </div>
        ) : list.error ? (
          <div className="p-3 text-xs text-red">{(list.error as Error).message}</div>
        ) : groups.length === 0 && closedTotal === 0 && !closed.isFetching ? (
          query ? (
            <Empty icon={<Search />} title="No matching sessions" hint={`Nothing matches "${query}".`} />
          ) : (
            <Empty
              icon={<MessageSquarePlus />}
              title="No sessions yet"
              hint="Describe a change in the agent panel and it will show up here."
              action={
                <button onClick={() => bus.emit("focus-composer")} className="mt-1 rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-fg outline-none hover:brightness-110">
                  Start one
                </button>
              }
            />
          )
        ) : (
          <>
            {newDraft && !query && <NewSessionDraftRow active={ws.activeSession === null} />}
            {groups.map((g) => (
              <Section key={g.key} title={g.label} count={g.items.length}>
                <div className="flex flex-col gap-0.5">{g.items.map(rowFor)}</div>
              </Section>
            ))}
            {closedTotal > 0 && (
              <Section title="Closed" count={closedTotal} open={closedShown} onOpenChange={setClosedOpen}>
                <div className="flex flex-col gap-0.5">
                  {closedShown && closedItems.map(rowFor)}
                  {closedShown && closed.isFetching && !closed.isFetchingNextPage && closedItems.length === 0 && <Skeleton className="mx-1.5 h-[52px]" />}
                  {closed.hasNextPage && (
                    <button onClick={() => void closed.fetchNextPage()} disabled={closed.isFetchingNextPage} className="mx-1.5 my-1 rounded-md px-2 py-1.5 text-left text-xs text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover disabled:opacity-60">
                      {closed.isFetchingNextPage ? "Loading…" : `Show more (${closedTotal - closedItems.length} older)`}
                    </button>
                  )}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
