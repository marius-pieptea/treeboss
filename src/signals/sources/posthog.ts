/**
 * PostHog: a few key product numbers, read through the HogQL query API and kept as metric signals. The
 * latest value of each metric lives in `meta.value`, and the row is updated in place on every sync.
 *
 * Needs POSTHOG_API_KEY (a personal API key with query access) and POSTHOG_PROJECT_ID. POSTHOG_HOST defaults
 * to https://us.posthog.com. POSTHOG_EVENTS is an optional comma-separated list of event names to count over
 * the last 7 days. Without the key and project, the source is not configured and nothing is read.
 */
import { upsertSignal } from "../store";
import { SourceError, type Env, type FetchFn, type SourceResult } from "../types";

export interface PostHogConfig {
  apiKey: string;
  projectId: string;
  host: string;
  events: string[];
}

/** Event names are plain identifiers in practice; anything else is dropped rather than quoted into the query. */
const EVENT_NAME = /^[A-Za-z0-9_$.:\- ]{1,120}$/;

export function posthogConfig(env: Env): PostHogConfig | null {
  const apiKey = env.POSTHOG_API_KEY?.trim();
  const projectId = env.POSTHOG_PROJECT_ID?.trim();
  if (!apiKey || !projectId) return null;
  const events = (env.POSTHOG_EVENTS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => EVENT_NAME.test(e));
  return { apiKey, projectId, host: (env.POSTHOG_HOST?.trim() || "https://us.posthog.com").replace(/\/+$/, ""), events: [...new Set(events)] };
}

/** One HogQL query. Returns the result rows. The key is sent as a bearer header and never echoed in an error. */
export async function runHogQL(cfg: PostHogConfig, sql: string, fetchFn: FetchFn): Promise<unknown[][]> {
  let res: Response;
  try {
    res = await fetchFn(`${cfg.host}/api/projects/${encodeURIComponent(cfg.projectId)}/query/`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql } }),
    });
  } catch (e) {
    throw new SourceError(`PostHog could not be reached: ${(e as Error).message}`);
  }
  if (!res.ok) throw new SourceError(`PostHog answered ${res.status}. Check POSTHOG_API_KEY, POSTHOG_PROJECT_ID and POSTHOG_HOST.`);
  const body = (await res.json()) as { results?: unknown[][] };
  return Array.isArray(body.results) ? body.results : [];
}

/** SQL for the active-user count over `days` days: distinct people with any event in the window. */
export const activeUsersSql = (days: number): string => `SELECT count(DISTINCT person_id) FROM events WHERE timestamp >= now() - INTERVAL ${Math.floor(days)} DAY`;

/** SQL for the 7-day counts of the named events. The names are validated by EVENT_NAME, and quotes are doubled anyway. */
export const eventCountsSql = (events: string[]): string =>
  `SELECT event, count() FROM events WHERE timestamp >= now() - INTERVAL 7 DAY AND event IN (${events.map((e) => `'${e.replace(/'/g, "''")}'`).join(", ")}) GROUP BY event`;

/** Read the configured PostHog project and upsert the metric signals. Never throws: a failure is reported in the result. */
export async function syncPosthog(workspaceId: string, env: Env, fetchFn: FetchFn): Promise<SourceResult> {
  const cfg = posthogConfig(env);
  if (!cfg) return { source: "posthog", configured: false, upserted: 0, error: null };
  try {
    const now = new Date().toISOString();
    const metrics: Array<{ key: string; title: string; value: number; window: string }> = [];
    for (const days of [7, 30]) {
      const rows = await runHogQL(cfg, activeUsersSql(days), fetchFn);
      metrics.push({ key: `active_users_${days}d`, title: `Active users, last ${days} days`, value: Number(rows[0]?.[0] ?? 0), window: `${days}d` });
    }
    if (cfg.events.length) {
      const rows = await runHogQL(cfg, eventCountsSql(cfg.events), fetchFn);
      const seen = new Map(rows.map((r) => [String(r[0]), Number(r[1] ?? 0)]));
      for (const event of cfg.events) metrics.push({ key: `event_${event}_7d`, title: `${event}, last 7 days`, value: seen.get(event) ?? 0, window: "7d" });
    }
    for (const m of metrics) {
      upsertSignal(workspaceId, {
        source: "posthog",
        kind: "metric",
        externalId: m.key,
        title: m.title,
        body: `Latest value from PostHog at ${now}.`,
        severity: "low",
        count: Math.max(1, Math.floor(m.value)),
        meta: { metric: m.key, value: Number.isFinite(m.value) ? m.value : 0, window: m.window, updatedAt: now },
        lastSeen: now,
      });
    }
    return { source: "posthog", configured: true, upserted: metrics.length, error: null };
  } catch (e) {
    return { source: "posthog", configured: true, upserted: 0, error: (e as Error).message };
  }
}
