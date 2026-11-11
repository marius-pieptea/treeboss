import { Network } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Cell, Tone } from "./logic";

const COLOR: Record<Tone, string> = { run: "var(--accent)", ok: "var(--green)", warn: "var(--amber)", bad: "var(--red)", idle: "var(--fg-faint)" };

/** A 7px status light; a running one pulses. It names its state in its label and title, and sits next to a word. */
export function Dot({ tone, label, className }: { tone: Tone; label: string; className?: string }) {
  return <span role="img" aria-label={label} title={label} style={{ background: COLOR[tone], ["--pulse" as string]: COLOR[tone] }} className={cn("inline-block size-[7px] shrink-0 rounded-full", tone === "run" && "animate-pulse-dot", className)} />;
}

/** A dot, its word, a mono count, and a violet mark when a Hydra pair is on it. */
export function CellView({ cell, className }: { cell: Cell; className?: string }) {
  return (
    <span title={cell.title} className={cn("inline-flex min-w-0 items-center gap-2 text-xs", className)}>
      <Dot tone={cell.tone} label={cell.word} />
      <span className={cn("truncate", cell.tone === "idle" ? "text-fg-muted" : "text-fg")}>{cell.word}</span>
      {cell.count && <span className="shrink-0 font-mono text-label text-fg-muted">{cell.count}</span>}
      {cell.pair && <Network className="size-3 shrink-0 text-violet" aria-label="Hydra pair" />}
    </span>
  );
}

/** The small uppercase label above or beside a control. */
export const LABEL = "text-label font-medium uppercase tracking-label text-fg-muted";
