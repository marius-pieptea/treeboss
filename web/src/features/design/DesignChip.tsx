import { ChevronDown, Palette, X } from "lucide-react";
import { DropdownMenu } from "@/components/ui/overlay";
import { BRAINSTORM_KINDS, type DesignKind } from "./logic";
import { INTENT_LABEL, intentLabel, type DesignIntent } from "./composer";

const KINDS: DesignKind[] = ["brief", "url", "codebase", "wire", "review"];

/** The composer chip of a design turn: what kind, brainstorm or not, and a way out. */
export function DesignChip({ intent, onChange, onClear }: { intent: DesignIntent; onChange: (i: DesignIntent) => void; onClear: () => void }) {
  const canBrainstorm = BRAINSTORM_KINDS.includes(intent.kind);
  return (
    <span data-design-chip className="group inline-flex h-5 max-w-[260px] items-center gap-1 rounded-md border border-accent/25 bg-accent-soft pl-1.5 pr-0.5 text-[11px] text-accent animate-pop">
      <DropdownMenu
        side="top"
        align="start"
        trigger={
          <button type="button" title="Design turn: the daemon wraps your message in the design instructions" className="flex min-w-0 items-center gap-1 outline-none">
            <Palette className="size-3 shrink-0" />
            <span className="truncate">{intentLabel(intent)}</span>
            <ChevronDown className="size-2.5 shrink-0 opacity-60" />
          </button>
        }
        entries={[
          ...KINDS.map((k) => ({ label: INTENT_LABEL[k], checked: intent.kind === k, onSelect: () => onChange({ kind: k, brainstorm: BRAINSTORM_KINDS.includes(k) && (canBrainstorm ? intent.brainstorm : true) }) })),
          { separator: true },
          { label: "Brainstorm first", checked: canBrainstorm && intent.brainstorm, disabled: !canBrainstorm, onSelect: () => onChange({ ...intent, brainstorm: !intent.brainstorm }) },
        ]}
      />
      <button type="button" aria-label="Not a design turn" onClick={onClear} className="flex size-4 items-center justify-center rounded text-accent/70 outline-none hover:bg-accent/15 hover:text-accent focus-visible:bg-accent/15">
        <X className="size-3" />
      </button>
    </span>
  );
}
