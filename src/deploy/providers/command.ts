/**
 * The generic provider: the user's own argv. Never detected from files, because only the user knows what
 * their deploy is. `config.argv` runs in the workspace root; `config.rollbackArgv` (optional) runs for a
 * rollback, with `{id}` replaced by the earlier deploy's handle (its URL, since a command has no other).
 */
import { UserError } from "../../util";
import { probeUrl, runArgv, urlIn } from "./exec";
import type { DeployOptions, DeployProvider, DeployResult, RollbackResult } from "./types";

const argvOf = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !x)) throw new UserError(`${name} must be a non-empty list of strings (argv, not a shell line).`);
  return v as string[];
};

export const command: DeployProvider = {
  id: "command",
  label: "Command",
  detect: () => null,

  async deploy(root, _env, opts: DeployOptions): Promise<DeployResult> {
    const argv = argvOf(opts.config.argv, "config.argv");
    const r = await runArgv(argv, { cwd: root, env: opts.vars, onLog: opts.onLog, signal: opts.signal });
    if (r.code !== 0) throw new Error(`${argv[0]} exited ${r.code}.`);
    const url = typeof opts.config.url === "string" && opts.config.url ? opts.config.url : urlIn(r.output);
    return { url, providerDeployId: url, log: r.output };
  },

  async rollback(root, providerDeployId, opts: DeployOptions): Promise<RollbackResult> {
    if (opts.config.rollbackArgv === undefined) throw new UserError("This command target has no rollbackArgv, so it cannot roll back.");
    const template = argvOf(opts.config.rollbackArgv, "config.rollbackArgv");
    const argv = template.map((a) => a.split("{id}").join(providerDeployId));
    const r = await runArgv(argv, { cwd: root, env: opts.vars, onLog: opts.onLog, signal: opts.signal });
    if (r.code !== 0) throw new Error(`${argv[0]} exited ${r.code}.`);
    return { url: urlIn(r.output) ?? providerDeployId, log: r.output };
  },

  status: (_root, url) => probeUrl(url),
};
