/** Remove a project's index (`codegraph uninit`). Only ever from an explicit, confirmed request. */
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { clearCodegraphCache, codegraphBinary, findIndexRoot } from "./detect";
import { runningJobFor } from "./jobs";

export function uninitCodegraph(dir: string): { removed: string } {
  const root = findIndexRoot(dir);
  if (!root) throw new UserError(`CodeGraph is not initialized in ${dir}.`);
  if (runningJobFor(root)) throw new UserError("An index job is still running here. Cancel it first.");
  const bin = codegraphBinary();
  const target = path.join(root, ".codegraph");
  if (bin) Bun.spawnSync([bin, "uninit", "--force", root], { stdout: "pipe", stderr: "pipe", timeout: 30_000, windowsHide: true });
  // The CLI is the polite way; the directory is ours to remove either way.
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  clearCodegraphCache();
  return { removed: target };
}
