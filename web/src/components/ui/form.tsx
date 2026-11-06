import * as React from "react";
import { Select as S, Switch as SW, Checkbox as CB } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const field = "w-full rounded-md border border-line bg-raised px-2.5 text-[13px] text-fg outline-none transition-colors placeholder:text-fg-faint hover:border-line-strong focus:border-accent/70 focus:bg-panel disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(field, "h-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(field, "min-h-16 resize-y py-1.5 leading-relaxed", className)} {...props} />;
}

export function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-fg-faint">{hint}</span>}
    </label>
  );
}

export interface Option {
  value: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
}

/** `value` "" is allowed (shown as the placeholder) via an internal sentinel, since Radix forbids empty item values. */
const EMPTY = "__none__";

export function Select({ value, onChange, options, placeholder = "Select…", className, size = "md", disabled, "aria-label": ariaLabel }: { value: string; onChange: (v: string) => void; options: Option[]; placeholder?: string; className?: string; size?: "sm" | "md"; disabled?: boolean; "aria-label"?: string }) {
  return (
    <S.Root value={value === "" ? EMPTY : value} onValueChange={(v) => onChange(v === EMPTY ? "" : v)} disabled={disabled}>
      <S.Trigger aria-label={ariaLabel} className={cn(field, "inline-flex items-center justify-between gap-2", size === "sm" ? "h-7 text-xs" : "h-8", className)}>
        <span className="truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon>
          <ChevronDown className="size-3.5 text-fg-faint" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} className="pop-surface z-[95] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line-strong p-1 text-[12.5px] text-fg">
          <S.Viewport>
            {options.map((o) => (
              <S.Item key={o.value} value={o.value === "" ? EMPTY : o.value} disabled={o.disabled} className="pop-row relative flex cursor-default select-none items-center gap-2 rounded-lg py-1.5 pl-7 pr-2 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-active">
                <S.ItemIndicator className="absolute left-2">
                  <Check className="pop-check size-3.5 text-accent" />
                </S.ItemIndicator>
                <S.ItemText>{o.label}</S.ItemText>
                {o.hint && <span className="ml-auto pl-3 text-[11px] text-fg-faint">{o.hint}</span>}
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <SW.Root checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} className="relative h-4 w-7 shrink-0 rounded-full bg-active outline-none transition-colors data-[state=checked]:bg-accent disabled:opacity-40">
      <SW.Thumb className="block size-3 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-150 data-[state=checked]:translate-x-[14px] data-[state=checked]:bg-accent-fg" />
    </SW.Root>
  );
}

export function Checkbox({ checked, onChange, label, className }: { checked: boolean | "indeterminate"; onChange: (v: boolean) => void; label?: string; className?: string }) {
  return (
    <CB.Root checked={checked} onCheckedChange={(v) => onChange(v === true)} aria-label={label} className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-line-strong bg-raised outline-none transition-colors hover:border-accent/70 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent", className)}>
      <CB.Indicator className="text-accent-fg">{checked === "indeterminate" ? <span className="block h-px w-2 bg-current" /> : <Check className="size-2.5 animate-pop" strokeWidth={3.5} />}</CB.Indicator>
    </CB.Root>
  );
}
