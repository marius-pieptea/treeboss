import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";
import { confirm } from "@/components/ui/dialogs";

/**
 * Close a tab, asking first when it has unsaved edits. Every close path (button, middle click, menu,
 * shortcut, command) goes through here so none of them can silently throw an edit away.
 */
export async function closeTabGuarded(id: string): Promise<boolean> {
  const { dirty, tabs } = (() => {
    const s = useUi.getState();
    return { dirty: s.dirty, tabs: s.current ? (s.byWs[s.current]?.tabs ?? []) : [] };
  })();
  const tab = tabs.find((t) => t.id === id);
  // A spec tab shows several files in the editor: any of them with unsaved edits holds the tab open.
  const prefix = tab?.kind === "spec" ? `file:${tab.root}:specs/${tab.feature}/` : null;
  const unsaved = prefix ? Object.keys(dirty).filter((k) => dirty[k] && k.startsWith(prefix)) : dirty[id] ? [id] : [];
  if (tab && unsaved.length) {
    const ok = await confirm({ title: `Discard changes to ${tab.title}?`, description: "Your unsaved edits will be lost.", confirmLabel: "Discard", danger: true });
    if (!ok) return false;
    for (const k of unsaved) bus.emit("tab-discard", { id: k });
  }
  useUi.getState().closeTab(id);
  return true;
}

export async function closeManyGuarded(ids: string[]): Promise<void> {
  for (const id of ids) if (!(await closeTabGuarded(id))) return;
}
