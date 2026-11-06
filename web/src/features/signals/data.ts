import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, post } from "@/lib/api";

export type SignalSource = "sentry" | "posthog" | "feedback" | "manual";
export type SignalStatus = "new" | "triaged" | "ignored" | "linked";
export type TriageAction = "to_finding" | "to_roadmap" | "to_session" | "ignore";

export interface Signal {
  id: string;
  source: SignalSource;
  kind: "error" | "metric" | "feedback";
  title: string;
  body: string;
  severity: "low" | "medium" | "high" | "critical";
  count: number;
  url: string | null;
  meta: Record<string, unknown>;
  status: SignalStatus;
  linkedRef: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface SignalsState {
  signals: Signal[];
  metrics: Signal[];
  sources: { sentry: boolean; posthog: boolean };
  feedback: boolean;
}

export interface SyncReport {
  sources: Array<{ source: string; configured: boolean; upserted: number; error: string | null }>;
}

export interface SignalFilter {
  source: SignalSource | "all";
  status: SignalStatus | "all";
}

export const signalsKey = (root: string) => ["signals", root] as const;

export const useSignals = (root: string | null, filter: SignalFilter) =>
  useQuery({
    queryKey: [...signalsKey(root ?? ""), filter],
    enabled: !!root,
    queryFn: () => {
      const q = new URLSearchParams({ workspace: root! });
      if (filter.source !== "all") q.set("source", filter.source);
      if (filter.status !== "all") q.set("status", filter.status);
      return get<SignalsState>(`/api/signals?${q.toString()}`);
    },
  });

export function useSignalActions(root: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: signalsKey(root) });
  const sync = useMutation({
    mutationFn: () => post<SyncReport>(`/api/signals/sync/${encodeURIComponent(root)}`),
    onSuccess: (r) => {
      refresh();
      const failed = r.sources.filter((s) => s.error);
      if (failed.length) toast.error(failed.map((s) => `${s.source}: ${s.error}`).join("\n"));
      else if (!r.sources.some((s) => s.configured)) toast("No source is set up for this project yet.");
      else toast.success("Synced.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const triage = useMutation({
    mutationFn: ({ id, action }: { id: string; action: TriageAction }) => post<{ session?: string; finding?: string; roadmapItem?: string }>(`/api/signals/${encodeURIComponent(id)}/triage`, { action }),
    onSuccess: (r) => {
      refresh();
      if (r.session) toast.success("A session is working on it.");
      else if (r.roadmapItem) toast.success(`Added to the roadmap as ${r.roadmapItem}.`);
      else if (r.finding) toast.success("Written as a Lab finding.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return { sync, triage };
}
