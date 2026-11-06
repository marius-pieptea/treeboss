import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Proposal } from "./api";

export function ProposalRow({ proposal, busy, onDecide }: { proposal: Proposal; busy: boolean; onDecide: (d: "accept" | "reject") => void }) {
  const { step } = proposal;
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-2 py-2">
      <div className="flex items-start gap-2">
        <span className="w-5 shrink-0 pt-px text-right font-mono text-[11px] leading-[18px] text-fg-muted">+</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-snug text-fg">{step.action}</div>
          {step.expected && <div className="mt-1 text-xs leading-snug text-fg-muted">{step.expected}</div>}
          {step.path && <div className="mt-1 font-mono text-[11px] text-fg-muted">{step.path}</div>}
          <div className="mt-1 text-xs italic leading-snug text-fg-muted">{proposal.why}</div>
          {proposal.orphan && <div className="mt-1 text-[11px] text-fg-muted">The step it followed was removed, so it sits at the end.</div>}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => onDecide("accept")}>
            <Check className="text-green" /> Accept
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => onDecide("reject")}>
            <X /> Reject
          </Button>
        </div>
      </div>
    </div>
  );
}
