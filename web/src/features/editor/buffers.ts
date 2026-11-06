/**
 * Editor buffers that outlive the component.
 *
 * Switching tabs unmounts an editor; closing a tab with unsaved edits must not lose them. So the state
 * (document, undo history, selection, scroll) is stashed here by tab id when an editor unmounts, restored
 * when one mounts, and a mounted editor registers itself in `live` so commands (save all, go to line) can
 * reach it. Nothing here touches React.
 */
import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { StateEffect } from "@codemirror/state";
import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";
import { put, url } from "@/lib/api";
import { queryClient } from "@/lib/queries";

export interface BufferMeta {
  /** The document as last read from / written to disk. Dirty means the editor's doc differs from this. */
  savedDoc: Text;
  savedMtime: number;
  eol: "lf" | "crlf";
  savedEol: "lf" | "crlf";
  mode: "edit" | "preview";
  /** The tab.line this buffer last jumped to, so remounting does not re-jump over the cursor. */
  appliedLine?: number;
  scroll?: StateEffect<unknown>;
}

export interface Buffer {
  state: EditorState;
  meta: BufferMeta;
  root: string;
  path: string;
}

const buffers = new Map<string, Buffer>();
/** Tabs closed on purpose with their edits thrown away: the unmounting editor must not stash them again. */
const discarded = new Set<string>();

export const bufferStore = {
  get: (id: string) => buffers.get(id),
  set: (id: string, b: Buffer) => void buffers.set(id, b),
  delete: (id: string) => void buffers.delete(id),
  has: (id: string) => buffers.has(id),
  size: () => buffers.size,
  /** A file moved: the buffer (with its unsaved edits) goes with it. */
  rekey(oldId: string, newId: string, newPath: string): void {
    const b = buffers.get(oldId);
    if (!b) return;
    buffers.delete(oldId);
    buffers.set(newId, { ...b, path: newPath });
  },
  ids: () => [...buffers.keys()],
  /** True once if this tab was discarded; the caller then skips stashing. */
  consumeDiscard: (id: string) => discarded.delete(id),
};

// The shell asks before closing a tab with unsaved edits; a "yes" arrives here, and the edits go with it.
bus.on("tab-discard", ({ id }) => {
  buffers.delete(id);
  discarded.add(id);
  // The flag only matters for the unmount that follows immediately; do not let it outlive a tab that never unmounts.
  setTimeout(() => discarded.delete(id), 2000);
});

export function isDirty(b: Pick<Buffer, "state" | "meta">): boolean {
  return !b.state.doc.eq(b.meta.savedDoc) || b.meta.eol !== b.meta.savedEol;
}

/** What a mounted editor offers to the rest of the app. */
export interface LiveEditor {
  tabId: string;
  root: string;
  path: string;
  view: EditorView;
  meta: BufferMeta;
  save(): Promise<boolean>;
  revert(): void;
  gotoLine(): void;
  toggleWrap(): void;
}
const live = new Map<string, LiveEditor>();
export const liveEditors = {
  register: (e: LiveEditor) => void live.set(e.tabId, e),
  unregister: (id: string, e?: LiveEditor) => {
    if (!e || live.get(id) === e) live.delete(id);
  },
  get: (id: string) => live.get(id),
  active(): LiveEditor | undefined {
    const ui = useUi.getState();
    const id = ui.current ? ui.byWs[ui.current]?.activeTab : null;
    return id ? live.get(id) : undefined;
  },
};

export function eolSerialize(doc: Text, eol: "lf" | "crlf"): string {
  return eol === "crlf" ? doc.sliceString(0, doc.length, "\r\n") : doc.toString();
}

/** Write a document to disk under the optimistic lock. Throws ApiError (409 = changed underneath us). */
export async function writeDoc(root: string, path: string, doc: Text, eol: "lf" | "crlf", expectedMtime: number | null): Promise<{ mtime: number; size: number }> {
  // `create` so saving a file that was deleted underneath us brings it back (the editor warned about it).
  const r = await put<{ mtime: number; size: number }>(url.fs(root, "file"), { path, content: eolSerialize(doc, eol), expectedMtime, create: true });
  queryClient.invalidateQueries({ queryKey: ["git", root] });
  queryClient.setQueryData(["fs", root, "file", path], (old: any) => (old && "content" in old ? { ...old, mtime: r.mtime, size: r.size, content: eolSerialize(doc, eol), eol } : old));
  return r;
}

/** Save a buffer that is not mounted (Save All across tabs). */
export async function saveStashed(tabId: string): Promise<boolean> {
  const b = buffers.get(tabId);
  if (!b || !isDirty(b)) return true;
  const doc = b.state.doc;
  const r = await writeDoc(b.root, b.path, doc, b.meta.eol, b.meta.savedMtime);
  buffers.set(tabId, { ...b, meta: { ...b.meta, savedDoc: doc, savedMtime: r.mtime, savedEol: b.meta.eol } });
  useUi.getState().setDirty(tabId, false);
  return true;
}

/** Tab ids with unsaved edits, whether or not their editor is on screen. */
export function dirtyTabIds(): string[] {
  const ids = new Set<string>();
  for (const [id, b] of buffers) if (isDirty(b)) ids.add(id);
  for (const [id, e] of live) if (!e.view.state.doc.eq(e.meta.savedDoc) || e.meta.eol !== e.meta.savedEol) ids.add(id);
  return [...ids];
}

/** Save every dirty file. Returns the ones that could not be saved (conflicts, errors). */
export async function saveAll(): Promise<{ saved: number; failed: Array<{ id: string; path: string; message: string }> }> {
  let saved = 0;
  const failed: Array<{ id: string; path: string; message: string }> = [];
  for (const id of dirtyTabIds()) {
    const e = live.get(id);
    try {
      const ok = e ? await e.save() : await saveStashed(id);
      if (ok) saved++;
      else failed.push({ id, path: e?.path ?? buffers.get(id)?.path ?? id, message: "save did not complete (see the editor)" });
    } catch (err: any) {
      failed.push({ id, path: e?.path ?? buffers.get(id)?.path ?? id, message: err?.message ?? String(err) });
    }
  }
  return { saved, failed };
}

// Forget clean buffers whose tab is gone; dirty ones stay so a reopened tab gets its edits back.
useUi.subscribe((s) => {
  const open = new Set<string>();
  for (const ws of Object.values(s.byWs)) for (const t of ws.tabs) open.add(t.id);
  for (const [id, b] of buffers) if (!open.has(id) && !isDirty(b)) buffers.delete(id);
});

/**
 * "Move the cursor into the editor after the next jump." Opening a search result with Enter wants focus in the
 * editor; clicking one keeps it in the results list so the next arrow key moves to the next result.
 */
let wantFocus = false;
export const editorFocus = {
  request(): void {
    wantFocus = true;
    setTimeout(() => (wantFocus = false), 3000);
  },
  take(): boolean {
    const w = wantFocus;
    wantFocus = false;
    return w;
  },
};
