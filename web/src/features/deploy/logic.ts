/** Pure helpers for the deploy pipeline. No React, no fetch, so the same rules are testable from the root suite. */

export type DeployStatus = "queued" | "running" | "succeeded" | "failed";
export type DeployKind = "deploy" | "rollback";

export interface DeployTarget {
  id: string;
  workspace_id: string;
  env: string;
  provider: string;
  config: Record<string, unknown>;
  url: string | null;
  created_at: string;
}

export interface Deploy {
  id: string;
  target_id: string;
  kind: DeployKind;
  status: DeployStatus;
  git_sha: string | null;
  version: string | null;
  url: string | null;
  provider_deploy_id: string | null;
  log_tail: string;
  started_at: string;
  finished_at: string | null;
}

/** The order a pipeline reads in. Other environments follow, by name. */
export const ENV_ORDER = ["dev", "staging", "prod"];

export function orderTargets<T extends { env: string }>(targets: T[]): T[] {
  const rank = (env: string) => {
    const i = ENV_ORDER.indexOf(env);
    return i < 0 ? ENV_ORDER.length : i;
  };
  return [...targets].sort((a, b) => rank(a.env) - rank(b.env) || a.env.localeCompare(b.env));
}

/** A target's deploys, newest first (the API already sorts them that way). */
export const deploysOf = (deploys: Deploy[], targetId: string): Deploy[] => deploys.filter((d) => d.target_id === targetId);

/** The live deploy: the newest one that succeeded. */
export const liveOf = (mine: Deploy[]): Deploy | null => mine.find((d) => d.status === "succeeded") ?? null;

const artifact = (d: Deploy): string => d.provider_deploy_id ?? d.url ?? "";

/** Rolling back needs a live deploy and an earlier successful one with a different artifact. The server decides for real. */
export function canRollback(mine: Deploy[]): boolean {
  const live = liveOf(mine);
  if (!live) return false;
  return mine.some((d) => d.status === "succeeded" && d.id !== live.id && artifact(d) !== "" && artifact(d) !== artifact(live));
}

export const isBusy = (d: Deploy | null): boolean => d?.status === "queued" || d?.status === "running";

export const STATUS_WORD: Record<DeployStatus, string> = { queued: "Queued", running: "Running", succeeded: "Live", failed: "Failed" };

/** The status light's own vocabulary (see components/ui/misc.tsx). */
export const STATUS_DOT: Record<DeployStatus, string> = { queued: "closed", running: "running", succeeded: "idle", failed: "failed" };

/** A launch check that blocks a prod deploy, as the daemon's refusal lists it. */
export interface LaunchBlocker {
  checklistTitle: string;
  text: string;
  status: "pass" | "fail" | "unknown";
}

/** The blockers of a refused prod deploy (the API answers 409 with them), or null for any other error. */
export function launchBlockersOf(err: unknown): LaunchBlocker[] | null {
  const e = err as { status?: unknown; body?: { blockers?: unknown } } | null;
  const list = e?.body?.blockers;
  if (e?.status !== 409 || !Array.isArray(list) || !list.length) return null;
  return list as LaunchBlocker[];
}

/** "28 Oct 2026, 14:05" in the reader's locale. SQLite stores UTC without a zone, so it is read as UTC. */
export function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso.replace(" ", "T")}${/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? "" : "Z"}`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
