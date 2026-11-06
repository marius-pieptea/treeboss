import { create } from "zustand";
import { persist } from "zustand/middleware";
import { clampFont } from "./logic";

interface TermPrefs {
  fontSize: number;
  /** Show every listening dev server, not only the ones inside this workspace. */
  allPorts: boolean;
  setFontSize(n: number): void;
  setAllPorts(v: boolean): void;
}

export const useTermPrefs = create<TermPrefs>()(
  persist(
    (set) => ({
      fontSize: 13,
      allPorts: false,
      setFontSize: (n) => set({ fontSize: clampFont(n) }),
      setAllPorts: (allPorts) => set({ allPorts }),
    }),
    { name: "trb.terminal.v1", version: 1 },
  ),
);
