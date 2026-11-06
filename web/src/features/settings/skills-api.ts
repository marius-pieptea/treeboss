/** The calls the skills UI makes beyond the basic list/toggle ones in data.ts: scan, import jobs, browsing, and a skill's own files. */
import { del, get, post, qs } from "@/lib/api";
import { sortEntries, type FsEntry, type ImportJobState, type ScanResult } from "./skills-logic";

export interface Browse {
  path: string;
  parent: string | null;
  home: string;
  repo: boolean;
  entries: Array<{ name: string; path: string; repo: boolean }>;
}

export const skillsApi = {
  browse: (path: string) => get<Browse>(`/api/browse${qs({ path })}`),
  scan: (dir: string) => post<ScanResult>("/api/skills/import/scan", { dir }),
  start: (dir: string, names: string[] | null, overwrite: boolean) => post<{ job: ImportJobState }>("/api/skills/import/start", { dir, names, overwrite }),
  job: (id: string) => get<{ job: ImportJobState }>(`/api/skills/import/jobs/${id}`).then((r) => r.job),
  cancel: (id: string) => post<{ cancelled: boolean }>(`/api/skills/import/jobs/${id}/cancel`),
};

/** A stored skill's folder is a file root named k_<skill>. */
export const skillRoot = (name: string) => `k_${name}`;

export const skillFs = {
  tree: (name: string, path: string) => get<{ entries: FsEntry[] }>(`/api/fs/${skillRoot(name)}/tree${qs({ path })}`).then((r) => sortEntries(r.entries)),
  create: (name: string, path: string, type: "file" | "dir") => post(`/api/fs/${skillRoot(name)}/create`, { path, type }),
  rename: (name: string, from: string, to: string) => post(`/api/fs/${skillRoot(name)}/rename`, { from, to }),
  remove: (name: string, path: string) => del(`/api/fs/${skillRoot(name)}/file${qs({ path })}`),
};

export const skillKeys = {
  tree: (name: string, path: string) => ["skillfs", name, "tree", path] as const,
  all: (name: string) => ["skillfs", name] as const,
  stats: (name: string) => ["skillfs", name, "stats"] as const,
  source: (name: string, source: string | null) => ["skillfs", name, "source", source] as const,
};
