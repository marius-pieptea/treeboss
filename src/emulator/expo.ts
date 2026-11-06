/**
 * Metro for the emulator: `adb reverse` so the device reaches the daemon-side bundler on localhost, then
 * `npx expo start --android --localhost` in its own process group. Expo CLI installs the Expo Go build that
 * matches the project's SDK and opens the app; we only learn from its output when Metro is up.
 */
import type { AdbClient } from "./adb";
import { SERIAL } from "./adb";
import type { Deps } from "./deps";
import type { MetroState } from "./types";

const METRO_PORT = 8081;
const TAIL_LINES = 40;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// Lines Expo prints once the bundler is listening.
const READY = /waiting on|logs for your project|metro waiting|bundled \d+ms|bundling complete/i;
const PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/;

export interface ExpoHandle {
  stop(): Promise<void>;
}

/** Starts Metro for `cwd`. `onState` hears starting, then running or failed, then off when it was stopped. */
export function startExpo(deps: Deps, adb: AdbClient, root: string, cwd: string, onState: (s: MetroState) => void): ExpoHandle {
  let stopping = false;
  let running = false;
  let failed = false;
  let child: ReturnType<Deps["exec"]["spawn"]> | null = null;
  const tail: string[] = [];
  const fail = (reason: string) => {
    if (failed || stopping) return;
    failed = true;
    onState({ kind: "failed", reason, logTail: tail.join("\n") });
  };

  onState({ kind: "starting", cwd });
  void (async () => {
    try {
      await adb.reverse(METRO_PORT);
    } catch (e: any) {
      return fail(`adb reverse tcp:${METRO_PORT} failed: ${String(e?.message ?? e)}`);
    }
    if (stopping) return;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, { ANDROID_HOME: root, ANDROID_SDK_ROOT: root, ANDROID_SERIAL: adb.serial || SERIAL, CI: "1" });
    try {
      child = deps.exec.spawn([Bun.which("npx") ?? "npx", "--yes", "expo", "start", "--android", "--localhost"], { env, cwd });
    } catch (e: any) {
      return fail(`expo start could not start: ${String(e?.message ?? e)}`);
    }
    child.onLine((raw) => {
      const line = raw.replace(ANSI, "").trimEnd();
      if (!line) return;
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
      if (!running && !failed && READY.test(line)) {
        running = true;
        onState({ kind: "running", cwd, port: Number(PORT.exec(line)?.[1]) || METRO_PORT });
      }
    });
    void child.exited.then((code) => fail(running ? `Metro exited (code ${code}).` : `expo start exited before Metro was ready (code ${code}).`));
  })();

  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      await child?.stop();
      onState({ kind: "off" });
    },
  };
}
