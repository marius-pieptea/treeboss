/** Mirrors BUG_KINDS in src/lab/findings.ts; kept free of imports so a root test can compare the two. */
export const BUG_KINDS = ["functional", "visual", "logic", "content", "performance"] as const;
export type BugKind = (typeof BUG_KINDS)[number];
