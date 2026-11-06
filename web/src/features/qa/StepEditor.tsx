import * as React from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import type { PlanStep, StepFields } from "./api";

/** A field commits on blur, so a half-typed word is never saved and the server sees one update per field. */
function Commit({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => setV(value), [value]);
  return <Input {...rest} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />;
}

export interface StepEditorProps {
  step: PlanStep;
  number: number;
  first: boolean;
  last: boolean;
  onUpdate: (fields: Partial<StepFields>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

export function StepEditor({ step, number, first, last, onUpdate, onMove, onRemove }: StepEditorProps) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line px-2 py-2">
      <span className="w-5 shrink-0 pt-1.5 text-right font-mono text-[11px] text-fg-muted">{number}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Commit aria-label="Action" value={step.action} onCommit={(action) => action.trim() && onUpdate({ action })} placeholder="What to do" />
        <Commit aria-label="Expected" value={step.expected} onCommit={(expected) => onUpdate({ expected })} placeholder="What should happen" className="h-7 text-xs" />
        <Commit aria-label="Path" value={step.path ?? ""} onCommit={(p) => onUpdate({ path: p.trim() === "" ? null : p.trim().startsWith("/") ? p.trim() : `/${p.trim()}` })} placeholder="/page to open (optional)" className="h-7 font-mono text-xs" />
      </div>
      <div className="flex shrink-0 flex-col">
        <IconButton label="Move up" size="icon-sm" disabled={first} onClick={() => onMove(-1)}>
          <ArrowUp />
        </IconButton>
        <IconButton label="Move down" size="icon-sm" disabled={last} onClick={() => onMove(1)}>
          <ArrowDown />
        </IconButton>
        <IconButton label="Remove step" size="icon-sm" variant="dangerGhost" onClick={onRemove}>
          <Trash2 />
        </IconButton>
      </div>
    </div>
  );
}
