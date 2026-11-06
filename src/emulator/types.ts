/**
 * The shared contract of the Android emulator: the host probe, the install plan, the SDK, device and Metro
 * states, and the commands agents and the operator send. Pure types plus EMULATOR_KEYS; every other
 * emulator module builds on these, and the web keeps a mirrored copy of EmulatorKey (checked by a test).
 */
export type HostOs = "windows" | "macosx" | "linux";
export type HostArch = "x64" | "aarch64";
export type Abi = "x86_64" | "arm64-v8a";
export type Actor = { kind: "you" } | { kind: "agent"; sessionId: string };

export interface HostProbe {
  os: HostOs;
  arch: HostArch;
  abi: Abi;
  accel: { state: "ok"; kind: "whpx" | "aehd" | "hvf" | "kvm" } | { state: "missing"; reason: string; fix: string } | { state: "unchecked" }; // unchecked: before the emulator binary exists, OS heuristic only
  diskFreeBytes: number;
  needBytes: number;
  existingSdk: string | null; // usable read-only SDK (has emulator + image)
}

export type SdkPath = "platform-tools" | "emulator" | `system-images;android-${number};google_apis;${Abi}`;
export interface PackageArchive {
  path: SdkPath;
  revision: string;
  url: string;
  sha1: string;
  size: number;
  licenseId: string;
  destDir: string; // relative to sdk root, e.g. "system-images/android-35/google_apis/x86_64"
}
export interface License {
  id: string;
  text: string;
  hash: string;
}
export interface AvdSpec {
  name: "trb";
  image: SdkPath;
  abi: Abi;
  api: number;
  width: 720;
  height: 1600;
  dpi: 320;
  ramMb: number;
  dataMb: number;
}
export interface InstallPlan {
  root: string;
  avdHome: string;
  packages: PackageArchive[];
  licenses: License[];
  avd: AvdSpec;
}
export type InstallStep = { pkg: SdkPath; phase: "download" | "verify" | "extract" } | { pkg: "avd"; phase: "create" };

export type SdkState =
  | { kind: "absent" }
  | { kind: "resolving" } // fetching manifests
  | { kind: "needs-license"; plan: InstallPlan }
  | { kind: "installing"; plan: InstallPlan; step: InstallStep; doneBytes: number; totalBytes: number }
  | { kind: "installed"; root: string; owned: boolean; avd: AvdSpec } // owned: treeboss may remove it
  | { kind: "removing" } // device stopping, owned dirs being deleted
  | { kind: "failed"; reason: string; retryable: boolean };

export type DeviceState =
  | { kind: "stopped" }
  | { kind: "booting"; serial: string; since: number }
  // live: the emulator's gRPC channel carries the operator's view (frames pushed, touches as they happen); false means adb
  | { kind: "running"; serial: string; screen: { width: number; height: number }; rotation: 0 | 1 | 2 | 3; seq: number; live: boolean }
  | { kind: "stopping"; serial: string }
  | { kind: "failed"; reason: string; logTail: string };

/** The operator's finger on the live view, in device pixels: pressed (or moved while pressed), or lifted. */
export type Pointer = { x: number; y: number; down: boolean };

export type MetroState = { kind: "off" } | { kind: "starting"; cwd: string } | { kind: "running"; cwd: string; port: number } | { kind: "failed"; reason: string; logTail: string };
export type Job = { id: string; kind: "install_apk" | "run_expo"; actor: Actor; since: number; state: "running" | "done" | "failed"; detail: string };

export const EMULATOR_KEYS = ["back", "home", "recents", "enter", "delete", "tab", "escape", "power", "volume_up", "volume_down", "menu", "dpad_up", "dpad_down", "dpad_left", "dpad_right"] as const;
export type EmulatorKey = (typeof EMULATOR_KEYS)[number];
/** Device pixels of the current frame. */
export type EmulatorInput =
  | { kind: "tap"; x: number; y: number }
  | { kind: "long_press"; x: number; y: number; ms?: number }
  | { kind: "swipe"; x1: number; y1: number; x2: number; y2: number; ms?: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: EmulatorKey }
  | { kind: "rotate"; to: "portrait" | "landscape" };

export type Command =
  | { kind: "boot" }
  | { kind: "shutdown" } // actor "you" only (checked in run)
  | { kind: "input"; input: EmulatorInput }
  | { kind: "open_url"; url: string } // http(s), exp(s)://, app schemes
  | { kind: "install_apk"; path: string }
  | { kind: "launch"; pkg: string }
  | { kind: "run_expo"; cwd: string }
  | { kind: "stop_expo" };
export type InstallOp =
  | { kind: "plan" }
  | { kind: "cancel" }
  | { kind: "retry" }
  | { kind: "accept"; by: "you"; licenses: string[] }
  | { kind: "remove"; by: "you" }; // stops the device, deletes owned SDK + AVD dirs only (refused when installed.owned === false)

export interface EmulatorView {
  enabled: boolean;
  host: HostProbe;
  sdk: SdkState;
  device: DeviceState;
  metro: MetroState;
  jobs: Job[];
  lastActor: { actor: Actor; at: number } | null;
}
export type CommandResult = { ok: true; text: string } | { ok: false; error: string };

/** What the device owner needs from the installer. emulator/install.ts implements it (createInstaller(deps)); the owner only ever sees this. */
export interface Installer {
  probe(): Promise<HostProbe>;
  /** Reads the disk: what is installed, owned or reused, with the AVD. Never fetches. */
  reconcile(): Promise<SdkState>;
  /** Fetches Google's manifests and returns the plan to show for license acceptance. */
  plan(host: HostProbe): Promise<InstallPlan>;
  /** Records the operator's acceptance of exactly these license ids (writes licenses/<id> into the owned SDK). */
  accept(plan: InstallPlan, licenseIds: string[]): Promise<void>;
  /** Idempotent: downloads, verifies, extracts, creates the AVD. Resumes after a crash; skips finished packages. */
  run(plan: InstallPlan, onStep: (step: InstallStep, doneBytes: number, totalBytes: number) => void, signal: AbortSignal): Promise<void>;
  /** Deletes only treeboss-owned sdk/avd/tmp dirs. A reused SDK is never touched. */
  remove(): Promise<void>;
  /** Absolute paths of the binaries inside the installed SDK. */
  bin(root: string): { adb: string; emulator: string };
}
