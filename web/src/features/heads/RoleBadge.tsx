import { cn } from "@/lib/utils";
import { roleTone, toneClasses } from "./roles";

export function RoleBadge({ role, className, fallback }: { role: string | null | undefined; className?: string; fallback?: string }) {
  const label = role ?? fallback;
  if (!label) return null;
  const t = toneClasses[roleTone(role)];
  return <span className={cn("inline-flex h-[18px] max-w-[110px] shrink-0 items-center truncate rounded-sm border px-1.5 font-mono text-label font-semibold uppercase leading-none tracking-label", t.text, t.bg, t.border, className)}>{label}</span>;
}
