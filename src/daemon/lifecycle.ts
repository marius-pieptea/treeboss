/**
 * Starting, finding and stopping the daemon. Shared by the CLI (client side) and `trb daemon run`
 * (server side). State lives in two files under trb's home:
 *   token        the bearer secret (0600), created on first use
 *   daemon.json  { pid, port, url, startedAt }: written by the running daemon, removed on exit
 */
import fs from "fs";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import path from "path";
import { paths } from "../paths";
import { getSetting } from "../settings";
import { selfInvocation } from "../self";
import { sleep } from "../util";
import { startServer, VERSION } from "./server";
import { setDaemonContext } from "../sessions/context";
import { interruptAll, recoverOnStartup, startReaper, stopReaper } from "../sessions/manager";
import { startSweepDriver, stopSweepDriver } from "../lab/sweeps";
import { startQaDriver, stopQaDriver } from "../qa/sessions";
import { startAutopilot, stopAutopilot } from "../autopilot/runner";
import { startScheduler, stopScheduler } from "../autopilot/schedule";
import { startMobilePoller } from "../mobile/store";
import { stopAllExpoPreviews } from "../mobile/preview";
import { setEnvProvider as setDeployEnvProvider } from "../deploy/store";
import { setEnvProvider as setMobileEnvProvider } from "../mobile/eas";
import { resolveEnv } from "../secrets/store";
import { db } from "../db";
import { seedBuiltinAgents } from "../agents/builtin";
import { seedBuiltinSkills } from "../skills/builtin";
import { sweepStaleRuns } from "../skills/scaffold";
import { shutdownBrowsers } from "../browser/manager";
import { shutdownEmulator, warmEmulator } from "../emulator/emulator";
import { stopAllCodegraphJobs } from "../codegraph/jobs";
import { stopAllRuns } from "../devserver/manager";
import { stopProxies } from "../preview/proxy";

export interface DaemonInfo {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  version: string;
}

export function ensureToken(): string {
  const file = paths.token();
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing) return existing;
  } catch {}
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

export function readInfo(): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(paths.info(), "utf-8")) as DaemonInfo;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** The running daemon, verified: the pid is alive AND it answers /api/health. A stale file is cleaned up. */
export async function liveDaemon(): Promise<DaemonInfo | null> {
  const info = readInfo();
  if (!info) return null;
  if (!pidAlive(info.pid)) {
    fs.rmSync(paths.info(), { force: true });
    return null;
  }
  try {
    const res = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return info;
  } catch {}
  return null;
}

/** Start the daemon in the background and wait until it answers. Returns the already-running one if there is one. */
export async function startDetached(): Promise<DaemonInfo> {
  const running = await liveDaemon();
  if (running) return running;
  ensureToken();
  const self = selfInvocation();
  const log = fs.openSync(paths.daemonLog(), "a");
  const child = spawn(self.command, [...self.args, "daemon", "run"], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: { ...process.env },
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(120);
    const info = await liveDaemon();
    if (info) return info;
    if (child.exitCode !== null) break;
  }
  throw new Error(`The daemon did not start. See ${paths.daemonLog()}.`);
}

export async function stopDaemon(): Promise<{ stopped: boolean; pid?: number }> {
  const info = await liveDaemon();
  if (!info) return { stopped: false };
  try {
    await fetch(`${info.url}/api/shutdown`, { method: "POST", headers: { authorization: `Bearer ${ensureToken()}` }, signal: AbortSignal.timeout(3000) });
  } catch {}
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pidAlive(info.pid)) await sleep(100);
  if (pidAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {}
    await sleep(1000);
    if (pidAlive(info.pid)) {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {}
    }
  }
  fs.rmSync(paths.info(), { force: true });
  return { stopped: true, pid: info.pid };
}

/** The daemon process: `trb daemon run`. Runs until SIGINT/SIGTERM or /api/shutdown. */
export async function runDaemon(opts: { port?: number } = {}): Promise<void> {
  if (await liveDaemon()) {
    console.error(`[trb] a daemon is already running (${readInfo()?.url}).`);
    process.exit(1);
  }
  db(); // migrate before serving
  try {
    const added = seedBuiltinSkills();
    if (added.length) console.log(`[trb] added built-in skills: ${added.join(", ")}`);
  } catch (err: any) {
    console.error(`[trb] could not seed the built-in skills: ${err?.message ?? err}`);
  }
  try {
    // After the skills: an agent names the skills it may use, and a built-in agent names only those that exist.
    const added = seedBuiltinAgents();
    if (added.length) console.log(`[trb] added built-in agents: ${added.join(", ")}`);
  } catch (err: any) {
    console.error(`[trb] could not seed the built-in agents: ${err?.message ?? err}`);
  }
  try {
    // Skill copies a killed daemon left in workspaces.
    const stranded = sweepStaleRuns();
    if (stranded) console.log(`[trb] removed ${stranded} skill folder(s) left in workspaces by an earlier run`);
  } catch {}
  const token = ensureToken();
  // A daemon on a throwaway home (tests, harnesses) must never take the real daemon's port: the
  // browser's cookie for that origin would hit a daemon holding a different token and read as signed out.
  const isolated = !!process.env.TRB_HOME && process.env.TRB_PORT === undefined;
  const wanted = opts.port ?? (process.env.TRB_PORT !== undefined ? Number(process.env.TRB_PORT) : isolated ? 0 : (getSetting("port") as number));

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[trb] shutting down: interrupting live turns…");
    stopReaper();
    stopSweepDriver();
    stopQaDriver();
    stopAutopilot();
    stopScheduler();
    stopMobilePoller();
    stopAllExpoPreviews();
    await interruptAll();
    await stopAllCodegraphJobs().catch(() => {});
    await shutdownBrowsers().catch(() => {});
    await shutdownEmulator().catch(() => {});
    await stopAllRuns().catch(() => {});
    stopProxies();
    try {
      handle.stop();
    } catch {}
    fs.rmSync(paths.info(), { force: true });
    fs.rmSync(paths.pid(), { force: true });
    process.exit(0);
  };

  // The daemon itself always listens on loopback. remote_mode lan/tailscale adds a second listener on one
  // specific address, started and stopped live by startServer (remote/listener.ts).

  let handle: ReturnType<typeof startServer>;
  try {
    handle = startServer({ port: wanted, token, onShutdown: shutdown });
  } catch (err: any) {
    // The configured port is taken (not by an trb daemon: we checked). Take any free one: every
    // client reads the real port from daemon.json, and each turn's MCP shim gets the URL passed in.
    console.warn(`[trb] port ${wanted} unavailable (${err?.code ?? err?.message}); using a free port.`);
    handle = startServer({ port: 0, token, onShutdown: shutdown });
  }

  setDaemonContext({ url: handle.url, token });
  warmEmulator();
  // Deploys and mobile builds read the workspace's production secrets (EXPO_TOKEN, deploy keys) from the secrets module.
  setDeployEnvProvider((ws, env) => resolveEnv(ws, env));
  setMobileEnvProvider((ws) => resolveEnv(ws, "prod"));
  const recovered = recoverOnStartup();
  startReaper();
  startSweepDriver();
  startQaDriver();
  startAutopilot();
  startScheduler();
  const stopMobilePoller = startMobilePoller();

  const info: DaemonInfo = { pid: process.pid, port: handle.port, url: handle.url, startedAt: new Date().toISOString(), version: VERSION };
  fs.writeFileSync(paths.info(), JSON.stringify(info, null, 2));
  fs.writeFileSync(paths.pid(), String(process.pid));
  console.log(`[trb] daemon ${VERSION} listening on ${handle.url} (pid ${process.pid}, home ${path.dirname(paths.db())})`);
  if (recovered.interrupted || recovered.swept) console.log(`[trb] recovered: ${recovered.interrupted} interrupted session(s), ${recovered.swept} stale worktree(s) swept.`);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The app that started this daemon owns it. When that process is gone (quit, crash, an installer closing it),
  // stop too: a daemon left behind keeps trb.exe locked and its turns running.
  const owner = Number(process.env.TRB_OWNER_PID);
  if (Number.isInteger(owner) && owner > 0 && owner !== process.pid) {
    const watch = setInterval(() => {
      if (!pidAlive(owner)) void shutdown();
    }, 2000);
    watch.unref();
  }
}
