import type { Artifact, ArtifactFileEntry, ArtifactIntent } from "./data";

export type IntentFilter = "all" | ArtifactIntent;
export type GroupMode = "session" | "date";

export interface ArtifactBadges {
  rowType: string | null;
  detailType: string | null;
  shared: boolean;
}

export interface ArtifactBoard {
  path: string;
  title: string;
  size: number;
}

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

/** Whether an artifact should be treated as a shared summary-only item. */
export function isSharedArtifact(item: Pick<Artifact, "owner" | "contentKind">): boolean {
  if (item.owner === "mine") return false;
  if (item.contentKind === "summary") return true;
  if (item.contentKind === "html" || item.contentKind === "markdown" || item.contentKind === "files") return false;
  return item.owner === "shared";
}

/** Badges for list rows and detail header. Owned typed artifacts never show `shared`. */
export function artifactBadges(
  item: Pick<Artifact, "typeName" | "owner" | "contentKind" | "intent">,
): ArtifactBadges {
  const typeName = item.typeName?.trim() || null;
  const shared = isSharedArtifact(item);
  return {
    rowType: typeName,
    detailType: typeName ?? (shared ? null : item.intent),
    shared,
  };
}

/** Prefilled composer draft when asking an agent about an artifact. */
export function formatAskAgentDraft(
  item: Pick<Artifact, "url" | "owner" | "contentKind" | "summary">,
): string {
  const base = `Use this artifact: ${item.url} (read it with the artifact_read tool)`;
  if (isSharedArtifact(item) && item.summary) {
    return `${base}\n\nSummary: ${item.summary}`;
  }
  return base;
}

function isHtmlBoardPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".dc.html") || lower.endsWith(".html");
}

function boardTitleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/(\.dc)?\.html$/i, "") || base;
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Derive previewable HTML boards from an artifact's file listing and optional parsed `project/canvas.json`.
 * Board titles come from `canvas.boards` when present, otherwise from file names.
 */
export function extractArtifactBoards(files: ArtifactFileEntry[], canvas?: unknown): ArtifactBoard[] {
  const byNorm = new Map<string, ArtifactFileEntry>();
  for (const f of files) {
    byNorm.set(normalizeRelPath(f.path), f);
  }

  const boards: ArtifactBoard[] = [];
  const seen = new Set<string>();
  const rawBoards =
    canvas && typeof canvas === "object" && Array.isArray((canvas as { boards?: unknown }).boards)
      ? ((canvas as { boards: unknown[] }).boards ?? [])
      : null;

  if (rawBoards) {
    for (const entry of rawBoards) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as { file?: unknown; path?: unknown; title?: unknown; name?: unknown };
      const rawFile = typeof obj.file === "string" ? obj.file : typeof obj.path === "string" ? obj.path : null;
      if (!rawFile) continue;
      const norm = normalizeRelPath(rawFile);
      const match = byNorm.get(norm) ?? (!norm.startsWith("project/") ? byNorm.get(`project/${norm}`) : undefined);
      if (!match || !isHtmlBoardPath(match.path) || seen.has(match.path)) continue;
      const title =
        typeof obj.title === "string" && obj.title.trim()
          ? obj.title.trim()
          : typeof obj.name === "string" && obj.name.trim()
            ? obj.name.trim()
            : boardTitleFromPath(match.path);
      seen.add(match.path);
      boards.push({ path: match.path, title, size: match.size });
    }
  }

  if (boards.length > 0) return boards;

  return files
    .filter((f) => isHtmlBoardPath(f.path))
    .map((f) => ({ path: f.path, title: boardTitleFromPath(f.path), size: f.size }));
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb % 1 === 0 ? kb.toFixed(0) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb % 1 === 0 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}
