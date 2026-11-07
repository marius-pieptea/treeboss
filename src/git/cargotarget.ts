/**
 * One Rust build cache per repo, shared by every worktree of it.
 *
 * Cargo puts `target/` next to Cargo.toml, so each head's worktree (a hydra pair, a lead's
 * children) did its own cold build: N heads, N copies of every dependency, tens of GB each.
 * Pointing them all at one directory under trb's home keeps a single copy of the registry
 * dependencies. Cargo locks the directory while it builds, so concurrent builds queue instead
 * of corrupting each other. Workspace crates still rebuild per worktree (their path is part of
 * the fingerprint), which is why the directory is capped and dropped when nothing is using it.
 */
import fs from "fs";
import path from "path";
import { home, paths } from "../paths";

export const CARGO_TARGET_ROOT = "cargo-target";

export function cargoTargetRoot(): string {
  return path.join(home(), CARGO_TARGET_ROOT);
}

/**
 * The CARGO_TARGET_DIR to give a process running in `cwd`, or null when it should keep its own:
 * the operator set one, `cwd` is not a trb worktree, or the setting is off.
 */
export function sharedCargoTarget(cwd: string, env: NodeJS.ProcessEnv, enabled: boolean): string | null {
  if (!enabled || env.CARGO_TARGET_DIR) return null;
  const rel = path.relative(paths.worktrees(), path.resolve(cwd));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const repoDir = rel.split(path.sep)[0];
  return repoDir ? path.join(cargoTargetRoot(), repoDir) : null;
}

/** Bytes under `dir`, links not followed. Stops early once past `limit`: the caller only asks "over the cap?". */
export function dirSizeOver(dir: string, limit: number): boolean {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {}
        if (total > limit) return true;
      }
    }
  }
  return false;
}

/**
 * Drop a repo's shared target dir once it is over `maxBytes` and no session of that repo is live
 * (deleting under a running build would break it). Returns the repo dirs removed.
 */
export function pruneSharedTargets(maxBytes: number): string[] {
  if (maxBytes <= 0) return [];
  const root = cargoTargetRoot();
  const removed: string[] = [];
  let repos: string[] = [];
  try {
    repos = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const repoDir of repos) {
    const inUse = (() => {
      try {
        return fs.readdirSync(path.join(paths.worktrees(), repoDir)).length > 0;
      } catch {
        return false;
      }
    })();
    if (inUse) continue;
    const dir = path.join(root, repoDir);
    if (!dirSizeOver(dir, maxBytes)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(repoDir);
    } catch {}
  }
  return removed;
}
