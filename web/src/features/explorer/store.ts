import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Explorer UI state that other features reach into (the editor reveals, commands create). */
interface ExplorerState {
  /** The highlighted row's path ("" = nothing). Files and folders alike. */
  selected: string;
  selectedIsDir: boolean;
  /** A path to scroll to and select the next time the tree renders (set before the sidebar is even mounted). */
  pendingReveal: string | null;
  autoReveal: boolean;
  select(path: string, isDir?: boolean): void;
  reveal(path: string): void;
  clearReveal(): void;
  setAutoReveal(v: boolean): void;
}

export const useExplorer = create<ExplorerState>()(
  persist(
    (set) => ({
      selected: "",
      selectedIsDir: false,
      pendingReveal: null,
      autoReveal: true,
      select: (selected, isDir = false) => set({ selected, selectedIsDir: isDir }),
      reveal: (path) => set({ pendingReveal: path }),
      clearReveal: () => set({ pendingReveal: null }),
      setAutoReveal: (autoReveal) => set({ autoReveal }),
    }),
    { name: "trb.explorer.v1", version: 1, partialize: (s) => ({ autoReveal: s.autoReveal }) },
  ),
);
