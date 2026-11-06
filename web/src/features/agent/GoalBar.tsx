/** The goal, above the composer: progress through the turn budget, the last check, and a Stop button. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, OctagonX, Target, X } from "lucide-react";
import { toast } from "sonner";
import { post, url } from "@/lib/api";
import { qk } from "@/lib/queries";
import type { SessionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { checkLabel, goalProgress, goalStatusLabel, goalTone, type Tone } from "./goal-logic";

const toneText: Record<Tone, string> = { accent: "text-accent", green: "text-green", amber: "text-amber", neutral: "text-fg-muted" };
const toneBar: Record<Tone, string> = { accent: "bg-accent", green: "bg-green", amber: "bg-amber", neutral: "bg-fg-faint" };

/** The goal bar, in the status slot. A finished goal stays until dismissed; the slot owns that, so it can give the slot up. */
export function GoalBar({ session, onDismiss }: { session: SessionView; onDismiss: () => void }) {
  const qc = useQueryClient();
  const g = session.goal ?? null;
  const stop = useMutation({
    mutationFn: () => post(url.session(session.id, "goal/stop")),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.session(session.id) }),
    onError: (e: Error) => toast.error("Could not stop the goal", { description: e.message }),
  });
  if (!g) return null;
  const tone = goalTone(g.status);
  const active = g.status === "active";
  const check = checkLabel(g);
  const pct = Math.round(goalProgress(g) * 100);

  return (
    <div data-goal-bar data-goal-status={g.status} className="overflow-hidden rounded-lg border border-line bg-raised">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
        {g.status === "met" ? <Check className="size-3.5 shrink-0 text-green" /> : <Target className={cn("size-3.5 shrink-0", toneText[tone], active && session.status === "running" && "animate-pulse")} />}
        <span className="min-w-0 flex-1 truncate text-fg" title={g.text}>
          {g.text.split("\n")[0]}
        </span>
        {check && (
          <span data-goal-check className={cn("shrink-0 font-mono text-[10.5px]", check.ok ? "text-green" : "text-fg-muted")} title={g.last_check_output ?? undefined}>
            {check.text}
          </span>
        )}
        <span data-goal-turns className="shrink-0 font-mono text-[10.5px] text-fg-muted">
          {g.turns_used}/{g.max_turns} turns
        </span>
        <span className={cn("shrink-0 text-[11px] font-medium", toneText[tone])}>{goalStatusLabel(g.status)}</span>
        {active ? (
          <Button size="xs" variant="outline" data-goal-stop disabled={stop.isPending} onClick={() => stop.mutate()} title="Stop after this turn and do not continue">
            <OctagonX /> Stop
          </Button>
        ) : (
          <button aria-label="Dismiss" title="Dismiss" onClick={onDismiss} className="flex size-5 shrink-0 items-center justify-center rounded text-fg-faint outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover">
            <X className="size-3" />
          </button>
        )}
      </div>
      <div className="h-[2px] bg-line">
        <div className={cn("h-full transition-[width] duration-200", toneBar[tone])} style={{ width: `${active || g.status === "met" ? Math.max(pct, active ? 4 : pct) : pct}%` }} />
      </div>
      {!active && g.last_note && (
        <div data-goal-note className="border-t border-line px-2.5 py-1 text-[11px] text-fg-muted">
          {g.last_note}
        </div>
      )}
    </div>
  );
}
