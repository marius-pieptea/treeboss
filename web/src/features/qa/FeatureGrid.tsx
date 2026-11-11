import { Checkbox } from "@/components/ui/form";
import type { BoardFeature } from "./api";
import { COLS, FeatureRow, type RowAction } from "./FeatureRow";
import { LABEL } from "./Status";

export function FeatureGrid({
  features,
  open,
  picked,
  busy,
  onOpen,
  onPick,
  onPickAll,
  onAction,
}: {
  features: BoardFeature[];
  open: string | null;
  picked: readonly string[];
  busy: boolean;
  onOpen: (id: string) => void;
  onPick: (id: string, on: boolean) => void;
  onPickAll: (on: boolean) => void;
  onAction: (a: RowAction, id: string) => void;
}) {
  const all = features.length > 0 && picked.length === features.length;
  return (
    <div role="table" aria-label="Features" className="flex flex-col">
      <div role="row" className="flex h-7 items-center gap-2 border-b border-line px-3">
        <span className="flex shrink-0 items-center">
          <Checkbox checked={all ? true : picked.length > 0 ? "indeterminate" : false} onChange={() => onPickAll(!all)} label="Pick every feature" />
        </span>
        <span className={`${LABEL} min-w-0 flex-1`}>Feature</span>
        <span className={`${LABEL} ${COLS.plan}`}>Plan</span>
        <span className={`${LABEL} ${COLS.test}`}>Test</span>
        <span className={`${LABEL} ${COLS.bugs}`}>Bugs</span>
        <span className="w-6 shrink-0" />
      </div>
      {features.map((f) => (
        <FeatureRow key={f.id} f={f} selected={open === f.id} picked={picked.includes(f.id)} busy={busy} onOpen={() => onOpen(f.id)} onPick={(on) => onPick(f.id, on)} onAction={(a) => onAction(a, f.id)} />
      ))}
    </div>
  );
}
