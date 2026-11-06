import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { History, ListFilter, ScanSearch, Search } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Badge, Empty, Spinner } from "@/components/ui/misc";
import { Popover } from "@/components/ui/overlay";
import { get } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import { useEngines, useWorkspaces } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { daysAgo, groupBySession, NO_FILTERS, ROLE_LABEL, searchUrl, splitSnippet, type Filters, type TranscriptHit } from "../transcripts/logic";
import { openReplay } from "../transcripts/open";

export function Snippet({ text }: { text: string }) {
  return (
    <>
      {splitSnippet(text).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[3px] bg-amber/25 px-px text-fg ring-1 ring-amber/30">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

const activeFilters = (f: Filters) => (["workspace", "engine", "since", "until"] as const).filter((k) => f[k]).length;

/** The two buttons beside the sessions filter: search inside conversations, and the compact filter popover. */
export function SearchControls({ advanced, onAdvanced, filters, onFilters }: { advanced: boolean; onAdvanced: (on: boolean) => void; filters: Filters; onFilters: (f: Filters) => void }) {
  const workspaces = useWorkspaces();
  const engines = useEngines();
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });
  const n = activeFilters(filters);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <IconButton label={advanced ? "Searching inside conversations (click for titles only)" : "Search inside conversations"} size="icon-sm" aria-pressed={advanced} onClick={() => onAdvanced(!advanced)} className={cn("size-7", advanced && "bg-active text-accent")}>
        <ScanSearch />
      </IconButton>
      {advanced && (
        <Popover
          align="end"
          width={260}
          trigger={
            <IconButton label="Search filters" size="icon-sm" className={cn("relative size-7", n > 0 && "text-accent")}>
              <ListFilter />
              {n > 0 && <span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-accent font-mono text-[9px] text-accent-fg">{n}</span>}
            </IconButton>
          }
        >
          <div className="space-y-2 p-3" aria-label="Search filters">
            <Select size="sm" aria-label="Workspace" value={filters.workspace} onChange={(v) => set({ workspace: v })} placeholder="Any workspace" options={[{ value: "", label: "Any workspace" }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))]} />
            <Select size="sm" aria-label="Engine" value={filters.engine} onChange={(v) => set({ engine: v })} placeholder="Any engine" options={[{ value: "", label: "Any engine" }, ...(engines.data ?? []).map((e) => ({ value: e.id, label: e.label }))]} />
            <div className="grid grid-cols-2 gap-2">
              <Input type="date" aria-label="From date" value={filters.since} onChange={(e) => set({ since: e.target.value })} className="h-7 text-xs" />
              <Input type="date" aria-label="To date" value={filters.until} onChange={(e) => set({ until: e.target.value })} className="h-7 text-xs" />
            </div>
            <div className="flex gap-1.5 text-[11px]">
              <button className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-hover" onClick={() => set({ since: daysAgo(1), until: "" })}>
                Last day
              </button>
              <button className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-hover" onClick={() => set({ since: daysAgo(7), until: "" })}>
                Last week
              </button>
              <button className="ml-auto rounded px-1.5 py-0.5 text-fg-muted hover:bg-hover" onClick={() => onFilters(NO_FILTERS)}>
                Clear
              </button>
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}

/** Ranked sessions with highlighted snippets; choosing a hit opens the replay at that turn. */
export function SessionSearchResults({ query, filters }: { query: string; filters: Filters }) {
  const q = useDebounced(query.trim(), 250);
  const results = useQuery({
    queryKey: ["transcript-search", q, filters],
    queryFn: () => get<{ hits: TranscriptHit[] }>(searchUrl(q, filters)),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5000,
  });
  const groups = useMemo(() => groupBySession(results.data?.hits ?? []), [results.data]);

  if (!q) return <Empty icon={<History />} title="Search inside conversations" hint="Prompts, answers and tool calls from every session, across workspaces." />;
  if (results.isLoading)
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  if (results.error) return <Empty title="Search failed" hint={(results.error as Error).message} />;
  if (groups.length === 0) return <Empty icon={<Search />} title="No matches" hint="Try fewer words or clear a filter." />;
  return (
    <div data-testid="session-search-results">
      {groups.map((g) => (
        <div key={g.session_id} className="border-b border-line px-2 py-2">
          <div className="flex items-center gap-2 px-1">
            <span className="truncate text-[12.5px] font-medium">{g.title}</span>
            <Badge className="ml-auto shrink-0">{g.engine}</Badge>
          </div>
          <div className="truncate px-1 text-[10.5px] text-fg-faint">{g.base_cwd}</div>
          <div className="mt-1 space-y-0.5">
            {g.hits.map((h) => (
              <button key={`${h.seq}-${h.role}`} onClick={() => openReplay(h.session_id, h.seq, g.title)} className="block w-full rounded-md px-1.5 py-1 text-left text-[11.5px] leading-snug text-fg-muted outline-none hover:bg-hover focus-visible:bg-hover">
                <span className="mr-1.5 font-mono text-[10px] text-accent">
                  turn {h.seq} · {ROLE_LABEL[h.role]}
                </span>
                <Snippet text={h.snippet} />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
