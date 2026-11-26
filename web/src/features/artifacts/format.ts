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
  section?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  radius?: number;
}

export interface CanvasNote {
  id: string;
  x: number;
  y: number;
  w?: number;
  maxW?: number;
  text: string;
  kind?: string;
  fill?: string;
}

export function capabilityFileUrl(base: string, path: string): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const clean = path.replace(/^\/+/, "");
  const encoded = clean
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return prefix + encoded;
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
  if (item.contentKind === "summary") return item.owner === "shared";
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

function isDcHtmlPath(path: string): boolean {
  return path.toLowerCase().endsWith(".dc.html");
}

function boardTitleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.dc\.html$/i, "") || base;
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function fileNameOf(path: string): string {
  const norm = normalizeRelPath(path);
  return norm.split("/").pop() ?? norm;
}

function compareBoardFiles(a: ArtifactFileEntry, b: ArtifactFileEntry): number {
  return (
    fileNameOf(a.path).localeCompare(fileNameOf(b.path), undefined, {
      numeric: true,
      sensitivity: "base",
    }) || a.path.localeCompare(b.path)
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Derive previewable `.dc.html` boards from an artifact's file listing and optional parsed `project/canvas.json`.
 * Order, titles, optional sections, and board geometry come from `canvas.json` when present; unlisted `.dc.html`
 * boards (and the full list when `canvas.json` is absent) are sorted alphabetically by file name.
 * Non-`.dc.html` files are ignored.
 */
export function extractArtifactBoards(files: ArtifactFileEntry[], canvas?: unknown): ArtifactBoard[] {
  const dcFiles = files.filter((f) => isDcHtmlPath(f.path));
  if (dcFiles.length === 0) return [];

  const byNorm = new Map<string, ArtifactFileEntry>();
  const byFileName = new Map<string, ArtifactFileEntry | null>();
  const byStem = new Map<string, ArtifactFileEntry | null>();
  for (const f of dcFiles) {
    byNorm.set(normalizeRelPath(f.path), f);
    const nameKey = fileNameOf(f.path).toLowerCase();
    byFileName.set(nameKey, byFileName.has(nameKey) ? null : f);
    const stemKey = boardTitleFromPath(f.path).toLowerCase();
    byStem.set(stemKey, byStem.has(stemKey) ? null : f);
  }

  const resolveBoardFile = (rawRef: string): ArtifactFileEntry | undefined => {
    const norm = normalizeRelPath(rawRef);
    const candidates = [norm];
    if (!norm.startsWith("project/")) candidates.push(`project/${norm}`);
    if (!norm.toLowerCase().endsWith(".dc.html")) {
      candidates.push(`${norm}.dc.html`);
      if (!norm.startsWith("project/")) candidates.push(`project/${norm}.dc.html`);
    }
    for (const candidate of candidates) {
      const hit = byNorm.get(candidate);
      if (hit) return hit;
    }
    if (!norm.includes("/")) {
      const lower = norm.toLowerCase();
      return byFileName.get(lower) ?? byStem.get(lower) ?? undefined;
    }
    return undefined;
  };

  const boards: ArtifactBoard[] = [];
  const seen = new Set<string>();

  const pushEntry = (entry: unknown, defaultSection?: string, rawRefOverride?: string) => {
    let rawRef: string | undefined = nonEmptyString(rawRefOverride);
    let title: string | undefined;
    let section = defaultSection;
    let x: number | undefined;
    let y: number | undefined;
    let w: number | undefined;
    let h: number | undefined;
    let radius: number | undefined;

    if (typeof entry === "string") {
      rawRef ??= nonEmptyString(entry);
    } else if (entry && typeof entry === "object") {
      const obj = entry as {
        file?: unknown;
        path?: unknown;
        src?: unknown;
        href?: unknown;
        id?: unknown;
        title?: unknown;
        name?: unknown;
        label?: unknown;
        section?: unknown;
        group?: unknown;
        x?: unknown;
        y?: unknown;
        w?: unknown;
        h?: unknown;
        radius?: unknown;
      };
      rawRef ??=
        nonEmptyString(obj.file) ??
        nonEmptyString(obj.path) ??
        nonEmptyString(obj.src) ??
        nonEmptyString(obj.href) ??
        nonEmptyString(obj.id);
      title = nonEmptyString(obj.title) ?? nonEmptyString(obj.name) ?? nonEmptyString(obj.label);
      section = nonEmptyString(obj.section) ?? nonEmptyString(obj.group) ?? defaultSection;
      x = finiteNum(obj.x);
      y = finiteNum(obj.y);
      w = positiveNum(obj.w);
      h = positiveNum(obj.h);
      radius = nonNegativeNum(obj.radius);
    }

    if (!rawRef) return;
    const match = resolveBoardFile(rawRef);
    if (!match || seen.has(match.path)) return;
    seen.add(match.path);
    const board: ArtifactBoard = {
      path: match.path,
      title: title ?? boardTitleFromPath(match.path),
      size: match.size,
    };
    if (section) board.section = section;
    if (x !== undefined) board.x = x;
    if (y !== undefined) board.y = y;
    if (w !== undefined) board.w = w;
    if (h !== undefined) board.h = h;
    if (radius !== undefined) board.radius = radius;
    boards.push(board);
  };

  if (canvas && typeof canvas === "object") {
    const obj = canvas as { sections?: unknown; boards?: unknown; order?: unknown };
    if (Array.isArray(obj.sections)) {
      for (const sec of obj.sections) {
        if (!sec || typeof sec !== "object") continue;
        const secObj = sec as { title?: unknown; name?: unknown; label?: unknown; boards?: unknown; items?: unknown };
        const secTitle = nonEmptyString(secObj.title) ?? nonEmptyString(secObj.name) ?? nonEmptyString(secObj.label);
        const list = Array.isArray(secObj.boards)
          ? secObj.boards
          : Array.isArray(secObj.items)
            ? secObj.items
            : [];
        for (const item of list) pushEntry(item, secTitle);
      }
    }
    if (Array.isArray(obj.boards)) {
      for (const item of obj.boards) pushEntry(item);
    } else if (obj.boards && typeof obj.boards === "object") {
      const boardsMap = obj.boards as Record<string, unknown>;
      if (Array.isArray(obj.order)) {
        for (const ref of obj.order) {
          if (typeof ref !== "string") continue;
          const entry = Object.prototype.hasOwnProperty.call(boardsMap, ref) ? boardsMap[ref] : undefined;
          pushEntry(entry ?? ref, undefined, ref);
        }
      }
      for (const [ref, entry] of Object.entries(boardsMap)) {
        pushEntry(entry, undefined, ref);
      }
    }
  }

  const remaining = dcFiles.filter((f) => !seen.has(f.path)).sort(compareBoardFiles);
  for (const f of remaining) {
    boards.push({ path: f.path, title: boardTitleFromPath(f.path), size: f.size });
  }

  return boards;
}

/** Extract valid canvas notes from `canvas.notes` (object map), ordered by `canvas.noteOrder` when present. */
export function extractCanvasNotes(canvas: unknown): CanvasNote[] {
  if (!canvas || typeof canvas !== "object") return [];
  const obj = canvas as { notes?: unknown; noteOrder?: unknown };
  if (!obj.notes || typeof obj.notes !== "object" || Array.isArray(obj.notes)) return [];

  const notesMap = obj.notes as Record<string, unknown>;
  const notes: CanvasNote[] = [];
  const seen = new Set<string>();

  const pushNote = (id: string, raw: unknown) => {
    if (seen.has(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const entry = raw as {
      x?: unknown;
      y?: unknown;
      w?: unknown;
      maxW?: unknown;
      text?: unknown;
      kind?: unknown;
      fill?: unknown;
    };
    const x = finiteNum(entry.x);
    const y = finiteNum(entry.y);
    const text = nonEmptyString(entry.text);
    if (x === undefined || y === undefined || !text) return;

    seen.add(id);
    const note: CanvasNote = { id, x, y, text };
    const w = positiveNum(entry.w);
    const maxW = positiveNum(entry.maxW);
    const kind = nonEmptyString(entry.kind);
    const fill = nonEmptyString(entry.fill);
    if (w !== undefined) note.w = w;
    if (maxW !== undefined) note.maxW = maxW;
    if (kind !== undefined) note.kind = kind;
    if (fill !== undefined) note.fill = fill;
    notes.push(note);
  };

  if (Array.isArray(obj.noteOrder)) {
    for (const id of obj.noteOrder) {
      if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(notesMap, id)) continue;
      pushNote(id, notesMap[id]);
    }
  }
  for (const [id, raw] of Object.entries(notesMap)) {
    pushNote(id, raw);
  }

  return notes;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb % 1 === 0 ? kb.toFixed(0) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb % 1 === 0 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}
