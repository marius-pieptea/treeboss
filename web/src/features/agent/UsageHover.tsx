import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { Tooltip } from "@/components/ui/overlay";
import { EngineIcon } from "@/components/ui/engine-icon";
import { get } from "@/lib/api";
import { limitsKey, useLimits } from "@/lib/limits";
import { ago, exposesLimits, orderedWindows, remainingOf, ringWindows, usageEmptyCopy, usageTone, windowView, type EngineLimits, type LimitWindow, type UsageRing, type UsageTone } from "@/lib/limits-logic";
import { useEngines } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** The reset countdown is in minutes, so a half-minute tick keeps it current. */
function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

const TONE_STROKE: Record<UsageTone, string> = { neutral: "stroke-green", warning: "stroke-amber", critical: "stroke-red" };
const TONE_FILL: Record<UsageTone, string> = { neutral: "bg-green", warning: "bg-amber", critical: "bg-red" };

/** Two tracks in a 32px box, 4px between their centers. The outer ring is the longest window. */
const RING = { size: 32, stroke: 2, gap: 4 };

function Rings({ rings }: { rings: UsageRing[] }) {
  const outer = (RING.size - RING.stroke) / 2;
  const c = RING.size / 2;
  return (
    <svg className="pointer-events-none absolute inset-1 -rotate-90" viewBox={`0 0 ${RING.size} ${RING.size}`} fill="none" aria-hidden>
      {rings.map((ring, index) => {
        const r = outer - index * RING.gap;
        return (
          <g key={ring.id}>
            <circle cx={c} cy={c} r={r} strokeWidth={RING.stroke} className="stroke-fg-faint opacity-20" />
            {ring.left !== null && ring.left > 0 && (
              <circle cx={c} cy={c} r={r} strokeWidth={RING.stroke} strokeLinecap="round" pathLength={100} strokeDasharray={`${ring.left} 100`} className={TONE_STROKE[ring.tone]} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function WindowRow({ w, now }: { w: LimitWindow; now: number }) {
  const view = windowView(w, now);
  const tone = usageTone(view.used === null ? null : w.percent, w.status);
  const left = view.used === null ? null : remainingOf(view.used);
  const limited = w.status !== null && w.status !== "allowed";
  const label = `${view.title}, ${view.summary}${view.reset ? `, ${view.reset}` : ""}`;
  if (left === null) {
    return <div className="col-start-2 col-span-4 text-[12px] text-fg-muted" aria-label={label}>{view.title}: {view.summary}{view.reset ? ` · ${view.reset}` : ""}</div>;
  }
  return (
    <div className="col-start-2 col-span-4 grid grid-cols-subgrid items-center" aria-label={label}>
      <span className="truncate text-[12px] text-fg-muted">
        {view.title}
        {limited && <span className="text-fg"> · {w.status}</span>}
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-line" aria-hidden>
        <span className={cn("block h-full rounded-full", TONE_FILL[tone])} style={{ width: `${left}%` }} />
      </span>
      <strong className="text-right font-mono text-[12px] font-semibold tabular-nums text-fg" title={view.summary}>{left}%</strong>
      <span className="text-right font-mono text-[11px] text-fg-muted" title={view.reset || undefined}>{view.reset.replace(/^resets in /, "")}</span>
    </div>
  );
}

/** One provider's plan windows: what is left of each, and when it resets. */
function UsageCard({ engine }: { engine: string }) {
  const q = useLimits(engine, true);
  const engines = useEngines();
  const now = useNow();
  const name = engines.data?.find((e) => e.id === engine)?.label ?? engine;
  const data = q.data;
  const windows = data ? orderedWindows(data.windows) : [];
  return (
    <div className="flex w-[344px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      <div className="flex items-center gap-2 px-1 text-[13px] font-semibold text-fg">
        <Gauge className="size-3.5 shrink-0" aria-hidden />
        Usage
      </div>
      {q.isLoading && !data && <p className="px-1 text-[12px] text-fg-muted">Reading…</p>}
      {q.error && !data && <p className="px-1 text-[12px] text-fg-muted">Could not read usage.</p>}
      {data && windows.length === 0 && <p className="px-1 text-[12px] text-fg-muted">{usageEmptyCopy(data.exposed)}</p>}
      {windows.length > 0 && (
        <div className="grid grid-cols-[auto_max-content_minmax(0,1fr)_max-content_max-content] items-center gap-x-2 gap-y-1 px-1">
          <EngineIcon engine={engine} className="size-3.5" />
          <strong className="col-span-4 truncate text-[12px] font-semibold text-fg">{name}</strong>
          {windows.map((w) => <WindowRow key={w.id} w={w} now={now} />)}
        </div>
      )}
      {data?.updated_at != null && <div className="border-t border-line px-1 pt-1.5 text-[11px] text-fg-muted">As of {ago(data.updated_at, now)}</div>}
    </div>
  );
}

function ringLabel(name: string, windows: LimitWindow[], exposed: boolean, now: number): string {
  if (!windows.length) return `${name}. ${usageEmptyCopy(exposed)}`;
  const parts = orderedWindows(windows).map((w) => {
    const view = windowView(w, now);
    return `${view.title}, ${view.summary}${view.reset ? `, ${view.reset}` : ""}`;
  });
  return `${name} usage. ${parts.join(". ")}`;
}

function UsageRingButton({ engine, name, windows, exposed }: { engine: string; name: string; windows: LimitWindow[]; exposed: boolean }) {
  const now = useNow();
  return (
    <Tooltip label={<UsageCard engine={engine} />} side="right" panel>
      <button type="button" aria-label={ringLabel(name, windows, exposed, now)} className="relative flex size-10 items-center justify-center rounded-full text-fg-muted outline-none hover:bg-hover">
        {windows.length > 0 && <Rings rings={ringWindows(windows, now)} />}
        <EngineIcon engine={engine} className="relative z-10 size-3" />
      </button>
    </Tooltip>
  );
}

/** One mark per engine installed on this machine. Rings appear only once that engine has reported windows. */
export function ProviderUsage() {
  const engines = useEngines();
  const installed = (engines.data ?? []).filter((e) => e.installed && e.id !== "fake");
  const results = useQueries({
    queries: installed.map((engine) => ({
      queryKey: limitsKey(engine.id),
      queryFn: () => get<EngineLimits>(`/api/engines/${encodeURIComponent(engine.id)}/limits`),
      staleTime: 0,
    })),
  });
  if (!installed.length) return null;
  return (
    <div role="group" aria-label="Provider usage" className="flex flex-col items-center pb-1">
      {installed.map((engine, i) => (
        <UsageRingButton key={engine.id} engine={engine.id} name={engine.label} windows={results[i]?.data?.windows ?? []} exposed={results[i]?.data?.exposed ?? exposesLimits(engine.id)} />
      ))}
    </div>
  );
}

/** Wraps an engine icon in the usage card. An engine that never reports says so instead of promising a later turn. */
export function UsageHover({ engine, children }: { engine: string; children: React.ReactNode }) {
  if (!engine) return <>{children}</>;
  return (
    <Tooltip label={<UsageCard engine={engine} />} side="top" panel>
      <span className="inline-flex">{children}</span>
    </Tooltip>
  );
}
