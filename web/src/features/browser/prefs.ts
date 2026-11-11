import { create } from "zustand";
import { persist } from "zustand/middleware";
import { clampZoom } from "./logic";

interface BrowserPrefs {
  device: string;
  rotated: boolean;
  zoom: number;
  fit: boolean;
  /** Serve the preview through the inspecting proxy (element picking, console capture). */
  inspect: boolean;
  runOpen: boolean;
  set(p: Partial<Omit<BrowserPrefs, "set">>): void;
}

export const useBrowserPrefs = create<BrowserPrefs>()(
  persist(
    (set) => ({
      device: "responsive",
      rotated: false,
      zoom: 1,
      fit: true,
      inspect: false,
      runOpen: false,
      set: (p) => set({ ...p, ...(p.zoom !== undefined ? { zoom: clampZoom(p.zoom) } : {}) }),
    }),
    { name: "trb.browser.v1", version: 1 },
  ),
);
