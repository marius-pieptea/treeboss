/** Grouping and filtering for the sessions list. Pure, so the ordering rules are tested. */
import type { SessionView } from "@/lib/types";

export interface SessionGroup {
  key: "pinned" | "running" | "recent" | "closed";
  label: string;
  items: SessionView[];
}

export function matchesQuery(s: SessionView, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [s.title, s.engine, s.model ?? "", s.pair ?? "", s.id, s.branch ?? ""].some((v) => v.toLowerCase().includes(needle));
}

/**
 * Leads only, most recently updated first within each group (the API returns them in that order already). Pinned leads, from any
 * workspace, lead the list in their own group; a lead is never listed twice, so `all` may include pinned ones.
 */
export function groupSessions(all: SessionView[], query: string, pinned: SessionView[] = []): SessionGroup[] {
  const pinnedIds = new Set(pinned.map((s) => s.id));
  const leads = all.filter((s) => s.depth === 0 && !pinnedIds.has(s.id) && matchesQuery(s, query));
  return [
    { key: "pinned" as const, label: "Pinned", items: pinned.filter((s) => matchesQuery(s, query)) },
    { key: "running" as const, label: "Running", items: leads.filter((s) => s.status === "running") },
    { key: "recent" as const, label: "Recent", items: leads.filter((s) => s.status === "idle" || s.status === "failed") },
    { key: "closed" as const, label: "Closed", items: leads.filter((s) => s.status === "closed") },
  ].filter((g) => g.items.length > 0);
}

/** Heads per lead, counting everything beneath it, and how many are working right now. */
export function headCounts(all: SessionView[]): Record<string, { total: number; running: number }> {
  const byId = new Map(all.map((s) => [s.id, s]));
  const out: Record<string, { total: number; running: number }> = {};
  for (const s of all) {
    if (s.depth === 0 || s.status === "closed") continue;
    // Walk up to the lead; a head of a head still counts toward the lead.
    let cur: SessionView | undefined = s;
    for (let i = 0; i < 8 && cur && cur.parent; i++) cur = byId.get(cur.parent);
    if (!cur || cur.depth !== 0) continue;
    const c = (out[cur.id] ??= { total: 0, running: 0 });
    c.total += 1;
    if (s.status === "running") c.running += 1;
  }
  return out;
}
