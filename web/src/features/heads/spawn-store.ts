import { create } from "zustand";

/** Whether the spawn dialog is open, and under which session. A tiny store so a command can open it from anywhere. */
export const useSpawnDialog = create<{ open: boolean; parentId: string | null; show(parentId?: string | null): void; hide(): void }>((set) => ({
  open: false,
  parentId: null,
  show: (parentId = null) => set({ open: true, parentId }),
  hide: () => set({ open: false }),
}));
