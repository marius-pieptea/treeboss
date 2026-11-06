import { create } from "zustand";

/** Small cross-component UI state for the git panel (so the command palette can open the branch picker). */
export const useGitUi = create<{ branchPickerOpen: boolean; setBranchPicker(o: boolean): void; focusCommit: number; bumpFocusCommit(): void }>((set) => ({
  branchPickerOpen: false,
  setBranchPicker: (branchPickerOpen) => set({ branchPickerOpen }),
  focusCommit: 0,
  bumpFocusCommit: () => set((s) => ({ focusCommit: s.focusCommit + 1 })),
}));
