import type { Finding, Impact, Lens, Status } from "./data";
import { BUG_KINDS, type BugKind } from "./kinds";

export { BUG_KINDS, type BugKind } from "./kinds";

export type StatusFilter = "open" | "dismissed" | "shipped" | "all";

export const IMPACT_TONE: Record<Impact, "red" | "amber" | "neutral"> = { high: "red", medium: "amber", low: "neutral" };
export const EFFORT_LABEL = { s: "small", m: "medium", l: "large" } as const;

export const inFilter = (status: Status, f: StatusFilter): boolean => (f === "all" ? true : f === "open" ? status === "new" || status === "accepted" : status === f);

export type BugState = "open" | "fixing" | "needs-check" | "fixed" | "dismissed";

/** Where a bug stands. An accepted bug has a fix session: while it runs the bug is being fixed, and when it stops without shipping, the fix needs a look. */
export function bugState(f: Pick<Finding, "status">, runningFix: boolean): BugState {
  if (f.status === "shipped") return "fixed";
  if (f.status === "dismissed") return "dismissed";
  if (f.status === "accepted") return runningFix ? "fixing" : "needs-check";
  return "open";
}

/** Bugs are logged from the browser and live in their own view: the findings list leaves them out. */
export const isBug = (f: Pick<Finding, "lens">): boolean => f.lens === "bug";

export type KindFilter = BugKind | "all";

/** How many bugs there are of each kind, for the Bugs view's filter. */
export function kindCounts(bugs: Pick<Finding, "bug">[]): Record<KindFilter, number> {
  const out = { all: bugs.length, ...Object.fromEntries(BUG_KINDS.map((k) => [k, 0])) } as Record<KindFilter, number>;
  for (const b of bugs) if (b.bug) out[b.bug.kind]++;
  return out;
}

export const byKind = <T extends Pick<Finding, "bug">>(bugs: T[], kind: KindFilter): T[] => (kind === "all" ? bugs : bugs.filter((b) => b.bug?.kind === kind));

/** A bug a QA agent logged that no person has confirmed: fix-all leaves it alone. */
export const unconfirmed = (f: Pick<Finding, "bug">): boolean => f.bug?.by === "agent" && f.bug.confirmed !== true;

/** Bugs a "fix all" would start: confirmed, not yet fixed, not dismissed, and not being fixed now. */
export const fixableBugs = (list: Finding[]): Finding[] => list.filter((f) => isBug(f) && !f.problem && !unconfirmed(f) && (bugState(f, f.fixRunning) === "open" || bugState(f, f.fixRunning) === "needs-check"));

/** The finding whose fix is running. Every fix edits the project folder, so while one runs no other may start. */
export const runningFix = (list: Pick<Finding, "id" | "title" | "fixRunning" | "fixSession">[]) => list.find((x) => x.fixRunning) ?? null;

/** Why a fix cannot start on `id` right now, or null when it can. */
export function fixBlock(list: Pick<Finding, "id" | "title" | "fixRunning" | "fixSession">[], id: string): string | null {
  const r = runningFix(list);
  if (!r) return null;
  return r.id === id ? "A fix for this finding is still running" : `A fix for "${r.title}" is running${r.fixSession ? ` (${r.fixSession})` : ""}. Fixes share the project folder: wait for it to finish.`;
}

/** A bug has a screenshot.png part only when it was logged with a screenshot. */
export const hasScreenshot = (f: Pick<Finding, "bug">): f is { bug: NonNullable<Finding["bug"]> & { capture: string } } => !!f.bug?.capture && f.bug.shot !== "none";

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
