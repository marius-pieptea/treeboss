/** Fakes for the emulator tests: an adb that answers from a small model of a device, and an installer with a scripted disk. */
import type { Child, Deps, RunResult } from "../src/emulator/deps";
import type { Frame, LiveChannel } from "../src/emulator/transport";
import type { AvdSpec, HostProbe, InstallPlan, InstallStep, Installer, SdkState } from "../src/emulator/types";

export const AVD: AvdSpec = { name: "trb", image: "system-images;android-35;google_apis;x86_64", abi: "x86_64", api: 35, width: 720, height: 1600, dpi: 320, ramMb: 2048, dataMb: 6144 };
export const HOST: HostProbe = { os: "windows", arch: "x64", abi: "x86_64", accel: { state: "ok", kind: "whpx" }, diskFreeBytes: 5e11, needBytes: 6e9, existingSdk: null };
export const PLAN: InstallPlan = {
  root: "/sdk",
  avdHome: "/avd",
  avd: AVD,
  licenses: [
    { id: "android-sdk-license", text: "terms", hash: "h1" },
    { id: "android-sdk-preview-license", text: "preview terms", hash: "h2" },
  ],
  packages: [{ path: "platform-tools", revision: "1", url: "u", sha1: "a", size: 100, licenseId: "android-sdk-license", destDir: "platform-tools" }],
};

/** A PNG header with the given size, then bytes that make the image differ (`tag`). */
export function png(width: number, height: number, tag: string): Uint8Array {
  const b = new Uint8Array(24 + tag.length);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  b.set(new TextEncoder().encode(tag), 24);
  return b;
}

export interface FakeDevice {
  /** An emulator is answering on emulator-5554, and as which AVD. */
  avd: string | null;
  /** What `getprop sys.boot_completed` says; boots flip it after `bootPolls` polls. */
  bootPolls: number;
  screen: { tag: string; width: number; height: number };
  /** Every adb argv after `-s serial`, in the order started. */
  calls: string[][];
  /** Held back until released: a `shell` whose text matches blocks on it (to prove ordering). */
  gates: Map<string, Promise<void>>;
  spawned: Array<{ argv: string[]; env: Record<string, string>; cwd: string; exit(code: number): void; stopped: boolean }>;
  /** What `logcat` returns. */
  logcat: string;
  ui: string;
  /** What `settings get system user_rotation` says. */
  rotation: number;
}

export function fakeDeps(): { deps: Deps; dev: FakeDevice } {
  const dev: FakeDevice = { avd: null, bootPolls: 1, screen: { tag: "a", width: 720, height: 1600 }, calls: [], gates: new Map(), spawned: [], logcat: "", ui: "", rotation: 0 };
  let polls = 0;
  const enc = new TextEncoder();
  const ok = (out: string | Uint8Array = ""): RunResult => ({ code: 0, stdout: typeof out === "string" ? enc.encode(out) : out, stderr: "" });

  const deps: Deps = {
    now: () => Date.now(),
    paths: { root: "/sdk", avdHome: "/avd", tmp: "/tmp" },
    fetch: { text: async () => "", download: async () => {} },
    exec: {
      async run(argv) {
        const args = argv.slice(3); // [adb, -s, serial, ...]
        dev.calls.push(args);
        const line = args.join(" ");
        for (const [needle, gate] of dev.gates) if (line.includes(needle)) await gate;
        if (args[0] === "emu" && args[1] === "avd") return dev.avd ? ok(`${dev.avd}\r\nOK\r\n`) : { code: 1, stdout: new Uint8Array(), stderr: "device not found" };
        if (args[0] === "emu" && args[1] === "kill") {
          dev.avd = null;
          for (const s of dev.spawned) s.exit(0);
          return ok("OK");
        }
        if (line.includes("sys.boot_completed")) {
          polls++;
          if (polls > dev.bootPolls && dev.spawned.length + (dev.avd ? 1 : 0) > 0) return ok("1\n");
          return ok("\n");
        }
        if (args[0] === "exec-out" && args[1] === "screencap") return ok(png(dev.screen.width, dev.screen.height, dev.screen.tag));
        if (args[0] === "exec-out" && args[1] === "cat") return ok(dev.ui);
        if (line.includes("user_rotation") && line.includes("settings get")) return ok(`${dev.rotation}\n`);
        if (args[0] === "logcat") return ok(dev.logcat);
        if (args[0] === "install") return ok("Performing Streamed Install\nSuccess\n");
        if (line.includes("monkey")) return ok("Events injected: 1\n");
        return ok("");
      },
      spawn(argv, o) {
        let resolveExit!: (c: number | null) => void;
        const exited = new Promise<number | null>((r) => (resolveExit = r));
        const rec = { argv, env: o.env, cwd: o.cwd, stopped: false, exit: (code: number) => resolveExit(code) };
        dev.spawned.push(rec);
        dev.avd = "trb";
        const child: Child = {
          pid: 1234,
          onLine: () => {},
          exited,
          async stop() {
            rec.stopped = true;
            resolveExit(null);
          },
        };
        return child;
      },
    },
  };
  return { deps, dev };
}

/** A live channel (the emulator's gRPC) that records what it was sent and pushes frames when told to. */
export function fakeLive() {
  const log: string[] = [];
  let push: ((f: Frame) => void) | null = null;
  let end: ((e: Error | null) => void) | null = null;
  const ch: LiveChannel = {
    touch: async (x, y, down) => void log.push(`touch ${x},${y} ${down ? "down" : "up"}`),
    key: async (key) => void log.push(`key ${key}`),
    text: async (text) => void log.push(`text ${text}`),
    frames(onFrame, onEnd) {
      push = onFrame;
      end = onEnd;
      log.push("stream");
      return () => {
        push = null;
        log.push("stream stopped");
      };
    },
    close: () => void log.push("close"),
  };
  return {
    ch,
    log,
    frame: (tag: string) => push?.({ bytes: png(720, 1600, tag), mime: "image/png", width: 720, height: 1600 }),
    /** The stream ends by itself, as when the emulator drops the channel. */
    end: () => end?.(new Error("gone")),
  };
}

export interface FakeInstaller extends Installer {
  disk: SdkState;
  log: string[];
  /** Resolves `run` when called; until then `run` waits (and rejects on abort). */
  release: () => void;
  autoFinish: boolean;
}

export function fakeInstaller(disk: SdkState = { kind: "absent" }): FakeInstaller {
  let release = () => {};
  const inst: FakeInstaller = {
    disk,
    log: [],
    autoFinish: true,
    get release() {
      return release;
    },
    set release(fn) {
      release = fn;
    },
    probe: async () => HOST,
    reconcile: async () => inst.disk,
    plan: async () => PLAN,
    accept: async (_plan, ids) => void inst.log.push(`accept ${ids.join(",")}`),
    run: (plan, onStep, signal) =>
      new Promise<void>((resolve, reject) => {
        const step: InstallStep = { pkg: "platform-tools", phase: "download" };
        onStep(step, 50, 100);
        const finish = () => {
          inst.disk = { kind: "installed", root: plan.root, owned: true, avd: plan.avd };
          resolve();
        };
        signal.addEventListener("abort", () => reject(new Error("aborted")));
        if (inst.autoFinish) finish();
        else release = finish;
      }),
    remove: async () => {
      inst.log.push("remove");
      inst.disk = { kind: "absent" };
    },
    bin: (root) => ({ adb: `${root}/platform-tools/adb`, emulator: `${root}/emulator/emulator` }),
  };
  return inst;
}
