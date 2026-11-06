import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { RoadmapItem, RoadmapLane } from "./data";
import { progressPct, timelineLayout } from "./logic";

const BAR_H = 24;
const GAP = 4;
const BAND_PAD = 6;
const LABEL_W = 112;

const BAR: Record<RoadmapItem["status"], string> = {
  shipped: "border-green/50 bg-green/15 text-fg",
  in_progress: "border-accent/60 bg-accent-soft text-fg",
  not_started: "border-line-strong bg-raised text-fg",
};

export function Timeline({ lanes, selected, onOpen, now }: { lanes: RoadmapLane[]; selected: string | null; onOpen: (key: string) => void; now?: number }) {
  const t = useMemo(() => timelineLayout(lanes, now), [lanes, now]);
  const unscheduled = t.bands.flatMap((b) => b.unscheduled.map((it) => ({ it, lane: b.lane })));
  const minWidth = Math.max(640, t.months.length * 76);
  return (
    <div data-roadmap-timeline className="h-full overflow-auto px-4 py-3">
      <div className="mx-auto" style={{ minWidth: LABEL_W + minWidth }}>
        {/* Axis */}
        <div className="sticky top-0 z-10 flex bg-panel/95 backdrop-blur">
          <div style={{ width: LABEL_W }} className="shrink-0" />
          <div className="relative flex-1">
            <div className="relative h-5 border-b border-line">
              {t.quarters.map((q) => (
                <div key={q.label} style={{ left: `${q.left}%`, width: `${q.width}%` }} className="absolute top-0 flex h-5 items-center border-l border-line-strong pl-1.5 font-mono text-[10px] font-semibold text-fg-muted">
                  {q.label}
                </div>
              ))}
            </div>
            <div className="relative h-5 border-b border-line">
              {t.months.map((m) => (
                <div key={`${m.year}-${m.month}`} style={{ left: `${m.left}%`, width: `${m.width}%` }} className="absolute top-0 flex h-5 items-center border-l border-line pl-1.5 font-mono text-[10px] text-fg-faint">
                  {m.label}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bands */}
        {t.bands.map((band) => {
          const h = band.rows * (BAR_H + GAP) + BAND_PAD * 2 - GAP;
          return (
            <div key={band.lane} data-band={band.lane} className="flex border-b border-line">
              <div style={{ width: LABEL_W }} className="shrink-0 py-2 pr-2 text-[12px] font-semibold text-fg">
                {band.lane}
                <div className="font-mono text-[10px] font-normal text-fg-faint">{band.bars.length} scheduled</div>
              </div>
              <div className="relative flex-1" style={{ height: h }}>
                {t.months.map((m) => (
                  <div key={`${m.year}-${m.month}`} style={{ left: `${m.left}%` }} className="absolute inset-y-0 border-l border-line/60" />
                ))}
                {t.today !== null && <div data-today style={{ left: `${t.today}%` }} className="absolute inset-y-0 z-[1] w-px bg-accent/70" />}
                {band.bars.map((b) => {
                  const pct = progressPct(b.item.progress);
                  return (
                    <button
                      key={b.item.key}
                      type="button"
                      data-bar={b.item.key}
                      title={`${b.item.title}\n${b.span.label}${b.item.progress?.hasTasks ? `\n${b.item.progress.done}/${b.item.progress.total} tasks` : ""}`}
                      onClick={() => onOpen(b.item.key)}
                      style={{ left: `${b.left}%`, width: `${b.width}%`, top: BAND_PAD + b.row * (BAR_H + GAP), height: BAR_H }}
                      className={cn("absolute z-[2] overflow-hidden rounded-md border px-1.5 text-left text-[11.5px] font-medium outline-none transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-pop focus-visible:ring-2 focus-visible:ring-accent/50 animate-slide-up", BAR[b.item.status], selected === b.item.key && "ring-2 ring-accent/70", b.item.done && "line-through decoration-fg-faint/60")}
                    >
                      {b.item.progress?.hasTasks && <span aria-hidden className="absolute inset-y-0 left-0 bg-accent/20" style={{ width: `${pct}%` }} />}
                      <span className="relative block truncate leading-[22px]">{b.item.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Unscheduled */}
        <div data-band="unscheduled" className="flex pt-2">
          <div style={{ width: LABEL_W }} className="shrink-0 pr-2 text-[12px] font-semibold text-fg-muted">
            Unscheduled
            <div className="font-mono text-[10px] font-normal text-fg-faint">{unscheduled.length} without a target</div>
          </div>
          <div className="flex flex-1 flex-wrap gap-1.5 pb-2">
            {unscheduled.map(({ it, lane }) => (
              <button key={it.key} type="button" data-chip={it.key} onClick={() => onOpen(it.key)} className={cn("flex max-w-[260px] items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] outline-none transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent/50", selected === it.key ? "border-accent/60 bg-accent-soft/50" : "border-line bg-panel", it.done && "text-fg-muted line-through decoration-fg-faint/60")}>
                <span className="truncate">{it.title}</span>
                <span className="shrink-0 font-mono text-[9.5px] text-fg-faint">{lane}</span>
              </button>
            ))}
            {unscheduled.length === 0 && <span className="py-1 text-[11.5px] text-fg-faint">Every item has a target.</span>}
          </div>
        </div>
        {t.unreadable.length > 0 && (
          <p className="mt-1 text-[11.5px] text-amber" data-unreadable>
            Cannot read {t.unreadable.map((u) => `"${u}"`).join(", ")} as a date. Use 2026-Q4, 2026-11 or 2026-11-15.
          </p>
        )}
      </div>
    </div>
  );
}
