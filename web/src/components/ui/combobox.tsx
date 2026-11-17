import * as React from "react";
import { Command } from "cmdk";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { field } from "./form";
import { Popover } from "./overlay";

export interface ComboOption {
  value: string;
  label: string;
  /** Mono text after the label, searched too (an id, a path). */
  hint?: string;
}

export function matchOptions<T extends ComboOption>(options: readonly T[], text: string): T[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((o) => {
    const hay = `${o.label} ${o.hint ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** `value` "" is a real choice (give it an option with value "") and shows as the placeholder when none has it. */
export function Combobox({ value, onChange, options, placeholder = "Select…", searchPlaceholder = "Search…", emptyText = "Nothing matches", className, size = "md", disabled, "aria-label": ariaLabel }: { value: string; onChange: (v: string) => void; options: ComboOption[]; placeholder?: string; searchPlaceholder?: string; emptyText?: string; className?: string; size?: "sm" | "md"; disabled?: boolean; "aria-label"?: string }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const current = options.find((o) => o.value === value);
  const shown = React.useMemo(() => matchOptions(options, query), [options, query]);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
      align="start"
      width={280}
      trigger={
        <button type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} className={cn(field, "inline-flex items-center justify-between gap-2 text-left", size === "sm" ? "h-7 text-xs" : "h-8", className)}>
          <span className={cn("truncate", !current && "text-fg-muted")}>{current?.label ?? placeholder}</span>
          <ChevronDown className="size-3.5 shrink-0 text-fg-faint" />
        </button>
      }
    >
      <Command shouldFilter={false} loop label={ariaLabel}>
        <Command.Input value={query} onValueChange={setQuery} placeholder={searchPlaceholder} className="h-7 w-full rounded-md border-b border-line bg-transparent px-2 text-xs text-fg outline-none placeholder:text-fg-muted" />
        <Command.List className="mt-1 max-h-60 overflow-y-auto">
          {shown.length === 0 && <Command.Empty className="px-2 py-3 text-center text-xs text-fg-muted">{emptyText}</Command.Empty>}
          {shown.map((o) => (
            <Command.Item
              key={o.value}
              // cmdk lowercases and trims item values and rejects an empty one, so the real value rides in a prefixed key.
              value={`opt:${o.value}`}
              onSelect={() => {
                onChange(o.value);
                setOpen(false);
                setQuery("");
              }}
              className="pop-row flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-xs data-[selected=true]:bg-active"
            >
              <Check className={cn("size-3.5 shrink-0 text-fg", o.value !== value && "invisible")} />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 font-mono text-label text-fg-muted">{o.hint}</span>}
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </Popover>
  );
}
