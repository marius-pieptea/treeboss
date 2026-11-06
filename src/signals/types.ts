/**
 * Shared shapes for signals: what the outside world reports (errors, metrics, feedback) and what the
 * operator does with it. Kept apart from store.ts so the sources do not need the database to be typed.
 */
export const SOURCES = ["sentry", "posthog", "feedback", "manual"] as const;
export const KINDS = ["error", "metric", "feedback"] as const;
export const STATUSES = ["new", "triaged", "ignored", "linked"] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type Source = (typeof SOURCES)[number];
export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Severity = (typeof SEVERITIES)[number];

/** One signal as the rest of the daemon sees it. `linkedRef` is a lab finding path, a roadmap item id or a spec dir. */
export interface Signal {
  id: string;
  workspaceId: string;
  source: Source;
  kind: Kind;
  externalId: string;
  title: string;
  body: string;
  severity: Severity;
  count: number;
  url: string | null;
  meta: Record<string, unknown>;
  status: Status;
  linkedRef: string | null;
  firstSeen: string;
  lastSeen: string;
}

/** What a source hands to the store. The store fills in ids, status and first_seen. */
export interface SignalInput {
  source: Source;
  kind: Kind;
  externalId: string;
  title: string;
  body?: string;
  severity?: Severity;
  count?: number;
  url?: string | null;
  meta?: Record<string, unknown>;
  /** ISO time the source saw it first and last. Default: now. */
  firstSeen?: string;
  lastSeen?: string;
}

/** Environment values by name. Secrets come from the secrets module (env "prod"), injected by the caller. */
export type Env = Record<string, string | undefined>;

/** Resolves the environment a workspace's sources read from. The default is an empty environment: nothing is configured. */
export type EnvProvider = (workspaceId: string) => Env;

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** What one source did in a sync. `error` is set when it was configured and failed; the other sources still run. */
export interface SourceResult {
  source: "sentry" | "posthog";
  configured: boolean;
  upserted: number;
  error: string | null;
}

/** A source that is configured but could not be read. The message never contains a credential. */
export class SourceError extends Error {}
