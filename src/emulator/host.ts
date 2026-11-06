/**
 * What this computer can do for the emulator: its OS, CPU and disk, whether hardware acceleration works, and
 * whether the operator already has a usable Android SDK. Read-only: nothing here downloads or writes.
 *
 * Acceleration is checked in two tiers. Before the emulator binary exists we only have an OS heuristic
 * (the Windows Hypervisor Platform, /dev/kvm, macOS 11+), reported as a guess the doctor labels as such.
 * Once the binary exists, `emulator -accel-check` is the authority.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Deps } from "./deps";
import { IMAGE_API } from "./manifest";
import type { Abi, HostArch, HostOs, HostProbe } from "./types";

/** About 6 GiB unpacked, plus the ~2.2 GB of archives that sit on disk until each one is extracted. */
export const NEED_BYTES = 6 * 2 ** 30 + 2.3e9;

export const WHPX_FIX = "Turn Windows features on or off > Windows Hypervisor Platform, then restart.";
const KVM_FIX = "Make /dev/kvm usable: enable virtualization (VT-x/AMD-V) in the BIOS, install KVM, and add your user to the kvm group.";
const MACOS_FIX = "The emulator needs macOS 11 or newer (Hypervisor.framework).";

type Accel = HostProbe["accel"];

/** The few things probeHost reads from the machine, so tests can fake them. */
export interface HostSeams {
  os: HostOs;
  arch: HostArch;
  env: Record<string, string | undefined>;
  exists(p: string): boolean;
  readable(p: string): boolean;
  /** `os.release()`: on macOS the Darwin version (20 is macOS 11). */
  release: string;
  freeBytes(dir: string): number;
}

export function hostOs(platform: string = process.platform): HostOs {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macosx" : "linux";
}
export const hostArch = (arch: string = process.arch): HostArch => (arch === "arm64" ? "aarch64" : "x64");
export const abiOf = (arch: HostArch): Abi => (arch === "aarch64" ? "arm64-v8a" : "x86_64");

const join = (hostos: HostOs) => (hostos === "windows" ? path.win32.join : path.posix.join);

/** The binaries inside an SDK root; `.exe` on Windows. */
export function sdkBins(root: string, hostos: HostOs = hostOs()): { adb: string; emulator: string } {
  const j = join(hostos);
  const ext = hostos === "windows" ? ".exe" : "";
  return { adb: j(root, "platform-tools", `adb${ext}`), emulator: j(root, "emulator", `emulator${ext}`) };
}
/** Where the system image of the AVD lives inside an SDK root. */
export const imageDir = (root: string, abi: Abi, hostos: HostOs = hostOs()) => join(hostos)(root, "system-images", `android-${IMAGE_API}`, "google_apis", abi);
/** Both installers write package.xml (sdkmanager's marker for a finished package), so it is the one "image is there" test. */
export const hasImage = (root: string, abi: Abi, exists: (p: string) => boolean, hostos: HostOs = hostOs()) => exists(join(hostos)(imageDir(root, abi, hostos), "package.xml"));

/**
 * The operator's own Android SDK, if one is usable read-only: it must hold the emulator binary and the
 * image treeboss would create the AVD from. The first candidate that qualifies wins, in this order:
 * ANDROID_HOME, ANDROID_SDK_ROOT, then the Android Studio default for the OS.
 */
export function findExistingSdk(env: HostSeams["env"], hostos: HostOs, exists: (p: string) => boolean, abi: Abi): string | null {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const j = join(hostos);
  const defaults: Record<HostOs, string | null> = {
    windows: env.LOCALAPPDATA ? j(env.LOCALAPPDATA, "Android", "Sdk") : null,
    macosx: home ? j(home, "Library", "Android", "sdk") : null,
    linux: home ? j(home, "Android", "Sdk") : null,
  };
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, defaults[hostos]].filter((c): c is string => Boolean(c));
  return candidates.find((root) => exists(sdkBins(root, hostos).emulator) && hasImage(root, abi, exists, hostos)) ?? null;
}

/** `emulator -accel-check` output and exit code to a verdict. Pure. */
export function parseAccelCheck(code: number, output: string, hostos: HostOs): Accel {
  const text = output.trim();
  const kind = /\b(whpx|aehd|kvm)\b/i.exec(text)?.[1]?.toLowerCase() ?? (/hvf|hypervisor\.framework/i.test(text) ? "hvf" : null);
  if (code === 0 && kind && /usable/i.test(text) && !/not usable/i.test(text)) return { state: "ok", kind: kind as "whpx" | "aehd" | "hvf" | "kvm" };
  const reason = text.split(/\r?\n/).find((l) => l.trim() && !/^\s*accelerator check/i.test(l))?.trim() ?? `emulator -accel-check exited with ${code}`;
  return { state: "missing", reason, fix: hostos === "windows" ? WHPX_FIX : hostos === "linux" ? KVM_FIX : MACOS_FIX };
}

export async function accelCheck(deps: Deps, root: string, hostos: HostOs = hostOs()): Promise<Accel> {
  const r = await deps.exec.run([sdkBins(root, hostos).emulator, "-accel-check"], { timeoutMs: 20_000 });
  return parseAccelCheck(r.code, `${Buffer.from(r.stdout).toString("utf-8")}\n${r.stderr}`, hostos);
}

/** One PowerShell run, no elevation: is a hypervisor running, is the platform DLL there, and (if readable) the optional feature's state. */
const WINDOWS_PROBE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "'hv=' + (Get-CimInstance Win32_ComputerSystem).HypervisorPresent",
  "'dll=' + (Test-Path (Join-Path $env:windir 'System32\\WinHvPlatform.dll'))",
  "$f = (Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform).State",
  "'feature=' + $(if ($f) { $f } else { 'unknown' })",
].join("; ");

/**
 * The Windows Hypervisor Platform without admin rights. The optional feature's own state needs elevation, so it
 * is only used when readable; otherwise a running hypervisor plus WinHvPlatform.dll is taken as a pass. A
 * heuristic, which `emulator -accel-check` confirms once the emulator is installed.
 */
export function parseWindowsProbe(output: string): Accel {
  const v = Object.fromEntries(output.split(/\r?\n/).map((l) => /^(\w+)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => m !== null).map((m) => [m[1]!, m[2]!.trim().toLowerCase()]));
  const missing = (reason: string): Accel => ({ state: "missing", reason, fix: WHPX_FIX });
  if (v.feature === "disabled" || v.feature === "disablepending") return missing("the Windows Hypervisor Platform feature is off");
  if (v.feature === "enabled" && v.hv === "true") return { state: "ok", kind: "whpx" };
  if (v.feature === "enabled") return missing("the Windows Hypervisor Platform is enabled but no hypervisor is running yet (restart pending)");
  if (v.hv === "false") return missing("no hypervisor is running");
  if (v.hv === "true" && v.dll === "true") return { state: "ok", kind: "whpx" };
  return { state: "unchecked" };
}

export async function windowsHypervisor(deps: Deps): Promise<Accel> {
  const r = await deps.exec.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE], { timeoutMs: 20_000 });
  return parseWindowsProbe(Buffer.from(r.stdout).toString("utf-8"));
}

/** The OS heuristic, for before the emulator binary exists. */
async function heuristicAccel(deps: Deps, s: HostSeams): Promise<Accel> {
  if (s.os === "windows") return windowsHypervisor(deps).catch(() => ({ state: "unchecked" }) as Accel);
  if (s.os === "linux") return s.readable("/dev/kvm") ? { state: "ok", kind: "kvm" } : { state: "missing", reason: s.exists("/dev/kvm") ? "/dev/kvm is not accessible to this user" : "/dev/kvm does not exist", fix: KVM_FIX };
  return Number.parseInt(s.release, 10) >= 20 ? { state: "ok", kind: "hvf" } : { state: "missing", reason: `Darwin ${s.release} is older than macOS 11`, fix: MACOS_FIX };
}

/** Free bytes on the drive that holds `dir`, measured at its nearest existing parent. */
export function diskFreeBytes(dir: string): number {
  let at = path.resolve(dir);
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    const s = fs.statfsSync(at);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return 0;
  }
}

export function realSeams(): HostSeams {
  const readable = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  return { os: hostOs(), arch: hostArch(), env: process.env, exists: fs.existsSync, readable, release: os.release(), freeBytes: diskFreeBytes };
}

export async function probeHost(deps: Deps, seams: Partial<HostSeams> = {}): Promise<HostProbe> {
  const s: HostSeams = { ...realSeams(), ...seams };
  const abi = abiOf(s.arch);
  const existingSdk = findExistingSdk(s.env, s.os, s.exists, abi);
  // The emulator binary decides when there is one: ours first, then the operator's.
  const root = [deps.paths.root, existingSdk].find((r): r is string => r !== null && s.exists(sdkBins(r, s.os).emulator)) ?? null;
  const accel = root ? await accelCheck(deps, root, s.os).catch(() => heuristicAccel(deps, s)) : await heuristicAccel(deps, s);
  return { os: s.os, arch: s.arch, abi, accel, diskFreeBytes: s.freeBytes(path.dirname(deps.paths.root)), needBytes: NEED_BYTES, existingSdk };
}
