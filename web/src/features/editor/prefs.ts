import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Editor preferences that follow the operator across files and sessions. */
interface EditorPrefs {
  wrap: boolean;
  guides: boolean;
  /** Save a file shortly after its last edit, instead of only on Mod-s or Save All. */
  autosave: boolean;
  setWrap(v: boolean): void;
  setGuides(v: boolean): void;
  setAutosave(v: boolean): void;
}

export const useEditorPrefs = create<EditorPrefs>()(
  persist(
    (set) => ({
      wrap: false,
      guides: true,
      autosave: false,
      setWrap: (wrap) => set({ wrap }),
      setGuides: (guides) => set({ guides }),
      setAutosave: (autosave) => set({ autosave }),
    }),
    { name: "trb.editor.v1", version: 1 },
  ),
);
