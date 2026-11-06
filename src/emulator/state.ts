/**
 * The emulator's state machine: one pure `reduce(view, event)` over the SDK, the device, Metro and the jobs.
 * An event that does not fit the current state (a boot while installing, progress after a cancel) is a no-op
 * that returns the same view object, so the owner can tell "nothing happened" with `===` and a late or
 * duplicated event can never put the view into a state the types forbid.
 */
import type { Actor, DeviceState, EmulatorView, HostProbe, InstallPlan, InstallStep, MetroState, SdkState, Job } from "./types";

const MAX_JOBS = 12;

type Rotation = 0 | 1 | 2 | 3;
type Screen = { width: number; height: number };

export type Event =
  | { type: "enabled"; enabled: boolean }
  | { type: "host"; host: HostProbe }
  | { type: "actor"; actor: Actor; at: number }
  // sdk: `sdk-reconciled` is what the disk says, trusted only while no install step is in flight
  | { type: "sdk-reconciled"; sdk: SdkState }
  | { type: "plan-requested" }
  | { type: "plan-ready"; plan: InstallPlan }
  | { type: "plan-failed"; reason: string }
  | { type: "plan-cancelled" }
  | { type: "install-started"; plan: InstallPlan }
  | { type: "install-progress"; step: InstallStep; doneBytes: number; totalBytes: number }
  | { type: "install-done"; root: string; owned: boolean }
  | { type: "install-failed"; reason: string; retryable: boolean }
  | { type: "install-cancelled" }
  | { type: "remove-started" }
  | { type: "remove-done" }
  | { type: "remove-failed"; reason: string }
  // device
  | { type: "boot-started"; serial: string; at: number }
  | { type: "boot-ready"; screen: Screen; rotation: Rotation }
  | { type: "boot-failed"; reason: string; logTail: string }
  | { type: "adopted"; serial: string; screen: Screen; rotation: Rotation }
  | { type: "frame"; screen: Screen }
  | { type: "rotated"; rotation: Rotation }
  | { type: "live"; live: boolean }
  | { type: "stop-started" }
  | { type: "device-stopped" }
  // metro
  | { type: "metro-starting"; cwd: string }
  | { type: "metro-running"; cwd: string; port: number }
  | { type: "metro-failed"; reason: string; logTail: string }
  | { type: "metro-stopped" }
  // jobs
  | { type: "job-started"; job: Job }
  | { type: "job-finished"; id: string; state: "done" | "failed"; detail: string };

export function initialView(host: HostProbe, sdk: SdkState, enabled = true): EmulatorView {
  return { enabled, host, sdk, device: { kind: "stopped" }, metro: { kind: "off" }, jobs: [], lastActor: null };
}

const withSdk = (v: EmulatorView, sdk: SdkState): EmulatorView => ({ ...v, sdk });
const withDevice = (v: EmulatorView, device: DeviceState): EmulatorView => ({ ...v, device });
const withMetro = (v: EmulatorView, metro: MetroState): EmulatorView => ({ ...v, metro });

const totalOf = (plan: InstallPlan) => plan.packages.reduce((n, p) => n + p.size, 0);
const firstStep = (plan: InstallPlan): InstallStep => (plan.packages[0] ? { pkg: plan.packages[0].path, phase: "download" } : { pkg: "avd", phase: "create" });

export function reduce(v: EmulatorView, e: Event): EmulatorView {
  const s = v.sdk;
  const d = v.device;
  switch (e.type) {
    case "enabled":
      return v.enabled === e.enabled ? v : { ...v, enabled: e.enabled };
    case "host":
      return { ...v, host: e.host };
    case "actor":
      return { ...v, lastActor: { actor: e.actor, at: e.at } };

    case "sdk-reconciled":
      return s.kind === "resolving" || s.kind === "installing" || s.kind === "removing" ? v : withSdk(v, e.sdk);
    case "plan-requested":
      return s.kind === "absent" || s.kind === "failed" ? withSdk(v, { kind: "resolving" }) : v;
    case "plan-ready":
      return s.kind === "resolving" ? withSdk(v, { kind: "needs-license", plan: e.plan }) : v;
    case "plan-failed":
      return s.kind === "resolving" ? withSdk(v, { kind: "failed", reason: e.reason, retryable: true }) : v;
    case "plan-cancelled":
      // The operator walked away from the license screen: forget the plan.
      return s.kind === "needs-license" ? withSdk(v, { kind: "absent" }) : v;
    case "install-started":
      // From needs-license once the operator accepts, or from failed on a retry that already holds an accepted plan.
      return s.kind === "needs-license" || s.kind === "failed" ? withSdk(v, { kind: "installing", plan: e.plan, step: firstStep(e.plan), doneBytes: 0, totalBytes: totalOf(e.plan) }) : v;
    case "install-progress":
      return s.kind === "installing" ? withSdk(v, { ...s, step: e.step, doneBytes: e.doneBytes, totalBytes: e.totalBytes }) : v;
    case "install-done":
      return s.kind === "installing" ? withSdk(v, { kind: "installed", root: e.root, owned: e.owned, avd: s.plan.avd }) : v;
    case "install-failed":
      return s.kind === "installing" ? withSdk(v, { kind: "failed", reason: e.reason, retryable: e.retryable }) : v;
    case "install-cancelled":
      // Installs resume, so a cancel goes back to the license screen with the same plan rather than to a dead end.
      return s.kind === "installing" ? withSdk(v, { kind: "needs-license", plan: s.plan }) : v;
    case "remove-started":
      return s.kind === "installed" && s.owned ? withSdk(v, { kind: "removing" }) : v;
    case "remove-done":
      return s.kind === "removing" ? withSdk(v, { kind: "absent" }) : v;
    case "remove-failed":
      return s.kind === "removing" ? withSdk(v, { kind: "failed", reason: e.reason, retryable: false }) : v;

    case "boot-started":
      return s.kind === "installed" && (d.kind === "stopped" || d.kind === "failed") ? withDevice(v, { kind: "booting", serial: e.serial, since: e.at }) : v;
    case "boot-ready":
      return d.kind === "booting" ? withDevice(v, { kind: "running", serial: d.serial, screen: e.screen, rotation: e.rotation, seq: 0, live: false }) : v;
    case "boot-failed":
      return d.kind === "booting" ? withDevice(v, { kind: "failed", reason: e.reason, logTail: e.logTail }) : v;
    case "adopted":
      return s.kind === "installed" && (d.kind === "stopped" || d.kind === "failed") ? withDevice(v, { kind: "running", serial: e.serial, screen: e.screen, rotation: e.rotation, seq: 0, live: false }) : v;
    case "frame":
      return d.kind === "running" ? withDevice(v, { ...d, screen: e.screen, seq: d.seq + 1 }) : v;
    case "rotated":
      return d.kind === "running" && d.rotation !== e.rotation ? withDevice(v, { ...d, rotation: e.rotation }) : v;
    case "live":
      return d.kind === "running" && d.live !== e.live ? withDevice(v, { ...d, live: e.live }) : v;
    case "stop-started":
      return d.kind === "running" || d.kind === "booting" ? withDevice(v, { kind: "stopping", serial: d.serial }) : v;
    case "device-stopped":
      // The process is gone whatever we thought it was doing: always accepted, and Metro (which ran on it) goes too.
      if (d.kind === "stopped" && v.metro.kind === "off") return v;
      return { ...v, device: { kind: "stopped" }, metro: { kind: "off" } };

    case "metro-starting":
      return d.kind === "running" && (v.metro.kind === "off" || v.metro.kind === "failed") ? withMetro(v, { kind: "starting", cwd: e.cwd }) : v;
    case "metro-running":
      return v.metro.kind === "starting" ? withMetro(v, { kind: "running", cwd: e.cwd, port: e.port }) : v;
    case "metro-failed":
      return v.metro.kind === "starting" || v.metro.kind === "running" ? withMetro(v, { kind: "failed", reason: e.reason, logTail: e.logTail }) : v;
    case "metro-stopped":
      return v.metro.kind === "off" ? v : withMetro(v, { kind: "off" });

    case "job-started": {
      const jobs = [...v.jobs, e.job];
      // Bounded by dropping the oldest finished jobs first, never one still running.
      while (jobs.length > MAX_JOBS) {
        const i = jobs.findIndex((j) => j.state !== "running");
        if (i < 0) break;
        jobs.splice(i, 1);
      }
      return { ...v, jobs };
    }
    case "job-finished": {
      const i = v.jobs.findIndex((j) => j.id === e.id && j.state === "running");
      return i < 0 ? v : { ...v, jobs: v.jobs.map((j, k) => (k === i ? { ...j, state: e.state, detail: e.detail } : j)) };
    }
  }
}
