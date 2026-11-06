import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, post, put } from "@/lib/api";

export interface Pack {
  id: string;
  title: string;
  summary: string;
  appliesTo: string[];
  rules: string[];
  skills?: string[];
  /** The checks this pack carries now (built-in packs only). */
  checks?: string[];
  custom: boolean;
  /** A built-in pack with an edit on file. Reset puts it back. */
  modified: boolean;
  /** The checks a built-in pack can carry. Empty for a custom pack. */
  knownChecks: string[];
}

export interface Thresholds {
  maxFileLines: number;
  maxFunctionLines: number;
}

export type Enforce = "off" | "warn" | "fix";

/** What is switched off inside one enabled pack, in one workspace. */
export interface Switched {
  rules: string[];
  checks: string[];
}

export interface PracticeSettings {
  enabled: string[];
  thresholds: Thresholds;
  enforce: Enforce;
  off: Record<string, Switched>;
}

export interface PracticeCatalog {
  packs: Pack[];
  stacks: string[];
  defaults: Thresholds;
  enforce: Enforce;
  checkIds: string[];
}

/** What a pack save sends: the editable fields, and the id for a new custom pack. */
export interface PackInput {
  id?: string;
  title: string;
  summary: string;
  appliesTo: string[];
  rules: string[];
  skills?: string[];
  checks?: string[];
}

export interface PracticeFinding {
  packId: string;
  check: string;
  file: string;
  line?: number;
  message: string;
}

/** A file of the main stack that no enabled check reads. `reason` names the files and says they are not checked mechanically. */
export interface SkippedNote {
  check: string | null;
  reason: string;
}

export interface CheckReport {
  packs: string[];
  checked: number;
  findings: PracticeFinding[];
  skipped: SkippedNote[];
}

const catalogKey = ["practices-catalog"] as const;
const settingsKey = (ws: string) => ["practices-settings", ws] as const;

export function usePracticeCatalog() {
  return useQuery({
    queryKey: catalogKey,
    queryFn: () => get<PracticeCatalog>("/api/practices"),
  });
}

export function usePracticeSettings(ws: string) {
  return useQuery({
    queryKey: settingsKey(ws),
    queryFn: () => get<PracticeSettings>(`/api/workspaces/${ws}/practices`),
  });
}

/** Saving refreshes the settings; a check reports findings for the whole repo and touches no state. */
export function usePracticeActions(ws: string) {
  const qc = useQueryClient();
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");

  const save = useMutation({
    mutationFn: (v: Partial<PracticeSettings>) => put<PracticeSettings>(`/api/workspaces/${ws}/practices`, v),
    onSuccess: (settings) => {
      qc.setQueryData(settingsKey(ws), settings);
      toast.success("Practices saved");
    },
    onError: fail,
  });

  const check = useMutation({
    mutationFn: () => post<CheckReport>(`/api/workspaces/${ws}/practices/check`, {}),
    onError: fail,
  });

  return { save, check };
}

/**
 * Edits to the catalog: a built-in pack edited in place, a custom pack created or replaced, a built-in forked into a custom
 * copy, a built-in reset, a custom pack deleted. Each refreshes the catalog and every workspace's settings, since a rule
 * change reaches every workspace that has the pack on.
 */
export function usePackActions() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: catalogKey });
    void qc.invalidateQueries({ queryKey: ["practices-settings"] });
  };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");
  const done = (what: string) => () => {
    refresh();
    toast.success(what);
  };

  const create = useMutation({
    mutationFn: (v: PackInput) => post<{ pack: Pack }>("/api/practices/custom", v),
    onSuccess: done("Pack created"),
    onError: fail,
  });
  const edit = useMutation({
    mutationFn: ({ id, ...v }: PackInput & { id: string }) => put<{ pack: Pack }>(`/api/practices/packs/${encodeURIComponent(id)}`, v),
    onSuccess: done("Pack saved"),
    onError: fail,
  });
  const fork = useMutation({
    mutationFn: ({ id }: { id: string }) => post<{ pack: Pack }>(`/api/practices/packs/${encodeURIComponent(id)}/fork`, {}),
    onSuccess: done("Forked into a custom pack"),
    onError: fail,
  });
  const reset = useMutation({
    mutationFn: ({ id }: { id: string }) => post<{ pack: Pack }>(`/api/practices/packs/${encodeURIComponent(id)}/reset`, {}),
    onSuccess: done("Reset to the shipped pack"),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: ({ id }: { id: string }) => del(`/api/practices/packs/${encodeURIComponent(id)}`),
    onSuccess: done("Pack deleted"),
    onError: fail,
  });

  return { create, edit, fork, reset, remove };
}
