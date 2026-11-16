import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Brain, Check, ChevronRight, Copy, FileDiff, GitBranch, GitMerge, Hourglass, MessageSquare, MoreHorizontal, PanelTop, Send, Square, SquareTerminal, UserRoundCog, Wrench, X } from "lucide-react";
import { useSession } from "@/lib/queries";
import { cn, money } from "@/lib/utils";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { DropdownMenu } from "@/components/ui/overlay";
import { Spinner, StatusDot } from "@/components/ui/misc";
import { Markdown } from "./Markdown";
import { RoleBadge } from "./RoleBadge";
import { engineLabel, formatElapsed, isMergeReady, type Activity, type HeadNode } from "./model";
import { useNow } from "./hooks";
import type { HeadActions } from "./actions";
import { EngineIcon, ModelIcon } from "@/components/ui/engine-icon";
import { showsModelMark } from "@/lib/models-logic";
import { awaitedLabel } from "@/features/agent/waiting-logic";
import { contextLevel } from "@/features/agent/context-logic";

/** Height collapse without measuring: grid rows 1fr -> 0fr. */
export function Collapse({ open, children, bleed }: { open: boolean; children: ReactNode; /** Let children draw 12px outside the left edge (the tree's elbow connectors). */ bleed?: boolean }) {
  return (
    <div className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
      <div className={cn("min-h-0 overflow-hidden", bleed && "-ml-3 pl-3")}>{children}</div>
    </div>
  );
}

/** The card's one status light, in a fixed slot so every title lines up. Status is an icon or a pulsing dot, never colour alone. */
function StatusMark({ status, turns }: { status: string; turns: number }) {
  if (status === "running") return <StatusDot status="running" size={8} />;
  if (status === "failed") return <AlertTriangle className="size-3.5 text-red" aria-label="failed" />;
  if (status === "idle" && turns > 0) return <Check className="size-3.5 text-green animate-pop" aria-label="done" />;
  return <StatusDot status={status} />;
}

/** What the strip is doing, as a quiet icon: a tool call, a thinking spell, or a line of text. */
function ActivityIcon({ kind }: { kind: Activity["kind"] | undefined }) {
  const Icon = kind === "thinking" ? Brain : kind === "text" ? MessageSquare : Wrench;
  return <Icon className="size-3 shrink-0 text-fg-faint" aria-hidden />;
}

/** Context window fill (pct is 0..1), only worth a word once the meter turns amber (70%), red from 90%. */
function contextNote(h: HeadNode["head"]): { text: string; tone: "text-amber" | "text-red" } | null {
  const pct = h.context?.pct;
  const level = contextLevel(pct);
  if (pct == null || (level !== "warn" && level !== "high")) return null;
  return { text: `ctx ${Math.round(pct * 100)}%`, tone: level === "high" ? "text-red" : "text-amber" };
}

export interface HeadCardProps {
  node: HeadNode;
  activity?: Activity;
  /** Epoch ms the running turn began (for the live timer). */
  startedAt?: number;
  selected: boolean;
  /** Bumped when this head just finished with work to review: restarts the flash animation. */
  flashKey: number;
  closing: boolean;
  index: number;
  actions: HeadActions;
  onSelect: (id: string) => void;
  /** The nested heads, drawn under this card on the rail. */
  nested?: ReactNode;
  /** Set while the lead (or this head's parent) is blocked in subagent_wait on this head. */
  awaitedBy?: { depth: number; title: string };
}

/**
 * One head on the rail, in four tiers that read top to bottom: who and how long (status light, title, timer), what
 * kind of worker it is (role, agent, engine), what it produced (branch, diff, cost), and what it is doing this
 * second (the activity strip). Actions sit last. The running pulse is the only motion; the strip's text shimmers
 * only while a tool call is in flight.
 */
export function HeadCard({ node, activity, startedAt, selected, flashKey, closing, index, actions, onSelect, nested, awaitedBy }: HeadCardProps) {
  const h = node.head;
  const [expanded, setExpanded] = useState(false);
  const [more, setMore] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const running = h.status === "running";
  const now = useNow(running);
  const full = useSession(expanded ? h.id : null);
  const detail = full.data?.session;
  const ready = isMergeReady(h);
  const ctx = contextNote(h);

  // Selecting a card by keyboard should reveal it.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const elapsed = running && startedAt ? formatElapsed((now - startedAt) / 1000) : null;

  const merge = async () => {
    const r = await actions.merge(h);
    if (r) setNote(r.message);
  };
  const send = async () => {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    if (await actions.send(h, text)) setMessage("");
    setSending(false);
  };

  const hasFacts = !!(h.branch || h.changes || h.merged || h.isolation === "none" || h.cost_usd || ctx);

  return (
    <Collapse open={!closing} bleed={node.level > 0}>
      <div ref={ref} data-head-id={h.id} className={cn("animate-slide-up relative py-1", node.level > 0 && "before:absolute before:-left-2.5 before:top-[26px] before:h-px before:w-2.5 before:bg-line-strong")} style={{ animationDelay: `${Math.min(index, 8) * 28}ms` }}>
        <div
          key={flashKey}
          onClick={() => onSelect(h.id)}
          className={cn(
            "group relative overflow-hidden rounded-lg border bg-raised/60 transition-[border-color,background,opacity] duration-150",
            h.status === "closed" && !selected && "opacity-60 hover:opacity-100",
            selected ? "border-accent/60 bg-raised" : "border-line hover:border-line-strong",
            flashKey > 0 && "animate-flash",
          )}
        >
          <div className="flex gap-2 p-3">
            {/* Media slot: the status light, level with the title. */}
            <div className="flex h-5 w-4 shrink-0 items-center justify-center">
              <StatusMark status={h.status} turns={h.turns} />
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-col gap-1">
                <div className="flex h-5 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={h.title}>
                    {h.title}
                  </span>
                  {elapsed && <span className="shrink-0 font-mono text-label tabular-nums text-fg">{elapsed}</span>}
                  <button onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} aria-label={expanded ? "Collapse" : "Expand"} className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-faint outline-none hover:bg-hover hover:text-fg">
                    <ChevronRight className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
                  </button>
                </div>

                {/* Who: role, agent, engine. */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-label text-fg-muted">
                  <RoleBadge role={h.role} fallback={h.engine} />
                  {h.agent && (
                    <span title={`Runs as the agent “${h.agent}”`} className="inline-flex h-[18px] max-w-[96px] shrink-0 items-center gap-1 truncate rounded-sm border border-blue/25 bg-blue/10 px-1 text-label text-blue">
                      <UserRoundCog className="size-3 shrink-0" />
                      <span className="truncate">{h.agent}</span>
                    </span>
                  )}
                  <span className="flex min-w-0 items-center gap-1">
                    <EngineIcon engine={h.engine} className="size-3 shrink-0" />
                    {showsModelMark(h.engine, h.model) && <ModelIcon model={h.model} engine={h.engine} className="size-3 shrink-0" />}
                    <span className="truncate">{engineLabel(h)}</span>
                  </span>
                  {awaitedBy && running && (
                    <span data-awaited title={`${awaitedBy.title} is blocked in subagent_wait until this head finishes`} className="inline-flex shrink-0 items-center gap-1 text-amber">
                      <Hourglass className="size-3" />
                      {awaitedLabel(awaitedBy)}
                    </span>
                  )}
                  {h.status === "failed" && <span className="shrink-0 font-medium text-red">failed</span>}
                </div>

                {/* What it produced: branch, diff, cost, context. */}
                {hasFacts && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-label text-fg-muted">
                    {h.branch && (
                      <button onClick={() => actions.copyBranch(h)} title={`Copy ${h.branch}`} className="flex max-w-[170px] items-center gap-1 truncate rounded-sm outline-none hover:text-fg">
                        <GitBranch className="size-3 shrink-0" />
                        <span className="truncate">{h.branch.replace(/^trb\//, "")}</span>
                      </button>
                    )}
                    {h.changes && (
                      <span title={`${h.changes.files} file(s) changed`} className="flex items-center gap-1">
                        <span className="text-green">+{h.changes.insertions}</span>
                        <span className="text-red">−{h.changes.deletions}</span>
                        <span>
                          · {h.changes.files} file{h.changes.files === 1 ? "" : "s"}
                        </span>
                      </span>
                    )}
                    {h.merged && (
                      <span className="inline-flex items-center gap-1 text-green">
                        <GitMerge className="size-3" /> merged
                      </span>
                    )}
                    {h.isolation === "none" && <span title="Shares the parent's workspace; its edits are already there">shared</span>}
                    {ctx && (
                      <span title="How full the context window is" className={ctx.tone}>
                        {ctx.text}
                      </span>
                    )}
                    {h.cost_usd ? <span>{money(h.cost_usd)}</span> : null}
                  </div>
                )}
              </div>

              {/* What it is doing this second. */}
              {(running || activity) && (
                <div data-head-activity className="flex h-7 items-center gap-2 rounded-md border border-line bg-panel px-2 font-mono text-xs">
                  {running && !activity ? <Spinner className="size-3" /> : <ActivityIcon kind={activity?.kind} />}
                  <span className={cn("min-w-0 flex-1 truncate", activity?.running ? "shimmer-text" : "text-fg-muted")} title={activity?.label}>
                    {activity?.label ?? "starting…"}
                  </span>
                </div>
              )}

              <div className="-ml-1 flex items-center gap-1">
                {ready && (
                  <Button size="xs" variant="primary" onClick={merge} className="animate-pop">
                    <GitMerge /> Merge
                  </Button>
                )}
                <IconButton label="Open head" size="icon-sm" onClick={() => actions.open(h)}>
                  <PanelTop />
                </IconButton>
                <IconButton label="View changes" size="icon-sm" disabled={!h.changes} onClick={() => actions.open(h, "changes")}>
                  <FileDiff />
                </IconButton>
                {running ? (
                  <IconButton label="Interrupt" size="icon-sm" onClick={() => actions.interrupt(h)} className="text-fg hover:text-fg">
                    <Square className="fill-current" />
                  </IconButton>
                ) : (
                  <IconButton
                    label="Send follow-up"
                    size="icon-sm"
                    onClick={() => {
                      setExpanded(true);
                      setTimeout(() => inputRef.current?.focus(), 80);
                    }}
                  >
                    <Send />
                  </IconButton>
                )}
                <div className="flex-1" />
                {h.status !== "closed" && (
                  <IconButton label="Close head" size="icon-sm" onClick={() => actions.close(h)} className="hover:text-red">
                    <X />
                  </IconButton>
                )}
                <DropdownMenu
                  align="end"
                  entries={[
                    { label: "Open in a tab", icon: <PanelTop />, onSelect: () => actions.open(h) },
                    { label: "View changes", icon: <FileDiff />, disabled: !h.changes, onSelect: () => actions.open(h, "changes") },
                    { label: "Open terminal here", icon: <SquareTerminal />, onSelect: () => actions.openTerminal(h) },
                    { label: "Copy branch name", icon: <Copy />, disabled: !h.branch, onSelect: () => actions.copyBranch(h) },
                    { separator: true },
                    { label: "Merge into parent", icon: <GitMerge />, disabled: !ready, shortcut: "m", onSelect: merge },
                    { label: "Interrupt", icon: <Square />, disabled: !running, onSelect: () => actions.interrupt(h) },
                    { label: "Close", icon: <X />, danger: true, onSelect: () => actions.close(h) },
                  ]}
                  trigger={
                    <button aria-label="More actions" className="flex size-6 items-center justify-center rounded-md text-fg-faint outline-none hover:bg-hover hover:text-fg">
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  }
                />
              </div>

              {note && (
                <div className="rounded-md border border-line bg-panel px-2 py-1 text-xs leading-relaxed text-fg-muted animate-slide-up">
                  {note}
                  <button className="ml-2 text-fg-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => setNote(null)}>
                    dismiss
                  </button>
                </div>
              )}

              <Collapse open={expanded}>
                <div className="flex flex-col gap-2">
                  {full.isLoading ? (
                    <Spinner />
                  ) : detail?.output ? (
                    <>
                      <div className={cn("overflow-hidden rounded-md border border-line bg-panel px-2 py-1", !more && "max-h-36")}>
                        <Markdown className="text-xs">{detail.output}</Markdown>
                      </div>
                      {!more && detail.output.length > 280 && (
                        <button onClick={() => setMore(true)} className="self-start rounded-sm text-label text-fg-muted outline-none hover:text-fg hover:underline">
                          Show more
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="text-xs text-fg-muted">{running ? "Working — its answer appears here when the turn ends." : "No answer recorded."}</div>
                  )}
                  {detail?.error && !detail.output?.includes(detail.error.split("\n")[0]) && <div className="rounded-md border border-red/30 bg-red/10 px-2 py-1 font-mono text-label text-red">{detail.error.split("\n")[0]}</div>}
                  <div className="flex items-center gap-2">
                    <Input
                      ref={inputRef}
                      value={message}
                      disabled={running}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void send();
                        }
                        e.stopPropagation();
                      }}
                      placeholder={running ? "Working… interrupt to redirect" : "Follow up with this head…"}
                      aria-label="Follow-up message"
                      className="h-7 min-w-0 flex-1 px-2 text-xs"
                    />
                    <Button size="sm" variant="subtle" aria-label="Send" disabled={running || !message.trim() || sending} onClick={send}>
                      {sending ? <Spinner /> : <Send />}
                    </Button>
                  </div>
                </div>
              </Collapse>
            </div>
          </div>
        </div>
        {nested}
      </div>
    </Collapse>
  );
}
