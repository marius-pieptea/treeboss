/**
 * The Chat view: the same transcript as Trace, drawn as a conversation. Messages, one muted line per run of tool
 * calls, one compact card per head. No costs, tokens, durations or dividers anywhere (Trace has those).
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, Check, ChevronRight, ExternalLink, GitMerge, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TranscriptItem } from "@/lib/transcript";
import type { SessionView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { EngineIcon } from "@/components/ui/engine-icon";
import { RoleBadge } from "@/features/heads/RoleBadge";
import { shortToolName } from "@/features/heads/model";
import { CopyButton, ForkButton, RewindButton, useScrollToTurn } from "@/features/checkpoints/ThreadActions";
import { AskFooter } from "./AskFooter";
import { askTurnsById, followUpsFor, lastTextByTurn } from "./ask-logic";
import { useSessionTurns } from "./ask-data";
import { AssistantText } from "./AssistantText";
import { OpenFileButton } from "./FileLinks";
import { CompactDivider } from "./ContextMeter";
import { PlanThreadChip } from "./PlanFlow";
import { nextStick, showJumpPill } from "./scroll-logic";
import { deriveChat, diffStat, hasLiveTail, headLine, isMergeReady, splitContext, splitInstructions, splitSkillCall, type ChatItem } from "./chat-logic";
import { useSkills } from "@/features/settings/data";
import { DesignThreadCard } from "@/features/design/ThreadCard";

type ToolsItem = Extract<ChatItem, { kind: "tools" }>;
type HeadItem = Extract<ChatItem, { kind: "head" }>;

/** Status words with a soft wave running through the letters (after Kokonut's AI Text Loading); the wave is CSS, so it costs no render. */
function WaveText({ text, className }: { text: string; className?: string }) {
  return (
    <span role="status" aria-label={text} className={className}>
      {Array.from(text).map((ch, i) => (
        <span key={i} aria-hidden className="wave-letter" style={{ ["--i" as string]: i }}>
          {ch === " " ? " " : ch}
        </span>
      ))}
    </span>
  );
}

function ToolsLine({ item }: { item: ToolsItem }) {
  const [open, setOpen] = useState(false);
  const failed = item.tools.some((t) => t.status === "err");
  return (
    <div className="min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex max-w-full items-center gap-1.5 rounded-full border border-transparent py-0.5 pl-1.5 pr-2.5 text-left text-[12px] text-fg-faint outline-none transition-colors hover:border-line hover:bg-raised hover:text-fg-muted focus-visible:border-line focus-visible:text-fg-muted"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        {item.running ? <span className="shimmer-text truncate">{item.verb}</span> : <span className="truncate">{item.summary}</span>}
        {failed && !item.running && <span className="shrink-0 text-red/80">· something failed</span>}
      </button>
      {open && (
        <ul className="mb-1 ms-3 mt-1.5 flex animate-slide-up flex-col gap-1.5 border-s border-line ps-3.5">
          {item.tools.map((t, i) => (
            <li key={t.id} style={{ ["--i" as string]: i }} className="stagger animate-slide-up flex items-center gap-2 text-[12px] text-fg-faint">
              <span className="step-ring" data-state={t.status}>
                {t.status === "ok" ? <Check className="size-2.5" strokeWidth={3} /> : t.status === "running" ? null : <X className="size-2.5" strokeWidth={3} />}
              </span>
              <span className={cn("shrink-0 text-fg-muted", t.status === "running" && "shimmer-text")}>{shortToolName(t.name)}</span>
              <span className="min-w-0 flex-1 truncate rounded-md bg-hover px-1.5 py-0.5 font-mono text-[11px]" title={t.arg}>
                {t.arg.replace(/\s+/g, " ")}
              </span>
              <OpenFileButton arg={t.arg} className="-my-0.5" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HeadCard({ item, head, onOpen, onMerge }: { item: HeadItem; head: SessionView | undefined; onOpen: (h: SessionView) => void; onMerge: (h: SessionView) => void }) {
  const label = head?.role ?? head?.engine ?? item.session.slice(0, 8);
  const status = head?.status ?? (item.activity?.running ? "running" : "idle");
  const running = status === "running";
  const failed = status === "failed";
  const stat = head ? diffStat(head) : null;
  const line = head ? headLine(head, item) : (item.activity?.label ?? item.result ?? "");
  return (
    <div data-chat-head={item.session} className={cn("relative flex min-w-0 items-center gap-2 overflow-hidden rounded-xl border bg-panel/50 py-1.5 pl-3.5 pr-2.5 text-[12px] shadow-sm before:absolute before:inset-y-0 before:left-0 before:w-[3px]", failed ? "border-red/30 before:bg-red" : running ? "border-violet/30 before:bg-violet sweep" : "border-line before:bg-green/70")}>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {running ? <span className="size-3 animate-spin-fast rounded-full border-[1.5px] border-accent/30 border-t-accent" /> : failed ? <AlertTriangle className="size-3.5 text-red" /> : <Check className="size-3.5 text-green" strokeWidth={2.6} />}
      </span>
      {head && <EngineIcon engine={head.engine} className="size-3.5 shrink-0 opacity-70" />}
      <RoleBadge role={head?.role} fallback={head ? undefined : label} />
      <span className={cn("min-w-0 flex-1 truncate", running ? "shimmer-text" : failed ? "text-red/90" : "text-fg-muted")} title={line}>
        {line}
      </span>
      {stat && (
        <span className="shrink-0 font-mono text-[10.5px] text-fg-faint" title={`${stat.files} file${stat.files === 1 ? "" : "s"} changed`}>
          <span className="text-green">+{stat.plus}</span> <span className="text-red">−{stat.minus}</span>
        </span>
      )}
      {head && isMergeReady(head) && (
        <Button size="xs" variant="outline" onClick={() => onMerge(head)}>
          <GitMerge /> Merge
        </Button>
      )}
      {head && (
        <button onClick={() => onOpen(head)} aria-label={`Open ${label}`} title="Open this head" className="flex size-5 shrink-0 items-center justify-center rounded text-fg-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover">
          <ExternalLink className="size-3" />
        </button>
      )}
    </div>
  );
}

/** The heads a lead is running, as one block: a live summary on top and the cards on a shared rail, so Hydra work reads as one thing. */
function HeadLanes({ items, headById, onOpen, onMerge }: { items: HeadItem[]; headById: Map<string, SessionView>; onOpen: (h: SessionView) => void; onMerge: (h: SessionView) => void }) {
  const states = items.map((h) => headById.get(h.session)?.status ?? (h.activity?.running ? "running" : "idle"));
  const working = states.filter((st) => st === "running").length;
  const failed = states.filter((st) => st === "failed").length;
  const done = items.length - working - failed;
  const summary = [working && `${working} working`, done && `${done} done`, failed && `${failed} failed`].filter(Boolean).join(" · ");
  return (
    <section data-heads-group aria-label="Heads" className={cn("rounded-2xl border bg-violet/[0.04] p-1.5 transition-colors", working ? "border-violet/30" : failed ? "border-red/25" : "border-line")}>
      <header className="flex items-center gap-2 px-1.5 pb-1.5 pt-0.5 text-[11px]">
        <span className={cn("size-1.5 rounded-full", working ? "animate-pulse-dot bg-violet" : failed ? "bg-red" : "bg-green")} style={{ ["--pulse" as string]: "var(--violet)" }} />
        <span className="font-medium text-fg">{items.length === 1 ? "Head" : "Heads"}</span>
        <span className="font-mono text-[10.5px] text-fg-faint">{summary}</span>
      </header>
      <div className="relative flex flex-col gap-1.5 ps-3 before:absolute before:inset-y-1 before:left-[5px] before:w-px before:bg-violet/30">
        {items.map((h) => (
          <HeadCard key={h.id} item={h} head={headById.get(h.session)} onOpen={onOpen} onMerge={onMerge} />
        ))}
      </div>
    </section>
  );
}

function Failure({ text, onRetry, retrying }: { text: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <div role="alert" className="rounded-lg border border-red/30 bg-red/5 px-3 py-2">
      <div className="flex items-center gap-2 text-[12px] font-medium text-red">
        <AlertTriangle className="size-3.5" />
        That did not finish
        {onRetry && (
          <Button size="xs" variant="outline" className="ml-auto" onClick={onRetry} disabled={retrying}>
            <RotateCcw /> Retry
          </Button>
        )}
      </div>
      {text && <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-muted">{text.split("\n").slice(0, 12).join("\n")}</pre>}
    </div>
  );
}

/** A message on its way out, shown before the daemon has written it to the transcript. */
/** The enabled skills' names, so a typed `/skill …` can be told apart from any other message starting with a slash. */
function useSkillNames(): string[] {
  const skills = useSkills().data;
  return useMemo(() => (skills ?? []).filter((k) => k.enabled).map((k) => k.name), [skills]);
}

/** A message bubble; a skill the message called shows as a small tag in front of the person's own words. */
function Bubble({ text, skill }: { text: string; skill: string | null }) {
  return (
    <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-line bg-gradient-to-b from-raised to-raised/60 px-3.5 py-2 text-[13px] leading-relaxed shadow-sm">
      {skill && (
        <span data-skill-call className="mr-1.5 inline-block rounded border border-line-strong px-1 align-baseline font-mono text-[10px] text-fg-faint">
          {skill}
        </span>
      )}
      {text}
    </div>
  );
}

export function PendingTurn({ text }: { text: string }) {
  const call = splitSkillCall(text, useSkillNames());
  return (
    <div data-pending-turn className="flex flex-col gap-3 pt-2">
      {text && (
        <div className="flex justify-end">
          <Bubble text={call.text} skill={call.skill} />
        </div>
      )}
      <WaveText text="Starting…" className="px-0.5 text-[12px] text-fg-muted" />
    </div>
  );
}

export interface ChatThreadProps {
  items: TranscriptItem[];
  focusSession: string;
  /** The session's heads, to label cards and offer Open / Merge. */
  heads: SessionView[];
  running: boolean;
  /** A message sent but not yet in the transcript. */
  pending?: { text: string } | null;
  /** The daemon's message for a failed session, when the log carries none. */
  error?: string | null;
  failed: boolean;
  onRetry: () => void;
  retrying: boolean;
  onOpenHead: (h: SessionView) => void;
  onMergeHead: (h: SessionView) => void;
  className?: string;
}

/** The operator's message. A prompt trb built around their words shows only the words, with a tag that unfolds the instructions. */
function UserMessage({ text, turnId }: { text: string; turnId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const withCtx = useMemo(() => splitContext(text), [text]);
  const split = useMemo(() => splitInstructions(withCtx.text), [withCtx.text]);
  const names = useSkillNames();
  const call = useMemo(() => splitSkillCall(split.text, names), [split.text, names]);
  return (
    <div className="group/msg flex flex-col items-end gap-1 pt-2">
      <div className="flex w-full items-center justify-end gap-0.5">
        <RewindButton turnId={turnId} />
        <Bubble text={call.text} skill={call.skill} />
      </div>
      {withCtx.context && (
        <button type="button" data-context-toggle onClick={() => setShowContext((o) => !o)} aria-expanded={showContext} className="flex items-center gap-1 rounded px-1 text-[10.5px] text-fg-faint outline-none hover:text-fg-muted focus-visible:text-fg-muted">
          <ChevronRight className={cn("size-3 transition-transform", showContext && "rotate-90")} />
          Attached context
        </button>
      )}
      {showContext && withCtx.context && <pre className="max-h-[320px] w-[88%] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-panel p-2.5 font-mono text-[10.5px] leading-relaxed text-fg-muted">{withCtx.context}</pre>}
      {split.label && (
        <button type="button" data-instructions-toggle onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1 rounded px-1 text-[10.5px] text-fg-faint outline-none hover:text-fg-muted focus-visible:text-fg-muted">
          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
          {split.label} · instructions
        </button>
      )}
      {open && split.instructions && <pre className="max-h-[320px] w-[88%] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-panel p-2.5 font-mono text-[10.5px] leading-relaxed text-fg-muted">{split.instructions}</pre>}
    </div>
  );
}

export const ChatThread = memo(function ChatThread({ items, focusSession, heads, running, pending, error, failed, onRetry, retrying, onOpenHead, onMergeHead, className }: ChatThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const unseen = useRef(0);
  const programmatic = useRef(false);
  const baseline = useRef<number | null>(null);
  const [pill, setPill] = useState(false);

  const chat = useMemo(() => deriveChat(items, focusSession), [items, focusSession]);
  // Consecutive head cards read as one Hydra block.
  const rows = useMemo(() => {
    const out: Array<ChatItem | { kind: "heads"; id: string; items: HeadItem[] }> = [];
    for (const c of chat) {
      const prev = out[out.length - 1];
      if (c.kind !== "head") out.push(c);
      else if (prev?.kind === "heads") prev.items.push(c);
      else out.push({ kind: "heads", id: `hg:${c.id}`, items: [c] });
    }
    return out;
  }, [chat]);
  // Ask answers carry a footer (what the question cost; the follow-ups on the newest one). The turns are fetched
  // again when the thread grows or a turn ends, which is when a turn's cost becomes known.
  const turnsQuery = useSessionTurns(focusSession ?? null, `${chat.length}:${running ? "r" : "i"}`);
  const asks = useMemo(() => askTurnsById(turnsQuery.data), [turnsQuery.data]);
  const lastText = useMemo(() => lastTextByTurn(chat), [chat]);
  const latestTextId = useMemo(() => [...chat].reverse().find((c) => c.kind === "text")?.id, [chat]);
  useScrollToTurn(content);
  const headById = useMemo(() => new Map(heads.map((h) => [h.id, h])), [heads]);
  // What is on screen when the thread first has content is history and appears at once; only later items animate in.
  if (baseline.current === null && chat.length > 0) baseline.current = chat.length;
  const indexOf = useMemo(() => new Map(chat.map((c, i) => [c.id, i])), [chat]);

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTo({ top: el.scrollHeight });
    requestAnimationFrame(() => requestAnimationFrame(() => (programmatic.current = false)));
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = nextStick(stick.current, { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, programmatic: programmatic.current });
    if (stick.current) {
      unseen.current = 0;
      setPill(false);
    }
  };

  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
      else {
        unseen.current += 1;
        setPill(showJumpPill(false, unseen.current));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  useLayoutEffect(() => {
    if (chat.length) toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline.current !== null]);

  // Sending a message takes you to the bottom, wherever you had scrolled to. The first value seen is history, not a send.
  const latestUserId = useMemo(() => [...chat].reverse().find((c) => c.kind === "user")?.id ?? null, [chat]);
  const seenUser = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    const first = seenUser.current === undefined;
    const sent = !first && latestUserId !== null && latestUserId !== seenUser.current;
    if (!first || chat.length > 0) seenUser.current = latestUserId;
    if (!sent) return;
    stick.current = true;
    unseen.current = 0;
    setPill(false);
    toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestUserId]);

  // A message being sent goes to the bottom the moment it is sent, not when the daemon records it.
  useLayoutEffect(() => {
    if (!pending) return;
    stick.current = true;
    unseen.current = 0;
    setPill(false);
    toBottom();
  }, [pending, toBottom]);

  const animate = (id: string) => baseline.current !== null && (indexOf.get(id) ?? 0) >= baseline.current;
  const last = chat[chat.length - 1];
  const lastFailure = [...chat].reverse().find((c) => c.kind === "failure");
  const showTail = running && !hasLiveTail(chat);
  // A failed session with no failure line in the log (the daemon only recorded it on the session) still gets its card.
  const orphanFailure = failed && !lastFailure;

  // A thread with a design turn in it shows the directions a brainstorm wrote, when there are any.
  const designThread = useMemo(() => chat.some((c) => c.kind === "user" && splitInstructions(splitContext(c.text).text).label?.startsWith("Design")), [chat]);

  const node = (c: ChatItem): ReactNode => {
    switch (c.kind) {
      case "user":
        return <UserMessage text={c.text} turnId={c.turnId} />;
      case "text":
        return (
          <div className="group/msg min-w-0">
            <AssistantText text={c.text} reveal={animate(c.id)} />
            {running && c === last && <span className="caret" aria-hidden />}
            {!(running && c === last) && c.turnId && lastText.get(c.turnId) === c.id && (
              <div className="-mb-1 mt-0.5 flex items-center">
                <CopyButton text={c.text} latest={c.id === latestTextId} />
                <ForkButton turnId={c.turnId} latest={c.id === latestTextId} />
              </div>
            )}
            {focusSession && c.turnId && asks.has(c.turnId) && lastText.get(c.turnId) === c.id && <AskFooter sessionId={focusSession} turn={asks.get(c.turnId)!} followUps={followUpsFor(c.turnId, asks, !running)} />}
          </div>
        );
      case "tools":
        return <ToolsLine item={c} />;
      case "thinking":
        return <WaveText text="Thinking…" className="px-0.5 text-[12px] text-fg-muted" />;
      case "failure":
        // The session's own error is the daemon's message; the log's end line is only a tally ("failed after 1 turn(s)").
        return <Failure text={(c === lastFailure && failed && error) || c.text || ""} onRetry={failed && c === lastFailure ? onRetry : undefined} retrying={retrying} />;
      case "compact":
        return <CompactDivider from={c.from} to={c.to} />;
      case "plan":
        return focusSession ? <PlanThreadChip sessionId={focusSession} item={c} /> : null;
      case "head":
        return <HeadCard item={c} head={headById.get(c.session)} onOpen={onOpenHead} onMerge={onMergeHead} />;
    }
  };

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div ref={content} data-chat-thread className="mx-auto flex max-w-[760px] flex-col gap-3 px-4 py-4">
          {rows.map((r) =>
            r.kind === "heads" ? (
              <div key={r.id} className={cn(animate(r.items[0].id) && "animate-slide-up")}>
                <HeadLanes items={r.items} headById={headById} onOpen={onOpenHead} onMerge={onMergeHead} />
              </div>
            ) : (
              <div key={r.id} className={cn(animate(r.id) && "animate-slide-up")}>
                {node(r)}
              </div>
            ),
          )}
          {pending ? <PendingTurn text={pending.text} /> : showTail && <WaveText text="Thinking…" className="px-0.5 text-[12px] text-fg-muted" />}
          {designThread && !running && <DesignThreadCard />}
          {orphanFailure && <Failure text={error ?? ""} onRetry={onRetry} retrying={retrying} />}
        </div>
      </div>
      {pill && (
        <button
          onClick={() => {
            stick.current = true;
            unseen.current = 0;
            setPill(false);
            toBottom();
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
