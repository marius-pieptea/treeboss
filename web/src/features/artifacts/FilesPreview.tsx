import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { File, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Empty, Skeleton } from "@/components/ui/misc";
import { get } from "@/lib/api";
import { artifactFilesUrl, type Artifact, type ArtifactFilesResponse } from "./data";
import { extractArtifactBoards, formatFileSize, formatRelativeTime } from "./format";

function capabilityFileUrl(base: string, path: string): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return prefix + encodeURI(path.replace(/^\/+/, ""));
}

export function FilesPreview({ item, onRefresh }: { item: Artifact; onRefresh?: () => void }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    setSelectedPath(null);
  }, [item.id]);

  const filesQuery = useQuery({
    queryKey: ["artifact-files", item.id, item.lastReadAt],
    queryFn: ({ signal }) => get<ArtifactFilesResponse>(artifactFilesUrl(item.id), signal),
    retry: false,
  });

  const files = filesQuery.data?.files ?? [];
  const base = filesQuery.data?.base ?? null;
  const canvasPath = useMemo(() => {
    const exact = files.find((f) => f.path.replace(/^\/+/, "") === "project/canvas.json");
    if (exact) return exact.path;
    return files.find((f) => f.path.replace(/^\/+/, "") === "canvas.json")?.path ?? null;
  }, [files]);

  const canvasQuery = useQuery({
    queryKey: ["artifact-canvas", item.id, item.lastReadAt, base, canvasPath],
    enabled: Boolean(base && canvasPath),
    queryFn: async ({ signal }) => {
      const res = await fetch(capabilityFileUrl(base!, canvasPath!), { signal });
      if (!res.ok) return null;
      try {
        return (await res.json()) as unknown;
      } catch {
        return null;
      }
    },
    retry: false,
  });

  const boards = useMemo(
    () => extractArtifactBoards(files, canvasQuery.data),
    [files, canvasQuery.data],
  );

  const activeBoard = boards.find((b) => b.path === selectedPath) ?? boards[0] ?? null;
  const loading = filesQuery.isPending || (Boolean(base && canvasPath) && canvasQuery.isPending);
  const readRel = item.lastReadAt ? formatRelativeTime(item.lastReadAt) : "just now";
  const typeLabel = item.typeName?.trim() || "Design";

  const stripText = loading
    ? `${typeLabel} · read ${readRel} · local copy`
    : boards.length > 0
      ? `${typeLabel} · ${boards.length} ${boards.length === 1 ? "board" : "boards"} · read ${readRel} · local copy`
      : `${item.typeName?.trim() || "Files"} · ${files.length} ${files.length === 1 ? "file" : "files"} · read ${readRel} · local copy`;

  return (
    <>
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-3 font-mono text-label text-fg-muted">
        <ShieldCheck className="size-3 shrink-0 text-fg-faint" />
        <span className="truncate">{stripText}</span>
      </div>
      {loading ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="flex h-full flex-col gap-3 rounded-lg border border-line bg-panel p-6">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="min-h-32 flex-1" />
          </div>
        </div>
      ) : filesQuery.error ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <Empty
            icon={<File />}
            title="Couldn't load files"
            hint={(filesQuery.error as Error).message}
            action={
              <Button variant="outline" onClick={() => void filesQuery.refetch()}>
                Try again
              </Button>
            }
            className="h-full"
          />
        </div>
      ) : !base && (boards.length > 0 || item.intent === "design") ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <Empty
            icon={<File />}
            title="Read this design again to preview it."
            action={
              onRefresh ? (
                <Button variant="subtle" onClick={onRefresh}>
                  <RefreshCw />
                  Refresh
                </Button>
              ) : undefined
            }
            className="h-full"
          />
        </div>
      ) : base && activeBoard ? (
        <>
          {boards.length > 1 && (
            <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-2">
              <span className="text-label font-medium uppercase tracking-label text-fg-muted">Board</span>
              <Combobox
                size="sm"
                value={activeBoard.path}
                onChange={setSelectedPath}
                options={boards.map((b) => ({
                  value: b.path,
                  label: b.title,
                  ...(b.section ? { hint: b.section } : {}),
                }))}
                placeholder="Select board…"
                searchPlaceholder="Filter boards…"
                emptyText="No matching boards"
                aria-label="Select board"
                className="w-auto min-w-48 max-w-md"
              />
            </div>
          )}
          <div className="min-h-0 flex-1 p-4">
            <div className="h-full overflow-hidden rounded-lg border border-line bg-panel">
              <iframe
                key={`${item.id}:${item.lastReadAt ?? ""}:${base}:${activeBoard.path}`}
                title={activeBoard.title}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                src={capabilityFileUrl(base, activeBoard.path)}
                className="h-full w-full border-0 bg-panel"
              />
            </div>
          </div>
        </>
      ) : files.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <Empty icon={<File />} title="No files stored" hint="This artifact has no saved files yet." className="h-full" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <ul className="mx-auto max-w-[820px] overflow-hidden rounded-lg border border-line bg-panel">
            {files.map((f) => (
              <li
                key={f.path}
                className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <File className="size-3.5 shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{f.path}</span>
                </div>
                <span className="shrink-0 font-mono text-label text-fg-muted">{formatFileSize(f.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
