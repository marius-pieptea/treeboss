import { Checkbox } from "@/components/ui/form";
import { cn } from "@/lib/utils";

/**
 * A checkbox with its text beside it, and the whole row toggles it. `Checkbox` only uses its label as the accessible name:
 * it draws nothing, so a rule or a check id needs this row to be readable.
 */
export function CheckRow({ label, checked, onChange, mono, className }: { label: string; checked: boolean; onChange: (v: boolean) => void; mono?: boolean; className?: string }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 text-[length:var(--text-sm)] leading-snug", mono && "font-mono", className)}>
      <Checkbox label={label} checked={checked} onChange={onChange} />
      <span className="min-w-0">{label}</span>
    </label>
  );
}
