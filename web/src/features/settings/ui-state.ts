import { create } from "zustand";
import type { SettingsPage } from "@/lib/store";

/**
 * Which settings dialog is open and which skill is selected. A store (not component state) so the command
 * palette can open "Add MCP server…" even before that page has mounted.
 */
export type SettingsDialog = "mcp-add" | "mcp-import" | "skill-new" | "skill-add" | "skill-import" | "pair-new" | "agent-new" | null;

interface SettingsUi {
  dialog: SettingsDialog;
  /** The dialog belongs to this page: a page ignores dialogs meant for another. */
  open(dialog: Exclude<SettingsDialog, null>): void;
  close(): void;
  selectedSkill: string | null;
  selectSkill(name: string | null): void;
  /** A pair to open in the editor once the Pairs page is showing (an agent card links here). */
  pendingPair: string | null;
  openPair(title: string): void;
  clearPendingPair(): void;
  /** A daemon setting to scroll to and highlight on the Daemon settings page (a search hit picks it). */
  focusedSetting: string | null;
  focusSetting(key: string | null): void;
}

export const DIALOG_PAGE: Record<Exclude<SettingsDialog, null>, SettingsPage> = {
  "mcp-add": "mcp",
  "mcp-import": "mcp",
  "skill-new": "skills",
  "skill-add": "skills",
  "skill-import": "skills",
  "pair-new": "pairs",
  "agent-new": "agents",
};

export const useSettingsUi = create<SettingsUi>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
  selectedSkill: null,
  selectSkill: (selectedSkill) => set({ selectedSkill }),
  pendingPair: null,
  openPair: (title) => set({ pendingPair: title }),
  clearPendingPair: () => set({ pendingPair: null }),
  focusedSetting: null,
  focusSetting: (focusedSetting) => set({ focusedSetting }),
}));
