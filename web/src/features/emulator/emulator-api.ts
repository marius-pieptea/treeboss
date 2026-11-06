/**
 * Data for the emulator view: the daemon's one Android device, its live frame, and the operator's controls.
 *
 * The types mirror src/emulator/types.ts (the web cannot import src/). The daemon pushes the whole EmulatorView
 * whenever anything changed; the picture is fetched on demand, one at a time, whenever `device.seq` moves.
 */
import { liveSource } from "@/lib/live";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, post } from "@/lib/api";
import { shouldFetchFrame, type FrameGate } from "../browser/agent-logic";
import { queueLive, type LiveItem } from "./emulator-logic";

/** The fastest the picture is refetched: about 30 a second, which is what the emulator's stream delivers while things move. */
const FRAME_GAP_MS = 33;

export type HostOs = "windows" | "macosx" | "linux";
export type Abi = "x86_64" | "arm64-v8a";
export type Actor = { kind: "you" } | { kind: "agent"; sessionId: string };

export interface HostProbe {
  os: HostOs;
  arch: "x64" | "aarch64";
  abi: Abi;
  accel: { state: "ok"; kind: "whpx" | "aehd" | "hvf" | "kvm" } | { state: "missing"; reason: string; fix: string } | { state: "unchecked" };
  diskFreeBytes: number;
  needBytes: number;
  existingSdk: string | null;
}

export type SdkPath = string;
export interface License {
  id: string;
  text: string;
  hash: string;
}
export interface PackageArchive {
  path: SdkPath;
  revision: string;
  url: string;
  sha1: string;
  size: number;
  licenseId: string;
  destDir: string;
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
  | { kind: "resolving" }
  | { kind: "needs-license"; plan: InstallPlan }
  | { kind: "installing"; plan: InstallPlan; step: InstallStep; doneBytes: number; totalBytes: number }
  | { kind: "installed"; root: string; owned: boolean; avd: AvdSpec }
  | { kind: "removing" }
  | { kind: "failed"; reason: string; retryable: boolean };

export type DeviceState =
  | { kind: "stopped" }
  | { kind: "booting"; serial: string; since: number }
  // live: the emulator's gRPC channel carries this view (frames pushed, the finger sent as it moves); false means adb
  | { kind: "running"; serial: string; screen: { width: number; height: number }; rotation: 0 | 1 | 2 | 3; seq: number; live: boolean }
  | { kind: "stopping"; serial: string }
  | { kind: "failed"; reason: string; logTail: string };

export type MetroState = { kind: "off" } | { kind: "starting"; cwd: string } | { kind: "running"; cwd: string; port: number } | { kind: "failed"; reason: string; logTail: string };
export interface Job {
  id: string;
  kind: "install_apk" | "run_expo";
  actor: Actor;
  since: number;
  state: "running" | "done" | "failed";
  detail: string;
}

export interface EmulatorState {
  enabled: boolean;
  host: HostProbe;
  sdk: SdkState;
  device: DeviceState;
  metro: MetroState;
  jobs: Job[];
  lastActor: { actor: Actor; at: number } | null;
}

/** Same list, same order as the server's EMULATOR_KEYS: tests/web/emulator-views.test.ts holds both to it. */
export const EMULATOR_KEYS = ["back", "home", "recents", "enter", "delete", "tab", "escape", "power", "volume_up", "volume_down", "menu", "dpad_up", "dpad_down", "dpad_left", "dpad_right"] as const;
export type EmulatorKey = (typeof EMULATOR_KEYS)[number];

export type EmulatorInput =
  | { kind: "tap"; x: number; y: number }
  | { kind: "long_press"; x: number; y: number; ms?: number }
  | { kind: "swipe"; x1: number; y1: number; x2: number; y2: number; ms?: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: EmulatorKey }
  | { kind: "rotate"; to: "portrait" | "landscape" };

export type CommandResult = { ok: true; text: string } | { ok: false; error: string };

export const emulatorKeys = { state: ["emulator", "state"] as const };

/** Start Expo's Metro on the emulator for a workspace's app. Not a hook: the mobile panel calls it from a click. */
export function runExpoOnEmulator(workspaceId: string): Promise<CommandResult> {
  return post<CommandResult>("/api/emulator/run-expo", { workspaceId });
}

export function useEmulator() {
  const qc = useQueryClient();
  const stateQ = useQuery({ queryKey: emulatorKeys.state, queryFn: () => get<EmulatorState>("/api/emulator/state") });
  const state = stateQ.data ?? null;
  const setState = useCallback((v: EmulatorState) => qc.setQueryData(emulatorKeys.state, v), [qc]);

  // The daemon's event stream: the authoritative state, pushed. When it refuses (a remote device) the query stays as it is.
  useEffect(() => {
    const es = liveSource("/api/emulator/stream");
    es.addEventListener("state", (e) => setState(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => es.close();
    return () => es.close();
  }, [setState]);

  // The picture. Object URLs from the screenshot endpoint, replaced as newer frames arrive.
  const running = state?.device.kind === "running";
  const seqNow = state?.device.kind === "running" ? state.device.seq : 0;
  const [frame, setFrame] = useState<{ url: string; seq: number } | null>(null);
  const gate = useRef<FrameGate>({ shown: -1, inFlight: false, lastFetchAt: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(0);
  latest.current = seqNow;

  const pump = useCallback(() => {
    const verdict = shouldFetchFrame(gate.current, latest.current, Date.now(), FRAME_GAP_MS);
    if (verdict === "no") return;
    if (verdict === "later") {
      if (!timer.current) timer.current = setTimeout(() => { timer.current = null; pump(); }, FRAME_GAP_MS);
      return;
    }
    const seq = latest.current;
    gate.current = { ...gate.current, inFlight: true, lastFetchAt: Date.now() };
    void fetch(`/api/emulator/screenshot?seq=${seq}`, { credentials: "same-origin" })
      .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
      .then((url) => {
        gate.current = { ...gate.current, inFlight: false, shown: seq };
        if (url)
          setFrame((old) => {
            if (old) setTimeout(() => URL.revokeObjectURL(old.url), 1000);
            return { url, seq };
          });
        // Something newer may have arrived while this one was in flight.
        pump();
      })
      .catch(() => {
        gate.current = { ...gate.current, inFlight: false };
      });
  }, []);

  useEffect(() => {
    if (running) pump();
  }, [running, seqNow, pump]);

  // A stopped device has no picture; the next boot starts the sequence over.
  useEffect(() => {
    if (running) return;
    gate.current = { shown: -1, inFlight: false, lastFetchAt: 0 };
    setFrame(null);
  }, [running]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  const fail = (e: unknown) => toast.error((e as Error).message);
  /** The routes that answer with the new state: take it at once instead of waiting for the stream. */
  const act = useCallback(
    async (path: string, body?: unknown) => {
      try {
        setState(await post<EmulatorState>(path, body));
      } catch (e) {
        fail(e);
      }
    },
    [setState],
  );
  /** The routes that answer with a CommandResult: a refusal or a failure is told to the operator. */
  const command = useCallback(
    async (path: string, body?: unknown) => {
      try {
        const r = await post<CommandResult>(path, body);
        if (!r.ok) toast.error(r.error);
        void qc.invalidateQueries({ queryKey: emulatorKeys.state });
      } catch (e) {
        fail(e);
      }
    },
    [qc],
  );

  // Live input: one request at a time, so nothing overtakes; what piles up meanwhile is folded (moves to the latest, text joined).
  const liveQueue = useRef<LiveItem[]>([]);
  const liveBusy = useRef(false);
  const live = useCallback((item: LiveItem) => {
    liveQueue.current = queueLive(liveQueue.current, item);
    if (liveBusy.current) return;
    liveBusy.current = true;
    void (async () => {
      try {
        for (let next = liveQueue.current.shift(); next; next = liveQueue.current.shift()) {
          const req = next.kind === "pointer" ? post<CommandResult>("/api/emulator/pointer", { x: next.x, y: next.y, down: next.phase !== "up" }) : post<CommandResult>("/api/emulator/input", next.input);
          const r = await req.catch((e: Error): CommandResult => ({ ok: false, error: e.message }));
          if (!r.ok) {
            // The rest of a refused gesture means nothing: drop it, and say why once.
            liveQueue.current = [];
            toast.error(r.error, { id: "emulator-live" });
          }
        }
      } finally {
        liveBusy.current = false;
      }
    })();
  }, []);

  return {
    state,
    frame,
    loading: stateQ.isLoading,
    error: stateQ.isError ? (stateQ.error as Error).message : null,
    /** The finger, keys and text on the live view (`device.live`), sent as they happen. */
    live,
    send: useCallback((input: EmulatorInput) => command("/api/emulator/input", input), [command]),
    install: useCallback(() => act("/api/emulator/install", { op: "plan" }), [act]),
    cancel: useCallback(() => act("/api/emulator/install", { op: "cancel" }), [act]),
    retry: useCallback(() => act("/api/emulator/install", { op: "retry" }), [act]),
    accept: useCallback((licenses: string[]) => act("/api/emulator/license", { accept: licenses }), [act]),
    remove: useCallback(() => act("/api/emulator/remove"), [act]),
    boot: useCallback(() => command("/api/emulator/boot"), [command]),
    shutdown: useCallback(() => command("/api/emulator/shutdown"), [command]),
    stopExpo: useCallback(() => command("/api/emulator/stop-expo"), [command]),
  };
}
