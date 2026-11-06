/** The provider registry: look up by id, and detect which providers a workspace uses. */
import { UserError } from "../../util";
import { cloudflare } from "./cloudflare";
import { command } from "./command";
import { fly } from "./fly";
import { vercel } from "./vercel";
import type { DeployProvider, ProviderId } from "./types";

export type { DeployOptions, DeployProvider, DeployResult, ProviderId, ProviderStatus, RollbackResult } from "./types";

export const PROVIDERS: Record<ProviderId, DeployProvider> = { cloudflare, vercel, fly, command };
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDER_IDS as string[]).includes(v);

export function providerFor(id: string): DeployProvider {
  if (!isProviderId(id)) throw new UserError(`Unknown deploy provider "${id}". Use one of: ${PROVIDER_IDS.join(", ")}.`);
  return PROVIDERS[id];
}

/** The providers whose config file is in `root`, each with the file that said so. */
export function detectProviders(root: string): Array<{ id: ProviderId; label: string; reason: string }> {
  const out: Array<{ id: ProviderId; label: string; reason: string }> = [];
  for (const p of Object.values(PROVIDERS)) {
    const reason = p.detect(root);
    if (reason) out.push({ id: p.id, label: p.label, reason });
  }
  return out;
}
