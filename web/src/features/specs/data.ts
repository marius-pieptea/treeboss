import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, post, put, qs } from "@/lib/api";
import { qk } from "@/lib/queries";
import { useUi } from "@/lib/store";
import type { SessionView } from "@/lib/types";
import type { AttachMode, FeatureInfo, ParsedTasks, SessionSpec, SpecsOverview, StepName } from "./logic";

export const specKey = {
  all: ["specs"] as const,
  root: (root: string) => ["specs", root] as const,
  feature: (root: string, id: string) => ["specs", root, "feature", id] as const,
  session: (id: string) => ["session-specs", id] as const,
};

const visible = () => (document.visibilityState === "visible" ? 5000 : false);

export const useSpecs = (root: string) =>
  useQuery({
    queryKey: specKey.root(root),
    queryFn: () => get<{ specs: SpecsOverview }>(`/api/specs/${root}`).then((r) => r.specs),
    refetchInterval: visible,
    staleTime: 2000,
  });

export interface FeatureDetail {
  feature: FeatureInfo;
  tasks: ParsedTasks | null;
}

export const useFeature = (root: string, id: string | null) =>
  useQuery({
    queryKey: specKey.feature(root, id ?? ""),
    enabled: !!id,
    queryFn: () => get<FeatureDetail>(`/api/specs/${root}/features/${encodeURIComponent(id!)}`),
    refetchInterval: visible,
    staleTime: 1500,
    retry: false,
  });

export interface SessionSpecs {
  attached: SessionSpec[];
  estimate: { tokens: number; items: Array<{ path: string; mode: AttachMode; tokens: number }> };
}

export const useSessionSpecs = (sessionId: string | null) =>
  useQuery({
    queryKey: specKey.session(sessionId ?? ""),
    enabled: !!sessionId,
    queryFn: () => get<SessionSpecs>(`/api/sessions/${sessionId}/specs`),
    staleTime: 2000,
  });

/** What attaching something would cost, for the picker before the user commits. */
export const useEstimate = (root: string, path: string | null, mode: AttachMode) =>
  useQuery({
    queryKey: ["specs", root, "estimate", path, mode],
    enabled: !!path,
    queryFn: () => get<{ tokens: number; truncated: boolean }>(`/api/specs/${root}/estimate${qs({ path, mode })}`),
    staleTime: 5000,
    retry: false,
  });

const fail = (e: Error) => toast.error(e.message);

/** Every mutation that can change the files or a session refreshes the same few things. */
function useRefresh(root: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: specKey.root(root) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
    void qc.invalidateQueries({ queryKey: qk.fsAll(root) });
  };
}

/** Open the session a run started, in the agent panel. */
export function showSession(id: string): void {
  const ui = useUi.getState();
  ui.setActiveSession(id);
  ui.setRightTab("agent");
}

export function useSpecActions(root: string) {
  const qc = useQueryClient();
  const refresh = useRefresh(root);

  const initConstitution = useMutation({
    mutationFn: (project?: string) => post<{ path: string }>(`/api/specs/${root}/constitution`, { project }),
    onSuccess: (r) => {
      refresh();
      toast.success(`Wrote ${r.path}`);
    },
    onError: fail,
  });

  const createFeature = useMutation({
    mutationFn: (a: { name: string; description?: string }) => post<{ feature: FeatureInfo }>(`/api/specs/${root}/features`, a),
    onSuccess: refresh,
    onError: fail,
  });

  const toggleTask = useMutation({
    mutationFn: (a: { feature: string; line: number; done?: boolean }) => post<FeatureDetail>(`/api/specs/${root}/features/${encodeURIComponent(a.feature)}/tasks/toggle`, { line: a.line, done: a.done }),
    // The checkbox flips at once; the answer (or the next poll) is the truth.
    onMutate: async (a) => {
      await qc.cancelQueries({ queryKey: specKey.feature(root, a.feature) });
      const prev = qc.getQueryData<FeatureDetail>(specKey.feature(root, a.feature));
      if (prev?.tasks) {
        const tasks = prev.tasks.tasks.map((t) => (t.line === a.line ? { ...t, done: a.done ?? !t.done } : t));
        const done = tasks.filter((t) => t.done).length;
        qc.setQueryData<FeatureDetail>(specKey.feature(root, a.feature), { ...prev, tasks: { ...prev.tasks, tasks, done, phases: prev.tasks.phases.map((p) => ({ ...p, tasks: p.tasks.map((t) => tasks.find((x) => x.line === t.line) ?? t) })) } });
      }
      return { prev };
    },
    onError: (e: Error, a, ctx) => {
      if (ctx?.prev) qc.setQueryData(specKey.feature(root, a.feature), ctx.prev);
      fail(e);
    },
    onSuccess: (r, a) => {
      qc.setQueryData(specKey.feature(root, a.feature), r);
      void qc.invalidateQueries({ queryKey: specKey.root(root) });
    },
  });

  const runStep = useMutation({
    mutationFn: (a: { step: StepName; feature?: string | null; body: Record<string, unknown> }) => post<{ session: SessionView }>(`/api/specs/${root}/steps/${a.step}`, { ...a.body, feature: a.feature ?? undefined }),
    onSuccess: (r) => {
      refresh();
      showSession(r.session.id);
    },
    onError: fail,
  });

  const implement = useMutation({
    mutationFn: (a: { feature: string; body: Record<string, unknown> }) => post<{ mode: string; note: string | null; heads: Array<{ id: string; tasks: string[] }>; session: SessionView }>(`/api/specs/${root}/features/${encodeURIComponent(a.feature)}/implement`, a.body),
    onSuccess: (r) => {
      refresh();
      showSession(r.session.id);
      if (r.note) toast.message(r.note);
      else if (r.heads.length) toast.success(`Opened ${r.heads.length} heads for the parallel tasks`);
    },
    onError: fail,
  });

  const runTask = useMutation({
    mutationFn: (a: { feature: string; line: number; body: Record<string, unknown> }) => post<{ session: SessionView }>(`/api/specs/${root}/features/${encodeURIComponent(a.feature)}/tasks/run`, { ...a.body, line: a.line }),
    onSuccess: (r) => {
      refresh();
      showSession(r.session.id);
    },
    onError: fail,
  });

  const architecture = useMutation({
    mutationFn: (a: { feature?: string | null; topic?: string; body: Record<string, unknown> }) => post<{ session: SessionView; tools: boolean }>(`/api/specs/${root}/architecture`, { ...a.body, feature: a.feature ?? undefined, topic: a.topic }),
    onSuccess: (r) => {
      refresh();
      showSession(r.session.id);
      if (!r.tools) toast.message("The questionnaire needs the daemon's tools; the agent will ask in plain text.");
    },
    onError: fail,
  });

  const writeFile = useMutation({
    mutationFn: (a: { path: string; content: string; create?: boolean }) => put(`/api/specs/${root}/file`, a),
    onSuccess: refresh,
    onError: fail,
  });

  return { initConstitution, createFeature, toggleTask, runStep, implement, runTask, architecture, writeFile };
}

export function useAttachActions(sessionId: string | null) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["attachments"] });
    if (sessionId) void qc.invalidateQueries({ queryKey: specKey.session(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
  };
  const attach = useMutation({
    mutationFn: (a: { path: string; mode: AttachMode }) => post<SessionSpecs & { attached: unknown }>(`/api/sessions/${sessionId}/specs`, a),
    onSuccess: done,
    onError: fail,
  });
  const detach = useMutation({
    mutationFn: (path: string) => del(`/api/sessions/${sessionId}/specs${qs({ path })}`),
    onSuccess: done,
    onError: fail,
  });
  return { attach, detach };
}
