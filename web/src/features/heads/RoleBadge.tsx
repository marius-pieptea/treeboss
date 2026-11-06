import { cn } from "@/lib/utils";
import { roleTone, toneClasses } from "./roles";

export function RoleBadge({ role, className, fallback }: { role: string | null | undefined; className?: string; fallback?: string }) {
  const label = role ?? fallback;
  if (!label) return null;
  const t = toneClasses[roleTone(role)];
  return <span className={cn("inline-flex h-[18px] max-w-[110px] shrink-0 items-center truncate rounded border px-1.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wide", t.text, t.bg, t.border, className)}>{label}</span>;
}
