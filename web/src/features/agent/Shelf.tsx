/**
 * The heads rail: one row per open head, joined to the top of the composer's box so the heads and the message you type
 * to the lead read as one thing. A row is a mark, the head's name, what it is doing (or what it changed), and how long
 * it has run; a finished head with changes that can be merged carries its Merge action. Rows scroll when there are many.
 * The lead's own wait lives in the header's waiting chip, not here. The session has no rail when it has no open heads,
 * so a plain single-agent session carries no extra chrome. No costs here.
 */
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/overlay";
import { StateMark } from "./StateMark";
import { useNow } from "@/features/heads/hooks";
import { formatElapsed } from "@/features/heads/model";
import type { Shelf as ShelfModel, ShelfChip } from "./chat-logic";

const Mark = ({ chip }: { chip: ShelfChip }) => <StateMark state={chip.state} awaited={chip.awaited} label={chip.state === "done" && chip.ready ? "done, ready to merge" : undefined} />;

/** Seconds a running head has been working: what the daemon last said, plus the time since it said it. */
function useRunSeconds(chip: ShelfChip, now: number): number | null {
  const anchor = useRef({ key: "", sec: 0, at: 0 });
  const key = `${chip.state}:${chip.runningSec ?? ""}`;
  if (anchor.current.key !== key) anchor.current = { key, sec: chip.runningSec ?? 0, at: Date.now() };
  return chip.state === "running" ? anchor.current.sec + Math.max(0, now - anchor.current.at) / 1000 : null;
}

/** The middle column: running heads say what they are doing; finished ones say what they changed. */
function Line({ chip }: { chip: ShelfChip }) {
  if (chip.state === "running") return <span className="min-w-0 flex-1 truncate font-mono text-label shimmer-text">{chip.activity ?? "working…"}</span>;
  if (chip.state === "failed") return <span className="min-w-0 flex-1 truncate font-mono text-label text-red">failed</span>;
  if (chip.stat) {
    return (
      <span className="min-w-0 flex-1 truncate font-mono text-label text-fg-muted">
        {chip.stat.files} file{chip.stat.files === 1 ? "" : "s"} · <span className="text-green">+{chip.stat.plus}</span> <span className="text-red">−{chip.stat.minus}</span>
      </span>
    );
  }
  return <span className="min-w-0 flex-1 truncate font-mono text-label text-fg-muted">no changes</span>;
}

function HeadRow({ chip, now, onOpen, onMerge }: { chip: ShelfChip; now: number; onOpen: (id: string) => void; onMerge?: (id: string) => void }) {
  const sec = useRunSeconds(chip, now);
  // A head without a role is named by its title.
  const name = chip.role ?? (chip.label === chip.engine ? chip.title : chip.label);
  const note = chip.awaited ? "The lead is waiting on this head." : chip.ready ? "Finished. Its changes can be merged." : chip.state === "failed" ? "Failed." : chip.state === "running" ? "Working." : "Finished.";
  return (
    <div className={cn("flex h-6 items-center rounded-md transition-colors hover:bg-hover", chip.state === "done" && !chip.ready && "opacity-80")}>
      <Tooltip
        panel
        side="top"
        label={
          <span className="block max-w-[260px] space-y-1">
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] font-semibold">{name}</span>
              <span className="font-mono text-label text-fg-muted">{chip.engine}</span>
            </span>
            <span className="block text-xs text-fg-muted">{chip.title}</span>
            <span className={cn("block text-label", chip.awaited ? "text-amber" : "text-fg-muted")}>{note}</span>
          </span>
        }
      >
        <button data-shelf-head={chip.id} onClick={() => onOpen(chip.id)} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left outline-none focus-visible:bg-hover">
          <Mark chip={chip} />
          <span className="w-16 shrink-0 truncate text-xs font-medium text-fg">{name}</span>
          <Line chip={chip} />
          {sec != null && <span className="shrink-0 font-mono text-label tabular-nums text-fg-muted">{formatElapsed(sec)}</span>}
        </button>
      </Tooltip>
      {chip.ready && onMerge && (
        <button data-shelf-merge={chip.id} onClick={() => onMerge(chip.id)} title="Merge this head's changes" className="mr-1 h-5 shrink-0 rounded px-1.5 text-xs font-medium text-fg outline-none transition-colors hover:bg-active focus-visible:bg-active active:scale-[0.97]">
          Merge
        </button>
      )}
    </div>
  );
}

/** The rail itself: the status slot owns where it sits and how it animates in and out. Null when there is no head to show. */
export function HydraRail({ shelf, onOpenHead, onMergeHead }: { shelf: ShelfModel; onOpenHead: (id: string) => void; onMergeHead?: (id: string) => void }) {
  const now = useNow(shelf.heads.some((h) => h.state === "running"));
  if (shelf.heads.length === 0) return null;
  const done = shelf.heads.filter((h) => h.state === "done").length;
  return (
    <div data-shelf role="group" aria-label={`Heads, ${done} of ${shelf.heads.length} done`} className="max-h-[132px] overflow-y-auto rounded-t-xl border border-b-0 border-line bg-raised p-1.5">
      {shelf.heads.map((h) => (
        <HeadRow key={h.id} chip={h} now={now} onOpen={onOpenHead} onMerge={onMergeHead} />
      ))}
    </div>
  );
}
