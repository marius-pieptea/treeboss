/** The plan questionnaire's data: one query per session, refreshed the moment the daemon says something changed. */
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, post, put, url } from "@/lib/api";
import { qk } from "@/lib/queries";
import type { PlanState } from "@/lib/types";
import type { PlanRecord } from "@/lib/types";
import { useUi } from "@/lib/store";
import { specKey } from "@/features/specs/data";

export function usePlanState(sessionId: string | null, enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!sessionId) return;
    const on = (e: Event) => {
      if ((e as CustomEvent).detail === sessionId) void qc.invalidateQueries({ queryKey: qk.planState(sessionId) });
    };
    window.addEventListener("trb:plan", on);
    return () => window.removeEventListener("trb:plan", on);
  }, [sessionId, qc]);
  return useQuery({
    queryKey: qk.planState(sessionId ?? ""),
    enabled: !!sessionId && enabled,
    queryFn: () => get<PlanState>(url.session(sessionId!, "plan-state")),
    // The stream pushes changes; the poll only covers a dropped connection while the agent is blocked on us.
    refetchInterval: (q) => (q.state.data?.pending ? 6000 : false),
    staleTime: 1000,
  });
}

/** Answer, approve or send back: each refreshes the questionnaire and the session. */
export function usePlanActions(sessionId: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.planState(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
  };
  const fail = (what: string) => (e: Error) => toast.error(what, { description: e.message });
  const answer = useMutation({
    mutationFn: (body: Record<string, unknown>) => post(url.session(sessionId, "plan/answer"), body),
    onSuccess: refresh,
    onError: fail("Could not send your answer"),
  });
  const approve = useMutation({
    mutationFn: (v: { planId: string }) => post<{ plan: PlanRecord; feature: string | null }>(url.session(sessionId, `plan/plans/${v.planId}/approve`), {}),
    onSuccess: refresh,
    onError: fail("Could not start building"),
  });
  const changes = useMutation({
    mutationFn: (v: { planId: string; note: string }) => post(url.session(sessionId, `plan/plans/${v.planId}/request-changes`), { note: v.note }),
    onSuccess: refresh,
    onError: fail("Could not send your note"),
  });
  return { answer, approve, changes };
}

/**
 * Approve a plan: the same call, toasts and follow-ups from the row above the composer and from the plan tab's bar,
 * so the two can never disagree.
 */
export function usePlanApprove(sessionId: string, root: string) {
  const actions = usePlanActions(sessionId);
  const openTab = useUi((s) => s.openTab);
  const openSpec = (feature: string) => openTab({ kind: "spec", root, feature, title: feature });
  const approve = (plan: Pick<PlanRecord, "id">) =>
    actions.approve.mutate(
      { planId: plan.id },
      {
        onSuccess: (r) => {
          if (r.feature) toast.success("Spec plan approved", { description: "The spec and plan are written. Next: generate the tasks, then Implement.", action: { label: "Open spec", onClick: () => openSpec(r.feature!) } });
          else toast.success("Building the plan", { description: "The agent is implementing it. Follow along in the agent panel." });
        },
      },
    );
  return { approve, pending: actions.approve.isPending, actions };
}

/** The plan's markdown as it stands now. The tab refetches when the daemon says the plan changed. */
export function usePlanFile(sessionId: string, planId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["plan-file", sessionId, planId ?? ""] as const,
    enabled: enabled && !!planId,
    queryFn: () => get<{ plan: PlanRecord; path: string | null; text: string; mtime: number | null; from_file: boolean }>(`${url.session(sessionId, "plan/file")}?plan=${planId}`),
    staleTime: 0,
  });
}

/** The rest of what the plan tab can do: skip, promote to a spec, give an old plan a file, choose the depth. */
export function usePlanDecisions(sessionId: string, root: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.planState(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
    void qc.invalidateQueries({ queryKey: ["plan-file", sessionId] });
    void qc.invalidateQueries({ queryKey: specKey.root(root) });
  };
  const fail = (what: string) => (e: Error) => toast.error(what, { description: e.message });
  const skip = useMutation({
    mutationFn: (planId: string) => post(url.session(sessionId, `plan/plans/${planId}/skip`), {}),
    onSuccess: refresh,
    onError: fail("Could not skip the plan"),
  });
  const promote = useMutation({
    mutationFn: (planId: string) => post<{ plan: PlanRecord; feature: string; dir: string }>(url.session(sessionId, `plan/plans/${planId}/promote`), {}),
    onSuccess: refresh,
    onError: fail("Could not promote the plan"),
  });
  const materialize = useMutation({
    mutationFn: (planId: string) => post<{ plan: PlanRecord }>(url.session(sessionId, `plan/plans/${planId}/materialize`), {}),
    onSuccess: refresh,
    onError: fail("Could not write the plan file"),
  });
  const depth = useMutation({
    mutationFn: (d: "quick" | "spec") => put<{ depth: "quick" | "spec" }>(url.session(sessionId, "plan/depth"), { depth: d }),
    onSuccess: refresh,
    onError: fail("Could not change the depth"),
  });
  return { skip, promote, materialize, depth, refresh };
}
