/** Server state for the settings pages: queries, and mutations that report failures in the daemon's words. */
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, patch, post, put } from "@/lib/api";
import type { Agent, McpServer, Pair, PairRecipe, RolePreset, Setting, Skill } from "@/lib/types";
import type { SkillPack, SkillPackCounts } from "./skills-logic";

export const keys = {
  roles: ["roles"] as const,
  recipes: ["pairs", "cookbook"] as const,
  mcp: ["mcp"] as const,
  skills: ["skills"] as const,
  skillPacks: ["skills", "packs"] as const,
  config: ["config"] as const,
  doctor: ["doctor"] as const,
  skillFile: (name: string) => ["skills", name, "file"] as const,
};

export interface ProbeTool {
  name: string;
  description: string;
}
export interface ProbeResult {
  name: string;
  ok: boolean;
  transport: "stdio" | "http";
  server?: { name: string; version: string };
  tools: ProbeTool[];
  latencyMs: number;
  error?: string;
  stderrTail?: string;
}

export interface DoctorCheck {
  id: string;
  level: "ok" | "warn" | "fail";
  text: string;
}
export interface DoctorEngine {
  id: string;
  label: string;
  installed: boolean;
  bin: string | null;
  version: string;
  mcp: "config-file" | "cli-override" | "workspace-file" | "none";
  skills_dir: string | null;
  resume: boolean;
  canLead: boolean;
}
export interface DoctorReport {
  checks: DoctorCheck[];
  engines: DoctorEngine[];
  status: "ok" | "warn" | "fail";
  counts: { pairs: number; mcp: number; mcpEnabled: number; skills: number; skillsEnabled: number };
}

export interface SkillFile {
  name: string;
  dir: string;
  content: string;
  mtime: number;
  files: Array<{ name: string; size: number; dir: boolean }>;
}

export interface McpImportPreview {
  file: string;
  added: string[];
  skipped: string[];
  invalid: string[];
  servers: Record<string, { transport: "stdio" | "http"; target: string }>;
}

export const useRoles = () => useQuery({ queryKey: keys.roles, queryFn: () => get<{ roles: RolePreset[] }>("/api/roles").then((r) => r.roles), staleTime: Infinity });
export const useRecipes = () => useQuery({ queryKey: keys.recipes, queryFn: () => get<{ recipes: PairRecipe[] }>("/api/pairs/cookbook").then((r) => r.recipes), staleTime: Infinity });
export const useMcp = () => useQuery({ queryKey: keys.mcp, queryFn: () => get<{ servers: McpServer[] }>("/api/mcp").then((r) => r.servers) });
export const useSkills = () => useQuery({ queryKey: keys.skills, queryFn: () => get<{ skills: Skill[] }>("/api/skills").then((r) => r.skills) });
export const useSkillPacks = () => useQuery({ queryKey: keys.skillPacks, queryFn: () => get<SkillPack[]>("/api/skills/packs"), staleTime: 60_000 });
export const useConfig = () => useQuery({ queryKey: keys.config, queryFn: () => get<{ settings: Setting[] }>("/api/config").then((r) => r.settings) });
export const useDoctor = () => useQuery({ queryKey: keys.doctor, queryFn: () => get<DoctorReport>("/api/doctor"), staleTime: 60_000 });
export const useSkillFile = (name: string | null) => useQuery({ queryKey: keys.skillFile(name ?? ""), enabled: !!name, queryFn: () => get<SkillFile>(`/api/skills/${encodeURIComponent(name!)}/file`), staleTime: 0, refetchOnWindowFocus: false });

/**
 * A mutation that invalidates what it changed and toasts the daemon's own message on failure, so every page
 * handles errors the same way and a failed call is never silent.
 */
export function useAction<A, R = unknown>(fn: (arg: A) => Promise<R>, opts: { invalidate?: QueryKey[]; success?: string | ((r: R, a: A) => string | null); quiet?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, a) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      const msg = typeof opts.success === "function" ? opts.success(r, a) : opts.success;
      if (msg) toast.success(msg);
    },
    onError: (e: Error) => {
      if (!opts.quiet) toast.error(e.message);
    },
  });
}

export const api = {
  agents: {
    create: (payload: Record<string, unknown>) => post<{ agent: Agent }>("/api/agents", payload),
    fromRole: (role: string, name?: string) => post<{ agent: Agent }>("/api/agents", { fromRole: role, name }),
    update: (name: string, payload: Record<string, unknown>) => patch<{ agent: Agent }>(`/api/agents/${encodeURIComponent(name)}`, payload),
    remove: (name: string, force = false) => del<{ removed: boolean }>(`/api/agents/${encodeURIComponent(name)}${force ? "?force=1" : ""}`),
    reset: (name: string) => post<{ agent: Agent }>(`/api/agents/${encodeURIComponent(name)}/reset`),
    restoreBuiltins: () => post<{ added: string[] }>("/api/agents/restore-builtins"),
  },
  pairs: {
    create: (payload: Record<string, unknown>) => post<{ pair: Pair }>("/api/pairs", payload),
    fromRecipe: (recipe: string) => post<{ pair: Pair }>("/api/pairs", { recipe }),
    update: (id: string, payload: Record<string, unknown>) => patch<{ pair: Pair }>(`/api/pairs/${id}`, payload),
    remove: (id: string) => del(`/api/pairs/${id}`),
  },
  mcp: {
    add: (s: { name: string; command?: string | null; args?: string[]; env?: Record<string, string>; url?: string | null; headers?: Record<string, string> }) => post<{ server: McpServer }>("/api/mcp", s),
    edit: (name: string, s: { command?: string | null; args?: string[]; env?: Record<string, string>; url?: string | null; headers?: Record<string, string> }) => put<{ server: McpServer }>(`/api/mcp/${encodeURIComponent(name)}`, s),
    remove: (name: string) => del(`/api/mcp/${encodeURIComponent(name)}`),
    toggle: (name: string, on: boolean) => post(`/api/mcp/${encodeURIComponent(name)}/${on ? "enable" : "disable"}`),
    test: (name: string) => post<ProbeResult>(`/api/mcp/${encodeURIComponent(name)}/test`),
    importFrom: (from: string, o: { overwrite?: boolean; dryRun?: boolean }) => post<McpImportPreview>("/api/mcp/import", { from, ...o }),
  },
  skills: {
    create: (name: string, description: string) => post<{ skill: Skill }>("/api/skills/create", { name, description }),
    addFolder: (path: string, force: boolean) => post<{ skill: Skill }>("/api/skills", { path, force }),
    importDir: (dir: string, overwrite: boolean) => post<{ dir: string; added: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> }>("/api/skills/import", { dir, overwrite }),
    remove: (name: string) => del(`/api/skills/${encodeURIComponent(name)}`),
    toggle: (name: string, on: boolean) => post(`/api/skills/${encodeURIComponent(name)}/${on ? "enable" : "disable"}`),
    togglePack: (id: string, on: boolean) => post<SkillPackCounts>(`/api/skills/packs/${encodeURIComponent(id)}/enabled`, { enabled: on }),
    save: (name: string, content: string, expectedMtime: number) => put<{ ok: true; mtime: number; description: string }>(`/api/skills/${encodeURIComponent(name)}/file`, { content, expectedMtime }),
  },
  config: {
    set: (key: string, value: string) => put(`/api/config/${key}`, { value }),
    reset: (key: string) => del(`/api/config/${key}`),
  },
};


