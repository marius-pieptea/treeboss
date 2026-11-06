import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, post } from "@/lib/api";
import type { ChecksState } from "./logic";

/** A pull request of the workspace, as GET /api/prs lists it. */
export interface PrItem {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  head: string;
  base: string;
  updatedAt: string | null;
  sessionId: string | null;
  checksState: ChecksState | null;
}

export interface SessionPr {
  workspaceId: string;
  number: number;
  sessionId: string | null;
  url: string;
  state: string;
  checksState: ChecksState;
  updatedAt: string;
}

export const prKeys = {
  all: ["prs"] as const,
  list: (ws: string) => ["prs", ws] as const,
};

/** The open PRs of a workspace, refreshed while the panel is open. */
export function usePrs(workspaceId: string | null) {
  return useQuery({
    queryKey: prKeys.list(workspaceId ?? ""),
    enabled: !!workspaceId,
    queryFn: () => get<{ prs: PrItem[] }>(`/api/prs?workspace=${encodeURIComponent(workspaceId!)}`).then((r) => r.prs),
    refetchInterval: 30_000,
  });
}

export function useMergePr(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ n, deleteBranch }: { n: number; deleteBranch?: boolean }) => post<{ pr: SessionPr }>(`/api/prs/${encodeURIComponent(workspaceId)}/${n}/merge`, { method: "squash", deleteBranch: deleteBranch === true }),
    onSuccess: (_, v) => {
      toast.success(`Merged #${v.n}`);
      qc.invalidateQueries({ queryKey: prKeys.list(workspaceId) });
    },
    onError: (e: Error) => toast.error(e.message || "Could not merge the pull request"),
  });
}

/** Push a session's branch and open its PR (or get the one it has open). */
export function useOpenSessionPr() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, draft }: { sessionId: string; draft?: boolean }) => post<{ pr: SessionPr; created: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/pr`, { draft: draft === true }),
    onSuccess: (r) => {
      toast.success(r.created ? `Opened PR #${r.pr.number}` : `PR #${r.pr.number} is already open`);
      qc.invalidateQueries({ queryKey: prKeys.all });
    },
    onError: (e: Error) => toast.error(e.message || "Could not open the pull request"),
  });
}
