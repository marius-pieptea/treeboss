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
import os from "os";
import path from "path";
import { home, paths } from "../paths";
import { getSetting } from "../settings";

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

export interface CargoLimits {
  /** cargo_shared_target is on. */
  shareTarget: boolean;
  /** cargo_build_jobs: 0 is auto. */
  jobs: number;
  /** cargo_lean_debug is on. */
  leanDebug: boolean;
}

export function cargoLimits(): CargoLimits {
  return { shareTarget: getSetting("cargo_shared_target") !== "off", jobs: getSetting("cargo_build_jobs"), leanDebug: getSetting("cargo_lean_debug") !== "off" };
}

/**
 * Jobs for one cargo build: half the cores, at most one per 4 GB of RAM, at least 2. A rustc or
 * link.exe of a big crate takes 1 to 2 GB, so cargo's default (every core) fills a 32 GB machine
 * once two builds overlap.
 */
export function autoCargoJobs(cores = os.availableParallelism(), totalBytes = os.totalmem()): number {
  return Math.max(2, Math.min(Math.floor(cores / 2), Math.floor(totalBytes / 4 / 1024 ** 3)));
}

/**
 * The cargo variables to add for a process trb starts in `cwd`. In a trb worktree: the shared
 * target dir and lean debug info (it changes the build fingerprint, so never in the operator's own
 * checkout, where it would force their next build to start over). Jobs are capped for every agent
 * turn and every worktree process. A variable already in `env` always wins.
 */
export function cargoEnv(cwd: string, env: NodeJS.ProcessEnv, limits: CargoLimits, opts: { agent: boolean }): Record<string, string> {
  const out: Record<string, string> = {};
  const target = sharedCargoTarget(cwd, env, limits.shareTarget);
  if (target) out.CARGO_TARGET_DIR = target;
  const inWorktree = sharedCargoTarget(cwd, {}, true) !== null;
  if (inWorktree && limits.leanDebug && !env.CARGO_PROFILE_DEV_DEBUG) out.CARGO_PROFILE_DEV_DEBUG = "line-tables-only";
  if ((inWorktree || opts.agent) && !env.CARGO_BUILD_JOBS) out.CARGO_BUILD_JOBS = String(limits.jobs > 0 ? limits.jobs : autoCargoJobs());
  return out;
}

/** A Cargo.toml at `dir` or one level down (a Tauri app keeps it in src-tauri/). */
export function isRustProject(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "Cargo.toml"))) return true;
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && fs.existsSync(path.join(dir, e.name, "Cargo.toml")));
  } catch {
    return false;
  }
}

/**
 * Said once per conversation in a Rust project. Agents otherwise point CARGO_TARGET_DIR at a new
 * folder of their own when the shared one is locked or busy: every such folder is a cold build of
 * every dependency (tens of GB, never cleaned up) and runs alongside the others, which is what
 * filled 32 GB of RAM and hundreds of GB of disk.
 */
export function rustBuildHint(vars: Record<string, string>): string {
  const shared = vars.CARGO_TARGET_DIR;
  return [
    Object.keys(vars).length
      ? `Rust builds: trb set ${Object.keys(vars).map((k) => `\`${k}\``).join(", ")} in your environment${shared ? `; \`CARGO_TARGET_DIR\` is one build cache shared by every checkout of this repo` : ""}.`
      : `Rust builds on this machine:`,
    `- Never set \`CARGO_TARGET_DIR\`, pass \`--target-dir\`, or pass \`-j\`/\`--jobs\`. A new target folder rebuilds every dependency from scratch (many minutes, tens of GB, never cleaned up) and parallel builds exhaust the machine's memory.`,
    `- "Blocking waiting for file lock on build directory" means another agent is building: wait for it. That is much faster than a cold build.`,
    `- A build that fails because a binary is in use (Windows "Access is denied", os error 5/32) means a program built from this repo is running: stop the one you started, or ask. ${shared ? "If you really must build apart, `unset CARGO_TARGET_DIR` so cargo uses `target/` in your own checkout, which is deleted with it. Never use a folder outside your checkout." : ""}`.trim(),
    `- Build and test only the package you changed (\`-p <crate>\`, \`--test <name>\`), not the whole workspace.`,
  ].join("\n");
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
