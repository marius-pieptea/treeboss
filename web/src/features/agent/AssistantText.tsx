/**
 * An assistant message's prose. The treeboss tier line the agent writes first is shown as a chip above the text, not as
 * text. Only the display changes: the message itself is stored and copied as the agent wrote it.
 */
import { useMemo } from "react";
import { TreePine } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { extractTierLines } from "./treeboss-logic";
import type { Tier } from "@/lib/types";

/** `reveal`: the text just arrived (the daemon sends a whole block at once), so its blocks ease in one after another instead of popping. */
export function AssistantText({ text, className, reveal }: { text: string; className?: string; reveal?: boolean }) {
  const { text: body, tier } = useMemo(() => extractTierLines(text), [text]);
  return (
    <>
      {tier && <TierChip tier={tier} />}
      <Markdown text={body} className={cn(className, reveal && "reveal")} />
    </>
  );
}

/** The tier as a quiet mono chip in the composer pill's family. */
function TierChip({ tier }: { tier: Tier }) {
  return (
    <span title={`Treeboss tier: ${tier}`} className={cn("mb-1 inline-flex h-4.5 items-center gap-1 rounded-sm bg-accent-soft px-1.5 font-mono text-[length:var(--text-xs)] text-fg-muted")}>
      <TreePine aria-hidden className="size-3 shrink-0 text-accent" />
      {tier}
    </span>
  );
}
