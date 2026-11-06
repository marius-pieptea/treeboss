import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { get, url } from "@/lib/api";
import { qk } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { SessionView, TreeEntry } from "@/lib/types";
import { Empty, Skeleton } from "@/components/ui/misc";
import { FileIcon } from "@/shell/FileIcon";

function Dir({ root, path, level }: { root: string; path: string; level: number }) {
  const q = useQuery({ queryKey: qk.tree(root, path), queryFn: () => get<{ entries: TreeEntry[] }>(url.fs(root, "tree", { path })).then((r) => r.entries), retry: false });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (q.isLoading) return <Skeleton className="m-1 h-4" />;
  if (q.error) return <div className="px-3 py-2 text-xs text-red">{(q.error as Error).message}</div>;
  return (
    <>
      {q.data?.map((e) => (
        <div key={e.path}>
          <button
            onClick={() => (e.type === "dir" ? setOpen((o) => ({ ...o, [e.path]: !o[e.path] })) : useUi.getState().openTab({ kind: "file", root, path: e.path, title: e.name, preview: true }))}
            style={{ paddingLeft: 8 + level * 14 }}
            className={cn("flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[12.5px] outline-none hover:bg-hover focus-visible:bg-hover", e.ignored && "opacity-50")}
          >
            {e.type === "dir" ? (
              <>
                <ChevronRight className={cn("size-3 shrink-0 text-fg-faint transition-transform", open[e.path] && "rotate-90")} />
                {open[e.path] ? <FolderOpen className="size-3.5 shrink-0 text-accent" /> : <Folder className="size-3.5 shrink-0 text-fg-muted" />}
              </>
            ) : (
              <>
                <span className="size-3 shrink-0" />
                <FileIcon name={e.name} className="size-3.5" />
              </>
            )}
            <span className="truncate">{e.name}</span>
          </button>
          {e.type === "dir" && open[e.path] && <Dir root={root} path={e.path} level={level + 1} />}
        </div>
      ))}
    </>
  );
}

/** The head's working directory, read-only: click a file to open it (the editor accepts a session as its root). */
export function Files({ session }: { session: SessionView }) {
  const probe = useQuery({ queryKey: qk.tree(session.id, ""), queryFn: () => get<{ entries: TreeEntry[] }>(url.fs(session.id, "tree", { path: "" })), retry: false });
  if (session.status === "closed" || probe.error) {
    return <Empty icon={<Folder />} title="The worktree is gone" hint={session.status === "closed" ? "Closing a head removes its worktree. Its branch, if it had changes, is kept." : (probe.error as Error).message} className="h-full" />;
  }
  return (
    <div className="h-full overflow-y-auto py-1">
      <div className="px-3 pb-1 pt-1 font-mono text-[10.5px] text-fg-faint" title={session.cwd}>
        {session.cwd}
      </div>
      <Dir root={session.id} path="" level={0} />
    </div>
  );
}
