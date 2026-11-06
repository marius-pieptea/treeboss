import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { create } from "zustand";
import { del, get, post, put, qs } from "@/lib/api";
import { qk } from "@/lib/queries";
import { useUi } from "@/lib/store";
import type { SessionView } from "@/lib/types";
import type { AttachMode, Backlink, DocMeta, DocsPayload, GenKind, RunResult, SessionDoc, Staleness } from "./logic";

export const docKey = {
  all: ["docs"] as const,
  root: (root: string) => ["docs", root] as const,
  page: (root: string, path: string) => ["docs", root, "page", path] as const,
  session: (id: string) => ["session-docs", id] as const,
  run: (root: string, session: string) => ["docs", root, "run", session] as const,
};

const visible = () => (document.visibilityState === "visible" ? 6000 : false);

export const useDocs = (root: string) =>
  useQuery({
    queryKey: docKey.root(root),
    queryFn: () => get<DocsPayload>(`/api/docs/${root}`),
    refetchInterval: visible,
    staleTime: 2500,
  });

export interface PageDetail {
  page: { path: string; content: string; mtime: number; size: number; eol: "lf" | "crlf"; title: string; meta: DocMeta; frontMatterError: string | null };
  head: string | null;
  staleness: Staleness;
  backlinks: Backlink[];
}

export const usePage = (root: string, path: string, enabled = true) =>
  useQuery({
    queryKey: docKey.page(root, path),
    enabled,
    queryFn: () => get<PageDetail>(`/api/docs/${root}/page${qs({ path })}`),
    refetchInterval: visible,
    staleTime: 1500,
    retry: false,
  });

export interface SessionDocs {
  attached: SessionDoc[];
  estimate: { tokens: number; items: Array<{ path: string; mode: AttachMode; tokens: number }> };
}

export const useSessionDocs = (sessionId: string | null) =>
  useQuery({ queryKey: docKey.session(sessionId ?? ""), enabled: !!sessionId, queryFn: () => get<SessionDocs>(`/api/sessions/${sessionId}/docs`), staleTime: 2000 });

export const useDocEstimate = (root: string, path: string | null, mode: AttachMode) =>
  useQuery({ queryKey: ["docs", root, "estimate", path, mode], enabled: !!path, queryFn: () => get<{ tokens: number; truncated: boolean }>(`/api/docs/${root}/estimate${qs({ path, mode })}`), staleTime: 5000, retry: false });

export interface DocsRunView {
  run: { session_id: string; kind: string; docs_dir: string; head: string | null; by: string; started_at: string; result: RunResult | null };
}

export const useDocsRun = (root: string, session: string | null, running: boolean) =>
  useQuery({
    queryKey: docKey.run(root, session ?? ""),
    enabled: !!session,
    queryFn: () => get<DocsRunView>(`/api/docs/${root}/runs/${session}`),
    refetchInterval: running ? 2000 : false,
    staleTime: 1000,
    retry: false,
  });

/** The generation session this tab started last: the sidebar follows it to show the result. */
export const useLastRun = create<{ session: string | null; set: (id: string | null) => void }>((set) => ({ session: null, set: (session) => set({ session }) }));

const fail = (e: Error) => toast.error(e.message);

function useRefresh(root: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: docKey.root(root) });
    void qc.invalidateQueries({ queryKey: qk.fsAll(root) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
  };
}

export function useDocActions(root: string) {
  const refresh = useRefresh(root);
  const qc = useQueryClient();
  return {
    createFolder: useMutation({
      mutationFn: () => post<{ created: string[] }>(`/api/docs/${root}/folder`, {}),
      onSuccess: refresh,
      onError: fail,
    }),
    createPage: useMutation({
      mutationFn: (a: { path?: string; title?: string; kind?: "page" | "adr" }) => post<{ path: string; title: string }>(`/api/docs/${root}/pages`, a),
      onSuccess: refresh,
      onError: fail,
    }),
    markCurrent: useMutation({
      mutationFn: (path: string) => post<{ head: string }>(`/api/docs/${root}/page/current`, { path }),
      onSuccess: (_r, path) => {
        refresh();
        void qc.invalidateQueries({ queryKey: docKey.page(root, path) });
        toast.success("Recorded as current as of HEAD.");
      },
      onError: fail,
    }),
    setDir: useMutation({
      mutationFn: (dir: string | null) => put(`/api/docs/${root}/dir`, { dir }),
      onSuccess: refresh,
      onError: fail,
    }),
  };
}

export interface GenerateArgs {
  kind: GenKind;
  page?: string;
  pages?: string[];
  stale?: boolean;
  input?: string;
  engine?: string;
  model?: string;
  agent?: string;
  pairId?: string;
  sessionId?: string;
  planFirst?: boolean;
}

export interface GeneratePreview {
  kind: GenKind;
  docsDir: string;
  targets: Array<{ path: string; exists: boolean; state?: string | null; changed?: string[]; changedTotal?: number }>;
  head: string | null;
  by: string;
  refresh: boolean;
  title: string;
  prompt: string;
}

export const previewGenerate = (root: string, a: GenerateArgs) => post<GeneratePreview>(`/api/docs/${root}/generate/preview`, a);

export function useGenerate(root: string) {
  const refresh = useRefresh(root);
  const setLast = useLastRun((s) => s.set);
  return useMutation({
    mutationFn: (a: GenerateArgs) => post<{ session: SessionView; targets: GeneratePreview["targets"] }>(`/api/docs/${root}/generate`, a),
    onSuccess: (r) => {
      setLast(r.session.id);
      refresh();
      showSession(r.session.id);
    },
    onError: fail,
  });
}

/** Open a session in the agent panel. */
export function showSession(id: string): void {
  const ui = useUi.getState();
  ui.setActiveSession(id);
  ui.setRightTab("agent");
}

export function useAttachActions(sessionId: string | null) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["attachments"] });
    if (sessionId) void qc.invalidateQueries({ queryKey: docKey.session(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
  };
  return {
    attach: useMutation({ mutationFn: (a: { path: string; mode: AttachMode }) => post(`/api/sessions/${sessionId}/docs`, a), onSuccess: done, onError: fail }),
    detach: useMutation({ mutationFn: (path: string) => del(`/api/sessions/${sessionId}/docs${qs({ path })}`), onSuccess: done, onError: fail }),
  };
}
