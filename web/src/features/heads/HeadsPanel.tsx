import { awaitedBy } from "@/features/agent/waiting-logic";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronsRight, GitMerge, Network, Rocket, XCircle } from "lucide-react";
import { useSession, usePairs } from "@/lib/queries";
import { useSessionStream } from "@/lib/session-stream";
import { useUi, useWs } from "@/lib/store";
import { cn, money, tokens } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/overlay";
import type { Pair, SessionView } from "@/lib/types";
import { HeadCard } from "./HeadCard";
import { SpawnDialog } from "./SpawnDialog";
import { RoleBadge } from "./RoleBadge";
import { activityBySession, buildTree, countHeads, flatten, isMergeReady, pairRoles, totals, type HeadNode } from "./model";
import { roleTone, toneClasses } from "./roles";
import { useHeadActions } from "./actions";
import { useSpawnDialog } from "./spawn-store";
import { EngineIcon } from "@/components/ui/engine-icon";

const spec = (e: string | null, m: string | null, ef: string | null) => [e, m].filter(Boolean).join("/") + (ef ? `@${ef}` : "");

function PairSummary({ pair, lead }: { pair: Pair | null; lead: SessionView }) {
  if (!pair) {
    return (
      <div className="font-mono text-[11px] text-fg-faint">
        no pair · lead <EngineIcon engine={lead.engine} className="inline size-3 align-[-2px]" /> <span className="text-fg-muted">{lead.engine}</span>
      </div>
    );
  }
  const roles = pairRoles(pair);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      <span className="font-medium text-fg">{pair.title}</span>
      <span className="font-mono text-fg-faint">
        lead <EngineIcon engine={pair.lead_engine || lead.engine} className="inline size-3 align-[-2px]" /> {spec(pair.lead_engine, pair.lead_model, pair.lead_effort) || lead.engine} <ChevronsRight className="inline size-3" />
      </span>
      {pair.mode === "heads" ? (
        <span className="font-mono text-fg-muted">heads <EngineIcon engine={pair.heads_engine} className="inline size-3 align-[-2px]" /> {spec(pair.heads_engine, pair.heads_model, pair.heads_effort) || "default"}</span>
      ) : (
        roles.map((r) => (
          <Tooltip key={r.id} label={[r.engine, r.model, r.effort && `@${r.effort}`].filter(Boolean).join(" ") || "default"}>
            <span>
              <RoleBadge role={r.id} />
            </span>
          </Tooltip>
        ))
      )}
      {pair.max_heads ? <span className="font-mono text-fg-faint">max {pair.max_heads}</span> : null}
    </div>
  );
}

/** One capsule per head: role colour, breathing while it works. A glance answers "who is busy?". */
function Orchestra({ heads, selected, onPick }: { heads: SessionView[]; selected: string | null; onPick: (id: string) => void }) {
  if (!heads.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" role="list" aria-label="Heads at a glance">
      {heads.map((h) => {
        const t = toneClasses[roleTone(h.role)];
        return (
          <Tooltip key={h.id} label={`${h.role ?? h.engine}: ${h.title} · ${h.status}`}>
            <button
              role="listitem"
              onClick={() => onPick(h.id)}
              className={cn("relative h-4 w-7 overflow-hidden rounded-full border outline-none transition-all duration-200", t.border, selected === h.id && "ring-1 ring-offset-1 ring-offset-panel", selected === h.id && t.ring, h.status === "failed" && "!border-red/60")}
            >
              <span className={cn("absolute inset-0 transition-opacity", t.dot, h.status === "running" ? "animate-pulse opacity-90" : h.status === "idle" ? "opacity-45" : h.status === "failed" ? "!bg-red opacity-80" : "opacity-15")} />
              {h.merged && <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white mix-blend-overlay">✓</span>}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: "accent" | "green" | "red" | "neutral" }) {
  if (!n) return null;
  return (
    <Badge tone={tone === "neutral" ? "neutral" : tone}>
      {n} {label}
    </Badge>
  );
}

/** The rail that visually nests a head's own heads under it. */
function Rail({ children }: { children: ReactNode }) {
  return <div className="relative ml-1 pl-4 before:absolute before:bottom-[24px] before:left-[6px] before:top-0 before:w-px before:bg-line-strong">{children}</div>;
}

export function HeadsPanel() {
  const ws = useWs();
  const setRightTab = useUi((s) => s.setRightTab);
  const session = useSession(ws.activeSession);
  const pairs = usePairs();
  const stream = useSessionStream(ws.activeSession, { tree: true });
  const actions = useHeadActions();
  const [selected, setSelected] = useState<string | null>(null);
  // History is the default: a head the lead closed is still part of the story (its answer, its diff).
  const [showClosed, setShowClosed] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  const lead = session.data?.session ?? null;
  const all = session.data?.children ?? [];
  const pair = pairs.data?.find((p) => p.id === lead?.pair) ?? null;

  /* ---- closing animation: a head that was open and is now closed collapses out before it is hidden ---- */
  const seenOpen = useRef(new Set<string>());
  const [closing, setClosing] = useState<Record<string, "closing" | "gone">>({});
  /* ---- live timers and "just finished" flashes ---- */
  const prev = useRef<Record<string, string>>({});
  const runStart = useRef<Record<string, number>>({});
  const [flash, setFlash] = useState<Record<string, number>>({});

  useEffect(() => {
    seenOpen.current = new Set();
    prev.current = {};
    runStart.current = {};
    setClosing({});
    setFlash({});
    setSelected(null);
  }, [ws.activeSession]);

  useEffect(() => {
    const nextClosing: Record<string, "closing" | "gone"> = {};
    const timers: ReturnType<typeof setTimeout>[] = [];
    let changed = false;
    for (const h of all) {
      if (h.status !== "closed") seenOpen.current.add(h.id);
      else if (!(h.id in closing)) {
        changed = true;
        if (seenOpen.current.has(h.id)) {
          nextClosing[h.id] = "closing";
          timers.push(setTimeout(() => setClosing((c) => ({ ...c, [h.id]: "gone" })), 340));
        } else nextClosing[h.id] = "gone";
      }
      // timers + flashes
      const was = prev.current[h.id];
      if (h.status === "running" && !runStart.current[h.id]) runStart.current[h.id] = Date.now() - (h.running_for_sec ?? 0) * 1000;
      if (h.status !== "running") delete runStart.current[h.id];
      if (was === "running" && h.status === "idle" && h.changes) setFlash((f) => ({ ...f, [h.id]: (f[h.id] ?? 0) + 1 }));
      prev.current[h.id] = h.status;
    }
    if (changed) setClosing((c) => ({ ...c, ...nextClosing }));
    return () => timers.forEach(clearTimeout);
    // `closing` is read only to avoid re-arming timers for heads already handled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all]);

  const awaiters = useMemo(() => awaitedBy(lead ? [lead, ...all] : []), [lead, all]);
  const tree = useMemo(() => (lead ? buildTree(lead.id, all, { includeClosed: true }) : []), [lead, all]);
  const live = useMemo(() => flatten(buildTree(lead?.id ?? "", all)), [lead, all]);
  const activity = useMemo(() => activityBySession(stream.transcript.items), [stream.transcript.items]);
  const counts = countHeads(live);
  const sum = totals(lead ? [lead, ...all] : []);

  const closedCount = all.filter((h) => h.status === "closed").length;
  const openRoots = tree.filter((n) => n.head.status !== "closed");
  const closedRoots = tree.filter((n) => n.head.status === "closed");
  const visibleIds = flatten(tree).filter((h) => h.status !== "closed").map((h) => h.id);
  const move = (dir: 1 | -1) => {
    if (!visibleIds.length) return;
    const i = selected ? visibleIds.indexOf(selected) : -1;
    setSelected(visibleIds[Math.min(visibleIds.length - 1, Math.max(0, i === -1 ? 0 : i + dir))]);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    const h = live.find((x) => x.id === selected);
    if (e.key === "j" || e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "k" || e.key === "ArrowUp") (e.preventDefault(), move(-1));
    else if (e.key === "Enter" && h) actions.open(h);
    else if (e.key === "m" && h && isMergeReady(h)) void actions.merge(h);
  };

  const renderNodes = (nodes: HeadNode[], offset = 0): ReactNode =>
    nodes
      .filter((n) => n.head.status !== "closed" || showClosed || closing[n.head.id] === "closing")
      .map((n, i) => (
        <HeadCard
          key={n.head.id}
          node={n}
          index={offset + i}
          activity={activity.get(n.head.id)}
          startedAt={runStart.current[n.head.id]}
          selected={selected === n.head.id}
          flashKey={flash[n.head.id] ?? 0}
          closing={n.head.status === "closed" && !showClosed}
          actions={actions}
          onSelect={setSelected}
          awaitedBy={awaiters.get(n.head.id)}
          nested={n.children.some((c) => c.head.status !== "closed" || showClosed || closing[c.head.id] === "closing") ? <Rail>{renderNodes(n.children)}</Rail> : null}
        />
      ));

  /* ---- empty states ---- */
  if (!ws.activeSession || !lead) {
    return (
      <div className="flex h-full flex-col">
        {session.isLoading && ws.activeSession ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : (
          <Empty
            icon={<Network />}
            title="Hydra heads live here"
            hint="Start a session with a pair: the lead splits the job into slices and opens a head for each. They run in parallel, in their own worktrees."
            action={
              <Button variant="subtle" onClick={() => setRightTab("agent")}>
                Open the agent
              </Button>
            }
          />
        )}
      </div>
    );
  }

  const noHeads = live.length === 0 && closedCount === 0;
  return (
    <div ref={panelRef} tabIndex={0} onKeyDown={onKeyDown} className="flex h-full flex-col outline-none" aria-label="Heads">
      <SpawnDialog lead={lead} heads={all} actions={actions} />

      <div className="flex flex-col gap-2 border-b border-line px-3 py-2.5">
        <PairSummary pair={pair} lead={lead} />
        <div className="flex flex-wrap items-center gap-1.5">
          <Stat n={counts.working} label="working" tone="accent" />
          <Stat n={counts.ready} label="ready" tone="green" />
          <Stat n={counts.idle - counts.ready} label="idle" tone="neutral" />
          <Stat n={counts.failed} label="failed" tone="red" />
          <Stat n={counts.merged} label="merged" tone="neutral" />
          <div className="flex-1" />
          <span className="font-mono text-[10.5px] text-fg-faint" title="Lead and heads combined (cached input included)">
            {tokens(sum.input)} in · {tokens(sum.output)} out{sum.cost ? ` · ${money(sum.cost)}` : ""}
          </span>
        </div>
        <Orchestra heads={live} selected={selected} onPick={setSelected} />
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="primary" disabled={!counts.ready} onClick={() => actions.mergeAll(live)}>
            <GitMerge /> Merge ready{counts.ready ? ` (${counts.ready})` : ""}
          </Button>
          <Button size="xs" variant="subtle" disabled={!live.some((h) => h.status !== "running" && !(h.changes && !h.merged))} onClick={() => actions.closeFinished(live)}>
            <XCircle /> Close finished
          </Button>
          <div className="flex-1" />
          <Button size="xs" variant="outline" onClick={() => useSpawnDialog.getState().show(lead.id)}>
            <Rocket /> Spawn head
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {noHeads ? (
          <Empty
            icon={<Network />}
            title="No heads yet"
            hint={pair ? "The lead will open heads as it works, or you can spawn one by hand." : "This session has no pair. Pick one when starting a session to let the lead fan out, or spawn a head by hand."}
            action={
              <Button variant="subtle" onClick={() => useSpawnDialog.getState().show(lead.id)}>
                <Rocket /> Spawn a head
              </Button>
            }
          />
        ) : (
          <>
            {renderNodes(openRoots)}
            {closedCount > 0 && (
              <div className="flex items-center justify-between px-1 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wide text-fg-faint">
                <span>{showClosed ? `Closed · ${closedCount}` : `${closedCount} closed`}</span>
                <button type="button" onClick={() => setShowClosed((v) => !v)} className="cursor-pointer normal-case tracking-normal hover:text-fg">
                  {showClosed ? "Hide closed" : "Show closed"}
                </button>
              </div>
            )}
            {showClosed && renderNodes(closedRoots, openRoots.length)}
          </>
        )}
        {!noHeads && <div className="px-1 pb-1 pt-2 font-mono text-[10px] text-fg-faint">j / k to move · Enter opens · m merges</div>}
      </div>
    </div>
  );
}
