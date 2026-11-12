/**
 * Dev servers (and one-off database tasks) the daemon runs for a project directory.
 *
 * Safety rules, on purpose:
 *  - a process is spawned in its own process group and only that group (by the pid we got back) is ever
 *    signalled: nothing is found or killed by port or by name;
 *  - everything still running is stopped when the daemon goes down;
 *  - output is kept in a bounded buffer; env values are never logged by trb (the child inherits the
 *    daemon's environment minus trb's own secrets, and reads its own .env files itself);
 *  - the workspace's "dev" secrets are handed to the child under the daemon's environment: the process env wins.
 */
import fs from "fs";
import net from "net";
import { DETACH_GROUP, STOP_SIGNAL, killTree, shellInvocation } from "../proctree";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import { Hub } from "../sessions/hub";
import { resolveEnv } from "../secrets/store";
import { cargoEnv, cargoLimits } from "../git/cargotarget";
import { owningWorkspace } from "../workspaces";
import { detect, type PackageManager, type RunService } from "./detect";
import { pickPort, portArgs, portFromOutput, withPortArgs } from "./ports";

const MAX_LINES = 2000;
const MAX_LINE = 2000;
const MAX_INSTANCES = 16;
const READY_POLL_MS = 400;
const READY_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 4000;

export type RunStatus = "starting" | "running" | "stopping" | "stopped" | "exited" | "failed";

export interface LogLine {
  seq: number;
  stream: "out" | "err" | "sys";
  text: string;
}

export interface InstanceView {
  key: string;
  service: string;
  kind: "dev" | "task";
  command: string;
  status: RunStatus;
  pid: number | null;
  port: number | null;
  url: string | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  owner: string;
}

interface Instance extends InstanceView {
  dir: string;
  lines: LogLine[];
  nextSeq: number;
  child: ChildProcess | null;
  partial: { out: string; err: string };
  poll: ReturnType<typeof setInterval> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}

const instances = new Map<string, Instance>();

export const instanceKey = (dir: string, service: string) => `${dir}::${service}`;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

function view(i: Instance): InstanceView {
  const { key, service, kind, command, status, pid, port, url, exitCode, startedAt, endedAt, owner } = i;
  return { key, service, kind, command, status, pid, port, url, exitCode, startedAt, endedAt, owner };
}

function push(i: Instance, stream: LogLine["stream"], text: string): void {
  i.lines.push({ seq: i.nextSeq++, stream, text: text.length > MAX_LINE ? text.slice(0, MAX_LINE) + "…" : text });
  if (i.lines.length > MAX_LINES) i.lines.splice(0, i.lines.length - MAX_LINES);
}

function feed(i: Instance, stream: "out" | "err", chunk: string): void {
  const buf = i.partial[stream] + stripAnsi(chunk).replace(/\r(?!\n)/g, "\n");
  const parts = buf.split(/\r?\n/);
  i.partial[stream] = parts.pop() ?? "";
  for (const line of parts) {
    if (!line.trim()) continue;
    push(i, stream, line);
    if (i.kind === "dev") learnPort(i, line);
  }
  if (i.partial[stream].length > MAX_LINE) {
    push(i, stream, i.partial[stream]);
    i.partial[stream] = "";
  }
}

/** The server said where it listens: believe it over the port we asked for. */
function learnPort(i: Instance, line: string): void {
  const p = portFromOutput(line);
  if (p && p !== i.port && i.status !== "running") {
    i.port = p;
    i.url = `http://localhost:${p}`;
    push(i, "sys", `Server announced port ${p}.`);
  }
}

function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => {
      // Some servers listen on ::1 only.
      const t = net.connect({ port, host: "::1" });
      t.setTimeout(500, () => (t.destroy(), resolve(false)));
      t.once("connect", () => (t.destroy(), resolve(true)));
      t.once("error", () => resolve(false));
    });
  });
}

function signalGroup(i: Instance, sig: NodeJS.Signals): void {
  const pid = i.pid;
  if (!pid || !i.child) return;
  killTree(pid, sig);
}

function clearTimers(i: Instance): void {
  if (i.poll) clearInterval(i.poll);
  if (i.killTimer) clearTimeout(i.killTimer);
  i.poll = null;
  i.killTimer = null;
}

const SECRET_ENV = ["TRB_TOKEN"];

/** The workspace's dev-environment secrets, read in the daemon. Empty when the folder is in no workspace and none was named. */
function devSecrets(rootDir: string, workspaceId?: string): Record<string, string> {
  const ws = workspaceId ?? owningWorkspace(rootDir);
  if (!ws) return {};
  try {
    return resolveEnv(ws, "dev");
  } catch (e) {
    throw new RunError(`Could not read the dev secrets: ${(e as Error).message}`);
  }
}

/** The child's environment. Exported for tests: the merge rule is checked without spawning anything. */
export function childEnv(port: number | null, extra: Record<string, string> = {}, secrets: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) if (!SECRET_ENV.includes(k)) env[k] = v;
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && !SECRET_ENV.includes(k)) env[k] = v;
  if (port) env.PORT = String(port);
  env.BROWSER = "none";
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  return { ...env, ...extra };
}

export interface StartInput {
  /** Real directory of the root (a workspace or a session's working copy). */
  rootDir: string;
  /** Root ref (w_… or s_…): who owns it, so closing a session stops its servers. */
  owner: string;
  service: string;
  /** The workspace whose secrets to inject, for a root outside its folder (a session worktree). Falls back to the folder match. */
  workspaceId?: string;
}

export class RunError extends Error {}

function findService(rootDir: string, id: string): { svc: RunService; pm: PackageManager | null } {
  const d = detect(rootDir);
  const svc = [...d.services, ...d.db].find((s) => s.id === id);
  if (!svc) throw new RunError(`No runnable "${id}" found in ${rootDir}.`);
  return { svc, pm: d.packageManager };
}

export function listInstances(rootDir: string): InstanceView[] {
  return [...instances.values()].filter((i) => i.dir === rootDir).map(view);
}

export function getInstance(rootDir: string, service: string): InstanceView | null {
  const i = instances.get(instanceKey(rootDir, service));
  return i ? view(i) : null;
}

export function readLogs(rootDir: string, service: string, since = 0, limit = 400): { lines: LogLine[]; next: number; instance: InstanceView | null } {
  const i = instances.get(instanceKey(rootDir, service));
  if (!i) return { lines: [], next: since, instance: null };
  const lines = i.lines.filter((l) => l.seq >= since).slice(-limit);
  return { lines, next: i.nextSeq, instance: view(i) };
}

/** The first live dev server of a directory, for the preview to point at and for the agent's tool. */
export function runningDev(rootDir: string): InstanceView | null {
  const live = [...instances.values()].filter((i) => i.dir === rootDir && i.kind === "dev" && (i.status === "running" || i.status === "starting"));
  live.sort((a, b) => (a.status === b.status ? b.startedAt - a.startedAt : a.status === "running" ? -1 : 1));
  return live[0] ? view(live[0]) : null;
}

export async function startService(input: StartInput): Promise<InstanceView> {
  const rootDir = fs.realpathSync(input.rootDir);
  const key = instanceKey(rootDir, input.service);
  const existing = instances.get(key);
  if (existing && (existing.status === "starting" || existing.status === "running" || existing.status === "stopping")) {
    if (existing.status === "stopping") throw new RunError("It is still stopping. Try again in a moment.");
    return view(existing);
  }
  if ([...instances.values()].filter((i) => i.child).length >= MAX_INSTANCES) throw new RunError(`Too many processes running (${MAX_INSTANCES}). Stop some first.`);

  const { svc, pm } = findService(rootDir, input.service);
  const cwd = path.join(rootDir, svc.dir);
  if (!fs.existsSync(cwd)) throw new RunError(`${svc.dir} does not exist.`);
  // Read before the instance is registered, so a failure here leaves nothing stuck in "starting".
  const secrets = devSecrets(rootDir, input.workspaceId);

  let port: number | null = null;
  let command = svc.command;
  if (svc.kind === "dev") {
    const takenByUs = [...instances.values()].filter((i) => i.child && i.port).map((i) => i.port as number);
    port = await pickPort(key, takenByUs);
    command = withPortArgs(command, svc.source === "package.json" ? pm : null, portArgs(svc.script, port));
  }

  const inst: Instance = {
    key,
    dir: rootDir,
    service: input.service,
    kind: svc.kind,
    command,
    status: "starting",
    pid: null,
    port,
    url: port ? `http://localhost:${port}` : null,
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    owner: input.owner,
    lines: existing ? existing.lines : [],
    nextSeq: existing ? existing.nextSeq : 1,
    child: null,
    partial: { out: "", err: "" },
    poll: null,
    killTimer: null,
  };
  instances.set(key, inst);
  push(inst, "sys", `$ ${command}${port ? `   (PORT=${port})` : ""}`);

  const sh = shellInvocation(command);
  const env = childEnv(port, {}, secrets);
  Object.assign(env, cargoEnv(cwd, env, cargoLimits(), { agent: false }));
  const child = spawn(sh.file, sh.args, { cwd, env: env as NodeJS.ProcessEnv, detached: DETACH_GROUP, windowsHide: true, windowsVerbatimArguments: sh.verbatim, stdio: ["ignore", "pipe", "pipe"] });
  inst.child = child;
  inst.pid = child.pid ?? null;
  child.stdout?.on("data", (d: Buffer) => feed(inst, "out", d.toString("utf-8")));
  child.stderr?.on("data", (d: Buffer) => feed(inst, "err", d.toString("utf-8")));
  child.once("error", (err) => {
    clearTimers(inst);
    inst.status = "failed";
    inst.endedAt = Date.now();
    inst.child = null;
    push(inst, "sys", `Could not start: ${err.message}`);
  });
  child.once("exit", (code, signal) => {
    clearTimers(inst);
    for (const s of ["out", "err"] as const) if (inst.partial[s].trim()) push(inst, s, inst.partial[s]);
    inst.partial = { out: "", err: "" };
    const requested = inst.status === "stopping";
    inst.exitCode = code;
    inst.endedAt = Date.now();
    inst.child = null;
    inst.status = requested ? "stopped" : code === 0 && inst.kind === "task" ? "exited" : code === 0 ? "exited" : "failed";
    push(inst, "sys", requested ? "Stopped." : signal ? `Ended by ${signal}.` : `Exited with code ${code}.`);
  });

  if (inst.kind === "dev") {
    const started = Date.now();
    inst.poll = setInterval(() => {
      void (async () => {
        if (inst.status !== "starting") return;
        if (inst.port && (await tryConnect(inst.port))) {
          inst.status = "running";
          push(inst, "sys", `Listening on ${inst.url}`);
          if (inst.poll) clearInterval(inst.poll);
          inst.poll = null;
        } else if (Date.now() - started > READY_TIMEOUT_MS) {
          push(inst, "sys", "Still not listening after 90s; leaving it running.");
          if (inst.poll) clearInterval(inst.poll);
          inst.poll = null;
        }
      })();
    }, READY_POLL_MS);
    inst.poll.unref?.();
  } else {
    inst.status = "running";
  }
  return view(inst);
}

export function stopService(rootDir: string, service: string): InstanceView | null {
  let real = rootDir;
  try {
    real = fs.realpathSync(rootDir);
  } catch {}
  const i = instances.get(instanceKey(real, service));
  if (!i) return null;
  if (!i.child) return view(i);
  if (i.status !== "stopping") {
    i.status = "stopping";
    push(i, "sys", "Stopping…");
    signalGroup(i, STOP_SIGNAL);
    i.killTimer = setTimeout(() => signalGroup(i, "SIGKILL"), KILL_GRACE_MS);
    i.killTimer.unref?.();
  }
  return view(i);
}

export async function restartService(input: StartInput): Promise<InstanceView> {
  const rootDir = fs.realpathSync(input.rootDir);
  const i = instances.get(instanceKey(rootDir, input.service));
  if (i?.child) {
    stopService(rootDir, input.service);
    const deadline = Date.now() + KILL_GRACE_MS + 3000;
    while (i.child && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (i.child) throw new RunError("The process did not stop in time.");
  }
  return startService(input);
}

/** Stop everything a root owns (a closed head's worktree is about to go). */
export function stopOwnedBy(owner: string): number {
  let n = 0;
  for (const i of instances.values()) {
    if (i.owner === owner && i.child) {
      stopService(i.dir, i.service);
      n++;
    }
  }
  return n;
}

/** Daemon shutdown: end every group we started. Waits briefly, then forces. */
export async function stopAllRuns(): Promise<void> {
  const live = [...instances.values()].filter((i) => i.child);
  for (const i of live) {
    i.status = "stopping";
    signalGroup(i, STOP_SIGNAL);
  }
  const deadline = Date.now() + 2000;
  while (live.some((i) => i.child) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  for (const i of live) if (i.child) signalGroup(i, "SIGKILL");
}

let hooked = false;
/** Called once by the routes: closing a session stops what it was running; a hard exit does not leave orphans. */
export function installRunHooks(): void {
  if (hooked) return;
  hooked = true;
  Hub.subscribe((e) => {
    if (e.type === "state" && e.status === "closed") stopOwnedBy(e.sessionId);
  });
  process.on("exit", () => {
    for (const i of instances.values()) if (i.child) signalGroup(i, "SIGKILL");
  });
}

/** Tests only. */
export function _resetRuns(): void {
  for (const i of instances.values()) {
    clearTimers(i);
    if (i.child) signalGroup(i, "SIGKILL");
  }
  instances.clear();
}
