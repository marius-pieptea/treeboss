import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, post } from "@/lib/api";
import { launchBlockersOf, type Deploy, type DeployTarget } from "./logic";

export type { Deploy, DeployTarget } from "./logic";
/** `root` is a workspace or session id (w_… or s_…), like the roadmap's. */
export const deployKey = (root: string) => ["deploy", root] as const;

export const useDeployView = (root: string) =>
  useQuery({
    queryKey: deployKey(root),
    queryFn: async () => {
      const [t, d] = await Promise.all([get<{ targets: DeployTarget[] }>(`/api/deploy/targets?root=${encodeURIComponent(root)}`), get<{ deploys: Deploy[] }>(`/api/deploys?root=${encodeURIComponent(root)}&limit=100`)]);
      return { targets: t.targets, deploys: d.deploys };
    },
    // A deploy streams its log while it runs: look every 2 s while one is in flight, every 15 s otherwise, and not at all off screen.
    refetchInterval: (query) => {
      if (document.visibilityState !== "visible") return false;
      const busy = query.state.data?.deploys.some((d) => d.status === "queued" || d.status === "running");
      return busy ? 2000 : 15000;
    },
    staleTime: 1000,
  });

export function useDeployActions(root: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: deployKey(root) });
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");
  const run = useMutation({
    mutationFn: ({ targetId, force }: { targetId: string; force: boolean }) => post<{ deploy: Deploy }>(`/api/deploy/targets/${encodeURIComponent(targetId)}/run`, { force }),
    onSuccess: () => void refresh(),
    // A refused prod deploy has its own dialog (see DeployView), so it gets no toast.
    onError: (e) => {
      if (!launchBlockersOf(e)) onError(e);
    },
  });
  const rollback = useMutation({
    mutationFn: (deployId: string) => post<{ deploy: Deploy }>(`/api/deploys/${encodeURIComponent(deployId)}/rollback`),
    onSuccess: () => void refresh(),
    onError,
  });
  return { run, rollback };
}

