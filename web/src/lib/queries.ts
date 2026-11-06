/**
 * Shared server-state hooks and the live stream that keeps them fresh. Feature-specific queries live in
 * their own feature directory; only what several features need is here.
 */
import { liveSource, type LiveSource } from "./live";
import { QueryClient, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { get, url } from "./api";
import type { Agent, EngineInfo, GitStatus, Pair, PinnedSession, RootInfo, SessionDetail, SessionView, Workspace } from "./types";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      retry: (count, err: any) => (err?.status && err.status < 500 ? false : count < 2),
      refetchOnWindowFocus: true,
    },
  },
});

/** One place for every key, so invalidation can never miss one because of a typo. */
export const qk = {
  workspaces: ["workspaces"] as const,
  workspaceActivity: ["workspaces", "activity"] as const,
  root: (ref: string) => ["root", ref] as const,
  sessions: (wsId: string) => ["sessions", wsId] as const,
  sessionsAll: ["sessions"] as const,
  pinned: ["sessions", "pinned"] as const,
  session: (id: string) => ["session", id] as const,
  planState: (id: string) => ["plan-state", id] as const,
  pairs: ["pairs"] as const,
  engines: ["engines"] as const,
  agents: ["agents"] as const,
  skills: ["skills"] as const,
  git: (ref: string) => ["git", ref] as const,
  gitStatus: (ref: string) => ["git", ref, "status"] as const,
  tree: (ref: string, path: string) => ["fs", ref, "tree", path] as const,
  fsAll: (ref: string) => ["fs", ref] as const,
};

export const useWorkspaces = () => useQuery({ queryKey: qk.workspaces, queryFn: () => get<{ workspaces: Workspace[] }>("/api/workspaces").then((r) => r.workspaces) });

/** Running and failed work per workspace id; a workspace with neither is absent. Kept fresh by the global stream. */
export const useWorkspaceActivity = () =>
  useQuery({ queryKey: qk.workspaceActivity, queryFn: () => get<{ activity: Record<string, { running: number; failed: number }> }>("/api/workspaces/activity").then((r) => r.activity) });

export const useRoot =(ref: string | null) =>
  useQuery({ queryKey: qk.root(ref ?? ""), enabled: !!ref, queryFn: () => get<RootInfo>(`/api/roots/${ref}`), staleTime: 30_000 });

/** Open leads in a workspace, with live status. */
export const useSessions = (wsId: string | null, opts: { closed?: boolean; all?: boolean } = {}) =>
  useQuery({
    queryKey: [...qk.sessions(wsId ?? ""), opts],
    enabled: !!wsId,
    queryFn: () => get<{ sessions: SessionView[] }>(`/api/workspaces/${wsId}/sessions${opts.closed || opts.all ? `?${opts.closed ? "closed=1&" : ""}${opts.all ? "all=1" : ""}` : ""}`).then((r) => r.sessions),
  });

export const CLOSED_PAGE = 50;

/**
 * Closed leads, a page at a time, newest first. Only fetched once `enabled` (the "Closed" group is opened or a filter is typed);
 * `total` is the match count across every page. Under the sessions key, so the global stream refreshes it with the lists.
 */
export const useClosedSessions = (wsId: string | null, q: string, enabled: boolean) =>
  useInfiniteQuery({
    queryKey: [...qk.sessions(wsId ?? ""), "closed", q],
    enabled: !!wsId && enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<{ sessions: SessionView[]; total: number }>(`/api/workspaces/${wsId}/sessions?closed=only&limit=${CLOSED_PAGE}&offset=${pageParam}&q=${encodeURIComponent(q)}`),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.sessions.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

/** How many closed leads there are (for the group's header) without loading any of them. */
export const useClosedCount = (wsId: string | null) =>
  useQuery({
    queryKey: [...qk.sessions(wsId ?? ""), "closed-count"],
    enabled: !!wsId,
    queryFn: () => get<{ total: number }>(`/api/workspaces/${wsId}/sessions?closed=only&limit=1`).then((r) => r.total),
  });

/** Pinned leads from every workspace. Under the sessions key, so the global stream refreshes it with the lists. */
export const usePinnedSessions = () =>
  useQuery({ queryKey: qk.pinned, queryFn: () => get<{ sessions: PinnedSession[] }>("/api/sessions/pinned").then((r) => r.sessions) });

export const useSession = (id: string | null) =>
  useQuery({ queryKey: qk.session(id ?? ""), enabled: !!id, queryFn: () => get<SessionDetail>(url.session(id!)), refetchInterval: (q) => (q.state.data?.session.status === "running" ? 3000 : false) });

export const usePairs = () => useQuery({ queryKey: qk.pairs, queryFn: () => get<{ pairs: Pair[] }>("/api/pairs").then((r) => r.pairs) });
/** The agents list and the built-ins it lacks come from one response: the same key, each hook selects its part. */
const agentsResponse = { queryKey: qk.agents, queryFn: () => get<{ agents: Agent[]; missingBuiltins?: string[] }>("/api/agents"), staleTime: 5000 };
export const useAgents = () => useQuery({ ...agentsResponse, select: (r) => r.agents });
export const useMissingBuiltinAgents = () => useQuery({ ...agentsResponse, select: (r) => r.missingBuiltins ?? [] });
export const useEngines = () => useQuery({ queryKey: qk.engines, queryFn: () => get<{ engines: EngineInfo[] }>("/api/engines").then((r) => r.engines), staleTime: 60_000 });

export const useGitStatus = (ref: string | null, enabled = true) =>
  useQuery({
    queryKey: qk.gitStatus(ref ?? ""),
    // A skill's folder (k_<name>) is not a repository: asking would only draw a 400 every few seconds.
    enabled: !!ref && enabled && !ref.startsWith("k_"),
    queryFn: () => get<GitStatus>(url.git(ref!, "status")),
    // Files change under us (an agent is editing, a build is running): a light poll while the tab is visible.
    refetchInterval: () => (document.visibilityState === "visible" ? 5000 : false),
    staleTime: 1000,
  });

/**
 * Apply the daemon's global stream to the query cache: every session's state changes. A turn ending is the moment
 * files, git status and the session list are all likely to have changed, so those refetch. Each event invalidates
 * only the keys it affects, so a replayed event (after a reconnect) does the same work as a live one. `reset` means
 * the daemon no longer has what the client missed: everything is stale.
 */
export function applyGlobalEvents(source: LiveSource, qc: QueryClient, onEvent?: (eventId: string) => void): void {
  const on = (type: string, handle: (d: any) => void) =>
    source.addEventListener(type, (e) => {
      const m = e as MessageEvent;
      if (m.lastEventId) onEvent?.(m.lastEventId);
      handle(JSON.parse(m.data));
    });
  // Several sessions change state in a burst (a lead and its heads): refetch the lists once for the lot.
  let listTimer: ReturnType<typeof setTimeout> | null = null;
  const sessions = () => {
    listTimer ??= setTimeout(() => {
      listTimer = null;
      qc.invalidateQueries({ queryKey: qk.sessionsAll });
      qc.invalidateQueries({ queryKey: qk.workspaceActivity });
    }, 150);
  };
  on("reset", () => qc.invalidateQueries());
  on("state", (d) => {
    sessions();
    qc.invalidateQueries({ queryKey: qk.session(d.rootId) });
    qc.invalidateQueries({ queryKey: qk.session(d.sessionId) });
  });
  // The meter moves while a turn runs: refresh that session's view, at most twice a second.
  let lastContext = 0;
  on("context", (d) => {
    const now = Date.now();
    if (now - lastContext < 500) return;
    lastContext = now;
    qc.invalidateQueries({ queryKey: qk.session(d.sessionId) });
    if (d.compacted) sessions();
  });
  // A lead started or stopped waiting on its heads: its own view (and the shelf, header, list) carries it.
  on("wait", (d) => {
    sessions();
    qc.invalidateQueries({ queryKey: qk.session(d.sessionId) });
    qc.invalidateQueries({ queryKey: qk.session(d.rootId) });
  });
  on("turn_start", () => sessions());
  on("turn_end", (d) => {
    sessions();
    qc.invalidateQueries({ queryKey: qk.session(d.rootId) });
    qc.invalidateQueries({ queryKey: qk.session(d.sessionId) });
    // Work just landed somewhere: the working tree and git state are stale (and the spec files with them).
    qc.invalidateQueries({ queryKey: ["specs"] });
    // Any workspace may have changed, not just the one on screen: mark them all stale so the others
    // are fresh when switched back to (only the mounted ones refetch now).
    qc.invalidateQueries({ queryKey: ["git"] });
    qc.invalidateQueries({ queryKey: ["fs"] });
    // A turn may have stored a new plan snapshot. The provider rings read ["limits", engine].
    qc.invalidateQueries({ queryKey: ["limits"] });
  });
}

/**
 * The daemon's global stream, mounted once by the shell. A reconnect resumes after the last event applied, so a
 * dropped stream replays what it missed rather than leaving the cache to go stale.
 */
export function useGlobalStream(workspaceRoot: string | null): void {
  const qc = useQueryClient();
  useEffect(() => {
    let es: LiveSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let cursor: string | undefined;
    const connect = () => {
      es = liveSource(cursor ? `/api/stream?lastEventId=${cursor}` : "/api/stream");
      applyGlobalEvents(es, qc, (id) => (cursor = id));
      es.onerror = () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [qc, workspaceRoot]);
}
