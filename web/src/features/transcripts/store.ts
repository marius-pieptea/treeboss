import { create } from "zustand";

/** What the session replay tab is looking at. Lives outside the component so anything can open a replay at a turn. */
interface TranscriptsView {
  query: string;
  sessionId: string | null;
  /** The turn to scroll to and flash. `tick` changes on every jump so choosing the same hit twice still scrolls. */
  seq: number | null;
  tick: number;
  setQuery: (q: string) => void;
  open: (sessionId: string, seq?: number | null) => void;
}

export const useTranscripts = create<TranscriptsView>((set) => ({
  query: "",
  sessionId: null,
  seq: null,
  tick: 0,
  setQuery: (query) => set({ query }),
  open: (sessionId, seq = null) => set((s) => ({ sessionId, seq, tick: s.tick + 1 })),
}));
