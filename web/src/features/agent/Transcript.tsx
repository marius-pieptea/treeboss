/**
 * The chat transcript renderer, shared by the agent panel and the per-head view.
 *
 * Contract (kept stable; others import it): `items` come from lib/transcript.ts. `focusSession` is the
 * session whose voice is "the main one"; lines from any other session are drawn indented on a coloured rail
 * with their role label. `labels` maps session id -> role label and depth. `compact` tightens spacing for
 * narrow panes. `footer` renders after the last item inside the scroll area.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, Check, ChevronRight, FileText, Globe, Network, Pencil, Search, Terminal, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { groupTools, summarizeTools, type DisplayItem, type ToolGroup, type TranscriptItem } from "@/lib/transcript";
import { AssistantText } from "./AssistantText";
import { OpenFileButton } from "./FileLinks";
import { CompactDivider } from "./ContextMeter";
import { nextStick, showJumpPill } from "./scroll-logic";
import { splitContext } from "./chat-logic";
import { CopyButton, ForkButton, RewindButton, useScrollToTurn, useThreadFocus } from "@/features/checkpoints/ThreadActions";

type Tool = ToolGroup["tools"][number];
export type SessionLabels = Record<string, { label: string; depth: number }>;

export interface TranscriptProps {
  items: TranscriptItem[];
  labels?: SessionLabels;
  running?: boolean;
  focusSession?: string;
  compact?: boolean;
  className?: string;
  footer?: ReactNode;
  /** Shown when there is nothing to render. */
  empty?: ReactNode;
}

/** How many top-level rows are mounted at once, and how many each "earlier" step adds. */
const WINDOW = 150;

const RAIL_COLORS = ["var(--accent)", "var(--violet)", "var(--amber)", "var(--green)", "var(--blue)", "var(--red)"];

/** A stable colour per role, so "worker" is the same colour wherever it appears. */
export function roleColor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return RAIL_COLORS[h % RAIL_COLORS.length];
}

function prettyName(name: string): string {
  return name.replace(/^mcp__([^_]+)__/, "$1 ").replace(/_/g, " ");
}

function ToolIcon({ name, className }: { name: string; className?: string }) {
  const n = name.toLowerCase();
  if (n === "bash" || n.startsWith("$")) return <Terminal className={className} />;
  if (n === "read" || n === "listdir" || n === "ls") return <FileText className={className} />;
  if (n === "write" || n === "edit" || n === "multiedit" || n.startsWith("edit")) return <Pencil className={className} />;
  if (n === "grep" || n === "glob" || n === "websearch") return <Search className={className} />;
  if (n === "webfetch") return <Globe className={className} />;
  if (n === "task" || n.includes("subagent")) return <Network className={className} />;
  return <Wrench className={className} />;
}

function ToolRow({ tool, compact }: { tool: Tool; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const canOpen = tool.arg.length > 60 || !!tool.detail;
  return (
    <div className={cn("relative", tool.status === "running" && "sweep rounded-md")}>
      <div className="flex items-center">
      <button
        onClick={() => canOpen && setOpen((o) => !o)}
        aria-expanded={canOpen ? open : undefined}
        className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left outline-none transition-colors", compact ? "h-6" : "h-[26px]", canOpen && "hover:bg-hover focus-visible:bg-hover")}
      >
        {tool.status === "running" ? (
          <span className="size-3 shrink-0 animate-spin-fast rounded-full border-[1.5px] border-accent/30 border-t-accent" />
        ) : tool.status === "ok" ? (
          <Check className="size-3 shrink-0 text-green" strokeWidth={2.6} />
        ) : (
          <X className="size-3 shrink-0 text-red" strokeWidth={2.6} />
        )}
        <ToolIcon name={tool.name} className="size-3 shrink-0 text-fg-faint" />
        <span className="shrink-0 text-[11.5px] font-medium text-fg-muted">{prettyName(tool.name)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-faint" title={tool.arg}>
          {tool.arg.replace(/\s+/g, " ")}
        </span>
        {tool.size && <span className="shrink-0 font-mono text-[10px] text-fg-faint">{tool.size}</span>}
      </button>
      <OpenFileButton arg={tool.arg} className="mr-1" />
      </div>
      {open && (
        <div className="mx-2 mb-1 animate-slide-up rounded-md border border-line bg-raised px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
          {tool.arg && <div className="whitespace-pre-wrap break-all text-fg-muted">{tool.arg}</div>}
          {tool.detail && <div className="mt-1 whitespace-pre-wrap break-words text-red">{tool.detail}</div>}
        </div>
      )}
      {tool.status === "err" && tool.detail && !open && <div className="truncate px-2 pb-0.5 pl-[34px] font-mono text-[10.5px] text-red/90">{tool.detail}</div>}
    </div>
  );
}

function ToolGroupView({ group, open, onToggle, compact }: { group: ToolGroup; open: boolean; onToggle: () => void; compact?: boolean }) {
  const running = group.tools.filter((t) => t.status === "running");
  const failed = group.tools.filter((t) => t.status === "err").length;
  const current = running[running.length - 1];
  return (
    <div className="rounded-lg border border-line bg-panel/40">
      <button onClick={onToggle} aria-expanded={open} className={cn("group flex w-full items-center gap-2 rounded-lg px-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover", compact ? "h-7" : "h-8")}>
        <ChevronRight className={cn("size-3 shrink-0 text-fg-faint transition-transform duration-150", open && "rotate-90")} />
        {current ? <span className="size-3 shrink-0 animate-spin-fast rounded-full border-[1.5px] border-accent/30 border-t-accent" /> : <ToolIcon name={group.tools[0].name} className="size-3.5 shrink-0 text-fg-faint" />}
        <span className={cn("truncate text-[12px]", current ? "text-fg" : "text-fg-muted")}>{current ? `${prettyName(current.name)}${current.arg ? ": " : ""}` : summarizeTools(group.tools)}</span>
        {current && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-faint">{current.arg.replace(/\s+/g, " ")}</span>}
        {!current && <span className="flex-1" />}
        {failed > 0 && <span className="rounded bg-red/10 px-1 font-mono text-[10px] text-red">{failed} failed</span>}
        <span className="shrink-0 rounded bg-raised px-1 font-mono text-[10px] text-fg-faint">{group.tools.length}</span>
      </button>
      {open && (
        <div className="animate-slide-up border-t border-line px-1 py-1">
          {group.tools.map((t) => (
            <ToolRow key={t.id} tool={t} compact={compact} />
          ))}
        </div>
      )}
    </div>
  );
}

const ItemView = memo(function ItemView({ item, open, onToggleGroup, compact, caret, small, thread }: { item: DisplayItem; open: boolean; onToggleGroup: (id: string) => void; compact?: boolean; caret?: boolean; small?: boolean; thread?: { fork: boolean; latest: boolean } }) {
  switch (item.type) {
    case "user":
      return (
        <div className="group/msg flex items-center justify-end gap-0.5">
          {thread && <RewindButton turnId={item.turnId} />}
          <div className={cn("max-w-[92%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm border border-accent/20 bg-accent-soft px-3 py-2 text-[13px] leading-relaxed", compact && "text-[12.5px]")}>{splitContext(item.text).text}</div>
        </div>
      );
    case "turn":
      return item.n > 1 ? (
        <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wider text-fg-faint">
          <div className="h-px flex-1 bg-line" />
          follow-up
          <div className="h-px flex-1 bg-line" />
        </div>
      ) : null;
    case "text":
      return (
        <div className={cn("group/msg min-w-0", small && "text-[12.5px]")}>
          <AssistantText text={item.text} />
          {caret && <span className="caret" aria-hidden />}
          {thread?.fork && !caret && (
            <div className="-mb-1 mt-0.5 flex items-center">
              <CopyButton text={item.text} latest={thread.latest} />
              <ForkButton turnId={item.turnId} latest={thread.latest} />
            </div>
          )}
        </div>
      );
    case "tools":
      return <ToolGroupView group={item} open={open} onToggle={() => onToggleGroup(item.id)} compact={compact} />;
    case "thinking":
      return item.active ? (
        <div className="flex items-center gap-2 px-1 text-[12px]">
          <span className="shimmer-text">Thinking…</span>
        </div>
      ) : null;
    case "compact":
      return <CompactDivider from={item.from} to={item.to} />;
    case "note":
      return (
        <div className={cn("flex items-start gap-1.5 px-1 font-mono text-[11px] leading-relaxed", item.tone === "warn" ? "text-amber" : "text-fg-faint")}>
          {item.tone === "warn" && <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
          <span className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words" title={item.text}>{item.text}</span>
        </div>
      );
    case "end":
      return (
        <div className={cn("flex items-center gap-2 py-0.5 font-mono text-[10.5px]", item.ok ? "text-fg-faint" : "text-red")}>
          <div className="h-px flex-1 bg-line" />
          <span className="max-w-[80%] truncate" title={item.text}>
            {item.ok ? <Check className="mr-1 inline size-3 text-green" /> : <X className="mr-1 inline size-3" />}
            {item.text}
          </span>
          <div className="h-px flex-1 bg-line" />
        </div>
      );
  }
}, (a, b) =>
  // `thread` is rebuilt every render, so compare what is in it.
  a.item === b.item && a.open === b.open && a.compact === b.compact && a.caret === b.caret && a.small === b.small && a.onToggleGroup === b.onToggleGroup && a.thread?.fork === b.thread?.fork && a.thread?.latest === b.thread?.latest && !!a.thread === !!b.thread,
);

type Segment = { kind: "main"; item: DisplayItem } | { kind: "sub"; session: string; items: DisplayItem[] };

/** Lines from other sessions are folded into one rail per consecutive run, so a head's burst reads as a unit. */
export function segment(items: DisplayItem[], focusSession: string | undefined): Segment[] {
  const out: Segment[] = [];
  for (const it of items) {
    if (!focusSession || it.session === focusSession) {
      out.push({ kind: "main", item: it });
      continue;
    }
    // A subagent's own turn dividers and prompts are noise inside a rail.
    if (it.type === "turn" || it.type === "user") continue;
    const last = out[out.length - 1];
    if (last?.kind === "sub" && last.session === it.session) last.items.push(it);
    else out.push({ kind: "sub", session: it.session, items: [it] });
  }
  return out;
}

export const Transcript = memo(function Transcript({ items, labels, running, focusSession, compact, className, footer, empty }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [pill, setPill] = useState(false);
  const unseen = useRef(0);
  const programmatic = useRef(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const baseline = useRef<number | null>(null);
  // Only the newest rows are mounted; older ones are added on demand (a long session is thousands of rows).
  const [limit, setLimit] = useState(WINDOW);
  // A palette jump to a turn outside the window must find its row mounted.
  const focusTurn = useThreadFocus((s) => s.turnId);
  const anchor = useRef<{ height: number; top: number } | null>(null);

  // groupTools builds fresh group objects each time; hand back the previous one when its tools are unchanged so memoized rows skip.
  const prevGroups = useRef(new Map<string, ToolGroup>());
  const display = useMemo(() => {
    const next = groupTools(items);
    const seen = new Map<string, ToolGroup>();
    for (let i = 0; i < next.length; i++) {
      const g = next[i];
      if (g.type !== "tools") continue;
      const old = prevGroups.current.get(g.id);
      if (old && old.tools.length === g.tools.length && old.tools.every((t, j) => t === g.tools[j])) next[i] = old;
      seen.set(g.id, next[i] as ToolGroup);
    }
    prevGroups.current = seen;
    return next;
  }, [items]);
  const segments = useMemo(() => segment(display, focusSession), [display, focusSession]);
  const focusAt = focusTurn
    ? segments.findIndex((g) => {
        const first = g.kind === "main" ? g.item : g.items[0];
        return "turnId" in first && first.turnId === focusTurn;
      })
    : -1;
  const shown = Math.max(limit, focusAt >= 0 ? segments.length - focusAt : 0);

  // Everything present when we first have content is history: it appears at once. Only what arrives after animates in.
  if (baseline.current === null && display.length > 0) baseline.current = display.length;
  const indexOf = useMemo(() => new Map(display.map((d, i) => [d.id, i])), [display]);

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    // The scroll event fires after this tick; clear the flag once it has had a chance to.
    requestAnimationFrame(() => requestAnimationFrame(() => (programmatic.current = false)));
  }, []);

  const showEarlier = useCallback(() => {
    const el = scroller.current;
    if (!el || anchor.current) return;
    anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setLimit((n) => n + WINDOW);
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollTop < 120 && !programmatic.current) showEarlier();
    const prev = stick.current;
    stick.current = nextStick(prev, { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, programmatic: programmatic.current });
    if (stick.current) {
      unseen.current = 0;
      setPill(false);
    }
  };

  // Follow growth: new items, markdown settling, a group expanding. A ResizeObserver catches all of them.
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (anchor.current) return; // older rows were just added above the reader: not news
      if (stick.current) toBottom();
      else {
        unseen.current += 1;
        setPill(showJumpPill(false, unseen.current));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  // First paint with history: land at the bottom.
  useLayoutEffect(() => {
    if (display.length && scroller.current) toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline.current !== null]);

  // Sending a message takes you to the bottom, wherever you had scrolled to. The first value seen is history.
  const latestUserId = useMemo(() => [...display].reverse().find((d) => d.type === "user" && (!focusSession || d.session === focusSession))?.id ?? null, [display, focusSession]);
  const seenUser = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    const first = seenUser.current === undefined;
    const sent = !first && latestUserId !== null && latestUserId !== seenUser.current;
    if (!first || display.length > 0) seenUser.current = latestUserId;
    if (!sent) return;
    stick.current = true;
    unseen.current = 0;
    setPill(false);
    toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestUserId]);

  // After older rows mount, keep the row the reader was looking at where it was.
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scroller.current;
    if (!a || !el) return;
    el.scrollTop = a.top + (el.scrollHeight - a.height);
    requestAnimationFrame(() => (anchor.current = null));
  }, [limit]);

  useEffect(() => {
    if (!display.length) {
      setLimit(WINDOW);
      stick.current = true;
      unseen.current = 0;
      setPill(false);
    }
  }, [display.length]);

  const toggleGroup = useCallback((id: string) => setOpenGroups((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  }), []);

  // The focus session's last text of each turn offers the fork; the newest one of all shows it persistently.
  const lastTextOfTurn = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of display) if (d.type === "text" && d.turnId && (!focusSession || d.session === focusSession)) m.set(d.turnId, d.id);
    return m;
  }, [display, focusSession]);
  const latestTextId = useMemo(() => [...display].reverse().find((d) => d.type === "text" && (!focusSession || d.session === focusSession))?.id, [display, focusSession]);
  useScrollToTurn(content);
  const threadFor = (it: DisplayItem) => (it.type === "user" ? { fork: false, latest: false } : it.type === "text" && it.turnId && lastTextOfTurn.get(it.turnId) === it.id ? { fork: true, latest: it.id === latestTextId } : undefined);

  const last = display[display.length - 1];
  const caretOn = running && last?.type === "text";
  const focusDepth = focusSession ? (labels?.[focusSession]?.depth ?? 0) : 0;
  const animate = (id: string) => baseline.current !== null && (indexOf.get(id) ?? 0) >= baseline.current;

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div ref={content} className={cn("flex flex-col", compact ? "gap-2 p-2.5" : "gap-3 p-3.5")}>
          {display.length === 0 && (empty ?? null)}
          {segments.length > shown && (
            <button onClick={showEarlier} className="self-center rounded-full border border-line px-3 py-1 text-[11px] text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-accent">
              Show earlier ({segments.length - shown} more)
            </button>
          )}
          {segments.slice(-shown).map((seg) => {
            if (seg.kind === "main") {
              const it = seg.item;
              return (
                <div key={it.id} className={cn(animate(it.id) && "animate-slide-up")}>
                  <ItemView item={it} open={it.type === "tools" && openGroups.has(it.id)} onToggleGroup={toggleGroup} compact={compact} caret={caretOn && it === last} thread={threadFor(it)} />
                </div>
              );
            }
            const info = labels?.[seg.session];
            const label = info?.label ?? seg.session.slice(0, 8);
            const color = roleColor(label);
            const depth = Math.max(1, (info?.depth ?? 1) - focusDepth);
            const first = seg.items[0];
            return (
              <div key={`${seg.session}:${first.id}`} style={{ marginLeft: Math.min(depth, 3) * 10, borderColor: color }} className={cn("min-w-0 border-l-2 pl-2.5", animate(first.id) && "animate-slide-up")}>
                <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider" style={{ color }}>
                  <Network className="size-3" />
                  {label}
                </div>
                <div className="flex flex-col gap-1.5">
                  {seg.items.map((it) => (
                    <ItemView key={it.id} item={it} open={it.type === "tools" && openGroups.has(it.id)} onToggleGroup={toggleGroup} compact small caret={caretOn && it === last} />
                  ))}
                </div>
              </div>
            );
          })}
          {footer}
        </div>
      </div>
      {pill && (
        <button
          onClick={() => {
            stick.current = true;
            unseen.current = 0;
            setPill(false);
            // Instant, not smooth: a smooth scroll fires scroll events that look like the reader leaving the bottom.
            toBottom(false);
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 animate-slide-up items-center gap-1.5 rounded-full border border-line-strong bg-overlay px-3 py-1 text-[11px] text-fg shadow-pop outline-none transition-transform hover:scale-105 focus-visible:ring-1 focus-visible:ring-accent"
        >
          <ArrowDown className="size-3 text-accent" />
          Jump to latest
        </button>
      )}
    </div>
  );
});
