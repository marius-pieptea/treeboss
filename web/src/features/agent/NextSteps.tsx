/**
 * The agent's suggested follow-ups for the latest finished turn: a row of small chips above the composer. A click
 * puts the message in the box (it does not send), so it can be edited first. The row is gone once the user types.
 *
 * An opportunity chip (something the agent noticed while working, not the obvious continuation) also offers
 * "Implement in a fork": a new isolated session from the end of the turn that suggested it, so the tangent does not
 * pull this thread off its goal. A chevron on the chip opens the menu; right-click opens the same one.
 */
import { useMemo } from "react";
import { ChevronDown, CornerDownLeft, GitFork, Sparkles } from "lucide-react";
import type { TurnRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ContextMenu, DropdownMenu, type MenuEntry } from "@/components/ui/overlay";
import { useActions } from "@/features/checkpoints/ThreadActions";

export interface NextStep {
  label: string;
  prompt: string;
  /** An improvement the agent noticed while working, not the obvious continuation. */
  opp?: boolean;
}

/** The steps stored on a turn row (JSON text); anything malformed is none. */
export function stepsOf(turn: Pick<TurnRow, "next_json" | "status"> | undefined | null): NextStep[] {
  if (!turn?.next_json || turn.status !== "completed") return [];
  try {
    const v = JSON.parse(turn.next_json);
    return Array.isArray(v) ? v.filter((s): s is NextStep => typeof s?.label === "string" && typeof s?.prompt === "string").slice(0, 3) : [];
  } catch {
    return [];
  }
}

/** The brief a fork gets for a chip: only this, apart from what the thread was doing. */
export const forkBrief = (prompt: string): string => `Do only this one thing, separate from the original task. Do not continue the earlier work: ${prompt}`;

const chipClass = "flex min-w-0 items-center gap-1 outline-none";

export function NextSteps({ turn, hidden, onPick }: { turn: TurnRow | undefined; hidden: boolean; onPick: (text: string) => void }) {
  const steps = useMemo(() => stepsOf(turn), [turn]);
  const actions = useActions();
  if (hidden || !steps.length) return null;
  return (
    <div key={turn?.id} role="group" aria-label="Suggested next steps" className="flex shrink-0 animate-slide-up flex-wrap gap-1.5 px-3 pb-1.5">
      {steps.map((s) => {
        const fork = s.opp && actions && turn ? actions.forkFor(turn.id) : null;
        const entries: MenuEntry[] = fork && turn && actions ? [{ label: "Implement in a fork", icon: <GitFork />, disabled: !fork.enabled || actions.busy, onSelect: () => actions.fork(turn.id, forkBrief(s.prompt)) }] : [];
        const pill = (
          <div className="group flex max-w-full items-center rounded-full border border-line text-xs text-fg-muted transition-colors focus-within:border-accent/60 hover:border-line-strong hover:bg-hover hover:text-fg">
            <button onClick={() => onPick(s.prompt)} title={s.opp ? `Noticed while working: ${s.prompt}` : s.prompt} className={cn(chipClass, "py-1 pl-2.5", entries.length ? "pr-1" : "pr-2.5")}>
              {s.opp && <Sparkles className="size-3 shrink-0 text-accent" aria-label="Noticed while working" />}
              <span className="truncate">{s.label}</span>
              {!entries.length && <CornerDownLeft className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 group-focus-within:opacity-60" />}
            </button>
            {entries.length > 0 && (
              <DropdownMenu
                side="top"
                trigger={
                  <button aria-label="More actions" title={fork && !fork.enabled ? fork.label : "More actions"} className={cn(chipClass, "rounded-r-full py-1 pl-0.5 pr-2 text-fg-faint hover:text-fg")}>
                    <ChevronDown className="size-3 shrink-0" />
                  </button>
                }
                entries={entries}
              />
            )}
          </div>
        );
        return (
          <ContextMenu key={s.label} entries={entries}>
            {pill}
          </ContextMenu>
        );
      })}
    </div>
  );
}
