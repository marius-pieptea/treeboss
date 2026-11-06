/**
 * The files a check runs over: every file git knows (for the whole repo), or the uncommitted ones. Both are relative to
 * the workspace root, which is where practices.json and the managed block live.
 */
import { spawnSync } from "child_process";
import { UserError } from "../util";

/** Every file git knows about and does not ignore (tracked and untracked), relative to the workspace root. */
export function repoFiles(root: string): string[] {
  return gitList(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
}

/** Files with uncommitted changes (tracked, against HEAD, and untracked), relative to the workspace root. */
export function changedFiles(root: string): string[] {
  const tracked = gitList(root, ["diff", "--name-only", "-z", "HEAD"]);
  const untracked = gitList(root, ["ls-files", "-o", "--exclude-standard", "-z"]);
  return [...new Set([...tracked, ...untracked])];
}

function gitList(root: string, args: string[]): string[] {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd: root, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 120_000 });
  if (r.status !== 0) throw new UserError(`${root} is not a git repository, so its file list is unknown. Pass the files to check.`);
  return r.stdout.split("\0").filter(Boolean);
}
