/**
 * The Android emulator's one owner. It holds the single EmulatorView (SDK, device, Metro, jobs), changes it only
 * through the pure reducer in state.ts, and is the only thing that touches the device: a serial queue for short
 * actions (so two agents and the operator never interleave a gesture), tracked jobs for long ones (an APK
 * install, Metro) that must not hold up the operator's taps, a frame poller that runs only while someone is
 * watching, boot and adoption of an orphaned emulator, the idle policy, and the audit log.
 *
 * The operator's view goes over the emulator's own gRPC channel when it has one (booted here with -grpc) and the
 * device is in portrait: frames are pushed as the screen changes and the finger is sent as it moves. Agents, a
 * rotated device and an emulator without the channel go through adb, as before.
 *
 * Every effect goes through Deps, the Installer and `openLive`, so the whole of it runs against fakes in tests.
 */
import fs from "fs";
import path from "path";
import { getSetting } from "../settings";
import { home } from "../paths";
import { Hub } from "../sessions/hub";
import { AdbError, SERIAL, adbClient, type AdbClient, type UiElement } from "./adb";
import { realDeps, type Deps } from "./deps";
import { createInstaller } from "./install";
import { startExpo as realStartExpo, type ExpoHandle } from "./expo";
import { openGrpcChannel } from "./grpc";
import { initialView, reduce, type Event } from "./state";
import { InputError, adbTransport, liveInput, type LiveChannel, type Transport } from "./transport";
import type { Actor, Command, CommandResult, EmulatorInput, EmulatorView, HostProbe, InstallOp, InstallPlan, Installer, Job, MetroState, Pointer } from "./types";

const FRAME_MS = 400;
/** A press whose release never comes (the tab closed mid-drag) is lifted after this, and lets go of the queue. */
const GESTURE_MAX_MS = 60_000;
/** After the live stream drops, one more try to reopen the channel this much later. */
const LIVE_RETRY_MS = 3000;
const IDLE_MS = 30 * 60_000;
const IDLE_CHECK_MS = 60_000;
const BOOT_TIMEOUT_MS = 240_000;
const BOOT_POLL_MS = 1500;
const STOP_WAIT_MS = 10_000;
const EXPO_WAIT_MS = 120_000;
const TAIL_LINES = 40;
const MAX_UI_LINES = 400;
const EMULATOR_PORT = 5554;
/** The emulator's own pairing of a console port with its gRPC port (5554 -> 8554). */
const GRPC_PORT = EMULATOR_PORT + 3000;
/** The emulator's boot output names its discovery file, which holds the gRPC port and token. */
const ADVERTISED = /Advertising in: (.+\.ini)\s*$/;
const NO_LIVE = "Live touch needs the emulator's gRPC channel and the device in portrait. Restart the emulator from treeboss to get it.";

/** Not installed, a refused operation, a state the operation does not fit: something the caller can show as is. */
export class EmulatorError extends Error {}

export const NOT_INSTALLED = "The Android emulator is not installed. The operator installs it from the Emulator tab (it needs Google's license accepted there).";

export interface Frame {
  seq: number;
  bytes: Uint8Array;
  mime: "image/png";
  width: number;
  height: number;
}
export type FrameResult = { ok: true; frame: Frame } | { ok: false; error: string };

export interface Emulator {
  snapshot(): EmulatorView;
  /** Called with the new view after every change (frames included). Returns the unsubscribe. A watcher is a viewer: it keeps the device alive and the frame poller running. */
  watch(fn: (v: EmulatorView) => void): () => void;
  /** The latest frame, or null when the device is not running or nothing has been captured yet. */
  frame(): Frame | null;
  run(actor: Actor, cmd: Command): Promise<CommandResult>;
  /** The operator's finger on the live view (needs `device.live`). A press holds the action queue until its release, so no agent action lands mid-gesture. */
  pointer(actor: Actor, p: Pointer): Promise<CommandResult>;
  /** Takes a fresh screenshot through the action queue. */
  capture(actor: Actor): Promise<FrameResult>;
  /** The on-screen elements, as compact text. */
  uiTree(actor: Actor): Promise<CommandResult>;
  logs(actor: Actor, tag: string, lines: number): Promise<CommandResult>;
  install(op: InstallOp): Promise<void>;
  /** Reads the disk once (what is installed, an orphaned emulator to adopt) and probes the host once, then returns the view. */
  refresh(): Promise<EmulatorView>;
  /** Resolves when no background install is running. */
  settled(): Promise<void>;
  /** Stops the device, Metro and the timers. The daemon calls this on its way down. */
  shutdown(): Promise<void>;
}

export interface EmulatorOptions {
  enabled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  frameMs?: number;
  idleMs?: number;
  idleCheckMs?: number;
  bootTimeoutMs?: number;
  bootPollMs?: number;
  expoWaitMs?: number;
  auditFile?: () => string;
  /** An agent did something on the device: the daemon turns this into a Hub event. */
  onAgentAction?: (sessionId: string, action: string) => void;
  startExpo?: typeof realStartExpo;
  /** Opens the running emulator's live channel (its gRPC endpoint), or null when it has none. `advertised` is the discovery file the emulator printed at boot. Without it, everything goes through adb. */
  openLive?: (advertised: string | null) => Promise<LiveChannel | null>;
}

const UNKNOWN_HOST: HostProbe = { os: "windows", arch: "x64", abi: "x86_64", accel: { state: "unchecked" }, diskFreeBytes: 0, needBytes: 0, existingSdk: null };
const noop = () => undefined;
const msg = (e: unknown) => String((e as { message?: string })?.message ?? e).split("\n")[0]!;
const who = (a: Actor) => (a.kind === "you" ? "you" : `agent:${a.sessionId}`);
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const REFUSED_SCHEMES = new Set(["file", "content", "data", "javascript", "blob", "about", "vbscript", "intent"]);
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

/** One line per thing done, typed text by its length only. */
function describe(cmd: Command): string {
  switch (cmd.kind) {
    case "input":
      return cmd.input.kind === "text" ? `type ${cmd.input.text.length} characters` : `input ${JSON.stringify(cmd.input)}`;
    case "open_url":
      return `open_url ${cmd.url}`;
    case "install_apk":
      return `install_apk ${cmd.path}`;
    case "launch":
      return `launch ${cmd.pkg}`;
    case "run_expo":
      return `run_expo ${cmd.cwd}`;
    default:
      return cmd.kind;
  }
}

function describeInput(i: EmulatorInput): string {
  switch (i.kind) {
    case "tap":
      return `Tapped (${Math.round(i.x)}, ${Math.round(i.y)}).`;
    case "long_press":
      return `Pressed and held (${Math.round(i.x)}, ${Math.round(i.y)}).`;
    case "swipe":
      return `Swiped (${Math.round(i.x1)}, ${Math.round(i.y1)}) to (${Math.round(i.x2)}, ${Math.round(i.y2)}).`;
    case "text":
      return `Typed ${i.text.length} character${i.text.length === 1 ? "" : "s"}.`;
    case "key":
      return `Pressed ${i.key}.`;
    case "rotate":
      return `Rotated to ${i.to}.`;
  }
}

/** Compact text for an agent: one element per line with its bounds and center. The text is the app's, so the caller marks it as data. */
export function formatUi(els: UiElement[]): string {
  const lines = els.slice(0, MAX_UI_LINES).map((e) => {
    const { x1, y1, x2, y2 } = e.bounds;
    const label = [e.text && `"${e.text}"`, e.desc && `desc="${e.desc}"`, e.id && `id=${e.id.split("/").pop()}`].filter(Boolean).join(" ");
    return `${e.cls}${e.clickable ? " [clickable]" : ""} ${label} [${x1},${y1}][${x2},${y2}] center=(${Math.round((x1 + x2) / 2)},${Math.round((y1 + y2) / 2)})`;
  });
  if (els.length > MAX_UI_LINES) lines.push(`… ${els.length - MAX_UI_LINES} more elements not shown; scroll to see them.`);
  return lines.join("\n");
}

export function createEmulator(deps: Deps, installer: Installer, opts: EmulatorOptions = {}): Emulator {
  const enabled = opts.enabled ?? (() => true);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const frameMs = opts.frameMs ?? FRAME_MS;
  const idleMs = opts.idleMs ?? IDLE_MS;
  const idleCheckMs = opts.idleCheckMs ?? IDLE_CHECK_MS;
  const bootTimeoutMs = opts.bootTimeoutMs ?? BOOT_TIMEOUT_MS;
  const bootPollMs = opts.bootPollMs ?? BOOT_POLL_MS;
  const expoWaitMs = opts.expoWaitMs ?? EXPO_WAIT_MS;
  const startExpo = opts.startExpo ?? realStartExpo;
  const auditFile = opts.auditFile ?? (() => path.join(home(), "emulator", "audit.log"));

  let view = initialView(UNKNOWN_HOST, { kind: "absent" }, enabled());
  const watchers = new Set<(v: EmulatorView) => void>();
  let frame: Frame | null = null;
  let lastHash: string | null = null;
  let lastActivity = deps.now();
  let ready: Promise<void> | null = null;
  let hostProbed: Promise<void> | null = null;
  let bootPromise: Promise<CommandResult> | null = null;
  let emuChild: ReturnType<Deps["exec"]["spawn"]> | null = null;
  let emuTail: string[] = [];
  let expo: ExpoHandle | null = null;
  let acceptedPlan: InstallPlan | null = null;
  let installAbort: AbortController | null = null;
  let installRun: Promise<void> = Promise.resolve();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let grabbing: Promise<boolean> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let jobSeq = 0;
  let adb: { root: string; client: AdbClient; transport: Transport } | null = null;
  let advertised: string | null = null;
  let live: LiveChannel | null = null;
  let liveOpening = false;
  let liveRetry: ReturnType<typeof setTimeout> | null = null;
  let stopFrames: (() => void) | null = null;
  /** The operator's finger from press to release: `chain` keeps its moves in order behind the press, `release` lets go of the queue. */
  let gesture: { chain: Promise<void>; last: { x: number; y: number }; release: () => void } | null = null;

  /* ---- state ---- */

  function dispatch(e: Event): boolean {
    const next = reduce(view, e);
    if (next === view) return false;
    view = next;
    for (const fn of [...watchers]) {
      try {
        fn(view);
      } catch {}
    }
    syncPoller();
    return true;
  }

  function installedRoot(): string | null {
    return view.sdk.kind === "installed" ? view.sdk.root : null;
  }

  function device(): { client: AdbClient; transport: Transport } {
    const root = installedRoot();
    if (!root) throw new EmulatorError(NOT_INSTALLED);
    if (!adb || adb.root !== root) {
      const client = adbClient(deps, installer.bin(root).adb, SERIAL);
      adb = { root, client, transport: adbTransport(client) };
    }
    return adb;
  }

  /** Why a command that needs a running device cannot run, or null when it can. */
  function notReady(): string | null {
    if (view.sdk.kind !== "installed") return NOT_INSTALLED;
    if (view.device.kind === "running") return null;
    if (view.device.kind === "booting") return "The emulator is still booting. Try again in a moment.";
    return "The emulator is not running. Start it with emulator_start.";
  }

  /* ---- queue, audit ---- */

  function audit(actor: Actor | "daemon", what: string): void {
    try {
      const file = auditFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ ts: new Date(deps.now()).toISOString(), actor: actor === "daemon" ? actor : who(actor), action: what }) + "\n");
    } catch {}
  }

  function touch(actor: Actor, what: string): void {
    lastActivity = deps.now();
    dispatch({ type: "actor", actor, at: lastActivity });
    audit(actor, what);
    if (actor.kind === "agent") opts.onAgentAction?.(actor.sessionId, what);
  }

  /** Run `fn` after every action queued before it. Errors do not stop the queue. `what` is recorded as the actor's action; null records nothing. */
  function enqueue<T>(actor: Actor, what: string | null, fn: () => Promise<T>): Promise<T> {
    const p = queue.then(() => {
      if (what !== null) touch(actor, what);
      return fn();
    });
    queue = p.then(noop, noop);
    return p;
  }

  const fail = (e: unknown): CommandResult => ({ ok: false, error: e instanceof EmulatorError || e instanceof InputError || e instanceof AdbError ? e.message : msg(e) });

  /* ---- frames ---- */

  /** Keeps a picture as the frame; true when it differs from the last one. */
  function takeFrame(f: { bytes: Uint8Array; width: number; height: number }): boolean {
    const hash = Bun.hash(f.bytes).toString(36);
    if (hash === lastHash && frame) return false;
    lastHash = hash;
    const seq = view.device.kind === "running" ? view.device.seq + 1 : (frame?.seq ?? 0) + 1;
    frame = { seq, bytes: f.bytes, mime: "image/png", width: f.width, height: f.height };
    dispatch({ type: "frame", screen: { width: f.width, height: f.height } });
    return true;
  }

  /** Captures the screen over adb; true when it differs from the last frame. Concurrent callers share one capture. */
  function grabFrame(): Promise<boolean> {
    if (grabbing) return grabbing;
    grabbing = (async () => takeFrame(await device().transport.capture()))().finally(() => {
      grabbing = null;
    });
    return grabbing;
  }

  /** A capture that starts after the caller's action: one already in flight began before it, and would show the screen as it was. */
  async function freshFrame(): Promise<boolean> {
    if (grabbing) await grabbing.catch(noop);
    return grabFrame();
  }

  /** The live channel is up and its coordinates are the screen's: the device is not rotated. */
  const liveReady = () => live !== null && view.device.kind === "running" && view.device.rotation === 0;

  /** While someone watches a running device: the live stream when there is one, else the poller. */
  function syncPoller(): void {
    const watching = watchers.size > 0 && view.device.kind === "running";
    const streaming = watching && liveReady();
    if (streaming && !stopFrames) startFrames(live!);
    if (!streaming && stopFrames) {
      stopFrames();
      stopFrames = null;
    }
    const polling = watching && !streaming;
    if (polling && !pollTimer) pollTimer = setTimeout(tick, 0);
    if (!polling && pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  async function tick(): Promise<void> {
    pollTimer = null;
    try {
      await grabFrame();
    } catch {}
    if (watchers.size > 0 && view.device.kind === "running" && !liveReady() && !pollTimer) pollTimer = setTimeout(tick, frameMs);
  }

  function startFrames(ch: LiveChannel): void {
    let on = true;
    const stop = ch.frames(
      (f) => {
        if (on) takeFrame(f);
      },
      () => {
        if (!on) return;
        // The stream ended by itself: the emulator dropped the channel or went away. Back to adb, and try the channel once more later.
        on = false;
        stopFrames = null;
        dropLive();
        if (!liveRetry) {
          liveRetry = setTimeout(() => {
            liveRetry = null;
            connectLive();
          }, LIVE_RETRY_MS);
          (liveRetry as { unref?: () => void }).unref?.();
        }
      },
    );
    stopFrames = () => {
      on = false;
      stop();
    };
  }

  /** Tells the view whether live input is on, and moves the picture to the stream or the poller to match. */
  function syncLive(): void {
    if (view.device.kind === "running") dispatch({ type: "live", live: liveReady() });
    syncPoller();
  }

  /** Opens a running device's live channel, once. Without one (an emulator started without -grpc), adb does everything. */
  function connectLive(): void {
    if (live || liveOpening || !opts.openLive || view.device.kind !== "running") return;
    liveOpening = true;
    opts.openLive(advertised).then(
      (ch) => {
        liveOpening = false;
        if (!ch) return;
        if (live || view.device.kind !== "running") return ch.close();
        live = ch;
        syncLive();
      },
      () => {
        liveOpening = false;
      },
    );
  }

  /** Forgets the live channel (its stream ended, the device stopped): the picture goes back to the poller, input to adb. */
  function dropLive(): void {
    const ch = live;
    live = null;
    endGesture();
    if (stopFrames) {
      stopFrames();
      stopFrames = null;
    }
    ch?.close();
    syncLive();
  }

  /* ---- the operator's finger ---- */

  /** Lifts the finger where it last was and lets go of the queue: a release that never came, or a channel going away. */
  function endGesture(): void {
    const g = gesture;
    if (!g) return;
    gesture = null;
    const ch = live;
    if (ch) void g.chain.then(() => ch.touch(g.last.x, g.last.y, false)).catch(noop).finally(g.release);
    else g.release();
  }

  async function pointer(actor: Actor, p: Pointer): Promise<CommandResult> {
    const why = notReady();
    if (why) return { ok: false, error: why };
    const ch = liveReady() ? live : null;
    if (!ch || view.device.kind !== "running") return { ok: false, error: NO_LIVE };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false, error: "x and y must be numbers." };
    const { width, height } = view.device.screen;
    const at = { x: Math.min(Math.max(0, Math.round(p.x)), width - 1), y: Math.min(Math.max(0, Math.round(p.y)), height - 1) };
    let g = gesture;
    if (!g) {
      if (!p.down) return { ok: true, text: "Released." }; // nothing is pressed (the press was cut short): nothing to lift
      // The press waits its turn in the queue like any action, then holds it until the release.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let pressed!: () => void;
      let refused!: (e: unknown) => void;
      const chain = new Promise<void>((res, rej) => {
        pressed = res;
        refused = rej;
      });
      const started = { chain, last: at, release };
      g = gesture = started;
      const lost = setTimeout(() => gesture === started && endGesture(), GESTURE_MAX_MS);
      (lost as { unref?: () => void }).unref?.();
      enqueue(actor, `touch (${at.x}, ${at.y})`, async () => {
        try {
          await ch.touch(at.x, at.y, true);
          pressed();
        } catch (e) {
          refused(e);
          return;
        }
        await held;
      })
        .catch(noop)
        .finally(() => clearTimeout(lost));
    } else {
      g.chain = g.chain.then(() => ch.touch(at.x, at.y, p.down));
      g.last = at;
    }
    if (!p.down) {
      gesture = null;
      void g.chain.catch(noop).finally(g.release);
    }
    try {
      await g.chain;
      return { ok: true, text: p.down ? `Touching (${at.x}, ${at.y}).` : `Released at (${at.x}, ${at.y}).` };
    } catch (e) {
      if (gesture === g) gesture = null;
      g.release();
      return fail(e);
    }
  }

  /* ---- idle ---- */

  function metroBusy(): boolean {
    return view.metro.kind === "starting" || view.metro.kind === "running";
  }

  function checkIdle(): void {
    if (view.device.kind !== "running" || watchers.size > 0 || metroBusy()) return;
    if (deps.now() - lastActivity < idleMs) return;
    audit("daemon", "idle shutdown");
    void stopDevice().catch(noop);
  }

  function syncIdleTimer(): void {
    const want = view.device.kind === "running";
    if (want && !idleTimer) {
      idleTimer = setInterval(checkIdle, idleCheckMs);
      (idleTimer as { unref?: () => void }).unref?.();
    }
    if (!want && idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  /* ---- device lifecycle ---- */

  async function adoptOrphan(): Promise<boolean> {
    if (view.sdk.kind !== "installed" || view.device.kind !== "stopped") return false;
    const avdName = view.sdk.avd.name;
    const { client, transport } = device();
    if ((await client.avdName().catch(() => null)) !== avdName) return false;
    const [shot, rotation] = await Promise.all([transport.capture(), client.rotation()]);
    // The SDK may have been removed while we asked: the reducer then refuses, and nothing was adopted.
    if (!dispatch({ type: "adopted", serial: SERIAL, screen: { width: shot.width, height: shot.height }, rotation })) return false;
    audit("daemon", "adopted a running emulator");
    syncIdleTimer();
    connectLive();
    return true;
  }

  function pushTail(line: string): void {
    emuTail.push(line);
    if (emuTail.length > TAIL_LINES) emuTail.shift();
    const m = ADVERTISED.exec(line);
    if (m) advertised = m[1]!.trim();
  }

  async function doBoot(): Promise<CommandResult> {
    const sdk = view.sdk;
    if (sdk.kind !== "installed") return { ok: false, error: NOT_INSTALLED };
    if (view.device.kind === "stopping") return { ok: false, error: "The emulator is shutting down. Try again in a moment." };
    if (await adoptOrphan()) return { ok: true, text: `The emulator was already running (${screenText()}).` };
    if (!dispatch({ type: "boot-started", serial: SERIAL, at: deps.now() })) return { ok: false, error: "The emulator cannot be started right now." };
    const { client, transport } = device();
    const bin = installer.bin(sdk.root);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, { ANDROID_AVD_HOME: deps.paths.avdHome, ANDROID_SDK_ROOT: sdk.root, ANDROID_HOME: sdk.root });
    emuTail = [];
    advertised = null;
    // -grpc with a token: the live channel, on localhost only, for whoever can read the discovery file the emulator writes.
    const argv = [bin.emulator, "-avd", sdk.avd.name, "-port", String(EMULATOR_PORT), "-grpc", String(GRPC_PORT), "-grpc-use-token", "-no-window", "-no-audio", "-no-boot-anim", "-gpu", "swiftshader_indirect"];
    const child = deps.exec.spawn(argv, { env, cwd: sdk.root });
    emuChild = child;
    child.onLine(pushTail);
    void child.exited.then((code) => {
      if (emuChild !== child) return;
      emuChild = null;
      if (view.device.kind === "booting") dispatch({ type: "boot-failed", reason: `The emulator exited (code ${code}) before it finished booting.`, logTail: emuTail.join("\n") });
      else {
        stopExpo();
        dropLive();
        frame = null;
        lastHash = null;
        dispatch({ type: "device-stopped" });
        syncIdleTimer();
      }
    });

    const deadline = deps.now() + bootTimeoutMs;
    for (;;) {
      if (view.device.kind !== "booting") break; // it died, or was shut down, while booting
      if (await client.bootCompleted()) break;
      if (deps.now() > deadline) {
        dispatch({ type: "boot-failed", reason: `The emulator did not finish booting within ${Math.round(bootTimeoutMs / 1000)} s.`, logTail: emuTail.join("\n") });
        emuChild = null;
        await child.stop().catch(noop);
        break;
      }
      await sleep(bootPollMs);
    }
    if (view.device.kind === "failed") return { ok: false, error: `${view.device.reason}${view.device.logTail ? `\n${view.device.logTail}` : ""}` };
    if (view.device.kind !== "booting") return { ok: false, error: "The emulator was shut down while it was booting." };
    const [shot, rotation] = await Promise.all([transport.capture(), client.rotation()]);
    dispatch({ type: "boot-ready", screen: { width: shot.width, height: shot.height }, rotation });
    syncIdleTimer();
    connectLive();
    return { ok: true, text: `The emulator is running (${screenText()}).` };
  }

  const screenText = () => (view.device.kind === "running" ? `${view.device.screen.width}x${view.device.screen.height}` : "no screen yet");

  function boot(): Promise<CommandResult> {
    if (view.device.kind === "running") return Promise.resolve({ ok: true, text: `The emulator is already running (${screenText()}).` });
    bootPromise ??= doBoot()
      .catch(fail)
      .finally(() => {
        bootPromise = null;
      });
    return bootPromise;
  }

  function stopExpo(): void {
    const handle = expo;
    expo = null;
    void handle?.stop().catch(noop);
    dispatch({ type: "metro-stopped" });
  }

  /** Stop the device: ask the emulator to exit, then take its process down if it will not. */
  async function stopDevice(): Promise<void> {
    if (!dispatch({ type: "stop-started" })) return;
    stopExpo();
    const child = emuChild;
    try {
      await device().client.kill().catch(noop);
      if (child) {
        const exited = await Promise.race([child.exited.then(() => true), sleep(STOP_WAIT_MS).then(() => false)]);
        if (!exited) await child.stop().catch(noop);
      } else {
        // An adopted emulator has no process of ours; wait for it to stop answering.
        const deadline = deps.now() + STOP_WAIT_MS;
        while (deps.now() < deadline && (await device().client.avdName().catch(() => null)) !== null) await sleep(500);
      }
    } finally {
      emuChild = null;
      dropLive();
      frame = null;
      lastHash = null;
      dispatch({ type: "device-stopped" });
      syncIdleTimer();
    }
  }

  /* ---- jobs ---- */

  async function job<T extends CommandResult>(actor: Actor, kind: Job["kind"], detail: string, fn: () => Promise<T>): Promise<T> {
    const id = `j${++jobSeq}`;
    touch(actor, `${kind} ${detail}`);
    dispatch({ type: "job-started", job: { id, kind, actor, since: deps.now(), state: "running", detail } });
    try {
      const r = await fn();
      dispatch({ type: "job-finished", id, state: r.ok ? "done" : "failed", detail: r.ok ? r.text : r.error });
      return r;
    } catch (e) {
      const r = fail(e) as T;
      dispatch({ type: "job-finished", id, state: "failed", detail: (r as { error: string }).error });
      return r;
    }
  }

  async function runExpo(cwd: string): Promise<CommandResult> {
    const sdk = view.sdk;
    if (sdk.kind !== "installed") return { ok: false, error: NOT_INSTALLED };
    if (view.metro.kind === "running" || view.metro.kind === "starting") return { ok: true, text: `Metro is already ${view.metro.kind} for ${view.metro.cwd}. Stop it from the Emulator tab to run another project.` };
    if (!fs.existsSync(path.join(cwd, "package.json"))) return { ok: false, error: `${cwd} has no package.json: give the Expo project's directory.` };
    return new Promise<CommandResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => done({ ok: true, text: "Metro is still starting (the first run installs Expo Go). Check emulator_status." }), expoWaitMs);
      const done = (r: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const onState = (s: MetroState) => {
        if (s.kind === "starting") dispatch({ type: "metro-starting", cwd: s.cwd });
        else if (s.kind === "running") {
          dispatch({ type: "metro-running", cwd: s.cwd, port: s.port });
          done({ ok: true, text: `Metro is running on port ${s.port} for ${s.cwd}. The app opens on the phone; read its output with emulator_logs.` });
        } else if (s.kind === "failed") {
          dispatch({ type: "metro-failed", reason: s.reason, logTail: s.logTail });
          done({ ok: false, error: `${s.reason}${s.logTail ? `\n${s.logTail}` : ""}` });
        } else dispatch({ type: "metro-stopped" });
      };
      expo = startExpo(deps, device().client, sdk.root, cwd, onState);
    });
  }

  /* ---- commands ---- */

  const refuse = (what: string): CommandResult => ({ ok: false, error: `${what} is the operator's: only you can do it from the Emulator tab.` });

  async function run(actor: Actor, cmd: Command): Promise<CommandResult> {
    try {
      switch (cmd.kind) {
        case "boot":
          touch(actor, "boot");
          return await boot();
        case "shutdown":
          if (actor.kind !== "you") return refuse("Shutting the emulator down");
          return await enqueue(actor, "shutdown", async () => {
            if (view.device.kind === "stopped") return { ok: true, text: "The emulator is already stopped." } as CommandResult;
            await stopDevice();
            return { ok: true, text: "The emulator is stopped." } as CommandResult;
          });
        case "stop_expo":
          if (actor.kind !== "you") return refuse("Stopping Metro");
          touch(actor, "stop_expo");
          stopExpo();
          return { ok: true, text: "Metro is stopped." };
        case "input": {
          const why = notReady();
          if (why) return { ok: false, error: why };
          const input = cmd.input;
          // The operator's keys and text take the live channel. Agents keep adb: its coordinates are the screen they read with uiTree, rotated or not.
          const ch = actor.kind === "you" && (input.kind === "key" || input.kind === "text") && liveReady() ? live : null;
          return await enqueue(actor, describe(cmd), async () => {
            if (ch) await liveInput(ch, input);
            else await device().transport.input(input);
            if (input.kind === "rotate") {
              dispatch({ type: "rotated", rotation: await device().client.rotation() });
              syncLive();
            }
            if (!stopFrames) await freshFrame().catch(noop); // the operator sees the effect now, not at the next poll; a live stream brings it by itself
            return { ok: true, text: describeInput(input) } as CommandResult;
          });
        }
        case "open_url": {
          const why = notReady();
          if (why) return { ok: false, error: why };
          const scheme = SCHEME.exec(cmd.url)?.[1]?.toLowerCase();
          if (!scheme) return { ok: false, error: "The URL needs a scheme, like https:// or exp://." };
          if (REFUSED_SCHEMES.has(scheme)) return { ok: false, error: `${scheme}: URLs are refused.` };
          return await enqueue(actor, describe(cmd), async () => {
            const out = await device().client.shell(["am", "start", "-a", "android.intent.action.VIEW", "-d", cmd.url]);
            if (/Error:|unable to resolve|not found/i.test(out)) return { ok: false, error: out.trim().split("\n").slice(0, 3).join(" ") } as CommandResult;
            if (!stopFrames) await freshFrame().catch(noop);
            return { ok: true, text: `Opened ${cmd.url}.` } as CommandResult;
          });
        }
        case "launch": {
          const why = notReady();
          if (why) return { ok: false, error: why };
          if (!PACKAGE.test(cmd.pkg)) return { ok: false, error: `"${cmd.pkg}" is not an Android package name (like com.example.app).` };
          return await enqueue(actor, describe(cmd), async () => {
            const out = await device().client.shell(["monkey", "-p", cmd.pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
            if (/No activities found|monkey aborted/i.test(out)) return { ok: false, error: `${cmd.pkg} is not installed or has no launcher activity.` } as CommandResult;
            if (!stopFrames) await freshFrame().catch(noop);
            return { ok: true, text: `Launched ${cmd.pkg}.` } as CommandResult;
          });
        }
        case "install_apk": {
          const why = notReady();
          if (why) return { ok: false, error: why };
          if (!/\.apk$/i.test(cmd.path) || !fs.existsSync(cmd.path)) return { ok: false, error: `${cmd.path} is not an existing .apk file.` };
          return await job(actor, "install_apk", cmd.path, async () => {
            await device().client.install(cmd.path);
            return { ok: true, text: `Installed ${path.basename(cmd.path)}.` } as CommandResult;
          });
        }
        case "run_expo": {
          const why = notReady();
          if (why) return { ok: false, error: why };
          return await job(actor, "run_expo", cmd.cwd, () => runExpo(cmd.cwd));
        }
      }
    } catch (e) {
      return fail(e);
    }
  }

  /* ---- installing ---- */

  /** Runs the install in the background; progress, completion and failure arrive as events. */
  function startInstall(plan: InstallPlan, beforeRun?: () => Promise<void>): boolean {
    // The state moves first, synchronously: a second caller finds it already installing and is refused.
    if (!dispatch({ type: "install-started", plan })) return false;
    const abort = new AbortController();
    installAbort = abort;
    installRun = (async () => {
      try {
        await beforeRun?.();
        await installer.run(plan, (step, doneBytes, totalBytes) => dispatch({ type: "install-progress", step, doneBytes, totalBytes }), abort.signal);
        const sdk = await installer.reconcile();
        if (sdk.kind === "installed") dispatch({ type: "install-done", root: sdk.root, owned: sdk.owned });
        else dispatch({ type: "install-failed", reason: "The install finished but the SDK on disk is incomplete.", retryable: true });
      } catch (e) {
        if (abort.signal.aborted) dispatch({ type: "install-cancelled" });
        else dispatch({ type: "install-failed", reason: msg(e), retryable: true });
      } finally {
        if (installAbort === abort) installAbort = null;
      }
    })();
    return true;
  }

  async function requestPlan(): Promise<void> {
    if (!dispatch({ type: "plan-requested" })) return;
    try {
      await ensureHost();
      const plan = await installer.plan(view.host);
      dispatch({ type: "plan-ready", plan });
      // A plan with no licenses is a reused SDK (Android Studio's): only treeboss's own AVD gets created, so the Install click is enough.
      if (plan.licenses.length === 0) {
        acceptedPlan = plan;
        startInstall(plan);
      }
    } catch (e) {
      dispatch({ type: "plan-failed", reason: msg(e) });
    }
  }

  async function install(op: InstallOp): Promise<void> {
    const s = view.sdk;
    switch (op.kind) {
      case "plan":
        if (s.kind === "needs-license") throw new EmulatorError("An install plan is already waiting for license acceptance.");
        if (s.kind !== "absent" && s.kind !== "failed") throw new EmulatorError(s.kind === "installed" ? "The emulator is already installed." : `The emulator is busy (${s.kind}); try again when it has finished.`);
        return requestPlan();
      case "retry":
        if (s.kind !== "failed") throw new EmulatorError("Nothing failed; there is nothing to retry.");
        // A failed install resumes from the plan the operator already accepted; a failed plan starts over.
        if (acceptedPlan) {
          if (!startInstall(acceptedPlan)) throw new EmulatorError("An install is already running.");
          return;
        }
        return requestPlan();
      case "cancel":
        if (s.kind === "installing") installAbort?.abort();
        else if (s.kind === "needs-license") dispatch({ type: "plan-cancelled" });
        else throw new EmulatorError("There is no install to cancel.");
        return;
      case "accept": {
        if (op.by !== "you") throw new EmulatorError("Only the operator can accept Google's licenses.");
        if (s.kind !== "needs-license") throw new EmulatorError("There is no license to accept right now.");
        const missing = s.plan.licenses.filter((l) => !op.licenses.includes(l.id));
        if (missing.length) throw new EmulatorError(`Accept every license in the plan: missing ${missing.map((l) => l.id).join(", ")}.`);
        audit({ kind: "you" }, `accepted ${s.plan.licenses.map((l) => l.id).join(", ")}`);
        const plan = s.plan;
        // Recording the acceptance happens inside the install, after the state has moved, so a double click cannot start two.
        const started = startInstall(plan, async () => {
          await installer.accept(plan, op.licenses);
          acceptedPlan = plan;
        });
        if (!started) throw new EmulatorError("The licenses were already accepted; the install is running.");
        return;
      }
      case "remove": {
        if (op.by !== "you") throw new EmulatorError("Only the operator can remove the emulator.");
        if (s.kind !== "installed") throw new EmulatorError("The emulator is not installed.");
        if (!s.owned) throw new EmulatorError("This SDK is not treeboss's own (it was found on this machine), so treeboss will not remove it.");
        audit({ kind: "you" }, "remove");
        try {
          await stopDevice(); // while the SDK still reads as installed: stopping needs its adb
          dispatch({ type: "remove-started" });
          await installer.remove();
          acceptedPlan = null;
          adb = null;
          dispatch({ type: "remove-done" });
        } catch (e) {
          dispatch({ type: "remove-failed", reason: msg(e) });
        }
        return;
      }
    }
  }

  /* ---- start up ---- */

  function ensureHost(): Promise<void> {
    hostProbed ??= installer.probe().then((host) => void dispatch({ type: "host", host }), () => void (hostProbed = null));
    return hostProbed;
  }

  function ensureReady(): Promise<void> {
    ready ??= (async () => {
      try {
        dispatch({ type: "sdk-reconciled", sdk: await installer.reconcile() });
        await adoptOrphan().catch(noop);
        syncIdleTimer();
      } catch {
        ready = null; // try again on the next refresh
      }
    })();
    return ready;
  }

  return {
    snapshot() {
      const on = enabled();
      if (view.enabled !== on) dispatch({ type: "enabled", enabled: on });
      return view;
    },
    watch(fn) {
      watchers.add(fn);
      lastActivity = deps.now();
      syncPoller();
      connectLive();
      return () => {
        watchers.delete(fn);
        lastActivity = deps.now();
        // Nobody left to hold the finger down.
        if (watchers.size === 0) endGesture();
        syncPoller();
      };
    },
    frame: () => (view.device.kind === "running" ? frame : null),
    run,
    pointer,
    async capture(actor) {
      const why = notReady();
      if (why) return { ok: false, error: why };
      try {
        return await enqueue(actor, "screenshot", async () => {
          // With a live stream the view's picture is the stream's; the caller still gets adb's, in the coordinates its taps use.
          if (stopFrames) {
            const f = await device().transport.capture();
            return { ok: true, frame: { ...f, seq: frame?.seq ?? 0 } } as FrameResult;
          }
          await grabFrame();
          return frame ? ({ ok: true, frame } as FrameResult) : ({ ok: false, error: "No frame was captured." } as FrameResult);
        });
      } catch (e) {
        return fail(e) as FrameResult;
      }
    },
    async uiTree(actor) {
      const why = notReady();
      if (why) return { ok: false, error: why };
      try {
        return await enqueue(actor, "snapshot", async () => ({ ok: true, text: formatUi(await device().client.uiDump()) }) as CommandResult);
      } catch (e) {
        return fail(e);
      }
    },
    async logs(actor, tag, lines) {
      const why = notReady();
      if (why) return { ok: false, error: why };
      try {
        return await enqueue(actor, `logs ${tag}`, async () => ({ ok: true, text: (await device().client.logcat(tag, lines)).trim() }) as CommandResult);
      } catch (e) {
        return fail(e);
      }
    },
    install,
    async refresh() {
      await ensureReady();
      await ensureHost();
      return this.snapshot();
    },
    settled: () => installRun,
    async shutdown() {
      watchers.clear();
      if (liveRetry) clearTimeout(liveRetry);
      liveRetry = null;
      dropLive();
      installAbort?.abort();
      stopExpo();
      if (view.device.kind !== "stopped") await stopDevice().catch(noop);
      syncIdleTimer();
    },
  };
}

/* ---- the daemon's emulator ---- */

let instance: Emulator | null = null;

export function emulator(): Emulator {
  if (!instance) {
    const deps = realDeps();
    instance = createEmulator(deps, createInstaller(deps), {
      enabled: () => getSetting("emulator") === "on",
      openLive: (advertised) => openGrpcChannel(EMULATOR_PORT, advertised),
      onAgentAction: (sessionId, action) =>
        void import("../sessions/manager").then(({ getSession }) => {
          const s = getSession(sessionId);
          if (s) Hub.publish({ type: "emulator", sessionId, rootId: s.root_id, action });
        }),
    });
    void instance.refresh().catch(noop);
  }
  return instance;
}

/** Tests put their own emulator in place of the daemon's (and null to forget it). */
export function setEmulator(e: Emulator | null): void {
  instance = e;
}

/** Warms the singleton at daemon start so the first turn already knows whether the emulator is installed. */
export function warmEmulator(): void {
  try {
    emulator();
  } catch {}
}

/** The setting is on and the SDK is installed (as last read from disk, never fetched): the emulator_* tools exist for new turns. */
export function emulatorEnabled(): boolean {
  try {
    return getSetting("emulator") === "on" && emulator().snapshot().sdk.kind === "installed";
  } catch {
    return false;
  }
}

export async function shutdownEmulator(): Promise<void> {
  await instance?.shutdown();
}
