/** What a PR's checks look like on screen. Color comes with a word, so the state never depends on color alone. */
export type ChecksState = "none" | "pending" | "passing" | "failing";

export const CHECKS_LABEL: Record<ChecksState, string> = {
  none: "no checks",
  pending: "checks running",
  passing: "checks passing",
  failing: "checks failing",
};

export const CHECKS_TONE: Record<ChecksState, "neutral" | "amber" | "green" | "red"> = {
  none: "neutral",
  pending: "amber",
  passing: "green",
  failing: "red",
};

/** The merge button is not offered over failing checks; the server refuses them too. */
export const canMerge = (checks: ChecksState | null): boolean => checks !== "failing";
