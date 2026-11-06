/**
 * Vercel through its CLI. Production deploys pass --prod. The deployment URL is the provider handle: it is
 * what `vercel rollback` promotes. The token travels as VERCEL_TOKEN in the child env, not as --token, so it
 * never shows up in argv or in a process listing.
 */
import fs from "fs";
import path from "path";
import { UserError } from "../../util";
import { probeUrl, runArgv, urlIn } from "./exec";
import type { DeployOptions, DeployProvider, DeployResult, RollbackResult } from "./types";

export const vercel: DeployProvider = {
  id: "vercel",
  label: "Vercel",
  detect(root) {
    if (fs.existsSync(path.join(root, "vercel.json"))) return "vercel.json";
    if (fs.existsSync(path.join(root, ".vercel", "project.json"))) return ".vercel/project.json";
    return null;
  },

  async deploy(root, env, opts: DeployOptions): Promise<DeployResult> {
    const argv = ["vercel", "deploy", "--yes", ...(env === "prod" ? ["--prod"] : []), ...(typeof opts.config.scope === "string" && opts.config.scope ? ["--scope", opts.config.scope] : [])];
    const r = await runArgv(argv, { cwd: root, env: opts.vars, onLog: opts.onLog, signal: opts.signal });
    if (r.code !== 0) throw new Error(`vercel deploy exited ${r.code}.`);
    const url = urlIn(r.output, /\.vercel\.app/);
    return { url, providerDeployId: url, log: r.output };
  },

  async rollback(root, providerDeployId, opts: DeployOptions): Promise<RollbackResult> {
    if (!providerDeployId) throw new UserError("This Vercel deploy has no deployment URL to roll back to.");
    const argv = ["vercel", "rollback", providerDeployId, "--yes", ...(typeof opts.config.scope === "string" && opts.config.scope ? ["--scope", opts.config.scope] : [])];
    const r = await runArgv(argv, { cwd: root, env: opts.vars, onLog: opts.onLog, signal: opts.signal });
    if (r.code !== 0) throw new Error(`vercel rollback exited ${r.code}.`);
    return { url: providerDeployId, log: r.output };
  },

  status: (_root, url) => probeUrl(url),
};
