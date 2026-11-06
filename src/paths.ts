import os from "os";
import path from "path";
import fs from "fs";

/**
 * Everything trb owns lives under one directory, so "where is my data" and
 * "reset everything" each have a one-line answer. Functions, not constants:
 * tests (and `TRB_HOME=… trb …`) repoint the home after import.
 */
export function home(): string {
  const dir = process.env.TRB_HOME ? path.resolve(process.env.TRB_HOME) : path.join(os.homedir(), ".treeboss");
  if (!process.env.TRB_HOME) migrateLegacyHome(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * One-time move of the pre-rename state directory (`~/.omni-code`, `occ.sqlite`) to the default home.
 * Refuses while a daemon from the old directory is still alive: moving a live daemon's state out from under it is how data gets split.
 */
export function migrateLegacyHome(dir: string, legacy = path.join(os.homedir(), ".omni-code")): void {
  if (fs.existsSync(dir) || !fs.existsSync(legacy)) return;
  try {
    const pid = Number(fs.readFileSync(path.join(legacy, "daemon.pid"), "utf8").trim());
    if (pid > 0) {
      process.kill(pid, 0);
      throw new Error(`A daemon from the old state directory (${legacy}, pid ${pid}) is still running. Stop it, then start TreeBoss again to move your state to ${dir}.`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("A daemon")) throw e;
    // no pid file, or the process is gone: safe to move
  }
  try {
    fs.renameSync(legacy, dir);
    for (const ext of ["", "-wal", "-shm"]) {
      const old = path.join(dir, `occ.sqlite${ext}`);
      if (fs.existsSync(old)) fs.renameSync(old, path.join(dir, `trb.sqlite${ext}`));
    }
  } catch {
    // Not fatal: a fresh home is created instead and the old one is left where it was.
  }
}

function sub(name: string): string {
  const dir = path.join(home(), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const paths = {
  db: () => path.join(home(), "trb.sqlite"),
  token: () => path.join(home(), "token"),
  pid: () => path.join(home(), "daemon.pid"),
  /** `{ port, url, pid, startedAt }` written by the running daemon. */
  info: () => path.join(home(), "daemon.json"),
  daemonLog: () => path.join(sub("logs"), "daemon.log"),
  worktrees: () => sub("worktrees"),
  /** Generated per-run MCP configs. Outside every checkout: they can carry secrets. */
  mcpConfigs: () => sub("cli-mcp"),
  skills: () => sub("skills"),
  /** One manifest per turn that put skill copies in a workspace, so a crash cannot strand them. See skills/scaffold.ts. */
  skillRuns: () => sub("skill-runs"),
  /** Private scratch directories for subagents that share their parent's workspace. */
  scratch: () => sub("scratch"),
  /** One folder per piece of evidence (captured pages, notes). Outside every checkout: a capture can hold a signed-in page. See evidence/store.ts. */
  evidence: () => sub("evidence"),
  /** Saved sign-ins of the agent browser, one file per project. Cookies and storage: secrets, so never inside a checkout or the evidence store. See browser/signins.ts. */
  browserSignins: () => sub("browser-signins"),
  /** Everything the Android emulator owns: `sdk/` (downloaded after the operator accepts Google's license; it cannot be bundled), `avd/` (the device) and `tmp/` (partial downloads). See emulator/. */
  android: () => sub("android"),
};
