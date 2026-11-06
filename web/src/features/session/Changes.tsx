import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileDiff, GitMerge, Columns2, Rows2 } from "lucide-react";
import { get, url } from "@/lib/api";
import { useUi } from "@/lib/store";
import { basename, cn, dirname } from "@/lib/utils";
import type { DiffResult, SessionView } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/button";
import { Empty, Skeleton } from "@/components/ui/misc";
import { DiffView } from "@/features/git/DiffView";
import { FileIcon } from "@/shell/FileIcon";
import { useHeadActions } from "@/features/heads/actions";
import { isMergeReady } from "@/features/heads/model";
import { splitDiff, summarize, type DiffFile } from "./diff-files";

const STATUS_MARK: Record<DiffFile["status"], { label: string; cls: string }> = {
  added: { label: "A", cls: "text-green" },
  deleted: { label: "D", cls: "text-red" },
  renamed: { label: "R", cls: "text-blue" },
  modified: { label: "M", cls: "text-amber" },
  binary: { label: "B", cls: "text-fg-muted" },
};

/** What the head committed on its branch, file by file, with the merge call-to-action beside it. */
export function Changes({ session }: { session: SessionView }) {
  const actions = useHeadActions();
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [note, setNote] = useState<string | null>(null);

  const q = useQuery({
    // Under ["session", ...] so a turn ending or a merge refreshes it with everything else.
    queryKey: ["session", session.id, "diff"],
    queryFn: () => get<DiffResult>(url.session(session.id, "diff")),
    refetchInterval: session.status === "running" ? 4000 : false,
  });
  const files = useMemo(() => splitDiff(q.data?.diff ?? ""), [q.data?.diff]);
  const sum = summarize(files);
  const shown = selected ? files.find((f) => f.path === selected) : null;
  const text = shown ? shown.text : q.data?.diff ?? "";
  const ready = isMergeReady(session);

  const merge = async () => {
    const r = await actions.merge(session);
    if (r) setNote(r.message);
  };

  if (q.isLoading) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-8" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (session.isolation !== "worktree") {
    return <Empty icon={<FileDiff />} title="Shared workspace" hint="This head edits the parent's checkout directly, so there is no separate branch to compare. Look at source control for what changed." className="h-full" />;
  }
  if (!files.length) {
    return (
      <Empty
        icon={<FileDiff />}
        title={session.status === "running" ? "Nothing committed yet" : "No changes"}
        hint={session.status === "running" ? "A head's edits are committed to its branch when its turn ends. They appear here then." : session.merged ? "Everything this head changed has been merged." : "This head did not change any files."}
        className="h-full"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-[11.5px] text-fg-muted">
          {sum.files} file{sum.files === 1 ? "" : "s"} <span className="text-green">+{sum.additions}</span> <span className="text-red">−{sum.deletions}</span>
        </span>
        {session.branch && <span className="truncate font-mono text-[11px] text-fg-faint">{session.branch}</span>}
        <div className="flex-1" />
        <IconButton label={mode === "unified" ? "Side by side" : "Unified"} size="icon-sm" onClick={() => setMode(mode === "unified" ? "split" : "unified")}>
          {mode === "unified" ? <Columns2 /> : <Rows2 />}
        </IconButton>
        {session.merged ? (
          <span className="flex items-center gap-1 text-xs text-green">
            <GitMerge className="size-3.5" /> merged
          </span>
        ) : (
          <Button size="sm" variant="primary" disabled={!ready} onClick={merge} title={ready ? "Apply these changes to the parent's checkout as uncommitted edits" : "Wait for the head to finish"}>
            <GitMerge /> Merge into parent
          </Button>
        )}
      </div>
      {note && <div className="shrink-0 border-b border-line bg-raised px-3 py-1.5 text-[11.5px] text-fg-muted animate-slide-up">{note}</div>}
      {q.data?.truncated && <div className="shrink-0 border-b border-line bg-amber/10 px-3 py-1 text-[11px] text-amber">The diff is very large and was cut off.</div>}
      <div className="flex min-h-0 flex-1">
        <div className="w-60 shrink-0 overflow-y-auto border-r border-line py-1" role="listbox" aria-label="Changed files">
          <button onClick={() => setSelected(null)} role="option" aria-selected={!selected} className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none hover:bg-hover", !selected && "bg-active text-fg")}>
            <span className="flex-1">All files</span>
            <span className="font-mono text-[10px] text-fg-faint">{sum.files}</span>
          </button>
          {files.map((f) => {
            const m = STATUS_MARK[f.status];
            return (
              <button key={f.path} onClick={() => setSelected(f.path)} role="option" aria-selected={selected === f.path} title={f.path} className={cn("flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs outline-none hover:bg-hover", selected === f.path && "bg-active")}>
                <FileIcon name={f.path} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">
                  {basename(f.path)} <span className="text-[10.5px] text-fg-faint">{dirname(f.path)}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px]">
                  <span className="text-green">{f.additions ? `+${f.additions}` : ""}</span> <span className="text-red">{f.deletions ? `−${f.deletions}` : ""}</span>
                </span>
                <span className={cn("w-3 shrink-0 text-center font-mono text-[10px] font-semibold", m.cls)}>{m.label}</span>
              </button>
            );
          })}
        </div>
        <div className="min-w-0 flex-1 overflow-auto">
          <DiffView
            key={selected ?? "all"}
            diff={text}
            mode={mode}
            collapsedByDefault={!selected && files.length > 6}
            onOpenFile={(path, line) => useUi.getState().openTab({ kind: "file", root: session.id, path, title: basename(path), line })}
          />
        </div>
      </div>
    </div>
  );
}
