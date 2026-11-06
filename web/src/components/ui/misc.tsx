import * as React from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-3.5 animate-spin-fast text-fg-muted", className)} />;
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn("rounded border border-line bg-raised px-1 py-px font-mono text-[10px] text-fg-muted", className)}>{children}</kbd>;
}

type Tone = "neutral" | "accent" | "green" | "red" | "amber" | "violet" | "blue";
const tones: Record<Tone, string> = {
  neutral: "bg-raised text-fg-muted border-line",
  accent: "bg-accent-soft text-accent border-accent/25",
  green: "bg-green/10 text-green border-green/25",
  red: "bg-red/10 text-red border-red/25",
  amber: "bg-amber/10 text-amber border-amber/25",
  violet: "bg-violet/10 text-violet border-violet/25",
  blue: "bg-blue/10 text-blue border-blue/25",
};
export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded border px-1.5 font-mono text-[10px] font-medium leading-none", tones[tone], className)}>
      {children}
    </span>
  );
}

const statusColors: Record<string, string> = { running: "var(--accent)", idle: "var(--green)", failed: "var(--red)", closed: "var(--fg-faint)", completed: "var(--green)", cancelled: "var(--amber)" };
/** A status light. Running ones breathe. */
export function StatusDot({ status, className, size = 7 }: { status: string; className?: string; size?: number }) {
  const c = statusColors[status] ?? "var(--fg-faint)";
  return <span aria-label={status} title={status} style={{ width: size, height: size, background: c, ["--pulse" as string]: c }} className={cn("inline-block shrink-0 rounded-full", status === "running" && "animate-pulse-dot", className)} />;
}

export function Empty({ icon, title, hint, action, className }: { icon?: React.ReactNode; title: string; hint?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center animate-slide-up", className)}>
      {icon && <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-raised text-fg-faint [&_svg]:size-5">{icon}</div>}
      <div className="text-[13px] font-medium text-fg">{title}</div>
      {hint && <div className="max-w-[26ch] text-xs leading-relaxed text-fg-muted">{hint}</div>}
      {action}
    </div>
  );
}

/** A collapsible group with a smooth height transition (grid-rows trick, no measuring). */
export function Section({ title, actions, count, open: openProp, onOpenChange, defaultOpen = true, children, className }: { title: React.ReactNode; actions?: React.ReactNode; count?: number; open?: boolean; onOpenChange?: (o: boolean) => void; defaultOpen?: boolean; children: React.ReactNode; className?: string }) {
  const [inner, setInner] = React.useState(defaultOpen);
  const open = openProp ?? inner;
  const toggle = () => (onOpenChange ? onOpenChange(!open) : setInner(!open));
  return (
    <section className={cn("flex min-h-0 flex-col", className)}>
      <div className="group flex h-7 shrink-0 items-center gap-1 px-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-muted">
        <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-1 text-left outline-none hover:text-fg">
          <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
          <span className="truncate">{title}</span>
          {count !== undefined && count > 0 && <span className="rounded bg-raised px-1 font-mono text-[10px] normal-case tracking-normal text-fg-faint">{count}</span>}
        </button>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{actions}</div>
      </div>
      <div className={cn("grid min-h-0 transition-[grid-template-rows] duration-200 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  );
}

export function SegTabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: React.ReactNode; badge?: React.ReactNode }>; className?: string }) {
  return (
    <div className={cn("relative flex items-center gap-0.5 rounded-lg bg-raised p-0.5", className)}>
      {items.map((it) => (
        <button key={it.value} onClick={() => onChange(it.value)} className={cn("relative flex h-6 flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors", value === it.value ? "bg-panel text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg")}>
          {it.label}
          {it.badge}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-active", className)} />;
}

/** A thin horizontal rule with a label in it. */
export function Divider({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wider text-fg-faint">
      <div className="h-px flex-1 bg-line" />
      {children}
      {children && <div className="h-px flex-1 bg-line" />}
    </div>
  );
}
