import { Checkbox } from "@/components/ui/form";
import { COLS, FeatureRow, type RowAction } from "./FeatureRow";
import type { FeatureRowModel } from "./logic";
import { LABEL } from "./Status";

export function FeatureGrid({
  rows,
  matched,
  locked,
  open,
  picked,
  busy,
  onOpen,
  onPick,
  onPickAll,
  onToggle,
  onAction,
}: {
  rows: FeatureRowModel[];
  matched: readonly string[];
  locked: boolean;
  open: string | null;
  picked: readonly string[];
  busy: boolean;
  onOpen: (id: string) => void;
  onPick: (id: string, on: boolean) => void;
  onPickAll: () => void;
  onToggle: (id: string) => void;
  onAction: (a: RowAction, id: string) => void;
}) {
  const all = matched.length > 0 && matched.every((id) => picked.includes(id));
  const some = matched.some((id) => picked.includes(id));
  return (
    <div role="table" aria-label="Features" className="flex flex-col">
      <div role="row" className="flex h-7 items-center gap-2 border-b border-line px-3">
        <span className="flex shrink-0 items-center">
          <Checkbox checked={all ? true : some ? "indeterminate" : false} onChange={onPickAll} label="Pick every shown feature" />
        </span>
        <span className={`${LABEL} min-w-0 flex-1`}>Feature</span>
        <span className={`${LABEL} ${COLS.plan}`}>Plan</span>
        <span className={`${LABEL} ${COLS.test}`}>Test</span>
        <span className={`${LABEL} ${COLS.bugs}`}>Bugs</span>
        <span className="w-6 shrink-0" />
      </div>
      {rows.map((m) => (
        <FeatureRow key={m.feature.id} model={m} selected={open === m.feature.id} picked={picked.includes(m.feature.id)} busy={busy} locked={locked} onOpen={() => onOpen(m.feature.id)} onPick={(on) => onPick(m.feature.id, on)} onToggle={() => onToggle(m.feature.id)} onAction={(a) => onAction(a, m.feature.id)} />
      ))}
    </div>
  );
}
