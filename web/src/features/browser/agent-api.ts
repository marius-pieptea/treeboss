/**
 * Data for the agent-browser view: the session's browser state, its live frame, and the operator's controls.
 *
 * The daemon pushes a small `state` event whenever the page or the status changed; the picture itself is
 * fetched on demand, one at a time and not faster than a few a second (see shouldFetchFrame).
 */
import { liveSource } from "@/lib/live";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, post } from "@/lib/api";
import { shouldFetchFrame, type FrameGate } from "./agent-logic";

export interface BrowserTabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface AgentBrowserState {
  open: boolean;
  rootId?: string;
  url?: string;
  title?: string;
  tabs?: BrowserTabInfo[];
  active?: number;
  lastAction?: string | null;
  actor?: "agent" | "you" | null;
  busy?: boolean;
  seq?: number;
  width?: number;
  height?: number;
  consoleErrors?: number;
}

export interface BrowserStatus {
  available: boolean;
  enabled: boolean;
  executable?: string;
  version?: string | null;
  hint?: string;
}

export type BrowserInputMsg =
  | { kind: "click"; x: number; y: number; double?: boolean }
  | { kind: "scroll"; dx: number; dy: number; x?: number; y?: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "navigate"; url: string }
  | { kind: "back" }
  | { kind: "reload" }
  | { kind: "select_tab"; index: number }
  | { kind: "new_tab"; url?: string }
  | { kind: "close_tab"; index: number };

export const browserKeys = {
  status: ["browser", "status"] as const,
  state: (session: string) => ["browser", session, "state"] as const,
};

export function useBrowserStatus() {
  return useQuery({ queryKey: browserKeys.status, queryFn: () => get<BrowserStatus>("/api/browser/status"), staleTime: 30_000 });
}

export function useAgentBrowser(sessionId: string | null) {
  const qc = useQueryClient();
  const stateQ = useQuery({
    queryKey: browserKeys.state(sessionId ?? ""),
    enabled: !!sessionId,
    queryFn: () => get<AgentBrowserState>(`/api/browser/${sessionId}/state`),
    // Until a browser exists there is no stream to listen to: look every couple of seconds.
    refetchInterval: (q) => (q.state.data?.open ? false : 2500),
  });
  const state = stateQ.data ?? null;
  const open = !!state?.open;

  // The daemon's per-browser event stream: authoritative state, pushed.
  useEffect(() => {
    if (!sessionId || !open) return;
    const es = liveSource(`/api/browser/${sessionId}/stream`);
    es.addEventListener("state", (e) => qc.setQueryData(browserKeys.state(sessionId), JSON.parse((e as MessageEvent).data)));
    es.addEventListener("closed", () => qc.setQueryData(browserKeys.state(sessionId), { open: false }));
    return () => es.close();
  }, [sessionId, open, qc]);

  // The picture. Object URLs from the screenshot endpoint, replaced as newer frames arrive.
  const [frame, setFrame] = useState<{ url: string; seq: number } | null>(null);
  const gate = useRef<FrameGate>({ shown: -1, inFlight: false, lastFetchAt: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(0);
  latest.current = state?.seq ?? 0;

  const pump = useCallback(() => {
    if (!sessionId) return;
    const verdict = shouldFetchFrame(gate.current, latest.current, Date.now());
    if (verdict === "no") return;
    if (verdict === "later") {
      if (!timer.current) timer.current = setTimeout(() => { timer.current = null; pump(); }, 120);
      return;
    }
    const seq = latest.current;
    gate.current = { ...gate.current, inFlight: true, lastFetchAt: Date.now() };
    void fetch(`/api/browser/${sessionId}/screenshot?s=${seq}`, { credentials: "same-origin" })
      .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
      .then((url) => {
        gate.current = { ...gate.current, inFlight: false, shown: seq };
        if (url) setFrame((old) => {
          if (old) setTimeout(() => URL.revokeObjectURL(old.url), 1000);
          return { url, seq };
        });
        // Something newer may have arrived while this one was in flight.
        pump();
      })
      .catch(() => {
        gate.current = { ...gate.current, inFlight: false };
      });
  }, [sessionId]);

  useEffect(() => {
    if (open) pump();
  }, [open, state?.seq, pump]);

  // A different session is a different browser: start the picture over.
  useEffect(() => {
    gate.current = { shown: -1, inFlight: false, lastFetchAt: 0 };
    setFrame(null);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [sessionId]);

  const send = useCallback(
    async (input: BrowserInputMsg) => {
      if (!sessionId) return;
      try {
        await post(`/api/browser/${sessionId}/input`, input);
        // A fresh browser has no stream yet: look right away so the view appears.
        if (!open) void qc.invalidateQueries({ queryKey: browserKeys.state(sessionId) });
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [sessionId, open, qc],
  );

  const close = useCallback(async () => {
    if (!sessionId) return;
    await post(`/api/browser/${sessionId}/close`).catch((e) => toast.error((e as Error).message));
    qc.setQueryData(browserKeys.state(sessionId), { open: false });
    setFrame(null);
  }, [sessionId, qc]);

  return { state, open, frame, send, close, loading: stateQ.isLoading };
}
