/**
 * The prompt context palette's pure logic: what chips are, what the `@` popup offers beyond files, and
 * how a chip list becomes the request payload. The daemon resolves chips into text; nothing here reads a file.
 */

import type { Tab } from "@/lib/store";

export type ChipKind = "file" | "symbol" | "commit" | "url" | "terminal" | "browser" | "image" | "upload" | "diff" | "roadmap";

export interface ContextChip {
  /** Unique within the composer. */
  id: string;
  kind: ChipKind;
  /** What the daemon resolves: a path, `path:a-b`, a sha, a URL, a terminal id or "", an image id. */
  value: string;
  label: string;
  detail?: string;
  /** Size of an uploaded file, for the per-message total. */
  bytes?: number;
}

export interface Candidate {
  kind: "file" | "symbol" | "commit";
  value: string;
  label: string;
  detail?: string;
  score: number;
}

export const MAX_CHIPS = 12;

/** The fixed `@` entries that are not searched: they name a source rather than a thing in the repo. */
export const KEYWORDS: Array<{ name: "url" | "terminal" | "browser" | "view"; help: string }> = [
  { name: "view", help: "Attach what is open in the editor right now" },
  { name: "url", help: "Fetch a web page and attach its text" },
  { name: "terminal", help: "Attach the latest terminal output" },
  { name: "browser", help: "Attach the preview's console errors" },
];

/**
 * What the operator is looking at, as a chip the daemon can resolve. Null for views with nothing to attach
 * (settings, sessions, memory) and for a tab from another workspace root, whose paths the daemon could not find.
 */
export function viewChip(tab: Tab | undefined, root: string): Omit<ContextChip, "id"> | null {
  if (!tab) return null;
  const here = (r: string) => r === root;
  switch (tab.kind) {
    case "file":
    case "doc":
      return here(tab.root) ? { kind: "file", value: tab.path, label: tab.title, detail: tab.path } : null;
    case "plan":
      return tab.path && here(tab.root) ? { kind: "file", value: tab.path, label: tab.title, detail: tab.path } : null;
    case "spec":
      return here(tab.root) ? { kind: "file", value: `specs/${tab.feature}/${tab.doc ?? "spec.md"}`, label: tab.title, detail: tab.feature } : null;
    case "diff": {
      if (!here(tab.root)) return null;
      const mode = tab.commit ? `commit:${tab.commit}` : tab.staged ? "staged" : tab.untracked ? "new" : "work";
      return { kind: "diff", value: `${mode}:${tab.path}`, label: `${tab.title} (diff)`, detail: tab.path };
    }
    case "commit":
      return here(tab.root) ? { kind: "commit", value: tab.sha, label: tab.title } : null;
    case "browser":
      return { kind: "browser", value: tab.url, label: tab.title || tab.url, detail: tab.url };
    case "roadmap":
      return { kind: "roadmap", value: "roadmap", label: "Roadmap" };
    case "design":
      return { kind: "file", value: "DESIGN.md", label: "DESIGN.md" };
    default:
      return null;
  }
}

export function matchKeywords(query: string): typeof KEYWORDS {
  const q = query.toLowerCase();
  if (/^https?:/.test(q)) return [];
  return KEYWORDS.filter((k) => k.name.startsWith(q));
}

/** `@https://example.com/x` typed out in full: a URL the popup can offer to attach. */
export function urlFromQuery(query: string): string | null {
  if (!/^https?:\/\/[^\s/]+/i.test(query)) return null;
  try {
    return new URL(query).toString();
  } catch {
    return null;
  }
}

export function chipFromCandidate(c: Candidate): Omit<ContextChip, "id"> {
  return { kind: c.kind, value: c.value, label: c.label, detail: c.detail };
}

export function sameChip(a: Pick<ContextChip, "kind" | "value">, b: Pick<ContextChip, "kind" | "value">): boolean {
  return a.kind === b.kind && a.value === b.value;
}

/** Adds unless an identical chip is there or the cap is reached. Returns the new list and whether it was added. */
export function addChip(list: ContextChip[], chip: Omit<ContextChip, "id">, nextId: () => string): { list: ContextChip[]; added: boolean; reason?: "duplicate" | "full" } {
  if (list.some((c) => sameChip(c, chip))) return { list, added: false, reason: "duplicate" };
  if (list.length >= MAX_CHIPS) return { list, added: false, reason: "full" };
  return { list: [...list, { ...chip, id: nextId() }], added: true };
}

/** Remove the `@query` the caret is in, tidying the space it leaves behind. */
export function removeMention(text: string, token: { start: number; query: string }, caret: number): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(caret);
  const joined = /\s$/.test(before) && /^\s/.test(after) ? before + after.replace(/^\s+/, "") : before + after;
  return { text: joined, caret: before.length };
}

export function toPayload(chips: ContextChip[]): Array<{ kind: ChipKind; value: string; label: string }> {
  return chips.map((c) => ({ kind: c.kind, value: c.value, label: c.label }));
}

/** Files on the clipboard or in a drop (a screenshot paste has no file name, only an item). Text items are not files. */
export function filesFromItems(items: DataTransferItemList | null | undefined): File[] {
  const out: File[] = [];
  for (const it of Array.from(items ?? [])) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

export function filesFromList(files: FileList | null | undefined): File[] {
  return Array.from(files ?? []);
}

/** Per-file and per-message limits, matching the daemon's (src/context/files.ts). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 75 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Why a file cannot be added right now, or null. `have` is the bytes of uploads already on the message. */
export function fileRefusal(f: { name: string; size: number }, have: number): string | null {
  if (f.size === 0) return `${f.name || "That file"} is empty`;
  if (f.size > MAX_FILE_BYTES) return `${f.name || "That file"} is over ${MAX_FILE_BYTES / 1024 / 1024} MB`;
  if (have + f.size > MAX_MESSAGE_BYTES) return `That is more than ${MAX_MESSAGE_BYTES / 1024 / 1024} MB of files for one message`;
  return null;
}
