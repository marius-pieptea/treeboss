/**
 * File operations shared by the explorer and the command palette. Each does the API call and then puts the
 * rest of the UI right: tree listings refetch, open tabs follow a rename, buffers go with their files.
 */
import { del, post, url } from "@/lib/api";
import { queryClient } from "@/lib/queries";
import { tabId, useUi, type Tab } from "@/lib/store";
import { basename } from "@/lib/utils";
import { bufferStore } from "../editor/buffers";

export function refreshTree(root: string): void {
  queryClient.invalidateQueries({ queryKey: ["fs", root, "tree"] });
  queryClient.invalidateQueries({ queryKey: ["fs", root, "find"] });
  queryClient.invalidateQueries({ queryKey: ["git", root] });
}

function currentTabs(): { tabs: Tab[]; active: string | null } {
  const s = useUi.getState();
  const ws = s.current ? s.byWs[s.current] : undefined;
  return { tabs: ws?.tabs ?? [], active: ws?.activeTab ?? null };
}

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

export async function createEntry(root: string, path: string, type: "file" | "dir"): Promise<void> {
  await post(url.fs(root, "create"), { path, type });
  refreshTree(root);
}

export async function renameEntry(root: string, from: string, to: string): Promise<void> {
  await post(url.fs(root, "rename"), { from, to });
  refreshTree(root);
  // Open tabs follow the file: same editor, new path, unsaved edits intact.
  const ui = useUi.getState();
  const { tabs, active } = currentTabs();
  let newActive: string | null = active;
  for (const t of tabs) {
    if ((t.kind !== "file" && t.kind !== "diff") || t.root !== root || !under(t.path, from)) continue;
    const newPath = to + t.path.slice(from.length);
    if (t.kind === "file") {
      const newId = tabId({ kind: "file", root, path: newPath, title: basename(newPath) });
      bufferStore.rekey(t.id, newId, newPath);
      ui.closeTab(t.id);
      ui.openTab({ kind: "file", root, path: newPath, title: basename(newPath), preview: false });
      if (t.id === active) newActive = newId;
    } else {
      ui.closeTab(t.id);
    }
  }
  if (newActive) ui.activateTab(newActive);
}

/** Does anything under this path have unsaved edits? Used to warn before deleting. */
export function hasUnsavedUnder(root: string, path: string): boolean {
  const dirty = useUi.getState().dirty;
  const { tabs } = currentTabs();
  return tabs.some((t) => t.kind === "file" && t.root === root && under(t.path, path) && dirty[t.id]);
}

export async function deleteEntry(root: string, path: string): Promise<void> {
  await del(url.fs(root, "file", { path }));
  const ui = useUi.getState();
  for (const t of currentTabs().tabs) {
    if ((t.kind === "file" || t.kind === "diff") && t.root === root && under(t.path, path)) {
      bufferStore.delete(t.id);
      ui.closeTab(t.id);
    }
  }
  refreshTree(root);
}

export async function duplicateEntry(root: string, from: string, to: string): Promise<void> {
  await post(url.fs(root, "copy"), { from, to });
  refreshTree(root);
}

/** Shows the entry in the OS file manager. The daemon runs on this machine, so this opens a window here. */
export async function revealEntry(root: string, path: string): Promise<void> {
  await post(url.fs(root, "reveal"), { path });
}
