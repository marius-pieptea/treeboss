/**
 * The files feature's palette commands. Registered when this module loads (it is imported by FileTab,
 * which the editor area always pulls in), because "New file" and "Find in files" must be available before
 * any editor is open. They read live state through the stores rather than closing over React state.
 */
import { FilePlus2, Replace, Save, SaveAll, Search, Target, TextCursorInput, WrapText } from "lucide-react";
import { toast } from "sonner";
import { ask } from "@/components/ui/dialogs";
import { bus } from "@/lib/bus";
import { useCommandStore, type Command } from "@/lib/commands";
import { formatCombo } from "@/lib/hooks";
import { useUi } from "@/lib/store";
import { basename } from "@/lib/utils";
import { createEntry } from "../explorer/ops";
import { useExplorer } from "../explorer/store";
import { validateName } from "../explorer/tree";
import { useSearch } from "../search/store";
import { dirtyTabIds, liveEditors, saveAll } from "./buffers";

const root = () => useUi.getState().current;
const hasEditor = () => Boolean(liveEditors.active());

export async function promptNewFile(dir: string): Promise<void> {
  const r = root();
  if (!r) return;
  const where = dir ? `${dir}/` : "";
  const name = await ask({
    title: "New file",
    description: dir ? `In ${dir}` : "In the workspace root",
    label: "Path",
    placeholder: "src/components/Button.tsx",
    confirmLabel: "Create",
    validate: (v) => validateName(v, { siblings: [], allowPath: true }),
  });
  if (!name) return;
  const path = `${where}${name.trim()}`;
  try {
    await createEntry(r, path, "file");
    useUi.getState().openTab({ kind: "file", root: r, path, title: basename(path) });
    useExplorer.getState().reveal(path);
  } catch (e: any) {
    toast.error(`Could not create ${path}`, { description: e?.message });
  }
}

/** Where "New file" lands: inside the selected folder, or next to the selected file. */
const selectedDir = (): string => {
  const { selected, selectedIsDir } = useExplorer.getState();
  if (!selected) return "";
  return selectedIsDir ? selected : selected.includes("/") ? selected.slice(0, selected.lastIndexOf("/")) : "";
};

const commands: Command[] = [
  { id: "files.save", group: "File", title: "Save", icon: <Save />, shortcut: formatCombo({ key: "s", mod: true }), when: hasEditor, run: () => void liveEditors.active()?.save() },
  {
    id: "files.saveAll",
    group: "File",
    title: "Save all",
    icon: <SaveAll />,
    when: () => dirtyTabIds().length > 0,
    run: async () => {
      const r = await saveAll();
      if (r.failed.length) toast.error(`${r.failed.length} file${r.failed.length === 1 ? "" : "s"} not saved`, { description: r.failed.map((f) => `${f.path}: ${f.message}`).join("\n") });
      else toast.success(`Saved ${r.saved} file${r.saved === 1 ? "" : "s"}`);
    },
  },
  { id: "files.revert", group: "File", title: "Revert file", icon: <Replace />, keywords: "reload discard disk", when: hasEditor, run: () => liveEditors.active()?.revert() },
  { id: "files.wrap", group: "Editor", title: "Toggle word wrap", icon: <WrapText />, shortcut: "Alt+Z", run: () => liveEditors.active()?.toggleWrap() ?? void 0 },
  { id: "files.gotoLine", group: "Editor", title: "Go to line…", icon: <TextCursorInput />, shortcut: "Ctrl+G", when: hasEditor, run: () => liveEditors.active()?.gotoLine() },
  {
    id: "files.reveal",
    group: "Editor",
    title: "Reveal active file in explorer",
    icon: <Target />,
    when: () => {
      const ui = useUi.getState();
      const ws = ui.current ? ui.byWs[ui.current] : undefined;
      return ws?.tabs.find((t) => t.id === ws.activeTab)?.kind === "file";
    },
    run: () => {
      const ui = useUi.getState();
      const ws = ui.current ? ui.byWs[ui.current] : undefined;
      const tab = ws?.tabs.find((t) => t.id === ws.activeTab);
      if (tab?.kind !== "file") return;
      ui.setActivity("explorer");
      useExplorer.getState().reveal(tab.path);
      bus.emit("reveal-in-explorer", { path: tab.path });
    },
  },
  { id: "files.new", group: "File", title: "New file…", icon: <FilePlus2 />, keywords: "create", run: () => void promptNewFile(selectedDir()) },
  {
    id: "files.find",
    group: "Search",
    title: "Find in files",
    icon: <Search />,
    shortcut: formatCombo({ key: "f", mod: true, shift: true }),
    run: () => {
      const sel = liveEditors.active()?.view;
      const text = sel ? sel.state.sliceDoc(sel.state.selection.main.from, sel.state.selection.main.to) : "";
      useUi.getState().setActivity("search");
      // Opening the search from an editor selection searches for that selection.
      useSearch.getState().prefill(text && !text.includes("\n") ? { query: text } : {});
    },
  },
];

useCommandStore.getState().set("files", commands);

// Cmd/Ctrl-S saves the active file wherever focus is (the explorer, a banner button), not only inside the
// editor, and never opens the browser's own "Save page as" dialog. The editor's own binding runs first and
// marks the event handled, so a save from inside the editor is not issued twice.
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
    if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
    const handled = e.defaultPrevented;
    e.preventDefault();
    if (!handled) void liveEditors.active()?.save();
  });
}
