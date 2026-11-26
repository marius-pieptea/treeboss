import { useCallback, useEffect, useRef, useState } from "react";
import { Layers } from "lucide-react";
import { toast } from "sonner";
import { Empty } from "@/components/ui/misc";
import { PaneSplitter, usePaneWidth } from "@/components/ui/splitter";
import { ApiError } from "@/lib/api";
import { useElementSize } from "@/lib/hooks";
import { useArtifactActions, useArtifacts, type AccountStatus, type Artifact } from "./data";
import { Detail } from "./Detail";
import { List } from "./List";

const DEFAULT_ACCOUNT: AccountStatus = { state: "unknown", version: null };

export function ArtifactsTab() {
  const [rootRef, rootSize] = useElementSize<HTMLDivElement>();
  const listW = usePaneWidth("artifacts.list", 364);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [narrowDetailOpen, setNarrowDetailOpen] = useState(false);
  const [readingIds, setReadingIds] = useState<Record<string, boolean>>({});
  const autoReadStarted = useRef(new Set<string>());

  const polling = Object.keys(readingIds).length > 0;
  const q = useArtifacts(polling);
  const act = useArtifactActions();

  const items = q.data?.items ?? [];
  const account = q.data?.account ?? DEFAULT_ACCOUNT;
  const current = items.find((i) => i.id === selectedId) ?? null;

  // Stop polling for any id whose read has completed or errored.
  useEffect(() => {
    if (!q.data) return;
    setReadingIds((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        const found = q.data.items.find((i) => i.id === id);
        if (!found || found.lastReadAt !== null || found.error !== null) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [q.data]);

  // Clear stale selection if the selected item disappeared externally.
  useEffect(() => {
    if (q.data && selectedId && !current) {
      setSelectedId(null);
      setNarrowDetailOpen(false);
    }
  }, [q.data, selectedId, current]);

  const narrow = rootSize.width > 0 && rootSize.width < 760;

  const runRead = useCallback(
    (id: string) => {
      setReadingIds((prev) => ({ ...prev, [id]: true }));
      act.refreshOne.mutate(id, {
        onSuccess: () => {
          setReadingIds((prev) => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        },
        onError: (err) => {
          // 409 means the server is already reading this artifact (e.g. just pasted); keep polling until it lands.
          if (err instanceof ApiError && err.status === 409) return;
          setReadingIds((prev) => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
          toast.error(err instanceof Error ? err.message : String(err));
        },
      });
    },
    [act.refreshOne],
  );

  const handleAutoRead = useCallback(
    (id: string) => {
      if (autoReadStarted.current.has(id)) return;
      autoReadStarted.current.add(id);
      runRead(id);
    },
    [runRead],
  );

  const handleSelect = (id: string) => {
    setSelectedId(id);
    if (narrow) setNarrowDetailOpen(true);
  };

  const handleAdd = async (url: string) => {
    const res = await act.add.mutateAsync(url);
    autoReadStarted.current.add(res.item.id);
    if (res.item.lastReadAt === null && !res.item.error) {
      setReadingIds((prev) => ({ ...prev, [res.item.id]: true }));
    }
    setSelectedId(res.item.id);
    if (narrow) setNarrowDetailOpen(true);
  };

  const handleRefreshAccount = () => {
    act.refreshAccount.mutate(undefined, {
      onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
    });
  };

  const handleRemove = (item: Artifact) => {
    if (selectedId === item.id) {
      setSelectedId(null);
      setNarrowDetailOpen(false);
    }
    act.remove.mutate(item.id, {
      onSuccess: () => {
        toast(`Removed “${item.title || item.url}” from the list. It is still on claude.ai.`, {
          duration: 30_000,
          action: {
            label: "Undo",
            onClick: () => {
              act.restore.mutate(item.id, {
                onSuccess: (r) => setSelectedId(r.item.id),
                onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
              });
            },
          },
        });
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
    });
  };

  if (narrow && narrowDetailOpen && current) {
    return (
      <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-bg">
        <Detail
          item={current}
          account={account}
          narrow
          reading={Boolean(readingIds[current.id])}
          onBack={() => setNarrowDetailOpen(false)}
          onRefresh={runRead}
          onAutoRead={handleAutoRead}
          onRemove={handleRemove}
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 bg-bg">
      <List
        items={items}
        account={account}
        isLoading={q.isLoading}
        loadError={q.error ? (q.error as Error).message : null}
        selectedId={selectedId}
        onSelect={handleSelect}
        onAdd={handleAdd}
        adding={act.add.isPending}
        onRefresh={handleRefreshAccount}
        refreshing={act.refreshAccount.isPending}
        fallbackWidth={narrow ? rootSize.width : listW}
        style={narrow ? undefined : { width: listW }}
        className={narrow ? "min-w-0 flex-1" : "shrink-0"}
      />
      {!narrow && (
        <>
          <PaneSplitter paneKey="artifacts.list" fallback={364} min={260} max={720} />
          <div className="min-w-0 flex-1 overflow-hidden">
            {current ? (
              <Detail
                item={current}
                account={account}
                narrow={false}
                reading={Boolean(readingIds[current.id])}
                onRefresh={runRead}
                onAutoRead={handleAutoRead}
                onRemove={handleRemove}
              />
            ) : (
              <Empty
                icon={<Layers />}
                title="Nothing to preview"
                hint="Pick an artifact on the left to see it here."
                className="h-full"
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
