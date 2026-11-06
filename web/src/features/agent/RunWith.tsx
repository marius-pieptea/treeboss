/**
 * "Run with": the one place that decides WHO runs a session, for a new session and an open one alike.
 *
 * Two exclusive choices, as tabs of one popover: a Harness (engine, model, effort) or a Hydra pair (a lead with
 * heads). Picking a pair makes its lead the session's engine, model and effort, so the two can never disagree;
 * picking a harness thing clears the pair. The pieces here are presentational: the composer (new session) and the
 * session chip (open session) bring the behaviour.
 */
import { useEffect, type ReactNode } from "react";
import { ArrowRight, Check, Network, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUi } from "@/lib/store";
import type { Pair } from "@/lib/types";
import { EngineIcon, ModelIcon } from "@/components/ui/engine-icon";
import { headsSummary, pairChipNames, pairSides } from "./composer-logic";

export type RunTab = "harness" | "hydra";

/** A pair's chip: the lead's mark, the arrow (violet, the Hydra signal), the heads' mark. Names only when the marks cannot tell the sides apart, and only when wide. */
export function PairChipInner({ pair }: { pair: Pair }) {
  const { lead, heads } = pairSides(pair);
  const names = pairChipNames(pair);
  return (
    <>
      <ModelIcon model={lead.model} engine={lead.engine} className="size-3.5" />
      <ArrowRight className="size-3 shrink-0 text-violet" aria-hidden />
      <ModelIcon model={heads.model} engine={heads.engine} className="size-3.5" />
      {names && <span className="hidden truncate font-mono text-xs @[460px]:inline">{`${names[0]} › ${names[1]}`}</span>}
    </>
  );
}

export function RunTabs({ tab, setTab, hasPair, children }: { tab: RunTab; setTab: (t: RunTab) => void; hasPair: boolean; children: ReactNode }) {
  return (
    <div data-run-with>
      <div role="tablist" aria-label="Run with" className="mb-1.5 grid grid-cols-2 gap-0.5 rounded-lg bg-raised p-0.5 text-[11.5px]">
        {(
          [
            ["harness", "Harness", null],
            ["hydra", "Hydra", <Network key="i" className="size-3" />],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-run-tab={id}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn("flex h-6 items-center justify-center gap-1 rounded-md outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent/60", tab === id ? (id === "hydra" ? "bg-violet/15 text-violet" : "bg-panel text-fg shadow-sm") : "text-fg-muted hover:text-fg")}
          >
            {icon}
            {label}
            {id === "hydra" && hasPair && <span className="size-1.5 rounded-full bg-violet" />}
            {id === "harness" && !hasPair && <span className="size-1.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

/**
 * The pairs, each with its lead and heads. `onPick("")` is "no pair". `note` can explain a row that needs more than a
 * click (a pair whose lead runs on another engine).
 */
export function PairList({ pairs, selectedId, onPick, note, disabled, refetch }: { pairs: Pair[]; selectedId: string; onPick: (id: string) => void; note?: (p: Pair) => string | null; disabled?: boolean; refetch?: () => unknown }) {
  // The list may have changed elsewhere (the CLI, another tab): look at the daemon's current one when it opens.
  useEffect(() => void refetch?.(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const row = "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] outline-none hover:bg-active focus-visible:bg-active disabled:opacity-50";
  return (
    <div data-pair-list>
      <button type="button" disabled={disabled} className={row} onClick={() => onPick("")}>
        <Check className={cn("mt-0.5 size-3.5 shrink-0 text-accent", selectedId && "opacity-0")} />
        <span className="flex-1">No pair</span>
        <span className="text-[10px] text-fg-faint">single agent</span>
      </button>
      <div className="max-h-[260px] overflow-y-auto">
        {pairs.map((p) => {
          const n = note?.(p) ?? null;
          return (
            <button key={p.id} type="button" disabled={disabled} data-pair-option={p.id} className={row} onClick={() => onPick(p.id)}>
              <Check className={cn("mt-0.5 size-3.5 shrink-0 text-violet", selectedId !== p.id && "opacity-0")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{p.title}</span>
                <span className="flex items-center gap-1 truncate font-mono text-[10.5px] text-fg-muted">
                  <EngineIcon engine={p.lead_engine ?? ""} className="!size-3" />
                  lead {p.lead_model && p.lead_model !== "default" ? p.lead_model : (p.lead_engine ?? "default")}
                  {p.lead_effort ? ` @${p.lead_effort}` : ""}
                </span>
                <span className="block truncate font-mono text-[10.5px] text-fg-faint">
                  heads {headsSummary(p)}
                  {p.mode === "heads" && p.max_heads ? ` ×${p.max_heads}` : ""}
                </span>
                {n && <span className="mt-0.5 block text-[10.5px] leading-snug text-amber">{n}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {pairs.length === 0 && <div className="px-2 py-2 text-xs text-fg-muted">No pairs yet. A pair is a lead model with heads that do the work.</div>}
      <div className="mt-1 border-t border-line pt-1">
        <button type="button" className={row} onClick={() => useUi.getState().openTab({ kind: "settings", page: "pairs", title: "Hydra pairs" })}>
          <Settings2 className="mt-0.5 size-3.5 shrink-0 text-fg-faint" />
          Manage pairs…
        </button>
      </div>
    </div>
  );
}
