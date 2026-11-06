import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, get, post } from "@/lib/api";
import type { DesignState, DesignSystem, SystemList } from "./logic";

export const SYSTEMS_KEY = ["design", "systems"] as const;
export const designKey = (root: string) => ["design", root] as const;

export const useSystems = (enabled = true) => useQuery({ queryKey: SYSTEMS_KEY, queryFn: () => get<SystemList>("/api/design/systems"), enabled, staleTime: 5000 });

export const useDesign = (root: string, enabled = true) =>
  useQuery({
    queryKey: designKey(root),
    enabled,
    queryFn: () => get<{ design: DesignState }>(`/api/design/${root}`).then((r) => r.design),
    // An agent writes these files while the tab is open: look again while it is on screen.
    refetchInterval: () => (document.visibilityState === "visible" ? 4000 : false),
    staleTime: 1500,
  });

export function useDesignActions(root: string) {
  const qc = useQueryClient();
  const base = `/api/design/${root}`;
  const set = (d: DesignState) => qc.setQueryData(designKey(root), d);
  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) toast.error("DESIGN.md changed on disk", { description: "Reloaded it. Try that again." });
    else toast.error(e instanceof Error ? e.message : "That did not work.");
    void qc.invalidateQueries({ queryKey: designKey(root) });
  };
  return {
    apply: useMutation({
      mutationFn: (v: { system: string; overwrite?: boolean }) => post<{ design: DesignState }>(`${base}/apply`, { ...v, rev: qc.getQueryData<DesignState>(designKey(root))?.rev }),
      onSuccess: (r) => set(r.design),
      onError,
    }),
    rule: useMutation({ mutationFn: () => post<{ design: DesignState }>(`${base}/rule`), onSuccess: (r) => (set(r.design), void qc.invalidateQueries({ queryKey: ["memory"] })), onError }),
    save: useMutation({
      mutationFn: (v: { name: string; description?: string }) => post<SystemList & { system: DesignSystem; design: DesignState }>(`${base}/save-to-library`, v),
      onSuccess: (r) => {
        set(r.design);
        qc.setQueryData(SYSTEMS_KEY, { systems: r.systems, missingDefaults: r.missingDefaults });
        toast.success(`Saved to the library as "${r.system.name}"`);
      },
      onError,
    }),
  };
}

export type DesignActions = ReturnType<typeof useDesignActions>;
