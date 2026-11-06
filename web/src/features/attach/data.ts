import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, post, qs } from "@/lib/api";
import { qk } from "@/lib/queries";
import type { AttachedRow, AttachKind, AttachMode, Candidates } from "./logic";

export const attachKey = {
  all: ["attachments"] as const,
  session: (id: string) => ["attachments", "session", id] as const,
  candidates: (root: string, fast: boolean) => ["attachments", "candidates", root, fast] as const,
};

export interface SessionAttachments {
  attached: AttachedRow[];
  estimate: { tokens: number; items: Array<{ path: string; kind: AttachKind; mode: AttachMode; tokens: number }> };
}

export const useSessionAttachments = (sessionId: string | null) =>
  useQuery({
    queryKey: attachKey.session(sessionId ?? ""),
    enabled: !!sessionId,
    queryFn: () => get<SessionAttachments>(`/api/sessions/${sessionId}/attachments`),
    // Other screens (the specs stepper, a doc page) attach through their own routes: pick that up.
    refetchInterval: () => (document.visibilityState === "visible" ? 5000 : false),
    staleTime: 2000,
  });

/** Everything the workspace offers, loaded when the picker is open (docs freshness is the slow part). */
export const useCandidates = (root: string, enabled: boolean, fast = false) =>
  useQuery({
    queryKey: attachKey.candidates(root, fast),
    enabled,
    queryFn: () => get<Candidates>(`/api/attachments/${root}/candidates${fast ? "?fast=1" : ""}`),
    staleTime: 5000,
  });

export const useAttachEstimate = (root: string, path: string | null, mode: AttachMode) =>
  useQuery({
    queryKey: ["attachments", "estimate", root, path, mode],
    enabled: !!path,
    queryFn: () => get<{ tokens: number; truncated: boolean; kind: AttachKind }>(`/api/attachments/${root}/estimate${qs({ path, mode })}`),
    staleTime: 5000,
  });

export function useAttachmentActions(sessionId: string | null) {
  const qc = useQueryClient();
  const done = () => {
    if (sessionId) void qc.invalidateQueries({ queryKey: attachKey.session(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
  };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not change the attachments");
  const attach = useMutation({ mutationFn: (a: { path: string; mode: AttachMode }) => post(`/api/sessions/${sessionId}/attachments`, a), onSuccess: done, onError: fail });
  const detach = useMutation({ mutationFn: (path: string) => del(`/api/sessions/${sessionId}/attachments${qs({ path })}`), onSuccess: done, onError: fail });
  return { attach, detach };
}
