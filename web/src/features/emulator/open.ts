import { useUi, type NewTab } from "@/lib/store";

/** One device per daemon, so one tab, with the fixed id "emulator". */
export const emulatorTab = (): NewTab => ({ kind: "emulator", title: "Emulator" });

/** Open (or focus) the emulator: the title bar, the palette, the activity bar and the mobile panel use this. */
export function openEmulator(): void {
  void useUi.getState().openTab(emulatorTab());
}
