/**
 * The pieces a diff is drawn from, shared by the read-only DiffView and the interactive DiffTab: a file with
 * its header, hunks in unified or side-by-side form, word-level highlights, and (optionally) selectable lines.
 */
import { memo, useMemo } from "react";
import { ChevronRight, ExternalLink, FileDiff } from "lucide-react";
import { alignSplit, intraLineRanges, type DiffFile, type DiffHunk, type DiffLine, type Range } from "@/lib/diff";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/misc";

export const STATUS_META: Record<DiffFile["status"], { letter: string; tone: "green" | "amber" | "red" | "violet"; label: string }> = {
  added: { letter: "A", tone: "green", label: "Added" },
  modified: { letter: "M", tone: "amber", label: "Modified" },
  deleted: { letter: "D", tone: "red", label: "Deleted" },
  renamed: { letter: "R", tone: "violet", label: "Renamed" },
  copied: { letter: "C", tone: "violet", label: "Copied" },
};

/** Split a line into plain and highlighted runs. */
function Marked({ text, ranges }: { text: string; ranges?: Range[] }) {
  const t = text.replace(/\r$/, "");
  if (!ranges?.length) return <>{t || " "}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(t.slice(at, s));
    out.push(
      <span key={i} className="rounded-[2px] bg-[var(--word)]">
        {t.slice(s, e)}
      </span>,
    );
    at = e;
  });
  if (at < t.length) out.push(t.slice(at));
  return <>{out}</>;
}

export interface Interactive {
  selected: ReadonlySet<string>;
  /** Toggle a line; `shift` extends a range from the last toggled line. */
  onToggle(hunk: DiffHunk, line: DiffLine, shift: boolean): void;
  /** Buttons shown in each hunk header (stage, discard …). */
  hunkActions?(hunk: DiffHunk): React.ReactNode;
}

const rowTone = (t: DiffLine["type"], selected: boolean) =>
  cn(t === "add" && "bg-diff-add [--word:var(--diff-add-strong)]", t === "del" && "bg-diff-del [--word:var(--diff-del-strong)]", selected && "!bg-accent-soft ring-1 ring-inset ring-accent/40");

function Gutter({ n, line, interactive, hunk }: { n: number | null; line: DiffLine; interactive?: Interactive; hunk: DiffHunk }) {
  const canSelect = interactive && line.type !== "ctx";
  return (
    <span
      onClick={canSelect ? (e) => interactive.onToggle(hunk, line, e.shiftKey) : undefined}
      className={cn("select-none px-1.5 text-right text-[11px] tabular-nums text-fg-faint", canSelect && "cursor-pointer hover:bg-active hover:text-fg")}
      title={canSelect ? "Click to select this line (shift-click for a range)" : undefined}
    >
      {n ?? ""}
    </span>
  );
}

const UnifiedHunk = memo(function UnifiedHunk({ hunk, interactive, wrap }: { hunk: DiffHunk; interactive?: Interactive; wrap?: boolean }) {
  const ranges = useMemo(() => intraLineRanges(hunk), [hunk]);
  return (
    <>
      {hunk.lines.map((l) => {
        const sel = interactive?.selected.has(l.id) ?? false;
        return (
          <div key={l.id} data-line={l.id} className={cn("grid grid-cols-[44px_44px_16px_minmax(0,1fr)] font-mono text-[12px] leading-[1.55]", rowTone(l.type, sel))}>
            <Gutter n={l.oldNo} line={l} interactive={interactive} hunk={hunk} />
            <Gutter n={l.newNo} line={l} interactive={interactive} hunk={hunk} />
            <span className={cn("select-none text-center", l.type === "add" ? "text-green" : l.type === "del" ? "text-red" : "text-fg-faint")}>{l.type === "add" ? "+" : l.type === "del" ? "−" : ""}</span>
            <span className={cn("pr-3", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")} style={{ tabSize: 4 }}>
              <Marked text={l.text} ranges={ranges.get(l.id)} />
              {l.noNewline && <span className="ml-2 select-none text-[10px] italic text-fg-faint">no newline at end of file</span>}
            </span>
          </div>
        );
      })}
    </>
  );
});

const SplitHunk = memo(function SplitHunk({ hunk, interactive, wrap }: { hunk: DiffHunk; interactive?: Interactive; wrap?: boolean }) {
  const rows = useMemo(() => alignSplit(hunk), [hunk]);
  const ranges = useMemo(() => intraLineRanges(hunk), [hunk]);
  const side = (l: DiffLine | null, which: "left" | "right") => {
    if (!l) return <div className="col-span-2 bg-raised/40" />;
    const sel = interactive?.selected.has(l.id) ?? false;
    const n = which === "left" ? l.oldNo : l.newNo;
    return (
      <>
        <div className={cn("flex", rowTone(l.type, sel))}>
          <Gutter n={n} line={l} interactive={interactive} hunk={hunk} />
        </div>
        <div className={cn("min-w-0 pr-2", rowTone(l.type, sel), wrap ? "whitespace-pre-wrap break-all" : "overflow-hidden whitespace-pre")} style={{ tabSize: 4 }}>
          <Marked text={l.text} ranges={ranges.get(l.id)} />
        </div>
      </>
    );
  };
  return (
    <>
      {rows.map((r, i) => (
        <div key={i} data-line={(r.left ?? r.right)?.id} className="grid grid-cols-[40px_minmax(0,1fr)_40px_minmax(0,1fr)] font-mono text-[12px] leading-[1.55] [&>div:nth-child(2)]:border-r [&>div:nth-child(2)]:border-line">
          {side(r.left, "left")}
          {side(r.right, "right")}
        </div>
      ))}
    </>
  );
});

export interface DiffFileViewProps {
  file: DiffFile;
  mode: "unified" | "split";
  wrap?: boolean;
  collapsed: boolean;
  onToggle(): void;
  onOpenFile?: (path: string, line: number) => void;
  interactive?: Interactive;
  /** Register hunk elements so a toolbar can scroll to them. */
  hunkRef?: (fileIndex: number, hunkIndex: number, el: HTMLElement | null) => void;
  /** Hide the file header (a single-file view that already names the file). */
  bare?: boolean;
  /** Sticky offset for the file header. */
  stickyTop?: number;
}

export function DiffFileView({ file, mode, wrap, collapsed, onToggle, onOpenFile, interactive, hunkRef, bare, stickyTop = 0 }: DiffFileViewProps) {
  const meta = STATUS_META[file.status];
  const firstLine = file.hunks[0]?.newStart ?? 1;
  const modeChanged = file.oldMode && file.newMode && file.oldMode !== file.newMode;
  return (
    <section data-file={file.path} className={cn(!bare && "mb-3 overflow-hidden rounded-lg border border-line bg-panel")}>
      {!bare && (
        <header style={{ top: stickyTop }} className="sticky z-10 flex h-8 items-center gap-2 border-b border-line bg-raised/95 px-2 backdrop-blur">
          <button onClick={onToggle} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none">
            <ChevronRight className={cn("size-3.5 shrink-0 text-fg-faint transition-transform duration-150", !collapsed && "rotate-90")} />
            <Badge tone={meta.tone} title={meta.label}>
              {meta.letter}
            </Badge>
            <span className="truncate font-mono text-[12px]">
              {file.status === "renamed" || file.status === "copied" ? (
                <>
                  <span className="text-fg-muted">{file.oldPath}</span> <span className="text-fg-faint">→</span> {file.newPath}
                </>
              ) : (
                file.path
              )}
            </span>
          </button>
          {modeChanged && (
            <span className="font-mono text-[10.5px] text-fg-faint">
              mode {file.oldMode} → {file.newMode}
            </span>
          )}
          {!file.binary && (
            <span className="shrink-0 font-mono text-[11px]">
              <span className="text-green">+{file.additions}</span> <span className="text-red">−{file.deletions}</span>
            </span>
          )}
          {onOpenFile && file.status !== "deleted" && (
            <button onClick={() => onOpenFile(file.path, firstLine)} aria-label={`Open ${file.path}`} title="Open file" className="rounded p-1 text-fg-faint outline-none hover:bg-active hover:text-fg">
              <ExternalLink className="size-3.5" />
            </button>
          )}
        </header>
      )}
      {!collapsed && (
        <div className="overflow-x-auto">
          <div className="min-w-fit">
            {file.binary ? (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-fg-muted">
                <FileDiff className="size-4" /> Binary file, no text diff.
              </div>
            ) : file.hunks.length === 0 ? (
              <div className="px-4 py-3 text-xs text-fg-muted">
                {file.status === "renamed" ? `Renamed${file.similarity !== undefined ? ` (${file.similarity}% similar)` : ""}, contents unchanged.` : modeChanged ? "File mode changed, contents unchanged." : "No textual changes."}
              </div>
            ) : (
              file.hunks.map((h) => (
                <div key={h.index} ref={(el) => hunkRef?.(file.index, h.index, el)} data-hunk={h.index}>
                  <div className="group/hunk flex h-6 items-center gap-2 border-y border-line bg-accent-soft/40 px-3 font-mono text-[11px] text-fg-muted">
                    <span className="text-accent">
                      @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                    </span>
                    <span className="min-w-0 flex-1 truncate">{h.section}</span>
                    {interactive?.hunkActions?.(h)}
                  </div>
                  {mode === "split" ? <SplitHunk hunk={h} interactive={interactive} wrap={wrap} /> : <UnifiedHunk hunk={h} interactive={interactive} wrap={wrap} />}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
