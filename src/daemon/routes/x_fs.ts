/**
 * Extension slot: file routes owned by the `fs` UI feature.
 *
 *   POST /api/fs/:root/copy { from, to }   duplicate a file or a whole directory
 *   POST /api/fs/:root/reveal { path }    show an entry in the OS file manager
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { RootError, resolveRoot, safeJoin } from "../../workspaces";
import { HttpError, json, type RouteModule } from "../http";

/**
 * The OS command that shows a path in its file manager. Windows and macOS select the item itself;
 * Linux has no select, so a file opens its folder.
 */
export function revealCommand(platform: NodeJS.Platform, abs: string, isDir: boolean): { cmd: string; args: string[] } {
  // The full path, not a PATH lookup: a daemon started with a trimmed environment still finds Explorer.
  if (platform === "win32") return { cmd: path.win32.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe"), args: [isDir ? `"${abs}"` : `/select,"${abs}"`] };
  if (platform === "darwin") return { cmd: "open", args: isDir ? [abs] : ["-R", abs] };
  return { cmd: "xdg-open", args: [isDir ? abs : path.dirname(abs)] };
}

export const fsExtRoutes: RouteModule = async (c) => {
  const reveal = c.match(/^\/api\/fs\/([^/]+)\/reveal$/);
  if (reveal && c.method === "POST") {
    const root = resolveRoot(reveal[1]);
    const rel = String(c.body.path ?? "");
    const abs = safeJoin(root.dir, rel);
    if (!fs.existsSync(abs)) throw new RootError(`No such file: ${rel}`, 404);
    const { cmd, args } = revealCommand(process.platform, abs, fs.statSync(abs).isDirectory());
    // Detached and unref'd: the file manager is a separate app and must not hold the daemon's event loop.
    // Answers once the process has started, and reports a failure to start instead of swallowing it.
    // explorer.exe exits non-zero even on success, so its exit code is not checked.
    // Not windowsHide: explorer inherits SW_HIDE from the spawn and opens its window hidden.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: process.platform === "win32" });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
      child.once("error", (err) => reject(new RootError(`Could not open the file manager: ${err.message}`, 500)));
    });
    return json({ ok: true });
  }

  const m = c.match(/^\/api\/fs\/([^/]+)\/copy$/);
  if (!m || c.method !== "POST") return null;
  const root = resolveRoot(m[1]);
  const from = String(c.body.from ?? "");
  const to = String(c.body.to ?? "");
  if (!from || !to) throw new HttpError(400, "from and to are required.");
  const a = safeJoin(root.dir, from);
  const b = safeJoin(root.dir, to);
  const rootReal = fs.realpathSync(root.dir);
  if (a === rootReal) throw new RootError("Cannot copy the workspace root.");
  if (a.split(path.sep).includes(".git") || b.split(path.sep).includes(".git")) throw new RootError("Refusing to touch .git.", 403);
  if (!fs.existsSync(a)) throw new RootError(`No such file: ${from}`, 404);
  if (fs.existsSync(b)) throw new RootError(`${to} already exists.`, 409);
  // `cp -r a a/sub` would recurse forever.
  if (b === a || b.startsWith(a + path.sep)) throw new RootError("Cannot copy a folder into itself.");
  fs.mkdirSync(path.dirname(b), { recursive: true });
  // Links are copied as links, never followed: a link out of the workspace must not pull outside files in.
  fs.cpSync(a, b, { recursive: true, errorOnExist: true, force: false, dereference: false });
  return json({ ok: true }, 201);
};
