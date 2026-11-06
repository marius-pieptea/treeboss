import { create } from "zustand";
import { useEffect } from "react";
import type { ReactNode } from "react";

export interface Command {
  id: string;
  title: string;
  group: string;
  icon?: ReactNode;
  shortcut?: string;
  keywords?: string;
  run: () => void | Promise<void>;
  /** Hidden from the palette unless this returns true. */
  when?: () => boolean;
}

interface CommandStore {
  sources: Record<string, Command[]>;
  set(source: string, commands: Command[]): void;
  clear(source: string): void;
}

export const useCommandStore = create<CommandStore>((set) => ({
  sources: {},
  set: (source, commands) => set((s) => ({ sources: { ...s.sources, [source]: commands } })),
  clear: (source) =>
    set((s) => {
      const { [source]: _drop, ...rest } = s.sources;
      return { sources: rest };
    }),
}));

/** Register a feature's commands in the palette for as long as the component is mounted. */
export function useRegisterCommands(source: string, commands: Command[], deps: unknown[] = []): void {
  useEffect(() => {
    useCommandStore.getState().set(source, commands);
    return () => useCommandStore.getState().clear(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
