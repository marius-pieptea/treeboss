import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Empty, Skeleton } from "@/components/ui/misc";
import { fetchArtifactContent, type Artifact } from "./data";
import { formatRelativeTime } from "./format";

export function DocPreview({ item }: { item: Artifact }) {
  const q = useQuery({
    queryKey: ["artifact-content", item.id, item.lastReadAt],
    queryFn: ({ signal }) => fetchArtifactContent(item.id, signal),
    retry: false,
  });

  return (
    <>
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-3 font-mono text-label text-fg-muted">
        <FileText className="size-3 shrink-0 text-fg-faint" />
        <span>
          Claude Docs · read {item.lastReadAt ? formatRelativeTime(item.lastReadAt) : "just now"} · local copy
        </span>
      </div>
      {q.isPending ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex max-w-[820px] flex-col gap-3 px-8 py-6">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4" />
            <Skeleton className="h-4" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        </div>
      ) : q.error ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <Empty
            icon={<FileText />}
            title="Couldn't load document"
            hint={(q.error as Error).message}
            action={
              <Button variant="outline" onClick={() => void q.refetch()}>
                Try again
              </Button>
            }
            className="h-full"
          />
        </div>
      ) : !q.data.trim() ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <Empty icon={<FileText />} title="Empty document" className="h-full" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="markdown mx-auto max-w-[820px] px-8 py-6 [&_h1]:border-b [&_h1]:border-line [&_h1]:pb-2 [&_h1]:text-[1.7em] [&_h2]:text-[1.35em] [&_li::marker]:text-fg-faint [&_ol]:list-decimal [&_ul]:list-disc">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) =>
                  href && href.startsWith("#") ? (
                    <a href={href}>{children}</a>
                  ) : (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
              }}
            >
              {q.data}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </>
  );
}
