import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Who } from "@/components/agent-who";
import { del, get, patch, post, put } from "@/lib/api";
import type { SessionView } from "@/lib/types";

export type FindingKind = "feature" | "ui";
export type FindingStatus = "new" | "planned" | "built" | "dismissed";
export type TargetKind = "web" | "electron" | "binary" | "android" | "other";
/** What an investigation is created with: a kind, or "auto" to work the kind out from the target. */
export type TargetKindChoice = TargetKind | "auto";
export type RunStatus = "running" | "idle" | "failed" | "closed" | "gone";

/** One agent session that studied an investigation. Newest first on the investigation. */
export interface InvestigationRun {
  id: string;
  session_id: string;
  status: RunStatus;
  created_at: string;
  note: string | null;
}

/** How a run is started: the engine, model and agent, and a focus line. All optional: the server picks the defaults. */
export interface RunOptions {
  engine?: string;
  model?: string;
  effort?: string;
  agent?: string;
  pairId?: string;
  note?: string;
}

export interface EvidenceItem {
  id: string;
  kind: "page" | "note";
  title: string;
  url: string | null;
  summary: string;
  refs: string[];
  files: Record<string, number>;
  bytes: number;
  session_id: string | null;
  created_at: string;
  investigation_id: string | null;
  /** A feature or a UI design the operator can build; null for plain evidence. */
  finding: FindingKind | null;
  finding_status: FindingStatus | null;
  /** Who made it: a browser capture, REA, an agent's note, or the operator. */
  source: "browser" | "rea" | "agent" | "operator" | null;
}

export interface CreateInvestigationInput extends Who {
  title: string;
  target?: string;
  target_kind?: TargetKindChoice;
  /** Start a run as well as creating it. */
  run?: boolean;
  /** The focus line the run's prompt carries. */
  note?: string;
}

/** The create POST body: the picked engine and model travel with the run, and are left out when unpicked. */
export function createInvestigationBody(a: CreateInvestigationInput): Record<string, unknown> {
  return { title: a.title, target: a.target, target_kind: a.target_kind, note: a.note, run: a.run === true, ...(a.engine ? { engine: a.engine } : {}), ...(a.model ? { model: a.model } : {}) };
}

export interface Investigation {
  id: string;
  title: string;
  target: string | null;
  target_kind: TargetKind;
  /** Why the kind is what it is, when it was worked out from the target; null when the operator chose it. */
  kind_reason: string | null;
  status: "open" | "closed";
  session_id: string | null;
  summary: string;
  created_at: string;
  closed_at: string | null;
  counts: { pages: number; notes: number; findings: number; new: number; planned: number; built: number; dismissed: number };
  /** Agent runs on this investigation, newest first. */
  runs: InvestigationRun[];
  /** An agent is working on it now. */
  running: boolean;
}

/** The create answer: `session` when a run was asked for and started; `runError` when it was asked for and could not start. `detected` when the kind was worked out (null when chosen). */
export interface CreatedInvestigation {
  investigation: Investigation;
  session: SessionView | null;
  runError?: string;
  detected?: { kind: TargetKind; reason: string } | null;
}

export interface EvidenceList {
  enabled: boolean;
  browser: boolean;
  rea: { enabled: boolean; available: boolean; version: string; source: "override" | "npx" | null };
  items: EvidenceItem[];
  investigations: Investigation[];
}

export interface EvidenceDetail {
  item: EvidenceItem;
  cites: EvidenceItem[];
  citedBy: EvidenceItem[];
}

/** Colors, fonts, radii and the rest as captured: `[value, count]` pairs, most used first. */
export interface CapturedStyles {
  tokens: Record<string, string>;
  colors: { text: Array<[string, number]>; background: Array<[string, number]>; border: Array<[string, number]> };
  fonts: { families: Array<[string, number]>; sizes: Array<[string, number]>; weights: Array<[string, number]> };
  radii: Array<[string, number]>;
  shadows: Array<[string, number]>;
  spacing: Array<[string, number]>;
}

/** Most findings one build takes. Mirrors MAX_BUILD_FINDINGS in src/evidence/investigations.ts. */
export const MAX_BUILD = 20;

export interface EvidenceQuery {
  q: string;
  kind: "all" | "page" | "note";
  /** An investigation's id, or undefined for all evidence. */
  investigation?: string;
}

const base = (root: string) => `/api/evidence/${root}`;
export const evKey = (root: string) => ["evidence", root] as const;

export const partUrl = (root: string, id: string, part: string) => `${base(root)}/${encodeURIComponent(id)}/file/${part}`;

/** While an agent is studying an investigation, the list is refetched so captures and findings show as they are saved. */
const RUNNING_POLL_MS = 3000;

export function useEvidence(root: string, { q: query, kind, investigation }: EvidenceQuery) {
  const q = new URLSearchParams({
    ...(query.trim() ? { q: query.trim() } : {}),
    ...(kind !== "all" ? { kind } : {}),
    ...(investigation ? { investigation } : {}),
  }).toString();
  return useQuery({
    queryKey: [...evKey(root), q] as const,
    queryFn: () => get<EvidenceList>(`${base(root)}${q ? `?${q}` : ""}`),
    retry: false,
    refetchInterval: (query) => (query.state.data?.investigations.some((i) => i.running) ? RUNNING_POLL_MS : false),
  });
}

export const useEvidenceDetail = (root: string, id: string | null) =>
  useQuery({ queryKey: [...evKey(root), "item", id] as const, queryFn: () => get<EvidenceDetail>(`${base(root)}/${encodeURIComponent(id!)}`), enabled: Boolean(id), retry: false });

export const useCapturedStyles = (root: string, item: EvidenceItem | null) =>
  useQuery({ queryKey: [...evKey(root), "styles", item?.id] as const, queryFn: () => get<CapturedStyles>(partUrl(root, item!.id, "styles.json")), enabled: Boolean(item && "styles.json" in item.files), retry: false });

export function useEvidenceActions(root: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: evKey(root) });
  const onError = (e: Error) => toast.error(e.message);
  return {
    capture: useMutation({ mutationFn: (a: { sessionId: string; label?: string; investigation_id?: string }) => post<{ item: EvidenceItem }>(`${base(root)}/capture`, a), onSuccess: (r) => (toast.success(`Captured ${r.item.title}`), refresh()), onError }),
    note: useMutation({ mutationFn: (a: { title: string; text: string; refs: string[]; finding?: FindingKind; investigation_id?: string }) => post<{ item: EvidenceItem }>(`${base(root)}/note`, a), onSuccess: refresh, onError }),
    remove: useMutation({ mutationFn: (id: string) => del(`${base(root)}/${encodeURIComponent(id)}`), onSuccess: refresh, onError }),
    exportDoc: useMutation({ mutationFn: (id: string) => post<{ page: { path: string } }>(`${base(root)}/${encodeURIComponent(id)}/export`), onSuccess: (r) => (toast.success(`Wrote ${r.page.path}`), void qc.invalidateQueries({ queryKey: ["docs"] })), onError }),
    setFindingStatus: useMutation({ mutationFn: (a: { id: string; status: FindingStatus }) => patch<{ item: EvidenceItem }>(`${base(root)}/${encodeURIComponent(a.id)}`, { finding_status: a.status }), onSuccess: refresh, onError }),
    /** Mark findings as planned once a build prompt has gone to the composer. */
    markPlanned: useMutation({ mutationFn: (ids: string[]) => Promise.all(ids.map((id) => patch(`${base(root)}/${encodeURIComponent(id)}`, { finding_status: "planned" }))), onSuccess: refresh, onError }),
    build: useMutation({ mutationFn: (ids: string[]) => post<{ prompt: string; ids: string[] }>(`${base(root)}/build`, { ids }), onError }),
    createInvestigation: useMutation({
      mutationFn: (a: CreateInvestigationInput) => post<CreatedInvestigation>(`${base(root)}/investigations`, createInvestigationBody(a)),
      onSuccess: (r) => {
        if (r.session) toast.success("Run started");
        void refresh();
      },
      onError,
    }),
    updateInvestigation: useMutation({ mutationFn: (a: { id: string; status?: "open" | "closed"; summary?: string; title?: string }) => patch<{ investigation: Investigation }>(`${base(root)}/investigations/${encodeURIComponent(a.id)}`, { status: a.status, summary: a.summary, title: a.title }), onSuccess: refresh, onError }),
    removeInvestigation: useMutation({ mutationFn: (a: { id: string; withEvidence: boolean }) => del<{ removed: unknown }>(`${base(root)}/investigations/${encodeURIComponent(a.id)}${a.withEvidence ? "?withEvidence=1" : ""}`), onSuccess: refresh, onError }),
  };
}

/** Start an agent run on an investigation: a new session that studies its target and saves what it finds here. */
export function useRunInvestigation(root: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...opts }: RunOptions & { id: string }) => post<{ investigation: Investigation; session: SessionView }>(`${base(root)}/investigations/${encodeURIComponent(id)}/run`, opts),
    onSuccess: () => {
      toast.success("Run started");
      void qc.invalidateQueries({ queryKey: evKey(root) });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** The two switches, both on by default: evidence tools for sessions, and the third-party REA server. */
export function useEvidenceSwitches() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["evidence-switches"] as const, queryFn: () => get<{ settings: Array<{ key: string; value: string }> }>("/api/config").then((r) => Object.fromEntries(r.settings.filter((s) => s.key === "evidence" || s.key === "rea_mcp").map((s) => [s.key, s.value === "on"])) as { evidence: boolean; rea_mcp: boolean }) });
  const set = useMutation({
    mutationFn: (a: { key: "evidence" | "rea_mcp"; on: boolean }) => put(`/api/config/${a.key}`, { value: a.on ? "on" : "off" }),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ["evidence-switches"] }), void qc.invalidateQueries({ queryKey: ["evidence"] }), void qc.invalidateQueries({ queryKey: ["config"] })),
    onError: (e: Error) => toast.error(e.message),
  });
  return { status, set };
}
