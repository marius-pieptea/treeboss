import { cn } from "@/lib/utils";
import { useDragResize } from "@/lib/hooks";
import { useUi } from "@/lib/store";

/** A drag handle between panes. `invert` for panes anchored to the right or bottom. */
export function Splitter({ axis, value, min, max, onChange, invert, className, onDoubleClick }: { axis: "x" | "y"; value: number; min: number; max: number; onChange: (px: number) => void; invert?: boolean; className?: string; onDoubleClick?: () => void }) {
  const { dragging, handlers } = useDragResize({ axis, invert, value, min, max, onChange });
  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onDoubleClick={onDoubleClick}
      {...handlers}
      className={cn("group relative z-20 shrink-0 touch-none", axis === "x" ? "w-px cursor-col-resize" : "h-px cursor-row-resize", className)}
    >
      <div className={cn("absolute bg-line transition-colors", axis === "x" ? "inset-y-0 left-0 w-px" : "inset-x-0 top-0 h-px", dragging ? "!bg-accent" : "group-hover:bg-accent/70")} />
      {/* A fat invisible hit area: a 1px line is impossible to grab. */}
      <div className={cn("absolute", axis === "x" ? "inset-y-0 -left-1.5 w-3" : "inset-x-0 -top-1.5 h-3")} />
      {dragging && <div className="fixed inset-0 z-50" style={{ cursor: axis === "x" ? "col-resize" : "row-resize" }} />}
    </div>
  );
}

/** The persisted width of an in-page pane. */
export function usePaneWidth(key: string, fallback: number) {
  return useUi((s) => s.panes[key] ?? fallback);
}

/** A Splitter that stores its width under `paneKey`; read it back with usePaneWidth. Double-click resets. */
export function PaneSplitter({ paneKey, fallback, min, max, invert, className }: { paneKey: string; fallback: number; min: number; max: number; invert?: boolean; className?: string }) {
  const value = usePaneWidth(paneKey, fallback);
  const setPane = useUi((s) => s.setPane);
  return <Splitter axis="x" invert={invert} value={value} min={min} max={max} onChange={(v) => setPane(paneKey, v)} onDoubleClick={() => setPane(paneKey, fallback)} className={className} />;
}
