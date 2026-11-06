/** The host probe: which existing SDK is usable, how acceleration output is read, and the whole probe on a faked machine. */
import { describe, expect, test } from "bun:test";
import { emulatorChecks, type DoctorCheck } from "../src/doctor";
import type { Deps, RunResult } from "../src/emulator/deps";
import { avdSpecFor } from "../src/emulator/manifest";
import type { HostProbe } from "../src/emulator/types";
import { WHPX_FIX, findExistingSdk, parseAccelCheck, parseWindowsProbe, probeHost, sdkBins } from "../src/emulator/host";

const has = (...files: string[]) => (p: string) => files.includes(p);
const sdk = (root: string, sep = "/") => [`${root}${sep}emulator${sep}emulator`, `${root}${sep}system-images${sep}android-35${sep}google_apis${sep}x86_64${sep}package.xml`];

describe("findExistingSdk", () => {
  test("ANDROID_HOME beats ANDROID_SDK_ROOT beats the default", () => {
    const exists = has(...sdk("/a"), ...sdk("/b"), ...sdk("/home/me/Android/Sdk"));
    expect(findExistingSdk({ ANDROID_HOME: "/a", ANDROID_SDK_ROOT: "/b", HOME: "/home/me" }, "linux", exists, "x86_64")).toBe("/a");
    expect(findExistingSdk({ ANDROID_SDK_ROOT: "/b", HOME: "/home/me" }, "linux", exists, "x86_64")).toBe("/b");
    expect(findExistingSdk({ HOME: "/home/me" }, "linux", exists, "x86_64")).toBe("/home/me/Android/Sdk");
  });

  test("a candidate is usable only with the emulator binary and the matching image", () => {
    const noImage = has("/a/emulator/emulator");
    const noEmulator = has(...sdk("/b").slice(1));
    const wrongAbi = has(...sdk("/c"));
    const env = { ANDROID_HOME: "/a", ANDROID_SDK_ROOT: "/b" };
    expect(findExistingSdk(env, "linux", noImage, "x86_64")).toBeNull();
    expect(findExistingSdk(env, "linux", noEmulator, "x86_64")).toBeNull();
    expect(findExistingSdk({ ANDROID_HOME: "/c" }, "linux", wrongAbi, "arm64-v8a")).toBeNull();
  });

  test("an unusable ANDROID_HOME falls through to the next usable candidate", () => {
    expect(findExistingSdk({ ANDROID_HOME: "/empty", ANDROID_SDK_ROOT: "/b" }, "linux", has(...sdk("/b")), "x86_64")).toBe("/b");
  });

  test("the per-OS default locations", () => {
    const win = String.raw`C:\Users\me\AppData\Local\Android\Sdk`;
    const winFiles = [sdkBins(win, "windows").emulator, String.raw`${win}\system-images\android-35\google_apis\x86_64\package.xml`];
    expect(findExistingSdk({ LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` }, "windows", has(...winFiles), "x86_64")).toBe(win);
    expect(findExistingSdk({ HOME: "/Users/me" }, "macosx", has(...sdk("/Users/me/Library/Android/sdk")), "x86_64")).toBe("/Users/me/Library/Android/sdk");
  });
});

describe("sdkBins", () => {
  test("adds .exe only on Windows", () => {
    expect(sdkBins("/sdk", "linux")).toEqual({ adb: "/sdk/platform-tools/adb", emulator: "/sdk/emulator/emulator" });
    expect(sdkBins(String.raw`C:\sdk`, "windows")).toEqual({ adb: String.raw`C:\sdk\platform-tools\adb.exe`, emulator: String.raw`C:\sdk\emulator\emulator.exe` });
  });
});

describe("parseAccelCheck", () => {
  test("usable output, per accelerator", () => {
    expect(parseAccelCheck(0, "WHPX (10.0.26100) is installed and usable.\naccel", "windows")).toEqual({ state: "ok", kind: "whpx" });
    expect(parseAccelCheck(0, "KVM (version 12) is installed and usable.", "linux")).toEqual({ state: "ok", kind: "kvm" });
    expect(parseAccelCheck(0, "HVF is installed and usable.", "macosx")).toEqual({ state: "ok", kind: "hvf" });
  });
  test("a failing check keeps the emulator's reason and the OS fix", () => {
    const r = parseAccelCheck(1, "WHPX: failed to initialize\naccelerator check failed", "windows");
    expect(r).toEqual({ state: "missing", reason: "WHPX: failed to initialize", fix: WHPX_FIX });
    expect(parseAccelCheck(0, "WHPX is not usable here", "windows").state).toBe("missing");
  });
});

describe("parseWindowsProbe", () => {
  test("hypervisor running with the platform DLL, feature state unreadable: ok (heuristic)", () => {
    expect(parseWindowsProbe("hv=True\r\ndll=True\r\nfeature=unknown\r\n")).toEqual({ state: "ok", kind: "whpx" });
  });
  test("feature Enabled and hypervisor running: ok", () => {
    expect(parseWindowsProbe("hv=True\ndll=True\nfeature=Enabled")).toEqual({ state: "ok", kind: "whpx" });
  });
  test("feature Disabled, or no hypervisor: missing with the Windows features fix", () => {
    expect(parseWindowsProbe("hv=True\ndll=True\nfeature=Disabled")).toMatchObject({ state: "missing", fix: WHPX_FIX });
    expect(parseWindowsProbe("hv=False\ndll=False\nfeature=unknown")).toMatchObject({ state: "missing", fix: WHPX_FIX });
  });
  test("an unreadable probe is unchecked, not a verdict", () => {
    expect(parseWindowsProbe("")).toEqual({ state: "unchecked" });
  });
});

describe("probeHost", () => {
  const run = (out: string, code = 0) => async (): Promise<RunResult> => ({ code, stdout: new TextEncoder().encode(out), stderr: "" });
  const deps = (exec: Deps["exec"]["run"]): Deps => ({ exec: { run: exec, spawn: () => { throw new Error("no spawn"); } }, fetch: { text: async () => "", download: async () => {} }, now: () => 0, paths: { root: "/trb/android/sdk", avdHome: "/trb/android/avd", tmp: "/trb/android/tmp" } });
  const seams = { os: "linux", arch: "x64", env: {}, release: "", freeBytes: () => 123, readable: () => true } as const;

  test("before any emulator binary exists it falls back to the OS heuristic", async () => {
    const p = await probeHost(deps(run("")), { ...seams, exists: () => false });
    expect(p).toMatchObject({ os: "linux", abi: "x86_64", accel: { state: "ok", kind: "kvm" }, diskFreeBytes: 123, existingSdk: null });
    expect(p.needBytes).toBeGreaterThan(6 * 2 ** 30);
  });

  test("once the emulator binary exists, -accel-check decides", async () => {
    const calls: string[][] = [];
    const exec = async (argv: string[]) => (calls.push(argv), { code: 1, stdout: new TextEncoder().encode("KVM is not installed"), stderr: "" });
    const p = await probeHost(deps(exec), { ...seams, exists: has("/trb/android/sdk/emulator/emulator") });
    expect(calls).toEqual([["/trb/android/sdk/emulator/emulator", "-accel-check"]]);
    expect(p.accel).toMatchObject({ state: "missing", reason: "KVM is not installed" });
  });

  test("arm64 macOS: hvf on macOS 11+, arm64-v8a image", async () => {
    const p = await probeHost(deps(run("")), { ...seams, os: "macosx", arch: "aarch64", release: "23.4.0", exists: () => false });
    expect(p).toMatchObject({ abi: "arm64-v8a", accel: { state: "ok", kind: "hvf" } });
  });

  test("a usable existing SDK is reported, and its emulator is the one checked", async () => {
    const calls: string[][] = [];
    const exec = async (argv: string[]) => (calls.push(argv), { code: 0, stdout: new TextEncoder().encode("KVM (version 12) is installed and usable."), stderr: "" });
    const p = await probeHost(deps(exec), { ...seams, env: { ANDROID_HOME: "/a" }, exists: has(...sdk("/a")) });
    expect(p.existingSdk).toBe("/a");
    expect(calls).toEqual([["/a/emulator/emulator", "-accel-check"]]);
    expect(p.accel).toEqual({ state: "ok", kind: "kvm" });
  });
});

describe("emulatorChecks (the doctor's view)", () => {
  const host = (extra: Partial<HostProbe> = {}): HostProbe => ({ os: "windows", arch: "x64", abi: "x86_64", accel: { state: "ok", kind: "whpx" }, diskFreeBytes: 100e9, needBytes: 8.7e9, existingSdk: null, ...extra });
  const avd = avdSpecFor("x86_64");
  const level = (checks: DoctorCheck[], id: string) => checks.find((c) => c.id === id)?.level;

  test("not installed is fine; the acceleration is labelled a guess", () => {
    const checks = emulatorChecks(host(), { kind: "absent" });
    expect(level(checks, "emulator")).toBe("ok");
    expect(checks.find((c) => c.id === "emulator:accel")!.text).toContain("a guess");
    expect(checks.some((c) => c.id === "emulator:disk")).toBe(false);
  });

  test("missing acceleration warns with the fix", () => {
    const checks = emulatorChecks(host({ accel: { state: "missing", reason: "no hypervisor is running", fix: WHPX_FIX } }), { kind: "absent" });
    expect(level(checks, "emulator:accel")).toBe("warn");
    expect(checks.find((c) => c.id === "emulator:accel")!.text).toContain(`Fix: ${WHPX_FIX}`);
  });

  test("low disk warns only while nothing is installed", () => {
    expect(level(emulatorChecks(host({ diskFreeBytes: 2e9 }), { kind: "absent" }), "emulator:disk")).toBe("warn");
    expect(emulatorChecks(host({ diskFreeBytes: 2e9 }), { kind: "installed", root: "/sdk", owned: true, avd }).some((c) => c.id === "emulator:disk")).toBe(false);
  });

  test("says whether the SDK is treeboss's or the operator's", () => {
    expect(emulatorChecks(host(), { kind: "installed", root: "/sdk", owned: true, avd })[0]!.text).toContain("installed by treeboss");
    expect(emulatorChecks(host(), { kind: "installed", root: "/studio", owned: false, avd })[0]!.text).toContain("read-only");
  });
});
