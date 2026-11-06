import { cn } from "@/lib/utils";

export function Banner({ tone = "warning", children }: { tone?: "warning" | "danger"; children: React.ReactNode }) {
  return (
    <div role="status" className={cn("rounded-md border px-2 py-1.5 text-xs leading-snug", tone === "danger" ? "border-red/25 bg-red/10 text-red" : "border-amber/25 bg-amber/10 text-amber")}>
      {children}
    </div>
  );
}
