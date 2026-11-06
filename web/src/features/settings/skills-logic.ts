/**
 * Pure logic for importing skills and browsing a skill's files: what a scan means for the checklist, how far an
 * import has got, the sentences the UI shows, and the rules for naming files inside a skill. No React, no network,
 * relative imports only, so it is unit tested directly.
 */

/* -------------------------------------------------------------------------- */
/* Shapes the daemon returns (src/skills/import.ts)                           */
/* -------------------------------------------------------------------------- */

export interface ScanSkill {
  name: string;
  description: string;
  /** Where it sits under the scanned folder ("." when the folder is itself a skill). */
  relDir: string;
  dir: string;
  files: number;
  bytes: number;
  /** A skill of this name is already stored. */
  exists: boolean;
  /** Things left out (dependencies, version control, symlink loops). */
  notes: string[];
  /** Present when this skill cannot be imported (too big, too many files). */
  error?: string;
}

export interface ScanResult {
  root: string;
  skills: ScanSkill[];
  duplicates: string[];
  truncated: boolean;
}

export type ImportStatus = "added" | "replaced" | "skipped" | "failed";

export interface ImportItem {
  name: string;
  status: ImportStatus;
  files: number;
  bytes: number;
  reason?: string;
}

export interface ImportJobState {
  id: string;
  status: "running" | "done" | "cancelled";
  root: string;
  total: number;
  done: number;
  totalBytes: number;
  doneBytes: number;
  current: { name: string; filesDone: number; filesTotal: number } | null;
  results: ImportItem[];
  startedAt: string;
  finishedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Sizes and times                                                            */
/* -------------------------------------------------------------------------- */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** 0:07, 1:05, 1:02:03. Whole seconds, never negative. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "about 12s left". Silent (null) until there is enough signal to say anything honest. */
export function formatEta(elapsedMs: number, percent: number): string | null {
  if (elapsedMs < 3000 || percent < 5 || percent >= 100) return null;
  const remaining = (elapsedMs * (100 - percent)) / percent / 1000;
  if (!Number.isFinite(remaining)) return null;
  if (remaining < 5) return "a few seconds left";
  if (remaining < 90) return `about ${Math.round(remaining / 5) * 5}s left`;
  return `about ${Math.round(remaining / 60)} min left`;
}

/* -------------------------------------------------------------------------- */
/* The scan checklist                                                         */
/* -------------------------------------------------------------------------- */

/** A skill that cannot be imported is never selectable; one that exists is selectable only when replacing. */
export function selectable(s: ScanSkill, overwrite: boolean): boolean {
  if (s.error) return false;
  return overwrite || !s.exists;
}

/** What is ticked when a scan first appears: everything that can be imported. */
export function initialSelection(skills: ScanSkill[], overwrite: boolean): Set<string> {
  return new Set(skills.filter((s) => selectable(s, overwrite)).map((s) => s.name));
}

/**
 * Turning overwrite on ticks the skills it newly allows; turning it off unticks them. Anything the operator
 * ticked or unticked by hand among the rest is left alone.
 */
export function reconcileSelection(prev: Set<string>, skills: ScanSkill[], overwrite: boolean): Set<string> {
  const next = new Set<string>();
  for (const s of skills) {
    if (!selectable(s, overwrite)) continue;
    if (s.exists) {
      if (overwrite) next.add(s.name); // newly allowed: tick it
    } else if (prev.has(s.name)) next.add(s.name);
  }
  return next;
}

export function filterSkills(skills: ScanSkill[], query: string): ScanSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.relDir.toLowerCase().includes(q));
}

/** Tick or untick every selectable skill in `visible` (the filtered view), leaving the rest of the selection as it was. */
export function setAll(prev: Set<string>, visible: ScanSkill[], overwrite: boolean, on: boolean): Set<string> {
  const next = new Set(prev);
  for (const s of visible) {
    if (!selectable(s, overwrite)) continue;
    if (on) next.add(s.name);
    else next.delete(s.name);
  }
  return next;
}

/** "all" | "some" | "none" among the selectable visible skills, for the header checkbox. */
export function selectionState(selected: Set<string>, visible: ScanSkill[], overwrite: boolean): "all" | "some" | "none" {
  const pool = visible.filter((s) => selectable(s, overwrite));
  if (pool.length === 0) return "none";
  const n = pool.filter((s) => selected.has(s.name)).length;
  return n === 0 ? "none" : n === pool.length ? "all" : "some";
}

export function scanSummary(scan: ScanResult): string {
  const files = scan.skills.reduce((n, s) => n + s.files, 0);
  const bytes = scan.skills.reduce((n, s) => n + s.bytes, 0);
  if (scan.skills.length === 0) return "No skills found";
  return `Found ${plural(scan.skills.length, "skill")} · ${plural(files, "file")} · ${formatBytes(bytes)}`;
}

export function selectedSummary(scan: ScanResult, selected: Set<string>): { count: number; files: number; bytes: number } {
  const picked = scan.skills.filter((s) => selected.has(s.name));
  return { count: picked.length, files: picked.reduce((n, s) => n + s.files, 0), bytes: picked.reduce((n, s) => n + s.bytes, 0) };
}

/** Why a skill is flagged, in a few words, for its badge. */
export function skillFlags(s: ScanSkill): Array<{ kind: "exists" | "fail" | "notes"; label: string; title?: string }> {
  const out: Array<{ kind: "exists" | "fail" | "notes"; label: string; title?: string }> = [];
  if (s.error) out.push({ kind: "fail", label: "will fail", title: s.error });
  if (s.exists) out.push({ kind: "exists", label: "already imported" });
  if (s.notes.length) out.push({ kind: "notes", label: `${s.notes.length} left out`, title: s.notes.join("\n") });
  return out;
}

/** A folder name that suggests skills live inside, for the picker's hint. */
export function looksLikeSkillsFolder(name: string): boolean {
  return /^(skills?|\.claude|\.agents|\.cursor|plugins|agent-?skills)$/i.test(name) || /skills?$/i.test(name);
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

const clamp = (n: number) => Math.min(100, Math.max(0, n));

/** How far through the current skill, 0-100. */
export function currentPercent(job: Pick<ImportJobState, "current">): number {
  const c = job.current;
  if (!c || c.filesTotal <= 0) return 0;
  return clamp(Math.round((c.filesDone / c.filesTotal) * 100));
}

/**
 * Overall progress, 0-100. Bytes weigh more than skill counts (one skill of 800 files is not one-23rd of a
 * folder of tiny ones), with the skill being copied counted by how far through it is. Falls back to counts when
 * there are no bytes to weigh (all-empty skills).
 * `bytesOfCurrent` is the size of the skill in flight, known from the scan; without it the partial skill is ignored.
 */
export function overallPercent(job: Pick<ImportJobState, "status" | "total" | "done" | "totalBytes" | "doneBytes" | "current">, bytesOfCurrent = 0): number {
  if (job.status === "done") return 100;
  if (job.total <= 0) return 0;
  const frac = job.current && job.current.filesTotal > 0 ? job.current.filesDone / job.current.filesTotal : 0;
  const byBytes = job.totalBytes > 0;
  const value = byBytes ? (job.doneBytes + frac * bytesOfCurrent) / job.totalBytes : (job.done + frac) / job.total;
  // Never report 100 until the daemon says done: the last skill may still be registering.
  return clamp(Math.min(99, Math.round(value * 100)));
}

/** The bar only ever moves forward within one job, however the estimates wobble between polls. */
export function monotonic(prev: number, next: number): number {
  return next < prev ? prev : next;
}

export interface Pulse {
  done: number;
  doneBytes: number;
  filesDone: number;
  name: string | null;
}

export function pulseOf(job: Pick<ImportJobState, "done" | "doneBytes" | "current">): Pulse {
  return { done: job.done, doneBytes: job.doneBytes, filesDone: job.current?.filesDone ?? 0, name: job.current?.name ?? null };
}

export function pulseChanged(a: Pulse | null, b: Pulse): boolean {
  return !a || a.done !== b.done || a.doneBytes !== b.doneBytes || a.filesDone !== b.filesDone || a.name !== b.name;
}

/**
 * True when a running job has shown no movement for `thresholdMs`: the UI then says what it is waiting on instead of
 * a bar that looks frozen. `lastChangeAt` is when the pulse last changed.
 */
export function isStalled(status: ImportJobState["status"], lastChangeAt: number, now: number, thresholdMs = 3000): boolean {
  return status === "running" && now - lastChangeAt >= thresholdMs;
}

/** "Copying references (14/40 files)" for the skill in flight. */
export function currentLabel(job: Pick<ImportJobState, "current">): string | null {
  const c = job.current;
  if (!c) return null;
  if (c.filesTotal <= 0) return `Copying ${c.name}`;
  return `Copying ${c.name} (${c.filesDone}/${plural(c.filesTotal, "file")})`;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export function countResults(results: ImportItem[]): Record<ImportStatus, number> {
  const c: Record<ImportStatus, number> = { added: 0, replaced: 0, skipped: 0, failed: 0 };
  for (const r of results) c[r.status]++;
  return c;
}

/** "Imported 21, skipped 2, failed 0". Replaced skills count as imported. */
export function summarizeResults(results: ImportItem[], cancelled = false): string {
  const c = countResults(results);
  const imported = c.added + c.replaced;
  const parts = [`Imported ${imported}`];
  if (c.replaced) parts[0] += ` (${c.replaced} replaced)`;
  parts.push(`skipped ${c.skipped}`, `failed ${c.failed}`);
  return parts.join(", ") + (cancelled ? " (cancelled)" : "");
}

/** A plain-text report to paste into an issue or a chat. */
export function formatReport(job: Pick<ImportJobState, "root" | "status" | "results" | "total" | "startedAt" | "finishedAt">): string {
  const lines = [`Skill import from ${job.root}`, `${summarizeResults(job.results, job.status === "cancelled")} of ${job.total}`, ""];
  for (const r of job.results) {
    lines.push(`${r.status.padEnd(8)} ${r.name} (${plural(r.files, "file")}, ${formatBytes(r.bytes)})${r.reason ? `: ${r.reason}` : ""}`);
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Files inside a skill                                                       */
/* -------------------------------------------------------------------------- */

export interface FsEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
}

/** Directories first, then names with numbers read as numbers (step2 before step10). */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.type === "dir" ? -1 : 1));
}

/** The entry point: deleting or renaming it makes the skill stop working. */
export function isEntryFile(path: string): boolean {
  return path === "SKILL.md";
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** A path typed into a "new file" or "rename" box: relative, no ".." and no empty parts. Returns the error, or null. */
export function validateEntryPath(input: string, existing: string[] = [], current?: string): string | null {
  const p = input.trim();
  if (!p) return "A name is required.";
  if (p.startsWith("/") || p.startsWith("~")) return "Use a path inside the skill, not an absolute one.";
  if (/\\/.test(p)) return "Use forward slashes.";
  if (p.includes("\0")) return "That name has an invalid character.";
  const parts = p.split("/");
  if (parts.some((x) => x === "")) return "A path cannot have empty parts or a trailing slash.";
  if (parts.some((x) => x === ".." || x === ".")) return 'A path cannot contain "." or "..".';
  if (parts.some((x) => x === ".git")) return "The .git folder is not part of a skill.";
  if (p !== current && existing.includes(p)) return `${p} already exists.`;
  return null;
}

/** How many files a directory listing contributes, for the "N files" label. */
export function countTree(listing: Map<string, FsEntry[]>): { files: number; dirs: number; bytes: number } {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  for (const entries of listing.values()) {
    for (const e of entries) {
      if (e.type === "dir") dirs++;
      else {
        files++;
        bytes += e.size;
      }
    }
  }
  return { files, dirs, bytes };
}

/** A skill with more than its SKILL.md. */
export function isMultiFile(files: number): boolean {
  return files > 1;
}

/* -------------------------------------------------------------------------- */
/* Skill packs (src/skill-packs.ts)                                           */
/* -------------------------------------------------------------------------- */

/** One pack as GET /api/skills/packs returns it. */
export interface SkillPack {
  id: string;
  title: string;
  version: string;
  author: string;
  license: string;
  upstream: string;
  commit: string;
  skills: string[];
  installed: number;
  enabled: number;
}

/** What POST /api/skills/packs/:id/enabled returns: the counts after the change. */
export interface SkillPackCounts {
  id: string;
  installed: number;
  enabled: number;
}

/** The part of a skill the grouping reads. The Skill type (lib/types.ts) has all of it. */
export interface PackableSkill {
  name: string;
  description: string;
  enabled: boolean;
  pack?: string | null;
}

/** One pack's group on the Skills page: its header, and the skills to list under it. */
export interface PackSection<S extends PackableSkill> {
  id: string;
  title: string;
  version: string;
  author: string;
  license: string;
  upstream: string;
  /** Installed skills of the pack, whatever the search. */
  installed: number;
  /** Of those, how many are on. */
  enabled: number;
  /** What to list: all of the pack's installed skills, or only the ones the search matches. */
  skills: S[];
}

/** A skill matches a search when its name or description contains the text, ignoring case. An empty search matches all. */
export function matchesSkill(s: Pick<PackableSkill, "name" | "description">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
}

/** The skills that are not in a pack: the operator's own, and the five built-ins written into trb. */
export function unpackedSkills<S extends PackableSkill>(skills: S[], query: string): S[] {
  return skills.filter((s) => !s.pack && matchesSkill(s, query));
}

/**
 * The pack groups, by title. Every pack the daemon lists shows, with the skills it has installed. A search keeps only the
 * packs it finds something in, and lists just those skills. A skill whose pack the list does not name (the list has not
 * loaded yet) still gets a group, titled by its pack id.
 */
export function packSections<S extends PackableSkill>(packs: SkillPack[], skills: S[], query: string): Array<PackSection<S>> {
  const searching = query.trim() !== "";
  const meta = new Map(packs.map((p) => [p.id, p]));
  const byPack = new Map<string, S[]>();
  for (const s of skills) if (s.pack) byPack.set(s.pack, [...(byPack.get(s.pack) ?? []), s]);
  const out: Array<PackSection<S>> = [];
  for (const id of new Set([...meta.keys(), ...byPack.keys()])) {
    const m = meta.get(id);
    const installed = byPack.get(id) ?? [];
    const shown = searching ? installed.filter((s) => matchesSkill(s, query)) : installed;
    if (searching && shown.length === 0) continue;
    out.push({
      id,
      title: m?.title || id,
      version: m?.version ?? "",
      author: m?.author ?? "",
      license: m?.license ?? "",
      upstream: m?.upstream ?? "",
      installed: installed.length,
      enabled: installed.filter((s) => s.enabled).length,
      skills: shown,
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** "3 of 58 enabled", or "none installed" when nothing of the pack is in the store. */
export function packCountText(p: { installed: number; enabled: number }): string {
  return p.installed === 0 ? "none installed" : `${p.enabled} of ${p.installed} enabled`;
}

/**
 * Which of a pack's two buttons can do anything. "Enable all" needs something installed and off; "Disable all" needs
 * something on. Neither applies when nothing of the pack is installed.
 */
export function packActions(p: { installed: number; enabled: number }): { enable: boolean; disable: boolean } {
  return { enable: p.installed > 0 && p.enabled < p.installed, disable: p.enabled > 0 };
}

/** A pack's upstream as a link target. http and https only, so a manifest cannot put a script URL in a link. */
export function safeHttpUrl(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
