import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, del, get, patch, post, put } from "@/lib/api";
import type { SessionView } from "@/lib/types";

export type ItemStatus = "shipped" | "in_progress" | "not_started";

export interface LinkState {
  value: string;
  ok: boolean;
  reason: string | null;
  path: string | null;
}

export interface SpecProgress {
  dir: string;
  done: number;
  total: number;
  hasTasks: boolean;
  status: "not_started" | "in_progress" | "done";
}

export interface ItemSession {
  id: string;
  title: string;
  status: string;
  kind: string;
  at: string;
}

export interface RoadmapItem {
  key: string;
  id: string | null;
  title: string;
  done: boolean;
  description: string;
  tags: string[];
  spec: string | null;
  docs: string | null;
  target: string | null;
  lane: string;
  index: number;
  line: number;
  status: ItemStatus;
  progress: SpecProgress | null;
  links: { spec: LinkState | null; docs: LinkState | null };
  sessions: ItemSession[];
}

export interface LaneProgress {
  items: number;
  shipped: number;
  inProgress: number;
  tasksDone: number;
  tasksTotal: number;
}

export interface RoadmapLane {
  name: string;
  items: RoadmapItem[];
  progress: LaneProgress;
}

export interface RoadmapState {
  exists: boolean;
  path: string;
  rev: string;
  heading: string | null;
  lanes: RoadmapLane[];
  broken: number;
}

export interface Choices {
  specs: Array<{ path: string; title: string; done: number; total: number }>;
  docs: string[];
  path: string;
}

export const rmKey = (root: string) => ["roadmap", root] as const;

export const useRoadmap = (root: string) =>
  useQuery({
    queryKey: rmKey(root),
    queryFn: () => get<{ roadmap: RoadmapState }>(`/api/roadmap/${root}`).then((r) => r.roadmap),
    // The file changes under us (an agent ticks a task, someone edits it): look again while the tab is on screen.
    refetchInterval: () => (document.visibilityState === "visible" ? 4000 : false),
    staleTime: 1500,
  });

export const useChoices = (root: string, enabled: boolean) => useQuery({ queryKey: ["roadmap", root, "choices"], enabled, queryFn: () => get<Choices>(`/api/roadmap/${root}/choices`), staleTime: 10_000 });

export interface ItemInput {
  title?: string;
  done?: boolean;
  description?: string;
  tags?: string[];
  spec?: string | null;
  docs?: string | null;
  target?: string | null;
}

export interface StartOpts {
  kind: "spec" | "build";
  engine?: string;
  model?: string;
}

/** Every write goes through here: it sends the rev it last saw, refreshes the cache from the answer, and explains a refusal. */
export function useRoadmapActions(root: string, onRekey?: (from: string, to: string) => void) {
  const qc = useQueryClient();
  const base = `/api/roadmap/${root}`;
  // Writes go one at a time, each stamped with the rev the previous one produced: two quick edits must not
  // race each other into a conflict with themselves.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const rev = () => qc.getQueryData<RoadmapState>(rmKey(root))?.rev;
  const apply = <R extends { roadmap: RoadmapState }>(r: R): R => {
    qc.setQueryData(rmKey(root), r.roadmap);
    return r;
  };
  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) toast.error("ROADMAP.md changed on disk", { description: "Reloaded it. Try that again." });
    else toast.error(e instanceof Error ? e.message : "That did not work.");
    // An optimistic move may have put the cache ahead of the file: take the file's word.
    void qc.invalidateQueries({ queryKey: rmKey(root) });
  };
  /** An item without an id gets one on its first edit, and with it a new key. */
  const rekey = <R extends { id?: string | null }>(from: string, r: R): R => {
    if (r.id && r.id !== from) onRekey?.(from, r.id);
    return r;
  };
  const serial = <V, R>(fn: (v: V) => Promise<R>) => (v: V): Promise<R> => {
    const run = queue.current.then(() => fn(v));
    queue.current = run.catch(() => {});
    return run;
  };
  const mut = <V, R>(fn: (v: V) => Promise<R>) => useMutation({ mutationFn: serial(fn), onError });
  const withRev = <T extends object>(b: T) => ({ ...b, rev: rev() });

  return {
    create: mut((project?: string) => post<{ roadmap: RoadmapState }>(`${base}/create`, { project }).then(apply)),
    add: mut((v: ItemInput & { lane: string; index?: number | null }) => post<{ roadmap: RoadmapState; id: string }>(`${base}/items`, withRev(v)).then(apply)),
    update: mut((v: { key: string; patch: ItemInput }) => patch<{ roadmap: RoadmapState; id: string }>(`${base}/items/${encodeURIComponent(v.key)}`, withRev(v.patch)).then(apply).then((r) => rekey(v.key, r))),
    move: mut((v: { key: string; lane: string; index?: number | null }) => post<{ roadmap: RoadmapState; id: string }>(`${base}/items/${encodeURIComponent(v.key)}/move`, withRev({ lane: v.lane, index: v.index })).then(apply).then((r) => rekey(v.key, r))),
    remove: mut((key: string) => del<{ roadmap: RoadmapState }>(`${base}/items/${encodeURIComponent(key)}?rev=${rev() ?? ""}`).then(apply)),
    addLane: mut((name: string) => post<{ roadmap: RoadmapState }>(`${base}/lanes`, withRev({ name })).then(apply)),
    renameLane: mut((v: { from: string; to: string }) => post<{ roadmap: RoadmapState }>(`${base}/lanes/rename`, withRev(v)).then(apply)),
    removeLane: mut((name: string) => post<{ roadmap: RoadmapState }>(`${base}/lanes/delete`, withRev({ name })).then(apply)),
    start: mut((v: { key: string } & StartOpts) =>
      post<{ session: SessionView; roadmap: RoadmapState }>(`${base}/items/${encodeURIComponent(v.key)}/start`, { kind: v.kind, engine: v.engine, model: v.model }).then((r) => {
        qc.setQueryData(rmKey(root), r.roadmap);
        void qc.invalidateQueries({ queryKey: ["sessions"] });
        return r;
      }),
    ),
    setPath: mut((path: string) => put<{ roadmap: RoadmapState }>(`${base}/prefs`, { path }).then(apply)),
  };
}

export type Actions = ReturnType<typeof useRoadmapActions>;
