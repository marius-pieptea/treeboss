import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/form";
import { cn } from "@/lib/utils";

/** "+ Add item" that turns into an input. Enter adds and stays open for the next one; Escape closes. */
export function AddInline({ label = "Add item", placeholder = "Title", open, onOpenChange, onAdd, className, busy }: { label?: string; placeholder?: string; open: boolean; onOpenChange: (o: boolean) => void; onAdd: (title: string) => void | Promise<unknown>; className?: string; busy?: boolean }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
    else setValue("");
  }, [open]);
  if (!open) {
    return (
      <button type="button" data-roadmap-add-open onClick={() => onOpenChange(true)} className={cn("flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-faint outline-none transition-colors hover:bg-hover hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-accent/40", className)}>
        <Plus className="size-3.5" />
        {label}
      </button>
    );
  }
  const submit = async () => {
    const t = value.trim();
    if (!t) return onOpenChange(false);
    setValue("");
    await onAdd(t);
    ref.current?.focus();
  };
  return (
    <Input
      ref={ref}
      data-roadmap-add-input
      value={value}
      disabled={busy}
      placeholder={`${placeholder}, Enter to add`}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void submit();
        else if (e.key === "Escape") onOpenChange(false);
      }}
      onBlur={() => !value.trim() && onOpenChange(false)}
      className={cn("h-7 text-[12.5px] animate-slide-up", className)}
    />
  );
}
