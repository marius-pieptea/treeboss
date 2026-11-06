import { memo, useEffect, useMemo, useRef } from "react";
import { ArrowDownToLine, FilterX, GitBranchPlus, GitCommitHorizontal, Link2, ListFilter, Loader2, Network } from "lucide-react";
import type { GitLogEntry } from "@/lib/types";
import { useUi } from "@/lib/store";
import { ago, cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/overlay";
import { Empty, Section, Skeleton } from "@/components/ui/misc";
import { ask, confirm } from "@/components/ui/dialogs";
import { toast } from "sonner";
import { computeGraph, laneColor, type GraphRow } from "./graph";
import { gitActions } from "./actions";
import { useHistory } from "./queries";
import { promptNewBranch } from "./BranchPicker";
import { create } from "zustand";
import { persist } from "zustand/middleware";

const useHistoryPrefs = create<{ all: boolean; path: string; setAll(v: boolean): void; setPath(p: string): void }>()(
  persist(
    (set) => ({ all: true, path: "", setAll: (all) => set({ all }), setPath: (path) => set({ path }) }),
    { name: "trb.git.history", partialize: (s) => ({ all: s.all }) },
  ),
);

const LANE_W = 12;
const ROW_H = 30;

/** One row of the graph, drawn as SVG: lines passing through, arriving, leaving, and the node. */
const GraphCell = memo(function GraphCell({ row, lanes, head }: { row: GraphRow; lanes: number; head: boolean }) {
  const x = (lane: number) => 8 + lane * LANE_W;
  const mid = ROW_H / 2;
  const w = 8 + lanes * LANE_W;
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
  return (
    <svg width={w} height={ROW_H} className="shrink-0" aria-hidden>
      {row.passing.map((p, i) => (
        <path key={`p${i}`} d={p.lane === p.to ? `M${x(p.lane)},0 V${ROW_H}` : curve(x(p.lane), 0, x(p.to), ROW_H)} stroke={laneColor(p.lane)} strokeWidth="1.6" fill="none" opacity="0.85" />
      ))}
      {row.fromAbove && <path d={`M${x(row.col)},0 V${mid}`} stroke={laneColor(row.col)} strokeWidth="1.6" fill="none" />}
      {row.edges.map((e, i) => (
        <path key={`e${i}`} d={e.from === e.to ? `M${x(e.from)},${mid} V${ROW_H}` : curve(x(e.from), mid, x(e.to), ROW_H)} stroke={laneColor(e.to === row.col ? row.col : e.to)} strokeWidth="1.6" fill="none" />
      ))}
      <circle cx={x(row.col)} cy={mid} r={row.merge ? 3.2 : 4} fill={row.merge ? "var(--panel)" : laneColor(row.col)} stroke={laneColor(row.col)} strokeWidth="1.8" />
      {head && <circle cx={x(row.col)} cy={mid} r="6.5" fill="none" stroke="var(--accent)" strokeWidth="1" opacity="0.7" />}
    </svg>
  );
});

/**
 * Which ref labels are worth a chip. `origin/HEAD` is noise, and a remote branch that sits on the same commit
 * as its local namesake says nothing the local chip does not.
 */
export function visibleRefs(refs: string[]): string[] {
  const names = refs.map((r) => r.replace(/^HEAD -> /, ""));
  const locals = new Set(names.filter((n) => !n.startsWith("tag: ") && !n.includes("/")));
  const shown = refs.filter((r) => {
    const n = r.replace(/^HEAD -> /, "");
    if (/\/HEAD$/.test(n)) return false;
    if (!n.startsWith("tag: ") && n.includes("/") && locals.has(n.slice(n.indexOf("/") + 1))) return false;
    return true;
  });
  return shown;
}

function RefChips({ refs }: { refs: string[] }) {
  const shown = visibleRefs(refs);
  const MAX = 2;
  return (
    <>
      {shown.slice(0, MAX).map((r) => {
        const isHead = r.startsWith("HEAD");
        const tag = r.startsWith("tag: ");
        const label = r.replace(/^HEAD -> /, "").replace(/^tag: /, "");
        const remote = !isHead && !tag && label.includes("/");
        return (
          <span key={r} title={r} className={cn("max-w-[110px] shrink-0 truncate rounded px-1 font-mono text-[10px] leading-[16px]", isHead ? "bg-accent text-accent-fg" : tag ? "bg-amber/15 text-amber" : remote ? "bg-violet/15 text-violet" : "bg-green/15 text-green")}>
            {label}
          </span>
        );
      })}
      {shown.length > MAX && (
        <span title={shown.slice(MAX).join(", ")} className="shrink-0 rounded bg-raised px-1 font-mono text-[10px] leading-[16px] text-fg-faint">
          +{shown.length - MAX}
        </span>
      )}
    </>
  );
}

export function History({ root, headSha }: { root: string; headSha: string | null }) {
  const { all, path, setAll, setPath } = useHistoryPrefs();
  const hist = useHistory(root, { all, path });
  const openTab = useUi((s) => s.openTab);
  const a = gitActions(root);
  const commits: GitLogEntry[] = useMemo(() => hist.data?.pages.flat() ?? [], [hist.data]);
  const graph = useMemo(() => computeGraph(commits), [commits]);
  const more = useRef<HTMLDivElement>(null);

  // Load the next page when the sentinel scrolls into view.
  useEffect(() => {
    const el = more.current;
    if (!el || !hist.hasNextPage) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && !hist.isFetchingNextPage && void hist.fetchNextPage(), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hist.hasNextPage, hist.isFetchingNextPage, hist.fetchNextPage, commits.length]);

  const open = (c: GitLogEntry) => openTab({ kind: "commit", root, sha: c.sha, title: c.short });

  return (
    <Section
      title="History"
      defaultOpen
      actions={
        <>
          <IconButton
            label={path ? `Showing history of ${path}. Clear filter` : "Filter by file"}
            size="icon-xs"
            onClick={async () => {
              if (path) return setPath("");
              const p = await ask({ title: "Filter history by file", label: "Path (relative to the repository)", placeholder: "src/greet.ts", confirmLabel: "Filter" });
              if (p) setPath(p.trim());
            }}
          >
            {path ? <FilterX className="text-accent" /> : <ListFilter />}
          </IconButton>
          <IconButton label={all ? "Showing all branches" : "Showing the current branch"} size="icon-xs" onClick={() => setAll(!all)}>
            <Network className={cn(all && "text-accent")} />
          </IconButton>
        </>
      }
    >
      {hist.isLoading ? (
        <div className="space-y-1.5 p-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-6" />
          ))}
        </div>
      ) : commits.length === 0 ? (
        <Empty icon={<GitCommitHorizontal />} title={path ? "No commits touch that file" : "No commits yet"} hint={path ? undefined : "Commit your first change to start the history."} className="py-6" />
      ) : (
        <div role="list" aria-label="Commit history" className="pb-2">
          {commits.map((c, i) => (
            <ContextMenu
              key={c.sha}
              entries={[
                { label: "Open commit", onSelect: () => open(c) },
                { label: "Copy SHA", icon: <Link2 />, onSelect: () => navigator.clipboard.writeText(c.sha).then(() => toast.success("Copied SHA")) },
                { label: "Copy subject", onSelect: () => navigator.clipboard.writeText(c.subject) },
                { separator: true },
                { label: "Create branch here…", icon: <GitBranchPlus />, onSelect: () => promptNewBranch(root, c.sha, `Create branch at ${c.short}`) },
                {
                  label: "Checkout (detached)",
                  icon: <ArrowDownToLine />,
                  onSelect: async () => {
                    if (await confirm({ title: `Check out ${c.short}?`, description: "HEAD becomes detached. New commits made there are easy to lose unless you create a branch.", confirmLabel: "Checkout" })) await a.detach(c.sha);
                  },
                },
              ]}
            >
              <div role="listitem" tabIndex={0} onClick={() => open(c)} onKeyDown={(e) => e.key === "Enter" && open(c)} title={`${c.subject}\n\n${c.author} <${c.email}>\n${c.date}`} className="flex cursor-default items-center gap-1.5 pr-2 text-[12.5px] outline-none hover:bg-hover focus-visible:bg-hover" style={{ height: ROW_H }}>
                <GraphCell row={graph.rows[i]} lanes={Math.min(graph.maxLanes, 8)} head={c.sha === headSha} />
                <RefChips refs={c.refs} />
                <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-fg-faint">{ago(c.date)}</span>
              </div>
            </ContextMenu>
          ))}
          <div ref={more} className="flex h-8 items-center justify-center text-[11px] text-fg-faint">
            {hist.isFetchingNextPage ? <Loader2 className="size-3.5 animate-spin-fast" /> : hist.hasNextPage ? "" : commits.length > 12 ? "Beginning of history" : ""}
          </div>
        </div>
      )}
    </Section>
  );
}
