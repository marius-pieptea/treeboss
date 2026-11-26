import type { Artifact, ArtifactIntent } from "./data";

export type IntentFilter = "all" | ArtifactIntent;
export type GroupMode = "session" | "date";

export interface IntentCounts {
  all: number;
  document: number;
  slides: number;
  design: number;
  other: number;
}

export interface ArtifactGroup {
  key: string;
  label: string;
  items: Artifact[];
  collapsedByDefault: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfYesterday(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return d.getTime();
}

export function formatShortDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function formatShortDateTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
}

export function formatRelativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const todayStart = startOfDay(now);
  if (ms >= todayStart) {
    const hours = Math.floor(diff / 3_600_000);
    return `${Math.max(1, hours)}h ago`;
  }
  const yesterdayStart = startOfYesterday(now);
  if (ms >= yesterdayStart) return "yesterday";
  return formatShortDate(ms);
}

/** Display title for an artifact's owning session, or fallback for untitled/pasted items. */
export function sessionLabel(item: Pick<Artifact, "sessionId" | "sessionTitle">): string {
  if (!item.sessionId) return "Pasted links";
  const title = item.sessionTitle?.trim();
  return title || `Session ${item.sessionId.slice(0, 6)}`;
}

/** Secondary metadata line under the row title. */
export function formatRowMeta(item: Artifact, mode: GroupMode, now = Date.now()): string {
  if (item.source === "pasted") return `added ${formatShortDate(item.createdAt)}`;
  const rel = formatRelativeTime(item.updatedAt ?? item.createdAt, now);
  return mode === "date" ? `${sessionLabel(item)} · ${rel}` : rel;
}

/** Case-insensitive match against title, session title, and URL. */
export function matchesSearch(item: Artifact, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    item.title.toLowerCase().includes(q) ||
    (item.sessionTitle ?? "").toLowerCase().includes(q) ||
    item.url.toLowerCase().includes(q)
  );
}

export function countByIntent(items: Artifact[]): IntentCounts {
  const counts: IntentCounts = { all: items.length, document: 0, slides: 0, design: 0, other: 0 };
  for (const item of items) counts[item.intent]++;
  return counts;
}

export function filterArtifacts(items: Artifact[], query: string, intent: IntentFilter): Artifact[] {
  return items.filter((item) => matchesSearch(item, query) && (intent === "all" || item.intent === intent));
}

export function documentsTabLabel(listWidth: number): "Docs" | "Documents" {
  return listWidth < 400 ? "Docs" : "Documents";
}

/**
 * Group artifacts by session (sorted by newest item, groups after the 5th collapsed by default)
 * or by calendar date (Today, Yesterday, Earlier).
 */
export function groupArtifacts(items: Artifact[], mode: GroupMode, now = Date.now()): ArtifactGroup[] {
  if (mode === "date") {
    const todayStart = startOfDay(now);
    const yesterdayStart = startOfYesterday(now);
    const buckets: Record<"Today" | "Yesterday" | "Earlier", Artifact[]> = {
      Today: [],
      Yesterday: [],
      Earlier: [],
    };
    const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
    for (const item of sorted) {
      if (item.createdAt >= todayStart) buckets.Today.push(item);
      else if (item.createdAt >= yesterdayStart) buckets.Yesterday.push(item);
      else buckets.Earlier.push(item);
    }
    return (["Today", "Yesterday", "Earlier"] as const)
      .filter((label) => buckets[label].length > 0)
      .map((label) => ({
        key: `date:${label}`,
        label,
        items: buckets[label],
        collapsedByDefault: false,
      }));
  }

  const byKey = new Map<string, { label: string; items: Artifact[]; newestAt: number }>();
  for (const item of items) {
    const key = item.sessionId === null ? "pasted" : `session:${item.sessionId}`;
    let group = byKey.get(key);
    if (!group) {
      group = { label: item.sessionId === null ? "Pasted links" : sessionLabel(item), items: [], newestAt: item.createdAt };
      byKey.set(key, group);
    } else if (item.sessionId !== null && item.sessionTitle?.trim() && group.label.startsWith("Session ")) {
      group.label = item.sessionTitle.trim();
    }
    group.items.push(item);
    if (item.createdAt > group.newestAt) group.newestAt = item.createdAt;
  }

  const sortedGroups = [...byKey.entries()].sort(([, a], [, b]) => b.newestAt - a.newestAt);
  return sortedGroups.map(([key, group], idx) => ({
    key,
    label: group.label,
    items: [...group.items].sort((a, b) => b.createdAt - a.createdAt),
    collapsedByDefault: idx >= 5,
  }));
}
