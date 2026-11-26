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
const POLL_TIMEOUT_MS = 60_000;

interface PollingEntry {
  startedAt: number;
  prevReadAt: number | null;
}

export function ArtifactsTab() {
  const [rootRef, rootSize] = useElementSize<HTMLDivElement>();
  const listW = usePaneWidth("artifacts.list", 364);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [narrowDetailOpen, setNarrowDetailOpen] = useState(false);
  const [inFlightIds, setInFlightIds] = useState<Set<string>>(() => new Set());
  const inFlightRef = useRef(new Set<string>());
  const [pollingReads, setPollingReads] = useState<Record<string, PollingEntry>>({});
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const autoReadStarted = useRef(new Set<string>());

  const polling = Object.keys(pollingReads).length > 0;
  const q = useArtifacts(polling);
  const act = useArtifactActions();

  const items = q.data?.items ?? [];
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const refreshOneAsync = useRef(act.refreshOne.mutateAsync);
  refreshOneAsync.current = act.refreshOne.mutateAsync;
  const account = q.data?.account ?? DEFAULT_ACCOUNT;
  const current = items.find((i) => i.id === selectedId) ?? null;

  // Stop polling for any id whose server-side read has completed, errored, disappeared, or hit the 60s cap.
  useEffect(() => {
    if (!q.data) return;
    const now = Date.now();
    setPollingReads((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, entry] of Object.entries(next)) {
        const found = q.data.items.find((i) => i.id === id);
        if (
          !found ||
          found.lastReadAt !== entry.prevReadAt ||
          found.error !== null ||
          now - entry.startedAt >= POLL_TIMEOUT_MS
        ) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [q.data]);

  // Enforce the 60s polling cap even if query data is unchanged or failing.
  useEffect(() => {
    const entries = Object.entries(pollingReads);
    if (entries.length === 0) return;
    const earliestExpiry = Math.min(...entries.map(([, e]) => e.startedAt + POLL_TIMEOUT_MS));
    const delay = Math.max(0, earliestExpiry - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now();
      setPollingReads((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [id, entry] of Object.entries(next)) {
          if (now - entry.startedAt >= POLL_TIMEOUT_MS) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [pollingReads]);

  // Clear stale selection if the selected item disappeared externally.
  useEffect(() => {
    if (q.data && selectedId && !current) {
      setSelectedId(null);
      setNarrowDetailOpen(false);
    }
  }, [q.data, selectedId, current]);

  const narrow = rootSize.width > 0 && rootSize.width < 760;

  const startPolling = useCallback((id: string, prevReadAt: number | null) => {
    setPollingReads((prev) => ({
      ...prev,
      [id]: { startedAt: Date.now(), prevReadAt },
    }));
  }, []);

  const runRead = useCallback(
    async (id: string) => {
      if (inFlightRef.current.has(id)) return;
      inFlightRef.current.add(id);
      setInFlightIds(new Set(inFlightRef.current));
      setReadErrors((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      try {
        await refreshOneAsync.current(id);
        setPollingReads((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } catch (err) {
        // 409 means the server is already reading this artifact (e.g. just pasted); poll until it lands.
        if (err instanceof ApiError && err.status === 409) {
          const prevReadAt = itemsRef.current.find((i) => i.id === id)?.lastReadAt ?? null;
          startPolling(id, prevReadAt);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setReadErrors((prev) => ({ ...prev, [id]: msg }));
        toast.error(msg);
      } finally {
        inFlightRef.current.delete(id);
        setInFlightIds(new Set(inFlightRef.current));
      }
    },
    [startPolling],
  );

  const handleAutoRead = useCallback(
    (id: string) => {
      if (autoReadStarted.current.has(id)) return;
      autoReadStarted.current.add(id);
      void runRead(id);
    },
    [runRead],
  );

  const handleSelect = (id: string) => {
    setSelectedId(id);
    if (narrow) setNarrowDetailOpen(true);
  };

  const handleAdd = async (url: string) => {
    const prevIds = new Set(items.map((i) => i.id));
    const res = await act.add.mutateAsync(url);
    const isBrandNew = !prevIds.has(res.item.id);
    autoReadStarted.current.add(res.item.id);
    setSelectedId(res.item.id);
    if (narrow) setNarrowDetailOpen(true);
    if (res.item.lastReadAt === null && !res.item.error) {
      if (isBrandNew) {
        startPolling(res.item.id, null);
      } else {
        void runRead(res.item.id);
      }
    }
  };

  const handleRefreshAccount = () => {
    act.refreshAccount.mutate(undefined, {
      onSuccess: () => setReadErrors({}),
      onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
    });
  };

  const handleRemove = (item: Artifact) => {
    if (selectedId === item.id) {
      setSelectedId(null);
      setNarrowDetailOpen(false);
    }
    setReadErrors((prev) => {
      if (!(item.id in prev)) return prev;
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
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

  const isReading = (id: string) => inFlightIds.has(id) || Boolean(pollingReads[id]);
  const showNarrowDetail = narrow && narrowDetailOpen && Boolean(current);

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
        className={showNarrowDetail ? "hidden" : narrow ? "min-w-0 flex-1" : "shrink-0"}
      />
      {showNarrowDetail && current && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Detail
            item={current}
            account={account}
            narrow
            reading={isReading(current.id)}
            readError={readErrors[current.id] ?? null}
            onBack={() => setNarrowDetailOpen(false)}
            onRefresh={runRead}
            onAutoRead={handleAutoRead}
            onRemove={handleRemove}
          />
        </div>
      )}
      {!narrow && (
        <>
          <PaneSplitter paneKey="artifacts.list" fallback={364} min={260} max={720} />
          <div className="min-w-0 flex-1 overflow-hidden">
            {current ? (
              <Detail
                item={current}
                account={account}
                narrow={false}
                reading={isReading(current.id)}
                readError={readErrors[current.id] ?? null}
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
