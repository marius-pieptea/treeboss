import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ask, confirm } from "@/components/ui/dialogs";
import { DropdownMenu } from "@/components/ui/overlay";
import { Input } from "@/components/ui/form";
import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Actions, RoadmapItem, RoadmapLane } from "./data";
import { AddInline } from "./AddInline";
import { ItemCard } from "./ItemCard";
import { dropIndex, isNoopMove, neighborLane, progressPct } from "./logic";

interface Drag {
  key: string;
  item: RoadmapItem;
  sx: number;
  sy: number;
  x: number;
  y: number;
  ox: number;
  oy: number;
  w: number;
  active: boolean;
  overLane: string | null;
  slot: number;
}

const laneHint = (l: RoadmapLane) => `${l.progress.shipped}/${l.progress.items} shipped${l.progress.tasksTotal ? ` · ${l.progress.tasksDone}/${l.progress.tasksTotal} tasks` : ""}`;

export function Board({
  lanes,
  allLanes,
  filtering,
  selected,
  actions,
  adding,
  onAdding,
  onOpen,
  onSession,
  optimistic,
}: {
  lanes: RoadmapLane[];
  allLanes: RoadmapLane[];
  filtering: boolean;
  selected: string | null;
  actions: Actions;
  adding: string | null;
  onAdding: (lane: string | null) => void;
  onOpen: (key: string) => void;
  onSession: (id: string) => void;
  optimistic: (key: string, lane: string, index: number | null) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const focusKey = useRef<string | null>(null);
  const [addingLane, setAddingLane] = useState(false);

  // After a keyboard move the card re-renders somewhere else: bring focus along.
  useLayoutEffect(() => {
    if (!focusKey.current) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(focusKey.current)}"]`);
    el?.focus({ preventScroll: false });
    focusKey.current = null;
  });

  const move = (item: RoadmapItem, lane: string, index: number | null) => {
    focusKey.current = item.key;
    optimistic(item.key, lane, index);
    actions.move.mutate({ key: item.key, lane, index });
  };

  const track = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.active && Math.hypot(d.x - d.sx, d.y - d.sy) > 5) d.active = true;
    if (d.active) {
      const hit = document.elementsFromPoint(d.x, d.y).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.lane !== undefined);
      d.overLane = hit?.dataset.lane ?? null;
      if (hit) {
        const mids = [...hit.querySelectorAll<HTMLElement>("[data-card]")].filter((c) => c.dataset.card !== d.key).map((c) => {
          const r = c.getBoundingClientRect();
          return r.top + r.height / 2;
        });
        d.slot = dropIndex(mids, d.y);
      }
      // Near the left or right edge of the board: keep it moving.
      const box = scroller.current?.getBoundingClientRect();
      if (box && scroller.current) {
        if (d.x < box.left + 48) scroller.current.scrollLeft -= 16;
        else if (d.x > box.right - 48) scroller.current.scrollLeft += 16;
      }
    }
    setDrag({ ...d });
  };

  const finish = (commit: boolean) => {
    const d = dragRef.current;
    window.removeEventListener("pointermove", track);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    dragRef.current = null;
    setDrag(null);
    if (!d?.active) return;
    // The click that ends a drag is not a click on the card.
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    if (!commit || !d.overLane) return;
    if (filtering) {
      // The visible slot is not the file's slot: only a change of lane makes sense, and it goes to the end.
      if (d.overLane !== d.item.lane) move(d.item, d.overLane, null);
      return;
    }
    // `slot` counts the other cards above the pointer, which is exactly the index the server wants.
    if (isNoopMove(d.item, d.overLane, d.slot)) return;
    move(d.item, d.overLane, d.slot);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      finish(false);
    }
  };
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    },
    [],
  );

  const begin = (e: React.PointerEvent, item: RoadmapItem) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,a,input,textarea,select")) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = { key: item.key, item, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, active: false, overLane: null, slot: 0 };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  const keys = (e: React.KeyboardEvent, item: RoadmapItem, lane: RoadmapLane) => {
    if ((e.target as HTMLElement).closest("input,textarea,select")) return;
    if (e.key === "Enter" || e.key === " ") {
      if ((e.target as HTMLElement).closest("button") && e.target !== e.currentTarget) return;
      e.preventDefault();
      onOpen(item.key);
      return;
    }
    if (!e.altKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const to = neighborLane(allLanes, item.lane, e.key === "ArrowLeft" ? -1 : 1);
      if (to) move(item, to, null);
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !filtering) {
      e.preventDefault();
      const to = item.index + (e.key === "ArrowUp" ? -1 : 1);
      if (to >= 0 && to < lane.items.length) move(item, item.lane, to);
    }
  };

  const renameLane = async (l: RoadmapLane) => {
    const to = await ask({ title: "Rename lane", initial: l.name, confirmLabel: "Rename", validate: (v) => (v.trim() ? null : "A lane needs a name.") });
    if (to && to.trim() !== l.name) actions.renameLane.mutate({ from: l.name, to: to.trim() });
  };
  const deleteLane = async (l: RoadmapLane) => {
    if (l.items.length) return toast.info(`"${l.name}" still has ${l.items.length} item${l.items.length === 1 ? "" : "s"}. Move or delete them first.`);
    if (await confirm({ title: `Delete lane "${l.name}"?`, description: "Only the heading is removed from ROADMAP.md.", confirmLabel: "Delete", danger: true })) actions.removeLane.mutate(l.name);
  };

  return (
    <div ref={scroller} data-roadmap-board className="flex h-full min-h-0 gap-3 overflow-x-auto overflow-y-hidden px-4 pb-3 pt-3">
      {lanes.map((lane) => {
        const over = drag?.active && drag.overLane === lane.name;
        let n = 0;
        const out: React.ReactNode[] = [];
        for (const it of lane.items) {
          const isDragged = drag?.active && drag.key === it.key;
          if (over && !isDragged && n === drag!.slot) out.push(<DropLine key="drop" />);
          out.push(
            <ItemCard
              key={it.key}
              item={it}
              selected={selected === it.key}
              dragging={!!isDragged}
              onOpen={() => !suppressClick.current && onOpen(it.key)}
              onToggle={() => actions.update.mutate({ key: it.key, patch: { done: !it.done } })}
              onShift={(dir) => {
                const to = neighborLane(allLanes, it.lane, dir);
                if (to) move(it, to, null);
              }}
              onSession={onSession}
              onPointerDown={(e) => begin(e, it)}
              onKeyDown={(e) => keys(e, it, lane)}
            />,
          );
          if (!isDragged) n++;
        }
        if (over && n === drag!.slot) out.push(<DropLine key="drop" />);
        const pct = lane.progress.items ? Math.round((lane.progress.shipped / lane.progress.items) * 100) : 0;
        return (
          <section key={lane.name} data-lane={lane.name} aria-label={`${lane.name} lane`} className={cn("flex w-[288px] shrink-0 flex-col rounded-xl border bg-raised/60 transition-colors duration-150", over ? "border-accent/50 bg-accent-soft/40" : "border-line")}>
            <header className="flex items-center gap-1.5 px-3 pb-1.5 pt-2.5">
              <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-fg">{lane.name}</h3>
              <span className="rounded bg-active px-1.5 font-mono text-[10px] tabular-nums text-fg-muted" title={laneHint(lane)}>
                {lane.items.length}
              </span>
              <DropdownMenu
                align="end"
                trigger={<IconButton label={`${lane.name} lane options`} size="icon-sm" data-lane-menu><MoreHorizontal /></IconButton>}
                entries={[
                  { label: "Add item", icon: <Plus />, onSelect: () => onAdding(lane.name) },
                  { label: "Rename lane", icon: <Pencil />, onSelect: () => void renameLane(lane) },
                  { separator: true },
                  { label: "Delete lane", icon: <Trash2 />, danger: true, disabled: lane.items.length > 0, onSelect: () => void deleteLane(lane) },
                ]}
              />
            </header>
            {lane.progress.items > 0 && (
              <div className="px-3 pb-2" title={laneHint(lane)}>
                <div className="h-0.5 overflow-hidden rounded-full bg-active">
                  <div className="h-full rounded-full bg-green transition-[width] duration-200" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1 flex justify-between font-mono text-[10px] text-fg-faint">
                  <span>{lane.progress.shipped}/{lane.progress.items} shipped</span>
                  {lane.progress.tasksTotal > 0 && <span>{progressPct({ done: lane.progress.tasksDone, total: lane.progress.tasksTotal })}% of tasks</span>}
                </div>
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-1.5">
              {out}
              {lane.items.length === 0 && !over && <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-fg-faint">{filtering ? "Nothing matches" : "Nothing here yet"}</div>}
            </div>
            <div className="p-1.5 pt-0.5">
              <AddInline open={adding === lane.name} onOpenChange={(o) => onAdding(o ? lane.name : null)} busy={actions.add.isPending} onAdd={(title) => actions.add.mutateAsync({ lane: lane.name, title }).catch(() => {})} />
            </div>
          </section>
        );
      })}
      <div className="w-[200px] shrink-0 pt-0.5">
        {addingLane ? (
          <LaneInput
            onDone={(name) => {
              setAddingLane(false);
              if (name) actions.addLane.mutate(name);
            }}
          />
        ) : (
          <button type="button" data-roadmap-add-lane onClick={() => setAddingLane(true)} className="flex h-9 w-full items-center gap-1.5 rounded-xl border border-dashed border-line px-3 text-[12px] text-fg-faint outline-none transition-colors hover:border-line-strong hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-accent/40">
            <Plus className="size-3.5" />
            Add lane
          </button>
        )}
      </div>
      {drag?.active && createPortal(<div style={{ position: "fixed", left: drag.x - drag.ox, top: drag.y - drag.oy, width: drag.w, zIndex: 120 }}><ItemCard item={drag.item} preview /></div>, document.body)}
    </div>
  );
}

function DropLine() {
  return <div data-drop-indicator className="-my-0.5 h-1 shrink-0 animate-pop rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />;
}

function LaneInput({ onDone }: { onDone: (name: string | null) => void }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Input
      ref={ref}
      value={v}
      placeholder="Lane name, Enter to add"
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(v.trim() || null);
        else if (e.key === "Escape") onDone(null);
      }}
      onBlur={() => onDone(v.trim() || null)}
      className="h-9 text-[12.5px] animate-slide-up"
    />
  );
}
