/**
 * Pull every configured signal source into a workspace. Exported for a scheduler: call it on a timer, or from
 * the sync route and `trb signals sync`. Sources run one after the other; one failing does not stop the rest.
 *
 * The environment comes from `envProvider` (the secrets module resolves it for env "prod" in production); the
 * default is an empty environment, so nothing is read until a provider is wired in.
 */
import { resolveRoot } from "../workspaces";
import { posthogConfig, syncPosthog } from "./sources/posthog";
import { sentryConfig, syncSentry } from "./sources/sentry";
import type { Env, EnvProvider, FetchFn, SourceResult } from "./types";

export interface SyncOptions {
  envProvider?: EnvProvider;
  fetch?: FetchFn;
}

export interface SyncReport {
  workspaceId: string;
  at: string;
  sources: SourceResult[];
}

export const noEnv: EnvProvider = () => ({});

export async function syncSignals(workspaceId: string, o: SyncOptions = {}): Promise<SyncReport> {
  resolveRoot(workspaceId);
  const env = (o.envProvider ?? noEnv)(workspaceId);
  const fetchFn: FetchFn = o.fetch ?? ((input, init) => fetch(input, init));
  const sources: SourceResult[] = [];
  sources.push(await syncSentry(workspaceId, env, fetchFn));
  sources.push(await syncPosthog(workspaceId, env, fetchFn));
  return { workspaceId, at: new Date().toISOString(), sources };
}

/** Which sources have the settings they need, so the inbox can say what is missing. */
export function sourcesConfigured(env: Env): { sentry: boolean; posthog: boolean } {
  return { sentry: sentryConfig(env) !== null, posthog: posthogConfig(env) !== null };
}
