import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, patch, post } from "@/lib/api";
import { needsFastPoll } from "./logic";

export type RunStatus = "running" | "paused" | "awaiting_approval" | "done" | "failed" | "stopped";
export type RunAction = "pause" | "resume" | "stop" | "approve" | "reject";
export type ScheduleKind = "prompt" | "lab_sweep" | "verify" | "deps_update" | "signals_sync";

export interface AutopilotLog {
  at: string;
  kind: "info" | "task" | "gate" | "error";
  text: string;
}

export interface AutopilotGate {
  key: string;
  kind: "merge" | "tagged" | "every";
  text: string;
}

export interface AutopilotActive {
  line: number;
  id: string | null;
  text: string;
  session: string;
  isolated: boolean;
  passed: boolean;
}

export interface AutopilotRun {
  id: string;
  workspace_id: string;
  spec_dir: string;
  status: RunStatus;
  budget_usd: number | null;
  spent_usd: number;
  max_tasks: number | null;
  concurrency: number;
  approval_policy: { merge: boolean; tagged: boolean; every: number | null };
  current_task: string | null;
  reason: string | null;
  done: number;
  active: AutopilotActive[];
  gate: AutopilotGate | null;
  sessions: string[];
  log: AutopilotLog[];
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface Schedule {
  id: string;
  workspace_id: string;
  name: string;
  cron: string;
  kind: ScheduleKind;
  payload: Record<string, any>;
  engine: string | null;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_session_id: string | null;
  last_result: Record<string, any> | null;
}

export const autopilotKey = (workspaceId: string) => ["autopilot", workspaceId] as const;
export const scheduleKey = (workspaceId: string) => ["schedules", workspaceId] as const;

/** The runs of a workspace. Polls quickly while a run is working or waiting on the operator, slowly otherwise. */
export function useAutopilotRuns(workspaceId: string) {
  return useQuery({
    queryKey: autopilotKey(workspaceId),
    queryFn: () => get<{ runs: AutopilotRun[] }>(`/api/autopilot?workspace=${workspaceId}`).then((r) => r.runs),
    refetchInterval: (q) => (needsFastPoll(q.state.data ?? []) ? 2000 : 15000),
  });
}

/** One run with its full log. */
export function useAutopilotRun(id: string | null) {
  return useQuery({
    queryKey: ["autopilot-run", id],
    enabled: !!id,
    queryFn: () => get<{ run: AutopilotRun }>(`/api/autopilot/${id}`).then((r) => r.run),
    refetchInterval: (q) => (q.state.data && needsFastPoll([q.state.data]) ? 2000 : false),
  });
}

export function useStartRun(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { spec: string; budget_usd: number | null; max_tasks: number | null; concurrency: number; approval_policy: { merge: boolean; tagged: boolean; every: number | null } }) =>
      post<{ run: AutopilotRun }>("/api/autopilot", { workspace: workspaceId, ...body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: autopilotKey(workspaceId) }),
    onError: (e: Error) => toast.error("Could not start the run", { description: e.message }),
  });
}

export function useRunAction(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: RunAction }) => post<{ run: AutopilotRun }>(`/api/autopilot/${id}/${action}`, {}),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: autopilotKey(workspaceId) });
      void qc.invalidateQueries({ queryKey: ["autopilot-run", v.id] });
    },
    onError: (e: Error) => toast.error("Could not change the run", { description: e.message }),
  });
}

export function useSchedules(workspaceId: string) {
  return useQuery({
    queryKey: scheduleKey(workspaceId),
    queryFn: () => get<{ schedules: Schedule[] }>(`/api/schedules?workspace=${workspaceId}`).then((r) => r.schedules),
    refetchInterval: 30000,
  });
}

export type ScheduleChange = { kind: "create"; body: Record<string, unknown> } | { kind: "patch"; id: string; body: Record<string, unknown> } | { kind: "delete"; id: string } | { kind: "run"; id: string };

export function useScheduleChange(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: ScheduleChange) => {
      switch (c.kind) {
        case "create":
          return post("/api/schedules", { workspace: workspaceId, ...c.body });
        case "patch":
          return patch(`/api/schedules/${c.id}`, c.body);
        case "delete":
          return del(`/api/schedules/${c.id}`);
        case "run":
          return post(`/api/schedules/${c.id}/run`, {});
      }
    },
    onSuccess: (_r, c) => {
      void qc.invalidateQueries({ queryKey: scheduleKey(workspaceId) });
      if (c.kind === "run") toast.message("Started");
    },
    onError: (e: Error) => toast.error("Could not change the schedule", { description: e.message }),
  });
}
