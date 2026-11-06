/**
 * Sentry: the unresolved issues of one project, read through the REST API and kept as error signals.
 *
 * Needs SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT (env "prod", see types.ts EnvProvider). SENTRY_URL
 * is optional and only for a self-hosted Sentry. Without the three, the source is not configured and nothing is read.
 */
import { upsertSignal } from "../store";
import { SourceError, type Env, type FetchFn, type SignalInput, type Severity, type SourceResult } from "../types";

export interface SentryConfig {
  token: string;
  org: string;
  project: string;
  baseUrl: string;
}

export interface SentryIssue {
  id: string;
  shortId?: string;
  title: string;
  culprit?: string | null;
  permalink?: string | null;
  level?: string;
  count?: string | number;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  status?: string;
}

export function sentryConfig(env: Env): SentryConfig | null {
  const token = env.SENTRY_AUTH_TOKEN?.trim();
  const org = env.SENTRY_ORG?.trim();
  const project = env.SENTRY_PROJECT?.trim();
  if (!token || !org || !project) return null;
  return { token, org, project, baseUrl: (env.SENTRY_URL?.trim() || "https://sentry.io").replace(/\/+$/, "") };
}

/** Sentry's levels, mapped to the signal scale. Fatal is critical; anything unknown is low. */
export function severityOfLevel(level: string | undefined): Severity {
  switch (level) {
    case "fatal":
      return "critical";
    case "error":
      return "high";
    case "warning":
      return "medium";
    default:
      return "low";
  }
}

export function sentryToSignal(issue: SentryIssue): SignalInput {
  const count = Number(issue.count ?? 1);
  const users = issue.userCount ?? 0;
  const body = [issue.culprit ? `Where: ${issue.culprit}` : "", `${Number.isFinite(count) ? count : 1} events, ${users} user${users === 1 ? "" : "s"}`, issue.shortId ? `Sentry ${issue.shortId}` : ""].filter(Boolean).join("\n");
  return {
    source: "sentry",
    kind: "error",
    externalId: String(issue.id),
    title: issue.title,
    body,
    severity: severityOfLevel(issue.level),
    count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 1,
    url: issue.permalink ?? null,
    meta: { shortId: issue.shortId ?? null, culprit: issue.culprit ?? null, level: issue.level ?? null, userCount: users, status: issue.status ?? null },
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
  };
}

/** The unresolved issues of the project, most recent first (one page of 50, with events in the last 14 days). */
export async function fetchSentryIssues(cfg: SentryConfig, fetchFn: FetchFn): Promise<SentryIssue[]> {
  const url = `${cfg.baseUrl}/api/0/projects/${encodeURIComponent(cfg.org)}/${encodeURIComponent(cfg.project)}/issues/?query=${encodeURIComponent("is:unresolved")}&statsPeriod=14d&limit=50`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" } });
  } catch (e) {
    throw new SourceError(`Sentry could not be reached: ${(e as Error).message}`);
  }
  if (!res.ok) throw new SourceError(`Sentry answered ${res.status}. Check SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT.`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new SourceError("Sentry sent something other than a list of issues.");
  return body as SentryIssue[];
}

/** Read the configured Sentry project and upsert its issues. Never throws: a failure is reported in the result. */
export async function syncSentry(workspaceId: string, env: Env, fetchFn: FetchFn): Promise<SourceResult> {
  const cfg = sentryConfig(env);
  if (!cfg) return { source: "sentry", configured: false, upserted: 0, error: null };
  try {
    const issues = await fetchSentryIssues(cfg, fetchFn);
    for (const issue of issues) upsertSignal(workspaceId, sentryToSignal(issue));
    return { source: "sentry", configured: true, upserted: issues.length, error: null };
  } catch (e) {
    return { source: "sentry", configured: true, upserted: 0, error: (e as Error).message };
  }
}
