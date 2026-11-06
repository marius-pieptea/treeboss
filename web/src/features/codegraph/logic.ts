/** Pure helpers for the CodeGraph panel, kept apart so they can be tested without a DOM. */
// Structural types, so this file has no imports: the root typecheck compiles it through the tests.
interface StatusLike {
  state: "none" | "indexed" | "stale" | "incomplete" | "unavailable";
  available: boolean;
  source: "override" | "bundled" | "path" | null;
  version: string | null;
}
interface JobLike {
  state: "running" | "done" | "failed" | "cancelled";
}

export type DotState = "none" | "indexed" | "stale" | "incomplete" | "failed" | "running" | "unavailable";

/** What the status bar dot shows: a running job wins, then a failed one, then the index state. */
export function dotState(st: Pick<StatusLike, "state" | "available">, job: JobLike | null): DotState {
  if (job?.state === "running") return "running";
  if (job?.state === "failed") return "failed";
  if (!st.available || st.state === "unavailable") return "unavailable";
  return st.state;
}

/** "42s", "3m 05s": elapsed since an ISO timestamp. */
export function elapsed(startedAt: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "bundled v1.6.2", "from PATH v1.5.0", "custom path v1.6.2". */
export function sourceLabel(st: Pick<StatusLike, "source" | "version" | "available">): string {
  if (!st.available || !st.source) return "not installed";
  const v = st.version ? ` v${st.version.replace(/^v/, "")}` : "";
  return `${st.source === "bundled" ? "bundled" : st.source === "path" ? "from PATH" : "custom path"}${v}`;
}
