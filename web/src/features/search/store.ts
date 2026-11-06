import { create } from "zustand";

/**
 * Search form state. A store rather than component state so the query survives switching sidebars, and so
 * other features ("Search in folder", "Find in files") can pre-fill it.
 */
interface SearchState {
  query: string;
  include: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Incremented to ask the (possibly not yet mounted) sidebar to focus its query box. */
  focusTick: number;
  setQuery(q: string): void;
  setInclude(i: string): void;
  toggle(k: "caseSensitive" | "wholeWord" | "regex"): void;
  /** Open the search with these values and focus it. */
  prefill(p: { query?: string; include?: string }): void;
}

export const useSearch = create<SearchState>((set) => ({
  query: "",
  include: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  focusTick: 0,
  setQuery: (query) => set({ query }),
  setInclude: (include) => set({ include }),
  toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<SearchState>),
  prefill: (p) => set((s) => ({ ...(p.query !== undefined ? { query: p.query } : {}), ...(p.include !== undefined ? { include: p.include } : {}), focusTick: s.focusTick + 1 })),
}));
