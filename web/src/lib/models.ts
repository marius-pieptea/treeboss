/**
 * Model catalogs for the pickers: one cached query per engine, with a refresh that asks the engine's CLI again.
 * The catalog types and the pure search/inheritance logic live in models-logic.ts.
 */
import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { get } from "./api";
import type { ModelCatalog } from "./models-logic";

export * from "./models-logic";

export const modelsKey = (engine: string) => ["models", engine] as const;

const FIVE_MIN = 5 * 60_000;

export function fetchCatalog(engine: string, refresh = false): Promise<ModelCatalog> {
  return get<ModelCatalog>(`/api/engines/${encodeURIComponent(engine)}/models${refresh ? "?refresh=1" : ""}`);
}

export interface UseModels {
  catalog: ModelCatalog | undefined;
  isLoading: boolean;
  /** A refresh the user asked for is running (the engine's CLI can take seconds). */
  refreshing: boolean;
  /** The request itself failed (daemon down); a missing live list comes back as catalog.error instead. */
  error: Error | null;
  refresh: () => Promise<void>;
}

export function useModels(engine: string | null | undefined): UseModels {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const q = useQuery({
    queryKey: modelsKey(engine ?? ""),
    enabled: !!engine,
    queryFn: () => fetchCatalog(engine!),
    staleTime: FIVE_MIN,
    // Switching engine keeps showing the previous list for a beat instead of flashing empty.
    placeholderData: keepPreviousData,
  });
  const refresh = useCallback(async () => {
    if (!engine) return;
    setRefreshing(true);
    try {
      qc.setQueryData(modelsKey(engine), await fetchCatalog(engine, true));
    } finally {
      setRefreshing(false);
    }
  }, [engine, qc]);
  // placeholderData from another engine must not be mistaken for this engine's catalog.
  const catalog = q.data && q.data.engine === engine ? q.data : undefined;
  return { catalog, isLoading: q.isLoading || (!!engine && !catalog && q.isFetching), refreshing, error: (q.error as Error) ?? null, refresh };
}

/** Already-loaded catalogs, read without subscribing: used when an engine changes and the model must be re-judged. */
export function cachedCatalog(qc: QueryClient, engine: string): ModelCatalog | undefined {
  return engine ? qc.getQueryData<ModelCatalog>(modelsKey(engine)) : undefined;
}

/** Fetch (or reuse) an engine's catalog now, for the moment a choice changes and the answer is needed before rendering. */
export async function loadCatalog(qc: QueryClient, engine: string): Promise<ModelCatalog | undefined> {
  if (!engine) return undefined;
  try {
    return await qc.fetchQuery({ queryKey: modelsKey(engine), queryFn: () => fetchCatalog(engine), staleTime: FIVE_MIN });
  } catch {
    return undefined;
  }
}
