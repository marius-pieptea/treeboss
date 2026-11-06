/**
 * Fly.io through flyctl. The release version is the provider handle: `flyctl releases rollback <version>`
 * makes an earlier release live. A per-environment config (fly.<env>.toml) is used when it exists.
 * The token comes from FLY_API_TOKEN in the child env.
 */
import fs from "fs";
import path from "path";
import { UserError } from "../../util";
import { probeUrl, runArgv, urlIn } from "./exec";
import type { DeployOptions, DeployProvider, DeployResult, RollbackResult } from "./types";

const appArgs = (cfg: Record<string, any>): string[] => (typeof cfg.app === "string" && cfg.app ? ["--app", cfg.app] : []);

/** The config flags: an explicit config.configFile, else fly.<env>.toml for a non-prod environment when it exists, else none. */
function configFor(root: string, env: string, cfg: Record<string, any>): string[] {
  if (typeof cfg.configFile === "string" && cfg.configFile) return ["--config", cfg.configFile];
  if (env !== "prod" && fs.existsSync(path.join(root, `fly.${env}.toml`))) return ["--config", `fly.${env}.toml`];
  return [];
}

/** The newest release version, from `flyctl releases --json`. Null when it cannot be read. */
async function latestRelease(root: string, cfg: Record<string, any>, vars: Record<string, string>): Promise<string | null> {
  const r = await runArgv(["flyctl", "releases", "--json", ...appArgs(cfg)], { cwd: root, env: vars });
  if (r.code !== 0) return null;
  try {
    const list = JSON.parse(r.output);
    const v = Array.isArray(list) ? list[0]?.Version : null;
    return v === undefined || v === null ? null : String(v);
  } catch {
    return null;
  }
}

export const fly: DeployProvider = {
  id: "fly",
  label: "Fly.io",
  detect: (root) => (fs.existsSync(path.join(root, "fly.toml")) ? "fly.toml" : null),

  async deploy(root, env, opts: DeployOptions): Promise<DeployResult> {
    const argv = ["flyctl", "deploy", ...appArgs(opts.config), ...configFor(root, env, opts.config)];
    const r = await runArgv(argv, { cwd: root, env: opts.vars, onLog: opts.onLog, signal: opts.signal });
    if (r.code !== 0) throw new Error(`flyctl deploy exited ${r.code}.`);
    const url = urlIn(r.output, /\.fly\.dev/) ?? (typeof opts.config.app === "string" && opts.config.app ? `https://${opts.config.app}.fly.dev` : null);
    const version = await latestRelease(root, opts.config, opts.vars);
    return { url, providerDeployId: version, log: r.output };
  },

  async rollback(root, providerDeployId, opts: DeployOptions): Promise<RollbackResult> {
    if (!providerDeployId) throw new UserError("This Fly deploy has no release version to roll back to.");
    const r = await runArgv(["flyctl", "releases", "rollback", providerDeployId, ...appArgs(opts.config)], { cwd: root, env: opts.vars, onLog: opts.onLog, signal: opts.signal });
    if (r.code !== 0) throw new Error(`flyctl releases rollback exited ${r.code}.`);
    return { url: typeof opts.config.app === "string" && opts.config.app ? `https://${opts.config.app}.fly.dev` : null, log: r.output };
  },

  status: (_root, url) => probeUrl(url),
};
