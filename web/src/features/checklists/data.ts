import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Who } from "@/components/agent-who";
import { del, get, patch, post, put } from "@/lib/api";

export type CheckStatus = "pass" | "fail" | "unknown";
/** na: an agent found the item does not apply to this project. Its reason is required. */
export type ItemStatus = CheckStatus | "na";
export type ItemKind = "auto" | "agent" | "manual";
/** Who answered: a check, an audit agent, or a person. */
export type ItemSource = "auto" | "agent" | "manual";
export type Severity = "required" | "recommended";

/** One item of a checklist with its state in this workspace. Mirrors src/checklists/store.ts. */
export interface ChecklistItemState {
  id: string;
  text: string;
  category: string;
  severity: Severity;
  kind: ItemKind;
  check?: string;
  hint: string;
  /** A project-only item: it is in this project's file, not in the catalog. */
  custom?: boolean;
  status: ItemStatus;
  source: ItemSource | null;
  evidence: string | null;
  message: string | null;
  reason: string | null;
  note: string | null;
  updatedAt: string | null;
  /** The Lab finding of a failing item: its id under lab/findings/. */
  finding: string | null;
}

export interface AttachedChecklist {
  id: string;
  title: string;
  summary: string;
  attachedAt: string;
  items: ChecklistItemState[];
  progress: { total: number; passing: number; requiredTotal: number; requiredPassing: number; requiredNotApplicable: number; unverified: number };
}

/** One item of a checklist definition, as the catalog API takes it. */
export interface CatalogItem {
  id: string;
  text: string;
  category: string;
  severity: Severity;
  kind: ItemKind;
  check?: string;
  hint: string;
}

/** A checklist definition: the catalog's, or the operator's edit of it. */
export interface CatalogDef {
  id: string;
  title: string;
  summary: string;
  appliesTo: string[];
  items: CatalogItem[];
}

/** A definition as the catalog page lists it: whether it came with trb, and whether an edit replaces the shipped one. */
export interface CatalogAdminEntry extends CatalogDef {
  builtin: boolean;
  modified: boolean;
}

/** The catalog page: every checklist, the checks an auto item may name, and the limits. */
export interface CatalogAdmin {
  checklists: CatalogAdminEntry[];
  checks: string[];
  kinds: ItemKind[];
  severities: Severity[];
  maxItems: number;
}

export interface CatalogChecklist {
  id: string;
  title: string;
  summary: string;
  appliesTo: string[];
  items: Array<{ id: string }>;
}

/** Something the automatic checks can run against: a running dev server or a deploy target. */
export interface CheckUrl {
  label: string;
  url: string;
  kind: "dev" | "deploy";
}

export interface RunResult {
  ran: number;
  skipped: number;
  results: Array<{ checklistId: string; itemId: string; status: CheckStatus; message: string; evidence: string | null }>;
}

/** The stack the folder is, and the evidence for it. Mirrors src/checklists/stack.ts. */
export interface StackInfo {
  stack: string;
  templateExts: string[];
  evidence: string[];
}

/** An audit of one attached checklist, or of all of them when `checklistId` is null. */
export interface AuditInput extends Who {
  checklistId: string | null;
  fix: boolean;
}

/** The POST an audit starts: the checklist and fix flag, plus the chosen engine and model. */
export function auditRequest(ws: string, v: AuditInput): { path: string; body: AuditInput } {
  return { path: `/api/workspaces/${ws}/checklists/audit`, body: { checklistId: v.checklistId, fix: v.fix, engine: v.engine, model: v.model } };
}

const attachedKey = (ws: string) => ["checklists", ws] as const;
const urlsKey = (ws: string) => ["checklist-urls", ws] as const;
const stackKey = (ws: string) => ["checklist-stack", ws] as const;
const catalogKey = ["checklist-catalog"] as const;
const adminKey = ["checklist-catalog-admin"] as const;

export function useChecklistCatalog() {
  return useQuery({
    queryKey: catalogKey,
    queryFn: async () => (await get<{ checklists: CatalogChecklist[] }>("/api/checklists")).checklists,
    staleTime: Infinity,
  });
}

/** The catalog as the editor sees it: every checklist with its built-in and modified flags, and the checks. */
export function useChecklistAdmin() {
  return useQuery({
    queryKey: adminKey,
    queryFn: () => get<CatalogAdmin>("/api/checklists/catalog"),
  });
}

/** Saves, forks, resets and deletes checklists in the catalog. Every change refreshes the catalog and the attached lists. */
export function useCatalogActions() {
  const qc = useQueryClient();
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: adminKey });
    void qc.invalidateQueries({ queryKey: catalogKey });
    void qc.invalidateQueries({ queryKey: ["checklists"] });
  };

  const save = useMutation({
    mutationFn: (v: { id: string; def: CatalogDef }) => put<{ checklist: CatalogDef }>(`/api/checklists/catalog/${encodeURIComponent(v.id)}`, v.def),
    onSuccess: (_d, v) => {
      refresh();
      toast.success(`${v.id} saved`);
    },
    onError: fail,
  });

  /** A new checklist. With `forkOf`, the fields the definition leaves out are copied from that checklist. */
  const create = useMutation({
    mutationFn: (v: { def: CatalogDef; forkOf?: string }) => post<{ checklist: CatalogDef }>("/api/checklists/catalog", v.forkOf ? { ...v.def, forkOf: v.forkOf } : v.def),
    onSuccess: (_d, v) => {
      refresh();
      toast.success(`${v.def.id} created`);
    },
    onError: fail,
  });

  const reset = useMutation({
    mutationFn: (id: string) => post<{ checklist: CatalogDef }>(`/api/checklists/catalog/${encodeURIComponent(id)}/reset`, {}),
    onSuccess: (_d, id) => {
      refresh();
      toast.success(`${id} is back to its default`);
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/checklists/catalog/${encodeURIComponent(id)}`),
    onSuccess: (_d, id) => {
      refresh();
      toast.success(`${id} deleted`);
    },
    onError: fail,
  });

  return { save, create, reset, remove };
}

export function useAttachedChecklists(ws: string) {
  return useQuery({
    queryKey: attachedKey(ws),
    queryFn: async () => (await get<{ checklists: AttachedChecklist[] }>(`/api/workspaces/${ws}/checklists`)).checklists,
  });
}

export function useCheckUrls(ws: string) {
  return useQuery({
    queryKey: urlsKey(ws),
    queryFn: async () => (await get<{ urls: CheckUrl[] }>(`/api/workspaces/${ws}/checklists/urls`)).urls,
  });
}

export function useStack(ws: string) {
  return useQuery({
    queryKey: stackKey(ws),
    queryFn: () => get<StackInfo>(`/api/workspaces/${ws}/checklists/stack`),
  });
}

/** Every mutation refreshes the attached checklists; a run also refreshes the URL list. */
export function useChecklistActions(ws: string) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: attachedKey(ws) });
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");
  const base = `/api/workspaces/${ws}/checklists`;

  const attach = useMutation({
    mutationFn: (checklistId: string) => post(base, { checklistId }),
    onSuccess: (_d, id) => {
      refresh();
      toast.success(`${id} attached`);
    },
    onError: fail,
  });

  const detach = useMutation({
    mutationFn: (checklistId: string) => del(`${base}/${encodeURIComponent(checklistId)}`),
    onSuccess: (_d, id) => {
      refresh();
      toast.success(`${id} detached`);
    },
    onError: fail,
  });

  const setItem = useMutation({
    mutationFn: (v: { checklistId: string; itemId: string; checked?: boolean | null; note?: string | null; disabled?: boolean }) => {
      const body: Record<string, unknown> = {};
      if (v.checked !== undefined) body.checked = v.checked;
      if (v.note !== undefined) body.note = v.note;
      if (v.disabled !== undefined) body.disabled = v.disabled;
      return patch(`${base}/${encodeURIComponent(v.checklistId)}/items/${encodeURIComponent(v.itemId)}`, body);
    },
    onSuccess: refresh,
    onError: fail,
  });

  /** A project-only item, added to one attached checklist (agent or manual). */
  const addItem = useMutation({
    mutationFn: (v: { checklistId: string; item: { text: string; category: string; severity: Severity; kind: "agent" | "manual"; hint: string } }) => post(`${base}/${encodeURIComponent(v.checklistId)}/items`, v.item),
    onSuccess: () => {
      refresh();
      toast.success("Item added to this project");
    },
    onError: fail,
  });

  const removeItem = useMutation({
    mutationFn: (v: { checklistId: string; itemId: string }) => del(`${base}/${encodeURIComponent(v.checklistId)}/items/${encodeURIComponent(v.itemId)}`),
    onSuccess: refresh,
    onError: fail,
  });

  const run = useMutation({
    mutationFn: (url: string | null) => post<RunResult>(`${base}/run`, { url }),
    onSuccess: (r) => {
      refresh();
      const failing = r.results.filter((x) => x.status === "fail").length;
      const unknown = r.results.filter((x) => x.status === "unknown").length;
      toast.success(`${r.ran} checked: ${r.ran - failing - unknown} pass, ${failing} fail, ${unknown} unknown`);
    },
    onError: fail,
  });

  /** Starts an audit session. `checklistId` null covers every attached checklist. `fix` also fixes failing items first. */
  const audit = useMutation({
    mutationFn: (v: AuditInput) => {
      const r = auditRequest(ws, v);
      return post<{ sessionId: string }>(r.path, r.body);
    },
    onSuccess: (r) => toast.success(`Audit session ${r.sessionId} started`),
    onError: fail,
  });

  return { attach, detach, setItem, addItem, removeItem, run, audit };
}
