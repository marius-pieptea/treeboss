/** The emulator's reducer: the legal transitions, and that anything else changes nothing. */
import { describe, expect, test } from "bun:test";
import { initialView, reduce, type Event } from "../src/emulator/state";
import type { AvdSpec, EmulatorView, HostProbe, InstallPlan, Job, SdkState } from "../src/emulator/types";

const host: HostProbe = { os: "windows", arch: "x64", abi: "x86_64", accel: { state: "unchecked" }, diskFreeBytes: 1e11, needBytes: 6e9, existingSdk: null };
const avd: AvdSpec = { name: "trb", image: "system-images;android-35;google_apis;x86_64", abi: "x86_64", api: 35, width: 720, height: 1600, dpi: 320, ramMb: 2048, dataMb: 6144 };
const plan: InstallPlan = {
  root: "/sdk",
  avdHome: "/avd",
  avd,
  licenses: [{ id: "android-sdk-license", text: "t", hash: "h" }],
  packages: [
    { path: "platform-tools", revision: "1", url: "u", sha1: "a", size: 100, licenseId: "android-sdk-license", destDir: "platform-tools" },
    { path: "emulator", revision: "1", url: "u", sha1: "b", size: 300, licenseId: "android-sdk-license", destDir: "emulator" },
  ],
};
const installed: SdkState = { kind: "installed", root: "/sdk", owned: true, avd };
const screen = { width: 720, height: 1600 };

const run = (v: EmulatorView, ...events: Event[]) => events.reduce(reduce, v);
const fresh = (sdk: SdkState = { kind: "absent" }) => initialView(host, sdk);

describe("sdk", () => {
  test("absent -> resolving -> needs-license -> installing (progress) -> installed", () => {
    let v = run(fresh(), { type: "plan-requested" });
    expect(v.sdk.kind).toBe("resolving");
    v = run(v, { type: "plan-ready", plan });
    expect(v.sdk).toEqual({ kind: "needs-license", plan });
    v = run(v, { type: "install-started", plan });
    expect(v.sdk).toMatchObject({ kind: "installing", step: { pkg: "platform-tools", phase: "download" }, doneBytes: 0, totalBytes: 400 });
    v = run(v, { type: "install-progress", step: { pkg: "emulator", phase: "download" }, doneBytes: 150, totalBytes: 400 });
    expect(v.sdk).toMatchObject({ kind: "installing", step: { pkg: "emulator", phase: "download" }, doneBytes: 150 });
    v = run(v, { type: "install-done", root: "/sdk", owned: true });
    expect(v.sdk).toEqual(installed);
  });

  test("failed -> retry resolves again, or reinstalls from an accepted plan", () => {
    let v = run(fresh(), { type: "plan-requested" }, { type: "plan-failed", reason: "offline" });
    expect(v.sdk).toEqual({ kind: "failed", reason: "offline", retryable: true });
    expect(run(v, { type: "plan-requested" }).sdk.kind).toBe("resolving");
    expect(run(v, { type: "install-started", plan }).sdk.kind).toBe("installing");
    v = run(fresh(), { type: "plan-requested" }, { type: "plan-ready", plan }, { type: "install-started", plan }, { type: "install-failed", reason: "bad sha1", retryable: true });
    expect(v.sdk).toEqual({ kind: "failed", reason: "bad sha1", retryable: true });
  });

  test("cancel returns to the license screen with the same plan", () => {
    const v = run(fresh({ kind: "needs-license", plan }), { type: "install-started", plan }, { type: "install-cancelled" });
    expect(v.sdk).toEqual({ kind: "needs-license", plan });
  });

  test("installed -> removing -> absent, and only an owned install can be removed", () => {
    const v = run(fresh(installed), { type: "remove-started" });
    expect(v.sdk.kind).toBe("removing");
    expect(run(v, { type: "remove-done" }).sdk.kind).toBe("absent");
    const reused = fresh({ kind: "installed", root: "/theirs", owned: false, avd });
    expect(run(reused, { type: "remove-started" })).toBe(reused);
    expect(run(v, { type: "remove-failed", reason: "locked" }).sdk).toEqual({ kind: "failed", reason: "locked", retryable: false });
  });

  test("a disk reconcile never overwrites an install or removal in flight", () => {
    const inFlight: SdkState[] = [{ kind: "resolving" }, { kind: "installing", plan, step: { pkg: "emulator", phase: "download" }, doneBytes: 1, totalBytes: 2 }, { kind: "removing" }];
    for (const sdk of inFlight) {
      const v = fresh(sdk);
      expect(run(v, { type: "sdk-reconciled", sdk: { kind: "absent" } })).toBe(v);
    }
    expect(run(fresh(), { type: "sdk-reconciled", sdk: installed }).sdk).toEqual(installed);
  });

  test("events that do not fit change nothing", () => {
    const abs = fresh();
    const misfits: Event[] = [
      { type: "plan-ready", plan },
      { type: "install-started", plan },
      { type: "install-progress", step: { pkg: "avd", phase: "create" }, doneBytes: 1, totalBytes: 1 },
      { type: "install-done", root: "/x", owned: true },
      { type: "install-cancelled" },
      { type: "remove-started" },
      { type: "remove-done" },
    ];
    for (const e of misfits) expect(run(abs, e)).toBe(abs);
    const inst = fresh(installed);
    expect(run(inst, { type: "plan-requested" })).toBe(inst);
    expect(run(inst, { type: "install-failed", reason: "x", retryable: true })).toBe(inst);
  });
});

describe("device", () => {
  test("stopped -> booting -> running, then frames bump seq", () => {
    let v = run(fresh(installed), { type: "boot-started", serial: "emulator-5554", at: 5 });
    expect(v.device).toEqual({ kind: "booting", serial: "emulator-5554", since: 5 });
    v = run(v, { type: "boot-ready", screen, rotation: 0 });
    expect(v.device).toEqual({ kind: "running", serial: "emulator-5554", screen, rotation: 0, seq: 0, live: false });
    v = run(v, { type: "frame", screen }, { type: "frame", screen: { width: 1600, height: 720 } });
    expect(v.device).toMatchObject({ seq: 2, screen: { width: 1600, height: 720 } });
  });

  test("no boot without an installed SDK, or while removing", () => {
    for (const sdk of [{ kind: "absent" }, { kind: "removing" }] as SdkState[]) {
      const v = fresh(sdk);
      expect(run(v, { type: "boot-started", serial: "s", at: 1 })).toBe(v);
    }
  });

  test("a failed boot can be booted again; a running device cannot be booted over", () => {
    const failed = run(fresh(installed), { type: "boot-started", serial: "s", at: 1 }, { type: "boot-failed", reason: "no accel", logTail: "tail" });
    expect(failed.device).toEqual({ kind: "failed", reason: "no accel", logTail: "tail" });
    expect(run(failed, { type: "boot-started", serial: "s", at: 2 }).device.kind).toBe("booting");
    const running = run(fresh(installed), { type: "adopted", serial: "s", screen, rotation: 0 });
    expect(running.device.kind).toBe("running");
    expect(run(running, { type: "boot-started", serial: "s", at: 2 })).toBe(running);
    expect(run(running, { type: "adopted", serial: "s", screen, rotation: 0 })).toBe(running);
  });

  test("stopping, and the device vanishing, end stopped and take Metro with them", () => {
    let v = run(fresh(installed), { type: "adopted", serial: "s", screen, rotation: 0 }, { type: "metro-starting", cwd: "/app" }, { type: "metro-running", cwd: "/app", port: 8081 });
    v = run(v, { type: "stop-started" });
    expect(v.device).toEqual({ kind: "stopping", serial: "s" });
    v = run(v, { type: "device-stopped" });
    expect(v.device).toEqual({ kind: "stopped" });
    expect(v.metro).toEqual({ kind: "off" });
    expect(run(v, { type: "device-stopped" })).toBe(v);
  });

  test("frames and rotation only count while running", () => {
    const v = fresh(installed);
    expect(run(v, { type: "frame", screen })).toBe(v);
    expect(run(v, { type: "rotated", rotation: 1 })).toBe(v);
    const r = run(v, { type: "adopted", serial: "s", screen, rotation: 0 });
    expect(run(r, { type: "rotated", rotation: 0 })).toBe(r);
    expect(run(r, { type: "rotated", rotation: 1 }).device).toMatchObject({ rotation: 1 });
  });

  test("the live channel only counts while running, and a repeat changes nothing", () => {
    const v = fresh(installed);
    expect(run(v, { type: "live", live: true })).toBe(v);
    const r = run(v, { type: "adopted", serial: "s", screen, rotation: 0 });
    expect(r.device).toMatchObject({ live: false });
    const on = run(r, { type: "live", live: true });
    expect(on.device).toMatchObject({ live: true });
    expect(run(on, { type: "live", live: true })).toBe(on);
    expect(run(on, { type: "live", live: false }).device).toMatchObject({ live: false });
  });
});

describe("metro and jobs", () => {
  const running = () => run(fresh(installed), { type: "adopted", serial: "s", screen, rotation: 0 });

  test("off -> starting -> running -> failed -> starting; not without a running device", () => {
    expect(run(fresh(installed), { type: "metro-starting", cwd: "/a" }).metro.kind).toBe("off");
    let v = run(running(), { type: "metro-starting", cwd: "/a" });
    expect(v.metro).toEqual({ kind: "starting", cwd: "/a" });
    expect(run(v, { type: "metro-starting", cwd: "/b" })).toBe(v);
    v = run(v, { type: "metro-running", cwd: "/a", port: 8081 });
    expect(v.metro).toEqual({ kind: "running", cwd: "/a", port: 8081 });
    v = run(v, { type: "metro-failed", reason: "exit 1", logTail: "t" });
    expect(v.metro.kind).toBe("failed");
    expect(run(v, { type: "metro-starting", cwd: "/a" }).metro.kind).toBe("starting");
    expect(run(v, { type: "metro-stopped" }).metro.kind).toBe("off");
  });

  test("jobs start running and finish once; the list stays bounded without dropping running ones", () => {
    const job = (id: string): Job => ({ id, kind: "install_apk", actor: { kind: "you" }, since: 1, state: "running", detail: "" });
    let v = run(fresh(installed), { type: "job-started", job: job("j1") }, { type: "job-finished", id: "j1", state: "done", detail: "ok" });
    expect(v.jobs).toEqual([{ ...job("j1"), state: "done", detail: "ok" }]);
    expect(run(v, { type: "job-finished", id: "j1", state: "failed", detail: "again" })).toBe(v);
    expect(run(v, { type: "job-finished", id: "nope", state: "failed", detail: "" })).toBe(v);
    for (let i = 2; i < 30; i++) v = run(v, { type: "job-started", job: job(`j${i}`) });
    expect(v.jobs.map((j) => j.id)).toEqual(Array.from({ length: 28 }, (_, i) => `j${i + 2}`)); // done j1 was dropped past the bound; the running ones all stay
    v = run(v, { type: "job-finished", id: "j2", state: "done", detail: "" }, { type: "job-started", job: job("j30") });
    expect(v.jobs.some((j) => j.id === "j2")).toBe(false);
    expect(v.jobs.some((j) => j.id === "j30")).toBe(true);
  });
});
