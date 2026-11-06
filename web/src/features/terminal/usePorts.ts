import { QueryClient, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { get } from "@/lib/api";
import type { ListeningPort } from "@/lib/types";
import { portsForWorkspace } from "./logic";

/** Listening dev servers, polled while a component using this is mounted (the terminal dock). */
export const portsQueryFn = () => get<{ ports: ListeningPort[] }>("/api/ports").then((r) => r.ports);

/** A fresh read, for the moment it matters (a navigation), bypassing the poll's cache. */
export const freshPorts = (qc: QueryClient) => qc.fetchQuery({ queryKey: ["ports"], queryFn: portsQueryFn, staleTime: 0 });

export function usePorts(workspacePath: string, all: boolean) {
  const q = useQuery({
    queryKey: ["ports"],
    queryFn: portsQueryFn,
    refetchInterval: 5000,
    staleTime: 3000,
  });
  const ownPort = Number(location.port) || undefined;
  const ports = useMemo(() => portsForWorkspace(q.data ?? [], workspacePath, { all, ownPort }), [q.data, workspacePath, all, ownPort]);
  return { ports, loaded: q.isSuccess };
}

export const previewUrl = (port: number) => `http://localhost:${port}`;
