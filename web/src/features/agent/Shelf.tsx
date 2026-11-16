/**
 * A slim strip in the composer's status slot: the lead pinned on the left, one chip per head after it, and a
 * done-count pinned on the right, so you see who is working without leaving the chat. The heads scroll on their
 * own when they do not fit; the lead and the count never do. The session has none when it has no pair and no
 * heads. No costs here.
 */
import { AlertTriangle, Check, ChevronRight, GitMerge, Hourglass } from "lucide-react";
import { cn } from "@/lib/utils";
import { EngineIcon } from "@/components/ui/engine-icon";
import { StatusDot } from "@/components/ui/misc";
import { useNow } from "@/features/heads/hooks";
import { roleTone, toneClasses } from "@/features/heads/roles";
import type { Shelf as ShelfModel, ShelfChip } from "./chat-logic";
import { formatWaitElapsed, waitingText } from "./waiting-logic";

/** One mark per chip, never colour alone: a pulsing dot (amber when the lead waits on it), a merge icon, a check, a triangle. */
function Mark({ chip }: { chip: ShelfChip }) {
  if (chip.state === "running") {
    if (!chip.awaited) return <StatusDot status="running" size={6} />;
    return <span data-awaited aria-label="working, the lead is waiting on it" style={{ width: 6, height: 6, background: "var(--amber)", ["--pulse" as string]: "var(--amber)" }} className="inline-block shrink-0 animate-pulse-dot rounded-full" />;
  }
  if (chip.state === "failed") return <AlertTriangle className="size-3 shrink-0" aria-label="failed" />;
  if (chip.ready) return <GitMerge className="size-3 shrink-0 text-green" aria-label="done, ready to merge" />;
  return <Check className="size-3 shrink-0 text-green" strokeWidth={2.8} aria-label="done" />;
}

function HeadChip({ chip, onOpen }: { chip: ShelfChip; onOpen: (id: string) => void }) {
  const plain = chip.state !== "failed" && !chip.awaited;
  // The role keeps the colour it has on the heads panel; a head without one is named by its title.
  const name = chip.role ?? (chip.label === chip.engine ? chip.title : chip.label);
  const note = chip.awaited ? " (the lead is waiting on this head)" : chip.ready ? " (ready to merge)" : "";
  return (
    <button
      data-shelf-head={chip.id}
      onClick={() => onOpen(chip.id)}
      title={`${chip.label}: ${chip.title}${note}`}
      className={cn(
        "flex h-6 max-w-[160px] shrink-0 items-center gap-1 rounded-md border px-2 text-label outline-none transition-colors",
        chip.state === "failed" ? "border-red/40 text-red hover:bg-red/10" : chip.awaited ? "border-amber/40 text-fg hover:border-amber/60" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
      )}
    >
      <Mark chip={chip} />
      <EngineIcon engine={chip.engine} className="size-3 shrink-0 opacity-70" />
      <span className={cn("truncate font-medium", plain && chip.role && toneClasses[roleTone(chip.role)].text)}>{name}</span>
    </button>
  );
}

/** The strip itself: the status slot owns where it sits and how it animates in and out. */
export function ShelfStrip({ shelf, onOpenHead }: { shelf: ShelfModel; onOpenHead: (id: string) => void }) {
  const waiting = shelf.lead.waiting ?? null;
  const now = useNow(!!waiting);
  const done = shelf.heads.filter((h) => h.state === "done").length;
  // The strip is the hourglass and the time, nothing else: the tooltip says who, and the awaited chip is outlined amber.
  const w = waiting ? { ids: [], names: waiting.names, sinceMs: waiting.sinceMs } : null;
  return (
    <div data-shelf className="flex items-center gap-2 rounded-lg border border-line bg-panel/70 px-2">
      <span className="flex h-8 shrink-0 items-center gap-2 text-xs">
        <StatusDot status={shelf.lead.status} size={6} />
        <EngineIcon engine={shelf.lead.engine} className="size-3.5" />
        <span className="font-medium text-fg">Lead</span>
      </span>
      {w && (
        <span data-shelf-waiting title={`${waitingText(w, now)} (the lead is blocked until these heads finish)`} className="flex h-8 shrink-0 animate-slide-up items-center gap-1 whitespace-nowrap text-label tabular-nums text-amber">
          <Hourglass className="size-3 shrink-0" aria-hidden />
          <span className="sr-only">waiting </span>
          {formatWaitElapsed(now - w.sinceMs)}
        </span>
      )}
      <ChevronRight className="-mx-1 size-3 shrink-0 text-fg-faint" aria-hidden />
      {shelf.heads.length > 0 ? (
        <>
          <div role="group" aria-label="Heads" className="flex h-8 min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {shelf.heads.map((h) => (
              <HeadChip key={h.id} chip={h} onOpen={onOpenHead} />
            ))}
          </div>
          <span title={`${done} of ${shelf.heads.length} heads done`} className="shrink-0 font-mono text-label tabular-nums text-fg-muted">
            {done} of {shelf.heads.length} done
          </span>
        </>
      ) : (
        <span className="text-label text-fg-muted">no heads yet</span>
      )}
    </div>
  );
}
