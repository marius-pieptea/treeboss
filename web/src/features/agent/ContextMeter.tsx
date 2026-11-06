import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Minimize2 } from "lucide-react";
import { toast } from "sonner";
import { post, url } from "@/lib/api";
import { qk } from "@/lib/queries";
import type { SessionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/overlay";
import { type ContextLevel, LEVEL_BG, LEVEL_STROKE, LEVEL_TEXT, breakdownRows, fmtTokens, meterModel, shouldHintHandoff } from "./context-logic";
import { openHandoff } from "./HandoffDialog";
import { showMeterLabel } from "./slot-logic";

const R = 6;
const C = 2 * Math.PI * R;

/** The ring: a track, and an arc that fills as the window does. */
function Ring({ fill, level }: { fill: number; level: ContextLevel }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={R} fill="none" strokeWidth="2" className="stroke-line-strong" />
      <circle cx="8" cy="8" r={R} fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(1, Math.max(0.02, fill)))} className={cn("transition-[stroke-dashoffset,stroke] duration-200", LEVEL_STROKE[level])} />
    </svg>
  );
}

/**
 * Context used out of the window, in the composer footer. Click for the breakdown and the two ways to shrink it:
 * compact in place (engines that take /compact) or hand the work to a fresh session. Past 80% a "Hand off" nudge
 * appears next to it. Renders nothing while the engine has reported nothing, so a quiet session stays quiet.
 */
export function ContextMeter({ session }: { session: SessionView }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const m = meterModel(session);
  const compact = useMutation({
    mutationFn: () => post(url.session(session.id, "compact")),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: qk.session(session.id) });
      toast.success("Compacting…", { description: "The session asks its engine to summarize its own history." });
    },
    onError: (e: Error) => toast.error("Could not compact", { description: e.message }),
  });
  if (!m) return null;
  const busy = session.status === "running";
  const rows = breakdownRows(session);
  const hint = shouldHintHandoff(session);

  return (
    <>
      {hint && (
        <button data-handoff-hint aria-label="Hand off to a fresh session" onClick={() => openHandoff(session.id)} title="The context window is nearly full. Hand off: start a fresh session from a summary." className="flex size-6 shrink-0 animate-pop items-center justify-center rounded-md bg-amber/15 text-amber outline-none transition-colors hover:bg-amber/25 focus-visible:ring-1 focus-visible:ring-amber">
          <ArrowRightLeft className="size-3.5" />
        </button>
      )}
      <Popover
        side="top"
        align="end"
        width={264}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button data-context-meter data-level={m.level} aria-label={`Context: ${m.label}`} title={m.title} className={cn("flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1 font-mono text-[10.5px] outline-none transition-colors hover:bg-hover focus-visible:bg-hover", LEVEL_TEXT[m.level])}>
            <Ring fill={m.fill} level={m.level} />
            {showMeterLabel(m.fill) && m.label}
          </button>
        }
      >
        <div className="px-1.5 pb-1 pt-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">Context</span>
            <span className={cn("font-mono text-[12px]", LEVEL_TEXT[m.level])}>{m.label}</span>
          </div>
          {session.context?.max ? (
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised">
              <div className={cn("h-full rounded-full transition-[width] duration-200", LEVEL_BG[m.level])} style={{ width: `${Math.round(m.fill * 100)}%` }} />
            </div>
          ) : null}
          {rows.length > 0 && (
            <dl className="mt-2 space-y-0.5 text-[11.5px]">
              {rows.map((r) => (
                <div key={r.key} className="flex items-center justify-between">
                  <dt className="text-fg-muted">{r.label}</dt>
                  <dd className="font-mono text-fg">{fmtTokens(r.tokens)}</dd>
                </div>
              ))}
            </dl>
          )}
          {session.context?.approx && <p className="mt-1.5 text-[11px] leading-snug text-fg-faint">This engine reports per-turn totals, so the number is an upper bound.</p>}
          {!!session.compactions && <p className="mt-1.5 text-[11px] text-fg-faint">Compacted {session.compactions} time{session.compactions === 1 ? "" : "s"} so far.</p>}
          <div className="mt-2 flex gap-1.5">
            {session.can_compact && (
              <Button size="xs" className="flex-1" disabled={busy || compact.isPending} onClick={() => compact.mutate()} title={busy ? "Wait for the turn to end" : "Ask the engine to summarize its own history in place"}>
                <Minimize2 /> Compact
              </Button>
            )}
            <Button
              size="xs"
              variant={hint ? "primary" : "subtle"}
              className="flex-1"
              disabled={session.status === "closed"}
              onClick={() => {
                setOpen(false);
                openHandoff(session.id);
              }}
            >
              <ArrowRightLeft /> Hand off…
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}

/** A thin bar for the sessions list: only once the window is meaningfully used. */
export function ContextBar({ session }: { session: Pick<SessionView, "context"> }) {
  const m = meterModel(session as SessionView);
  if (!m || m.fill < 0.5) return null;
  return (
    <span data-context-bar title={m.title} className={cn("flex shrink-0 items-center gap-1 font-mono text-[10px]", LEVEL_TEXT[m.level])}>
      <span className="h-1 w-6 overflow-hidden rounded-full bg-raised">
        <span className={cn("block h-full rounded-full", LEVEL_BG[m.level])} style={{ width: `${Math.round(m.fill * 100)}%` }} />
      </span>
      {Math.round(m.fill * 100)}%
    </span>
  );
}

/** The divider where the engine compacted its own history. */
export function CompactDivider({ from, to }: { from: number | null; to: number | null }) {
  return (
    <div data-compact-divider className="flex items-center gap-2 py-0.5 font-mono text-[10.5px] text-fg-faint">
      <div className="h-px flex-1 bg-line" />
      <Minimize2 className="size-3" />
      <span>
        Context compacted {fmtTokens(from)} → {fmtTokens(to)}
      </span>
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}
