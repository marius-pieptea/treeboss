/** What a session can have attached: specs, plans and docs, grouped for the picker. */
import { attachLabel as specLabel, compact, costTone, type AttachMode } from "@/features/specs/logic";
import type { Freshness } from "@/features/docs/logic";

export type { AttachMode };
export { compact, costTone };
export type AttachKind = "spec" | "plan" | "doc";

export interface AttachItem {
  path: string;
  mode: AttachMode;
  kind?: AttachKind;
}

export interface Candidate {
  path: string;
  title: string;
  sub: string;
}

export interface Candidates {
  specs: Candidate[];
  plans: Candidate[];
  docs: Candidate[];
}

export interface AttachedRow {
  path: string;
  kind: AttachKind;
  mode: AttachMode;
  purpose: string;
  delivered: boolean;
}

export const KIND_LABEL: Record<AttachKind, string> = { spec: "Specs", plan: "Plans", doc: "Docs" };
export const GROUPS: Array<{ kind: AttachKind; key: keyof Candidates }> = [
  { kind: "spec", key: "specs" },
  { kind: "plan", key: "plans" },
  { kind: "doc", key: "docs" },
];

/** The kind of a path the way the daemon decides it, for chips shown before a session exists. */
export function guessKind(path: string, plansDir = "plans"): AttachKind {
  if (path === plansDir || path.startsWith(`${plansDir}/`)) return "plan";
  if (path.startsWith("specs/") || path.startsWith(".specify/")) return "spec";
  return "doc";
}

export function labelFor(path: string, kind: AttachKind, titles: Map<string, string>): string {
  const t = titles.get(path);
  if (t) return t;
  if (kind === "spec") return specLabel(path);
  return path.split("/").pop()?.replace(/\.mdx?$/, "") ?? path;
}

export const isFreshness = (s: string): s is Freshness => ["fresh", "drifting", "stale", "unknown", "unmanaged"].includes(s);

/** Chips and a list read as one thing: merge what is attached with the pending choice, newest last. */
export function summarize(items: AttachItem[]): { total: number; byKind: Record<AttachKind, number> } {
  const byKind: Record<AttachKind, number> = { spec: 0, plan: 0, doc: 0 };
  for (const i of items) byKind[i.kind ?? guessKind(i.path)]++;
  return { total: items.length, byKind };
}
