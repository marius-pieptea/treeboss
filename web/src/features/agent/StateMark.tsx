/**
 * The one mark for "how is this going" in the agent pane: a head's row on the rail, a head's card in the thread and a
 * tool call in the timeline all use it. Never colour alone: hopping dots while it works (amber when the lead waits on
 * it), a filled check when it is done, a triangle when it failed.
 */
import { AlertTriangle, Check } from "lucide-react";
import { WorkingDots } from "@/components/ui/misc";

export type MarkState = "running" | "done" | "failed";

export function StateMark({ state, awaited, label }: { state: MarkState; awaited?: boolean; label?: string }) {
  if (state === "running") {
    return awaited ? (
      <span data-awaited className="text-amber">
        <WorkingDots label={label ?? "working, the lead is waiting on it"} />
      </span>
    ) : (
      <WorkingDots className="text-fg" label={label} />
    );
  }
  if (state === "failed") return <AlertTriangle className="size-3 shrink-0 text-red" aria-label={label ?? "failed"} />;
  return (
    <span role="img" aria-label={label ?? "done"} className="flex size-3 shrink-0 items-center justify-center rounded-full bg-green">
      <Check className="size-2 text-bg" strokeWidth={3.5} />
    </span>
  );
}
