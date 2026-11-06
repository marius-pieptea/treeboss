/**
 * The deploy provider contract. A provider knows one CLI (wrangler, vercel, flyctl) or the user's own argv,
 * and turns a workspace root into a live URL. Providers never see a shell: every command is an argv array.
 *
 * Secrets arrive in `vars` and reach only the child process environment (see exec.ts). They are never put in
 * argv, never written to a log and never returned.
 */

export type ProviderId = "cloudflare" | "vercel" | "fly" | "command";

export interface DeployOptions {
  /** The target's config (argv, project names, paths). Already validated by the store. */
  config: Record<string, any>;
  /** Secrets for this workspace and environment. Child env only. */
  vars: Record<string, string>;
  /** Live output. The store keeps a redacted tail of it. */
  onLog: (text: string) => void;
  signal?: AbortSignal;
}

export interface DeployResult {
  /** The URL the new deploy answers on, or null when the CLI did not say. */
  url: string | null;
  /** The provider's handle for this deploy, used to roll back to it. Null when the provider has none. */
  providerDeployId: string | null;
  /** The CLI output, not redacted here (the store redacts before saving). */
  log: string;
}

export interface RollbackResult {
  url: string | null;
  log: string;
}

export interface ProviderStatus {
  state: "up" | "down" | "unknown";
  url: string | null;
  httpStatus: number | null;
  checkedAt: string;
}

export interface DeployProvider {
  id: ProviderId;
  label: string;
  /** The file that says this provider is used here, or null. "command" is never detected. */
  detect(root: string): string | null;
  deploy(root: string, env: string, opts: DeployOptions): Promise<DeployResult>;
  /** Make `providerDeployId` (from an earlier DeployResult) the live deploy again. */
  rollback(root: string, providerDeployId: string, opts: DeployOptions): Promise<RollbackResult>;
  status(root: string, url: string | null): Promise<ProviderStatus>;
}
