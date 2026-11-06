import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { get, post, put } from "@/lib/api";

export interface CodegraphStatus {
  available: boolean;
  version: string | null;
  /** Which executable is in use: the codegraph_bin setting, the copy shipped with the app, or PATH. */
  source: "override" | "bundled" | "path" | null;
  root: string | null;
  /** incomplete: a .codegraph/ exists but its last run never finished (or it cannot be read). */
  state: "none" | "indexed" | "stale" | "incomplete" | "unavailable";
  /** Built by an older extractor: sync cannot refresh it, a full re-index can. */
  reindexRecommended: boolean;
  builtWith: string | null;
  note: string | null;
  files: number;
  symbols: number;
  edges: number;
  lastIndexed: string | null;
  pendingChanges: number;
  /** Whether sessions here get the tools: the workspace's override, else the global setting. */
  setting: "auto" | "off";
  useOverride: "auto" | "off" | null;
  keepInSync: boolean;
  installCommand: string;
}

export type CodegraphJobMode = "init" | "sync" | "reindex";

export interface CodegraphJobProgress {
  phase: string | null;
  step: number;
  steps: number;
  percent: number | null;
  overall: number | null;
  detail: string | null;
}

export interface CodegraphJob {
  id: string;
  mode: CodegraphJobMode;
  state: "running" | "done" | "failed" | "cancelled";
  log: string[];
  error: string | null;
  note: string | null;
  summary: string | null;
  progress: CodegraphJobProgress;
  createdRoot: boolean;
  timeoutMs: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface CodegraphEstimate {
  files: number;
  method: "git" | "walk";
  capped: boolean;
  vendored: Array<{ dir: string; files: number }>;
  warning: string | null;
}

export const cgKey = (ws: string) => ["codegraph", ws] as const;

/** Status plus the project's current job: a reloaded page finds a running job here. */
export const useCodegraphState = (ws: string | null) =>
  useQuery({
    queryKey: cgKey(ws ?? ""),
    enabled: !!ws,
    queryFn: () => get<{ codegraph: CodegraphStatus; job: CodegraphJob | null }>(`/api/workspaces/${ws}/codegraph`),
    refetchInterval: (q) => (document.visibilityState !== "visible" ? false : q.state.data?.job?.state === "running" ? 1500 : 15_000),
    staleTime: 5_000,
  });

export const useCodegraph = (ws: string | null) => {
  const q = useCodegraphState(ws);
  return { ...q, data: q.data?.codegraph };
};

export const useCodegraphEstimate = (ws: string, enabled: boolean) =>
  useQuery({ queryKey: ["codegraph", ws, "estimate"], enabled, staleTime: 30_000, queryFn: () => get<{ estimate: CodegraphEstimate }>(`/api/workspaces/${ws}/codegraph/estimate`).then((r) => r.estimate) });

export const useCodegraphGlobal = () => useQuery({ queryKey: ["codegraph", "global"], queryFn: () => get<{ available: boolean; setting: "auto" | "off" }>("/api/codegraph") });

export function useCodegraphToggle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => post("/api/codegraph/toggle", { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["codegraph"] }),
  });
}

/** Per-workspace choices: `use` true/false overrides the global setting, null follows it again. */
export function useCodegraphPrefs(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { use?: boolean | null; keepInSync?: boolean }) => put<{ codegraph: CodegraphStatus }>(`/api/workspaces/${ws}/codegraph/prefs`, patch).then((r) => r.codegraph),
    onSuccess: (st) => {
      qc.setQueryData(cgKey(ws), (old: any) => (old ? { ...old, codegraph: st } : old));
      qc.invalidateQueries({ queryKey: ["codegraph"] });
    },
  });
}

/**
 * Start / follow / cancel init, sync and re-index (only ever from a button). The job itself lives in the
 * daemon: this reads it from the status query, so a reload or a tab switch re-attaches to a running one,
 * and every failure is shown (toast here, inline in the panel through `error`).
 */
export function useCodegraphJob(ws: string) {
  const qc = useQueryClient();
  const state = useCodegraphState(ws);
  const [local, setLocal] = useState<CodegraphJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["codegraph"] });
  const start = useMutation({
    mutationFn: (a: { mode: CodegraphJobMode; gitignore?: boolean }) => {
      const route = a.mode === "reindex" ? "index" : a.mode;
      return post<{ job: CodegraphJob }>(`/api/workspaces/${ws}/codegraph/${route}`, a.mode === "init" ? { gitignore: a.gitignore !== false } : undefined).then((r) => r.job);
    },
    onMutate: () => setError(null),
    onSuccess: (job) => {
      setLocal(job);
      refresh();
    },
    onError: (e: Error) => {
      setError(e.message);
      toast.error(e.message);
    },
  });
  // The daemon's copy wins once the status query has it; until then show what the start call returned.
  const server = state.data?.job ?? null;
  const job = server && (!local || server.id === local.id || (server.startedAt ?? "") >= (local.startedAt ?? "")) ? server : local;
  // Follow a running job closely, whoever started it.
  useEffect(() => {
    if (job?.state !== "running") return;
    const t = setInterval(async () => {
      try {
        const r = await get<{ job: CodegraphJob }>(`/api/codegraph/jobs/${job.id}`);
        setLocal(r.job);
        if (r.job.state !== "running") refresh();
      } catch {}
    }, 500);
    return () => clearInterval(t);
  }, [job?.id, job?.state]);
  const cancel = useMutation({
    mutationFn: () => post<{ job: CodegraphJob }>(`/api/codegraph/jobs/${job!.id}/cancel`),
    onSuccess: (r) => {
      setLocal(r.job);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const dismiss = useMutation({
    mutationFn: () => post(`/api/codegraph/jobs/${job!.id}/dismiss`),
    onSuccess: () => {
      setLocal(null);
      setError(null);
      qc.setQueryData(cgKey(ws), (old: any) => (old ? { ...old, job: null } : old));
      refresh();
    },
  });
  const uninit = useMutation({
    mutationFn: () => post(`/api/workspaces/${ws}/codegraph/uninit`, { confirm: true }),
    onSuccess: () => {
      setLocal(null);
      setError(null);
      refresh();
    },
    onError: (e: Error) => {
      setError(e.message);
      toast.error(e.message);
    },
  });
  return { job, start, cancel, dismiss, uninit, error, clearError: () => setError(null), running: start.isPending || job?.state === "running" };
}

export const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
