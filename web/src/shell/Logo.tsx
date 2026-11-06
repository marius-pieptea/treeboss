import { cn } from "@/lib/utils";

/** A trunk that splits into three branches: the lead (foreground) over two heads (muted). The branches draw in on mount. */
export function Logo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={cn("shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--raised)" stroke="var(--line-strong)" />
      {[
        "M16 27V18",
        "M16 18c0-5-9-4-9-11",
        "M16 18c0-5 9-4 9-11",
        "M16 18V9",
      ].map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--fg-muted)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ strokeDasharray: 24, ["--len" as string]: 24, animation: `trb-draw 0.7s ${i * 0.12}s cubic-bezier(.3,.7,.2,1) both` }} />
      ))}
      <circle cx="7" cy="7" r="2.6" fill="var(--fg-muted)" />
      <circle cx="25" cy="7" r="2.6" fill="var(--fg-muted)" />
      <circle cx="16" cy="6.5" r="3.6" fill="var(--fg)" />
    </svg>
  );
}
