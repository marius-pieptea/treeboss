import { AlertTriangle, ArrowLeft, ArrowRight, Check, FileText, Layers } from "lucide-react";
import { Badge, StatusDot } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import type { RoadmapItem } from "./data";
import { liveSessions, parseTarget, progressPct, STATUS_LABEL } from "./logic";

/** The round tick at the left of a card or row: click to ship or reopen. */
export function DoneToggle({ item, onToggle, className }: { item: RoadmapItem; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={item.done}
      aria-label={item.done ? `Reopen ${item.title}` : `Mark ${item.title} as shipped`}
      data-roadmap-done
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn("mt-px flex size-4 shrink-0 items-center justify-center rounded-full border outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-accent/50", item.done ? "border-green bg-green text-white" : "border-line-strong text-transparent hover:border-green hover:text-green/60", className)}
    >
      <Check className={cn("size-2.5 transition-transform", item.done ? "scale-100" : "scale-75")} strokeWidth={3} />
    </button>
  );
}

export function SpecBar({ item, className }: { item: RoadmapItem; className?: string }) {
  const p = item.progress;
  if (!p) return null;
  const pct = progressPct(p);
  return (
    <div className={cn("flex items-center gap-1.5", className)} title={p.hasTasks ? `${p.done} of ${p.total} spec tasks done` : "The spec has no tasks yet"}>
      <div className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-active">
        <div className={cn("h-full rounded-full transition-[width] duration-200", pct === 100 ? "bg-green" : "bg-accent")} style={{ width: `${p.hasTasks ? Math.max(pct, p.done ? 4 : 0) : 0}%` }} />
      </div>
      <span className="font-mono text-[10px] tabular-nums text-fg-faint">{p.hasTasks ? `${p.done}/${p.total}` : "no tasks"}</span>
    </div>
  );
}

export function SessionDots({ item, onOpen, max = 3 }: { item: RoadmapItem; onOpen?: (id: string) => void; max?: number }) {
  if (!item.sessions.length) return null;
  const shown = item.sessions.slice(0, max);
  return (
    <span className="flex items-center gap-1" data-roadmap-sessions>
      {shown.map((s) => (
        <Tooltip key={s.id} label={`${s.kind === "spec" ? "Spec" : "Build"}: ${s.title} (${s.status})`}>
          <button type="button" data-session-dot={s.status} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), onOpen?.(s.id))} className="flex size-3.5 items-center justify-center rounded-full outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50">
            <StatusDot status={s.status} size={6} />
          </button>
        </Tooltip>
      ))}
      {item.sessions.length > max && <span className="font-mono text-[10px] text-fg-faint">+{item.sessions.length - max}</span>}
    </span>
  );
}

export function LinkWarning({ item }: { item: RoadmapItem }) {
  const bad = [item.links.spec, item.links.docs].filter((l) => l && !l.ok);
  if (!bad.length) return null;
  return (
    <Tooltip label={bad.map((l) => `${l!.value}: ${l!.reason}`).join("\n")}>
      <span data-roadmap-broken className="flex items-center gap-0.5 text-amber">
        <AlertTriangle className="size-3" />
      </span>
    </Tooltip>
  );
}

export function TargetChip({ target }: { target: string | null }) {
  if (!target) return null;
  const span = parseTarget(target);
  return (
    <Badge tone={span ? "neutral" : "amber"} title={span ? span.label : `Cannot read "${target}" as a date, month or quarter`}>
      {target}
    </Badge>
  );
}

export function ItemCard({
  item,
  selected,
  dragging,
  preview,
  onOpen,
  onToggle,
  onShift,
  onSession,
  onPointerDown,
  onKeyDown,
}: {
  item: RoadmapItem;
  selected?: boolean;
  dragging?: boolean;
  /** Rendered as the floating copy while dragging. */
  preview?: boolean;
  onOpen?: () => void;
  onToggle?: () => void;
  onShift?: (dir: -1 | 1) => void;
  onSession?: (id: string) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const live = liveSessions(item);
  return (
    <div
      data-card={item.key}
      data-status={item.status}
      role="button"
      tabIndex={preview ? -1 : 0}
      aria-label={`${item.title}, ${STATUS_LABEL[item.status]}`}
      aria-pressed={selected}
      onClick={onOpen}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        "group relative flex touch-none select-none flex-col gap-1.5 rounded-lg border bg-panel px-2.5 py-2 text-left outline-none transition-[border-color,box-shadow,opacity,transform] duration-150",
        selected ? "border-accent/60 shadow-[0_0_0_1px_var(--accent)]" : "border-line hover:border-line-strong",
        "focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/30",
        item.done && "opacity-70",
        dragging && "opacity-30",
        preview && "pointer-events-none rotate-[1.2deg] border-accent/60 opacity-95 shadow-pop",
        !preview && "cursor-grab active:cursor-grabbing",
      )}
    >
      <div className="flex items-start gap-2">
        <DoneToggle item={item} onToggle={onToggle ?? (() => {})} />
        <div className={cn("min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-fg [overflow-wrap:anywhere]", item.done && "text-fg-muted line-through decoration-fg-faint/60")}>{item.title}</div>
        {live > 0 && (
          <Badge tone="accent" title={`${live} session${live === 1 ? "" : "s"} working on this`}>
            <span className="size-1.5 animate-pulse-dot rounded-full bg-accent" />
            {live}
          </Badge>
        )}
      </div>
      {(item.tags.length > 0 || item.target) && (
        <div className="flex flex-wrap items-center gap-1 pl-6">
          {item.tags.map((t) => (
            <Badge key={t} tone="violet">
              {t}
            </Badge>
          ))}
          <TargetChip target={item.target} />
        </div>
      )}
      {item.progress && <SpecBar item={item} className="pl-6" />}
      <div className="flex items-center gap-2 pl-6 text-fg-faint">
        <span className="font-mono text-[10px]">{item.id ?? "·"}</span>
        {item.spec && (
          <Tooltip label={item.links.spec?.ok ? `Spec: ${item.links.spec.path}` : `Spec: ${item.spec}`}>
            <span className={cn("flex items-center gap-0.5 text-[10px]", item.links.spec && !item.links.spec.ok && "text-amber")}>
              <Layers className="size-3" />
            </span>
          </Tooltip>
        )}
        {item.docs && (
          <Tooltip label={`Docs: ${item.docs}`}>
            <span className={cn("flex items-center gap-0.5 text-[10px]", item.links.docs && !item.links.docs.ok && "text-amber")}>
              <FileText className="size-3" />
            </span>
          </Tooltip>
        )}
        <LinkWarning item={item} />
        <SessionDots item={item} onOpen={onSession} />
        <span className="flex-1" />
        {onShift && (
          <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <button type="button" aria-label="Move to the previous lane" data-roadmap-shift="-1" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), onShift(-1))} className="flex size-5 items-center justify-center rounded hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50">
              <ArrowLeft className="size-3" />
            </button>
            <button type="button" aria-label="Move to the next lane" data-roadmap-shift="1" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), onShift(1))} className="flex size-5 items-center justify-center rounded hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50">
              <ArrowRight className="size-3" />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
