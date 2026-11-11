import type { Finding, Impact, Lens, Status } from "./data";
export { BUG_KINDS, type BugKind } from "./kinds";

export type StatusFilter = "open" | "dismissed" | "shipped" | "all";

export const IMPACT_TONE: Record<Impact, "red" | "amber" | "neutral"> = { high: "red", medium: "amber", low: "neutral" };
export const EFFORT_LABEL = { s: "small", m: "medium", l: "large" } as const;

export const inFilter = (status: Status, f: StatusFilter): boolean => (f === "all" ? true : f === "open" ? status === "new" || status === "accepted" : status === f);

/** Bugs are logged from the browser and live in the QA view: the findings list leaves them out. */
export const isBug = (f: Pick<Finding, "lens">): boolean => f.lens === "bug";

/** The finding whose fix is running. Every fix edits the project folder, so while one runs no other may start. */
export const runningFix = (list: Pick<Finding, "id" | "title" | "fixRunning" | "fixSession">[]) => list.find((x) => x.fixRunning) ?? null;

/** Why a fix cannot start on `id` right now, or null when it can. */
export function fixBlock(list: Pick<Finding, "id" | "title" | "fixRunning" | "fixSession">[], id: string): string | null {
  const r = runningFix(list);
  if (!r) return null;
  return r.id === id ? "A fix for this finding is still running" : `A fix for "${r.title}" is running${r.fixSession ? ` (${r.fixSession})` : ""}. Fixes share the project folder: wait for it to finish.`;
}

export interface Filter {
  status: StatusFilter;
  lens: Lens | "all";
}

export const NO_FILTER: Filter = { status: "open", lens: "all" };

export const applyFilter = (list: Finding[], f: Filter): Finding[] => list.filter((x) => inFilter(x.status, f.status) && (f.lens === "all" || x.lens === f.lens));

export const countByStatus = (list: Finding[]): Record<StatusFilter, number> => ({
  open: list.filter((x) => inFilter(x.status, "open")).length,
  dismissed: list.filter((x) => x.status === "dismissed").length,
  shipped: list.filter((x) => x.status === "shipped").length,
  all: list.length,
});

/** "12k tokens", "850 tokens": what a sweep is about to read, at a glance. */
export function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k tokens`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${n} tokens`;
}

/** A finding's `checklist` field, `<checklistId>/<itemId>`: the item id has no slash, so the item is what follows the last one. */
export function checklistRef(ref: string | null): { checklist?: string; item?: string } {
  const i = ref ? ref.lastIndexOf("/") : -1;
  if (!ref || i <= 0 || i === ref.length - 1) return {};
  return { checklist: ref.slice(0, i), item: ref.slice(i + 1) };
}

/** `path/to/file.ts:84` or `path/to/file.ts` (with an optional `:line:col` or `#L84`): the file and the line. */
export function splitEvidence(e: string): { path: string; line: number | null } | null {
  const m = /^([^\s:#][^\s:#]*?)(?:[:#]L?(\d+))?(?::\d+)?(?:-\d+)?$/.exec(e.trim());
  if (!m || !/[./]/.test(m[1]!)) return null;
  return { path: m[1]!, line: m[2] ? Number(m[2]) : null };
}
