import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, patch, post } from "@/lib/api";
import type { SessionView } from "@/lib/types";
import type { BugKind } from "./logic";

/** `checklist` is the launch-checklist pass: started from the checklist panel, filtered here like the others. */
export type Lens = "features" | "ui" | "ux" | "ai" | "perf" | "dx" | "review" | "security" | "checklist" | "bug";
export type Impact = "high" | "medium" | "low";
export type Effort = "s" | "m" | "l";
export type Status = "new" | "accepted" | "dismissed" | "shipped";

export interface Finding {
  id: string;
  path: string;
  title: string;
  lens: Lens | null;
  scope: string | null;
  impact: Impact;
  effort: Effort;
  status: Status;
  evidence: string[];
  missing: string[];
  unmeasured: boolean;
  roadmap: string | null;
  spec: string | null;
  /** `<checklistId>/<itemId>` for a finding raised by a failing checklist item. */
  checklist: string | null;
  /** Set exactly when `lens` is `bug`: the page, its evidence capture id, and how the screenshot was taken. */
  bug: { url: string; capture: string | null; shot: "desktop" | "rerender" | "none"; kind: BugKind } | null;
  /** The session that wrote or last changed the file during a run. */
  session: string | null;
  /** The fix session started from this finding. */
  fixSession: string | null;
  /** That fix session is still running: the Fix button stays off. */
  fixRunning: boolean;
  /** Evidence whose line changed since the run that cited it. */
  drifted: string[];
  summary: string;
  body: string;
  updatedAt: number;
  problem: string | null;
}

export interface LensInfo {
  id: Lens;
  label: string;
  hint: string;
  /** False for a lens the operator does not start from this tab (the checklist pass). */
  runnable: boolean;
}

export interface ModuleInfo {
  path: string;
  files: number;
  tokens: number;
}

export interface LabRun {
  sessionId: string;
  lens: string;
  scope: string;
  sweepId: string | null;
  touched: string[];
  at: string;
}

export interface SweepView {
  id: string;
  /** `fix` queues findings to fix one at a time; `run` queues modules for a lens. */
  kind: "run" | "fix";
  lens: string;
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  /** The reason the last module could not start. */
  lastError: string | null;
  cancelled: boolean;
  at: string;
}

export interface LabState {
  findings: Finding[];
  open: number;
  lenses: LensInfo[];
  runs: LabRun[];
  sweeps: SweepView[];
  modules: ModuleInfo[];
}

export interface SweepPlan {
  lens: Lens;
  modules: ModuleInfo[];
  tokens: number;
  skipped: string[];
}

export interface Who {
  engine?: string;
  model?: string;
}

export interface RunInput extends Who {
  lens: Lens;
  scope: string;
  note?: string;
}

export const labKey = (root: string) => ["lab", root] as const;

export const useLab = (root: string) =>
  useQuery({
    queryKey: labKey(root),
    queryFn: () => get<LabState>(`/api/lab/${root}`),
    // Agents write findings while the tab is open: look again while it is on screen.
    refetchInterval: () => (document.visibilityState === "visible" ? 4000 : false),
    staleTime: 1500,
  });

/** Open findings and open bugs for the activity bar badges: the summary endpoint, not the whole state. */
export const useLabCounts = (root: string | null) =>
  useQuery({ queryKey: ["lab", root ?? "", "summary"], enabled: !!root, queryFn: () => get<{ open: number; bugs: number; total: number; running: number }>(`/api/lab/${root}/summary`), staleTime: 15_000, refetchInterval: () => (document.visibilityState === "visible" ? 30_000 : false) });

/** The folders a sweep can cover. The server caches the scan for a minute, so the picker asks once per open. */
export const useModules = (root: string | null) =>
  useQuery({ queryKey: ["lab", root ?? "", "modules"], enabled: !!root, queryFn: () => get<{ modules: ModuleInfo[] }>(`/api/lab/${root}/modules`).then((r) => r.modules), staleTime: 60_000 });

export const useSweepPlan = (root: string, lens: Lens, limit: number, enabled: boolean) =>
  useQuery({ queryKey: ["lab", root, "sweep", lens, limit], enabled, queryFn: () => get<{ plan: SweepPlan }>(`/api/lab/${root}/sweep?lens=${lens}&limit=${limit}`).then((r) => r.plan), staleTime: 5000 });

export function useLabActions(root: string) {
  const qc = useQueryClient();
  const base = `/api/lab/${root}`;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: labKey(root) });
    void qc.invalidateQueries({ queryKey: ["sessions"] });
    void qc.invalidateQueries({ queryKey: ["roadmap", root] });
  };
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");
  const mut = <V, R>(fn: (v: V) => Promise<R>) => useMutation({ mutationFn: fn, onSuccess: refresh, onError });
  return {
    run: mut((v: RunInput) => post<{ session: SessionView }>(`${base}/run`, v)),
    sweep: mut((v: Who & { lens: Lens; scopes: string[]; limit: number; parallel: number; note?: string }) => post<{ sweepId: string; sessions: SessionView[]; plan: SweepPlan }>(`${base}/sweep`, v)),
    fixAllBugs: mut((v: Who) => post<{ sweep: SweepView; sessions: SessionView[] }>(`${base}/bugs/fix-all`, v)),
    cancelSweep: mut((id: string) => post<{ sweep: SweepView }>(`${base}/sweeps/${encodeURIComponent(id)}/cancel`, {})),
    setStatus: mut((v: { id: string; status: Status }) => patch<{ finding: Finding }>(`${base}/findings/${encodeURIComponent(v.id)}`, { status: v.status })),
    remove: mut((id: string) => del<{ ok: true }>(`${base}/findings/${encodeURIComponent(id)}`)),
    toRoadmap: mut((id: string) => post<{ finding: Finding; itemId: string }>(`${base}/findings/${encodeURIComponent(id)}/roadmap`, {})),
    toSpec: mut((id: string) => post<{ finding: Finding; session: SessionView }>(`${base}/findings/${encodeURIComponent(id)}/spec`, {})),
    fix: mut((id: string) => post<{ finding: Finding; session: SessionView }>(`${base}/findings/${encodeURIComponent(id)}/fix`, {})),
    design: mut((id: string) => post<{ finding: Finding; session: SessionView }>(`${base}/findings/${encodeURIComponent(id)}/design`, {})),
  };
}

export type Actions = ReturnType<typeof useLabActions>;
