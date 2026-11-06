/**
 * A slim strip in the composer's status slot: the lead and one chip per head, so you see who is working without
 * leaving the chat. The session has none when it has no pair and no heads. No costs here.
 */
import { AlertTriangle, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { EngineIcon } from "@/components/ui/engine-icon";
import { StatusDot } from "@/components/ui/misc";
import { useNow } from "@/features/heads/hooks";
import type { Shelf as ShelfModel, ShelfChip } from "./chat-logic";
import { waitingText } from "./waiting-logic";

function HeadChip({ chip, onOpen }: { chip: ShelfChip; onOpen: (id: string) => void }) {
  return (
    <button
      data-shelf-head={chip.id}
      onClick={() => onOpen(chip.id)}
      title={chip.awaited ? `${chip.label}: ${chip.title} (the lead is waiting on this head)` : `${chip.label}: ${chip.title}`}
      className={cn(
        "flex h-5 max-w-[130px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] outline-none transition-colors focus-visible:border-accent/60",
        chip.state === "failed" ? "border-red/40 text-red hover:bg-red/10" : chip.awaited ? "border-amber/40 text-fg hover:border-amber/60" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
      )}
    >
      {chip.state === "running" ? <span data-awaited={chip.awaited ? "" : undefined} className={cn("size-2.5 shrink-0 animate-spin-fast rounded-full border-[1.5px]", chip.awaited ? "border-amber/30 border-t-amber" : "border-accent/30 border-t-accent")} /> : chip.state === "failed" ? <AlertTriangle className="size-3 shrink-0" /> : <Check className="size-3 shrink-0 text-green" strokeWidth={2.8} />}
      <EngineIcon engine={chip.engine} className="size-3 shrink-0 opacity-70" />
      {/* The icon already says which engine: a role is worth the room, else the head's own title (cut short). */}
      <span className="truncate">{chip.label === chip.engine ? chip.title : chip.label}</span>
    </button>
  );
}

/** The strip itself: the status slot owns where it sits and how it animates in and out. */
export function ShelfStrip({ shelf, onOpenHead }: { shelf: ShelfModel; onOpenHead: (id: string) => void }) {
  const waiting = shelf.lead.waiting ?? null;
  const now = useNow(!!waiting);
  return (
    <div data-shelf className="flex items-center gap-1.5 overflow-x-auto rounded-lg border border-line bg-panel/70 px-2 py-1">
      <span className="flex h-5 shrink-0 items-center gap-1.5 text-[11px] text-fg-muted">
        <StatusDot status={shelf.lead.status} size={6} />
        <EngineIcon engine={shelf.lead.engine} className="size-3 opacity-80" />
        Lead
      </span>
      {waiting && (
        <span data-shelf-waiting title={waitingText({ ids: [], names: waiting.names, sinceMs: waiting.sinceMs }, now) + " (the lead is blocked until these heads finish)"} className="flex h-5 shrink-0 animate-slide-up items-center gap-1.5 whitespace-nowrap text-[11px] text-amber">
          <span className="relative flex size-1.5 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-amber" />
          </span>
          {waitingText({ ids: [], names: waiting.names, sinceMs: waiting.sinceMs }, now, { compact: true })}
        </span>
      )}
      {shelf.heads.length > 0 && <span className="h-3 w-px shrink-0 bg-line" />}
      {shelf.heads.map((h) => (
        <HeadChip key={h.id} chip={h} onOpen={onOpenHead} />
      ))}
    </div>
  );
}
