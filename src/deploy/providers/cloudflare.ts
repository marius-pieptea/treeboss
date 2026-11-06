/**
 * Cloudflare through wrangler. Workers when the config has no `pages_build_output_dir`, Pages when it does.
 * The API token is CLOUDFLARE_API_TOKEN in the child env (wrangler reads it there).
 */
import fs from "fs";
import path from "path";
import { UserError } from "../../util";
import { probeUrl, runArgv, urlIn } from "./exec";
import type { DeployOptions, DeployProvider, DeployResult, RollbackResult } from "./types";

const CONFIGS = ["wrangler.toml", "wrangler.jsonc", "wrangler.json"];

export function wranglerFile(root: string): string | null {
  return CONFIGS.find((f) => fs.existsSync(path.join(root, f))) ?? null;
}

/** The Pages build output folder the wrangler config declares, or null. */
const PAGES_DIR = (root: string): string | null => {
  const file = wranglerFile(root);
  if (!file) return null;
  const m = /pages_build_output_dir["']?\s*[:=]\s*["']([^"']+)["']/.exec(fs.readFileSync(path.join(root, file), "utf-8"));
  return m ? m[1]! : null;
};

/** "pages" when the wrangler config declares a Pages build output, else "workers". Null when there is no config. */
export function cloudflareKind(root: string): "pages" | "workers" | null {
  if (!wranglerFile(root)) return null;
  return PAGES_DIR(root) ? "pages" : "workers";
}

/** The version id wrangler prints after a Workers deploy. Used to roll back to it. */
const VERSION_ID = /Current Version ID:\s*([0-9a-f-]{36})/i;

export const cloudflare: DeployProvider = {
  id: "cloudflare",
  label: "Cloudflare",
  detect: (root) => wranglerFile(root),

  async deploy(root, env, opts: DeployOptions): Promise<DeployResult> {
    const kind = cloudflareKind(root);
    if (!kind) throw new UserError("No wrangler.toml, wrangler.jsonc or wrangler.json in this workspace.");
    let argv: string[];
    if (kind === "workers") {
      // Workers environments come from the wrangler config; prod is the default one.
      argv = ["wrangler", "deploy", ...(env === "prod" ? [] : ["--env", env])];
    } else {
      const project = opts.config.project;
      const dir = opts.config.dir ?? PAGES_DIR(root);
      if (typeof project !== "string" || !project) throw new UserError("Cloudflare Pages needs the project name (config.project).");
      if (typeof dir !== "string" || !dir) throw new UserError("Cloudflare Pages needs the build output folder (config.dir).");
      const branch = typeof opts.config.branch === "string" && opts.config.branch ? opts.config.branch : env === "prod" ? "main" : env;
      argv = ["wrangler", "pages", "deploy", dir, "--project-name", project, "--branch", branch];
    }
    const r = await runArgv(argv, { cwd: root, env: opts.vars, onLog: opts.onLog, signal: opts.signal });
    if (r.code !== 0) throw new Error(`wrangler exited ${r.code}.`);
    const version = kind === "workers" ? VERSION_ID.exec(r.output)?.[1] ?? null : null;
    return { url: urlIn(r.output, /\.(workers|pages)\.dev/), providerDeployId: version, log: r.output };
  },

  async rollback(root, providerDeployId, opts: DeployOptions): Promise<RollbackResult> {
    if (cloudflareKind(root) !== "workers") {
      // Pages has no rollback command in wrangler. Promoting an earlier deployment is a dashboard action.
      throw new UserError("Cloudflare Pages rolls back from the dashboard (promote the earlier deployment). wrangler has no Pages rollback.");
    }
    const r = await runArgv(["wrangler", "rollback", providerDeployId, "--yes"], { cwd: root, env: opts.vars, onLog: opts.onLog, signal: opts.signal });
    if (r.code !== 0) throw new Error(`wrangler rollback exited ${r.code}.`);
    return { url: urlIn(r.output, /\.(workers|pages)\.dev/), log: r.output };
  },

  status: (_root, url) => probeUrl(url),
};
