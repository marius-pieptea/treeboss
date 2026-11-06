/**
 * Which import (if any) the Skills page is showing. A store, not component state, so closing the dialog does not
 * lose the job: the import keeps running in the daemon and the page header shows its progress until you look again.
 */
import { create } from "zustand";

export type ImportMode = "directory" | "single";

interface SkillImportUi {
  /** The dialog is on screen. */
  open: boolean;
  mode: ImportMode;
  /** The job being watched (running, or finished and not yet dismissed). */
  jobId: string | null;
  /** Names the job was started for, to size the skill in flight when estimating bytes. */
  sizes: Record<string, number>;
  /** A finished job whose summary the operator has not seen (it ended while the dialog was closed). */
  unseen: boolean;
  openDialog(mode: ImportMode): void;
  openJob(jobId: string, sizes: Record<string, number>): void;
  close(): void;
  markSeen(): void;
  markUnseen(): void;
  dismiss(): void;
}

export const useSkillImport = create<SkillImportUi>((set) => ({
  open: false,
  mode: "directory",
  jobId: null,
  sizes: {},
  unseen: false,
  openDialog: (mode) => set((s) => ({ open: true, mode: s.jobId ? s.mode : mode })),
  openJob: (jobId, sizes) => set({ jobId, sizes, unseen: false, open: true }),
  close: () => set({ open: false }),
  markSeen: () => set({ unseen: false }),
  markUnseen: () => set({ unseen: true }),
  dismiss: () => set({ jobId: null, sizes: {}, unseen: false, open: false }),
}));

/** The folder the operator last imported from. */
const LAST_DIR = "trb.skills.lastDir";
export function lastImportDir(): string | null {
  try {
    return localStorage.getItem(LAST_DIR);
  } catch {
    return null;
  }
}
export function rememberImportDir(dir: string): void {
  try {
    localStorage.setItem(LAST_DIR, dir);
  } catch {}
}
