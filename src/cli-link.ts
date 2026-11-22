/**
 * Putting `trb` on the operator's PATH. The app ships the CLI inside its bundle (TreeBoss.app/Contents/Resources/bin/trb),
 * which no shell searches, so `trb config set …` and the commands error messages name do not work after an install.
 * The settings page offers a symlink in /usr/local/bin (when the daemon may write there) or ~/.local/bin.
 *
 * Never overwrites: a target that exists and is not a link to a trb binary is someone else's file and is left alone.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { selfInvocation } from "./self";
import { UserError } from "./util";

export interface CliLinkTarget {
  path: string;
  /** absent: nothing there; ours: a link to this binary; stale: a link to another trb (an older install); other: not ours. */
  state: "absent" | "ours" | "stale" | "other";
  /** The daemon may create the link here. */
  writable: boolean;
  /** This folder is on the operator's shell PATH. */
  onPath: boolean;
}

export interface CliLinkStatus {
  /** The trb binary a link would point at; null when the daemon runs from source (bun run), where there is nothing to link. */
  binary: string | null;
  /** `trb` in the operator's shell already runs this binary. */
  installed: boolean;
  targets: CliLinkTarget[];
  /** The platform this status was computed on: the UI's wording differs on Windows (no symlinks, no shell profile). */
  platform?: string;
}

export interface CliLinkEnv {
  binary: string | null;
  home: string;
  /** The operator's shell PATH, folders in order. */
  shellPath: string[];
  /** The system-wide folder tried first: /usr/local/bin (a test points it elsewhere). */
  systemBin?: string;
  /** Defaults to process.platform; Windows takes its own path below. */
  platform?: NodeJS.Platform;
  /** Windows only: how a folder is put on the operator's persistent PATH (a test substitutes a fake). */
  addToUserPath?: (dir: string) => void;
}

/** The compiled trb binary this daemon runs as, or null when it runs from source. */
export function trbBinary(): string | null {
  const self = selfInvocation();
  return self.args.length === 0 && path.basename(self.command).startsWith("trb") ? self.command : null;
}

/**
 * The operator's PATH as their shell builds it. A daemon started by the app inherits launchd's short PATH, so its own
 * env says nothing about what a terminal finds: the login shell is asked instead, with the daemon's PATH as the fallback.
 */
export function shellPath(): string[] {
  const shell = process.env.SHELL || "/bin/zsh";
  const res = spawnSync(shell, ["-ilc", 'printf "\\n__trb_path__%s" "$PATH"'], { encoding: "utf-8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
  const line = (res.stdout ?? "").split("\n").find((l) => l.startsWith("__trb_path__"));
  const value = line ? line.slice("__trb_path__".length) : (process.env.PATH ?? "");
  return value.split(path.delimiter).filter(Boolean);
}

/**
 * The persistent PATH a new terminal gets on Windows: the machine's Path, then the user's, read from the registry —
 * the same values the installer writes. The daemon's own env is only a fallback: an app-started daemon may carry a
 * PATH the user's terminals never see. (PowerShell, not `reg query`: argument passing to reg.exe is unreliable.)
 */
function windowsShellPath(): string[] {
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", '[Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")'], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const dirs = (res.stdout ?? "").split(";").map((d) => d.trim()).filter(Boolean);
  return dirs.length ? dirs : (process.env.PATH ?? "").split(";").filter(Boolean);
}

/**
 * Put a folder on the operator's persistent user PATH — the same registry write the Windows installer offers at
 * setup (build/installer.nsh). New terminals pick it up; nothing already running needs to change.
 */
function addToUserPath(dir: string): void {
  const ps =
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true); " +
    "$p=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); " +
    "$b=$env:TB_BIN; if(($p -split ';') -contains $b){exit 0}; " +
    "if($p){$p=$p+';'+$b}else{$p=$b}; $k.SetValue('Path',$p,[Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close()";
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    encoding: "utf-8",
    timeout: 15000,
    env: { ...process.env, TB_BIN: dir },
  });
  if (res.status !== 0) throw new UserError(`Could not add ${dir} to your PATH. Add it by hand: Settings → Edit environment variables → Path (user).`);
}

export function defaultEnv(): CliLinkEnv {
  const win = process.platform === "win32";
  return { binary: trbBinary(), home: os.homedir(), shellPath: win ? windowsShellPath() : shellPath(), platform: process.platform, addToUserPath: win ? addToUserPath : undefined };
}

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

function canWrite(dir: string): boolean {
  // The nearest folder that exists decides: ~/.local/bin is created when missing.
  let d = dir;
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try {
    fs.accessSync(d, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function targetState(file: string, binary: string | null): CliLinkTarget["state"] {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return "absent";
  }
  if (!st.isSymbolicLink()) return "other";
  const to = path.resolve(path.dirname(file), fs.readlinkSync(file));
  if (binary && real(to) === real(binary)) return "ours";
  return path.basename(to).startsWith("trb") ? "stale" : "other";
}

/** Where a link can go and what is there now: /usr/local/bin first, then ~/.local/bin. */
export function cliLinkStatus(env: CliLinkEnv = defaultEnv()): CliLinkStatus {
  if (env.platform === "win32") return cliLinkStatusWin(env);
  const onPath = new Set(env.shellPath.map(real));
  const targets = [env.systemBin ?? "/usr/local/bin", path.join(env.home, ".local", "bin")].map((dir) => {
    const file = path.join(dir, "trb");
    return { path: file, state: targetState(file, env.binary), writable: canWrite(dir), onPath: onPath.has(real(dir)) };
  });
  // What a terminal runs for `trb`: the first PATH folder that has one.
  const found = env.shellPath.map((d) => path.join(d, "trb")).find((f) => fs.existsSync(f));
  return { binary: env.binary, installed: !!env.binary && !!found && real(found) === real(env.binary), targets, platform: env.platform };
}

/**
 * Windows: nothing is linked — the app's own bin folder goes on the user PATH directly, the same thing the
 * installer offers at setup. The one target is that folder; "ours" means it is already on the PATH.
 */
const WIN_TRB_NAMES = ["trb.exe", "trb.cmd", "trb.bat", "trb"];

function cliLinkStatusWin(env: CliLinkEnv): CliLinkStatus {
  const binDir = env.binary ? path.dirname(env.binary) : null;
  const on = binDir !== null && env.shellPath.some((d) => real(d).toLowerCase() === real(binDir).toLowerCase());
  // What a new terminal runs for `trb`: the first PATH folder that has one under any runnable name.
  const found = env.shellPath
    .map((d) => WIN_TRB_NAMES.map((n) => path.join(d, n)).find((f) => fs.existsSync(f)))
    .find(Boolean);
  const installed = !!env.binary && !!found && real(found).toLowerCase() === real(env.binary).toLowerCase();
  return {
    binary: env.binary,
    installed,
    targets: binDir ? [{ path: binDir, state: on ? "ours" : "absent", writable: true, onPath: on }] : [],
    platform: "win32",
  };
}

/**
 * Link `trb` into `target` (a path from cliLinkStatus), or the first writable one. A stale link to an older trb is
 * replaced; anything else in the way is refused. Returns the new status and what the operator still has to do.
 */
export function installCliLink(target: string | null, env: CliLinkEnv = defaultEnv()): { status: CliLinkStatus; linked: string; note: string | null } {
  if (!env.binary) throw new UserError("This daemon runs from source, not the app's trb binary: there is nothing to link. Use `bun run src/cli/main.ts`, or install the app.");
  if (env.platform === "win32") {
    // The app's bin folder goes on the persistent user PATH. After a successful write it is there, so the status
    // is recomputed with it appended — the env snapshot still carries the pre-write PATH.
    const dir = path.dirname(env.binary);
    const before = cliLinkStatusWin(env);
    if (!before.installed && !before.targets[0]?.onPath) (env.addToUserPath ?? addToUserPath)(dir);
    const status = cliLinkStatusWin({ ...env, shellPath: [...env.shellPath, dir] });
    return { status, linked: dir, note: status.installed ? `${dir} is on your PATH now. Open a new terminal for it to apply.` : null };
  }
  const before = cliLinkStatus(env);
  const pick = target ? before.targets.find((t) => t.path === target) : (before.targets.find((t) => t.writable && t.onPath && t.state !== "other") ?? before.targets.find((t) => t.writable && t.state !== "other"));
  if (!pick) throw new UserError(target ? `"${target}" is not a place trb links itself: use ${before.targets.map((t) => t.path).join(" or ")}.` : "No folder to link trb into is writable: neither /usr/local/bin nor ~/.local/bin.");
  if (pick.state === "other") throw new UserError(`${pick.path} already exists and is not a link to trb. Remove it first, or pick the other folder.`);
  if (!pick.writable) throw new UserError(`${path.dirname(pick.path)} is not writable by you. Run: sudo ln -sf "${env.binary}" ${pick.path}`);
  if (pick.state !== "ours") {
    fs.mkdirSync(path.dirname(pick.path), { recursive: true });
    if (pick.state === "stale") fs.unlinkSync(pick.path);
    fs.symlinkSync(env.binary, pick.path);
  }
  const status = cliLinkStatus(env);
  const dir = path.dirname(pick.path);
  const note = pick.onPath ? null : `${dir} is not on your PATH yet. Add this line to your shell profile (~/.zshrc), then open a new terminal:\nexport PATH="${dir}:$PATH"`;
  return { status, linked: pick.path, note };
}
