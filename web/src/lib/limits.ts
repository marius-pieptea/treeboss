/** Plan limits an engine last reported (the daemon keeps them; see src/engines/limits.ts). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import type { EngineLimits } from "./limits-logic";

export const limitsKey = (engine: string) => ["limits", engine] as const;

/** Fetched when the card opens, so each hover reads what the last turn stored. */
export function useLimits(engine: string, enabled: boolean) {
  return useQuery({
    queryKey: limitsKey(engine),
    enabled: enabled && !!engine,
    queryFn: () => get<EngineLimits>(`/api/engines/${encodeURIComponent(engine)}/limits`),
    staleTime: 0,
  });
}
