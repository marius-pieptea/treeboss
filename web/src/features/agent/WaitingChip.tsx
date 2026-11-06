import { cn } from "@/lib/utils";
import { useNow } from "@/features/heads/hooks";
import type { SessionView } from "@/lib/types";
import { waitingInfo, waitingText } from "./waiting-logic";

/** A pulsing dot and "waiting on api-head, 2m 10s" while the session is blocked in subagent_wait. Nothing otherwise. */
export function WaitingChip({ session, compact, className }: { session: Pick<SessionView, "waiting_on" | "waiting_since">; compact?: boolean; className?: string }) {
  const w = waitingInfo(session);
  const now = useNow(!!w);
  if (!w) return null;
  const full = waitingText(w, now);
  return (
    <span data-waiting-chip title={full} className={cn("inline-flex h-[18px] min-w-0 max-w-full items-center gap-1.5 rounded-full border border-amber/25 bg-amber/10 px-2 font-mono text-[10px] font-medium leading-none text-amber animate-slide-up", className)}>
      <span className="relative flex size-1.5 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-amber" />
      </span>
      <span className="truncate">{compact ? waitingText(w, now, { compact: true }) : full}</span>
    </span>
  );
}
