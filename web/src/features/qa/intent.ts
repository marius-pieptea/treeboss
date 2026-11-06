import { create } from "zustand";

interface PlanIntent {
  slug: string | null;
  /** Ask the QA panel to select this plan the next time it has the plan list: it works whether the panel is open already or opens later. */
  selectPlanOnOpen(slug: string): void;
  clear(): void;
}

export const useQaIntent = create<PlanIntent>((set) => ({
  slug: null,
  selectPlanOnOpen: (slug) => set({ slug }),
  clear: () => set({ slug: null }),
}));

export const selectPlanOnOpen = (slug: string): void => useQaIntent.getState().selectPlanOnOpen(slug);
