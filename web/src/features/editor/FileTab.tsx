import { useQuery } from "@tanstack/react-query";
import { FileX } from "lucide-react";
import { ApiError, get, url } from "@/lib/api";
import { useUi, type Tab } from "@/lib/store";
import type { FileRead } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { bufferStore } from "./buffers";
import { CodeEditor } from "./CodeEditor";
import { mediaKind } from "./language";
import { FileCard, MediaView } from "./MediaView";
import "./commands";

type FileTabT = Extract<Tab, { kind: "file" }>;

function EditorSkeleton() {
  return (
    <div className="flex h-full flex-col gap-2 p-6">
      {[62, 40, 78, 55, 30, 70, 48, 66, 35].map((w, i) => (
        <div key={i} style={{ width: `${w}%`, animationDelay: `${i * 70}ms` }}>
          <Skeleton className="h-3.5" />
        </div>
      ))}
    </div>
  );
}

/**
 * One file in the editor area: loads it, then hands it to the right viewer. The query key sits under
 * ["fs", root], which the global stream invalidates after every agent turn, so an agent's edits flow in.
 */
export function FileTab({ tab }: { tab: FileTabT }) {
  const closeTab = useUi((s) => s.closeTab);
  const media = mediaKind(tab.path);
  const q = useQuery({
    queryKey: ["fs", tab.root, "file", tab.path],
    enabled: media === null || media === "pdf",
    queryFn: () => get<FileRead>(url.fs(tab.root, "file", { path: tab.path })),
    staleTime: 1500,
    retry: false,
  });

  if (media === "image" || media === "video" || media === "audio") return <MediaView root={tab.root} path={tab.path} />;
  if (media === "pdf") return <FileCard root={tab.root} path={tab.path} size={q.data?.size ?? 0} reason="pdf" />;

  const stashed = bufferStore.has(tab.id);
  const gone = q.error instanceof ApiError && q.error.status === 404;

  if (q.isPending && !stashed) return <EditorSkeleton />;
  if (q.error && !stashed) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex max-w-sm animate-slide-up flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl border border-line bg-raised text-fg-faint">
            <FileX className="size-5" />
          </div>
          <div className="text-[13px] font-medium">{gone ? "This file no longer exists" : "Could not open this file"}</div>
          <p className="font-mono text-[11px] text-fg-faint">{tab.path}</p>
          {!gone && <p className="text-xs text-red">{(q.error as Error).message}</p>}
          <div className="flex gap-2">
            {!gone && (
              <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
                Try again
              </Button>
            )}
            <Button size="sm" variant="subtle" onClick={() => closeTab(tab.id)}>
              Close tab
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const data = q.data;
  if (data && "binary" in data) return <FileCard root={tab.root} path={tab.path} size={data.size} reason="binary" />;
  if (data && "tooLarge" in data) return <FileCard root={tab.root} path={tab.path} size={data.size} reason="too-large" />;
  return <CodeEditor tab={tab} file={data && "content" in data ? data : null} deleted={gone} />;
}
