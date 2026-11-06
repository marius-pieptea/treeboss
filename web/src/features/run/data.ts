import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, post, qs } from "@/lib/api";
import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";
import type { Instance, Issue, LogLine, RunInfo } from "./logic";

export const runKey = {
  info: (root: string) => ["run", root] as const,
  logs: (root: string, service: string) => ["run-logs", root, service] as const,
  issues: (port: number) => ["preview-issues", port] as const,
};

const visible = () => (document.visibilityState === "visible" ? 2500 : false);

export const useRunInfo = (root: string, enabled = true) =>
  useQuery({
    queryKey: runKey.info(root),
    enabled,
    queryFn: () => get<RunInfo>(`/api/run${qs({ root })}`),
    refetchInterval: visible,
    staleTime: 1500,
    retry: false,
  });

export function useRunActions(root: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: runKey.info(root) });
  const make = (op: "start" | "stop" | "restart") =>
    useMutation({
      mutationFn: (service: string) => post<{ instance: Instance | null }>(`/api/run/${op}`, { root, service }),
      onSuccess: refresh,
      onError: (e: Error) => toast.error(e.message),
    });
  return { start: make("start"), stop: make("stop"), restart: make("restart") };
}

/** Log lines for one service, appended as they arrive (cursor-based; a restart keeps the same buffer). */
export const fetchLogs = (root: string, service: string, since: number) => get<{ lines: LogLine[]; next: number; instance: Instance | null }>(`/api/run/logs${qs({ root, service, since })}`);

export const useIssues = (port: number | null, enabled: boolean) =>
  useQuery({
    queryKey: runKey.issues(port ?? 0),
    enabled: enabled && !!port,
    queryFn: () => get<{ issues: Issue[]; count: number }>(`/api/preview/issues${qs({ port })}`),
    refetchInterval: () => (document.visibilityState === "visible" ? 3000 : false),
    staleTime: 1000,
  });

export const clearIssues = (port: number) => get(`/api/preview/issues${qs({ port, clear: true })}`);
export const openProxy = (port: number) => post<{ port: number }>("/api/preview/proxy", { port });
export const sendPick = (body: unknown) => post<{ text: string; thumbnail: string | null; pick: { selector: string; screenshot: string | null; screenshotNote: string | null } }>("/api/preview/pick", body);

/** Put text in the open composer (the agent tab opens first so the composer exists to hear it). */
export function insertIntoComposer(text: string): void {
  useUi.getState().setRightTab("agent");
  setTimeout(() => bus.emit("composer-insert", { text }), 60);
}
