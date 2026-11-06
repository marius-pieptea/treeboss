/**
 * A read-only renderer of a full (multi-file) unified diff. This is the shared contract other panels build on
 * (the heads view, commit view): keep the props stable.
 */
import { useMemo, useState } from "react";
import { FileDiff } from "lucide-react";
import { parseDiff } from "@/lib/diff";
import { cn } from "@/lib/utils";
import { Empty } from "@/components/ui/misc";
import { DiffFileView } from "./DiffBlocks";

export interface DiffViewProps {
  diff: string;
  mode?: "unified" | "split";
  className?: string;
  onOpenFile?: (path: string, line: number) => void;
  collapsedByDefault?: boolean;
  emptyLabel?: string;
}

/** A file this long starts collapsed even when the caller wants them open: drawing 20k rows helps nobody. */
const HUGE = 1500;

export function DiffView({ diff, mode = "unified", className, onOpenFile, collapsedByDefault = false, emptyLabel = "No changes" }: DiffViewProps) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  // Remember only what the reader toggled; everything else follows the default.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  if (files.length === 0) return <Empty icon={<FileDiff />} title={emptyLabel} className={className} />;

  return (
    <div className={cn("p-3", className)}>
      {files.map((f) => {
        const size = f.hunks.reduce((n, h) => n + h.lines.length, 0);
        const defaultCollapsed = collapsedByDefault || size > HUGE;
        const key = `${f.index}:${f.path}`;
        const collapsed = toggled[key] ?? defaultCollapsed;
        return <DiffFileView key={key} file={f} mode={mode} collapsed={collapsed} onToggle={() => setToggled((t) => ({ ...t, [key]: !collapsed }))} onOpenFile={onOpenFile} />;
      })}
    </div>
  );
}
