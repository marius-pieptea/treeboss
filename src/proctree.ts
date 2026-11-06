import { spawnSync } from "child_process";
import fs from "fs";

/**
 * `detached` is how POSIX gets a process group to kill as a unit. On Windows Node maps it to
 * DETACHED_PROCESS, which leaves the child with no console, so every console program it then
 * starts (MCP servers, git, sh, node…) opens its own visible window. Windows gets no group, and
 * `killTree` takes the tree down with taskkill instead.
 */
export const DETACH_GROUP = process.platform !== "win32";

/**
 * The signal that asks a tree to stop. Windows has no graceful one for a windowless tree (`taskkill` without
 * /F does nothing), so there it is forced: a stop that sent SIGTERM alone would report success and change nothing.
 */
export const STOP_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGKILL" : "SIGTERM";

/** How to run a shell command line: `/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows (which has no /bin/sh). */
export function shellInvocation(command: string): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform === "win32") return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
  return { file: "/bin/sh", args: ["-c", command], verbatim: false };
}

/** Signal every process of a POSIX process group (its pgid is the leader's pid). Windows has no groups: no-op. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32" || pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch {}
}

/** Whether a POSIX process group still exists. A group with only zombies still counts (see groupProcessCount). Windows: false. */
export function groupAlive(pgid: number): boolean {
  if (process.platform === "win32" || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export interface GroupProcess {
  pid: number;
  ppid: number;
  /** The full command line, as `ps` shows it. */
  args: string;
}

/**
 * The live (not zombie) processes of a POSIX process group. Linux reads /proc (a slim container may have no `ps`);
 * elsewhere `ps` is asked. Null where neither can say.
 */
export function groupProcesses(pgid: number): GroupProcess[] | null {
  if (process.platform === "win32" || pgid <= 1) return null;
  return process.platform === "linux" ? procGroupProcesses(pgid) : psGroupProcesses(pgid);
}

function procGroupProcesses(pgid: number): GroupProcess[] | null {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return null;
  }
  const out: GroupProcess[] = [];
  for (const e of entries) {
    try {
      // /proc/<pid>/stat: "pid (comm) state ppid pgrp …"; comm may hold spaces and parentheses, so parse after the last ")".
      const stat = fs.readFileSync(`/proc/${e}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== pgid || fields[0].startsWith("Z")) continue;
      const args = fs.readFileSync(`/proc/${e}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      out.push({ pid: Number(e), ppid: Number(fields[1]), args });
    } catch {
      // Gone between the listing and the read: not a member any more.
    }
  }
  return out;
}

function psGroupProcesses(pgid: number): GroupProcess[] | null {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,args="], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
  const out: GroupProcess[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (m && Number(m[3]) === pgid && !m[4].startsWith("Z")) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[5] });
  }
  return out;
}

/**
 * How many live (not zombie) processes a POSIX process group holds. Where `ps` cannot say, a live group counts as
 * one process, so a leftover is never mistaken for an empty group.
 */
export function groupProcessCount(pgid: number): number {
  if (!groupAlive(pgid)) return 0;
  return groupProcesses(pgid)?.length ?? 1;
}

/** Signal a spawned child and everything it started. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", ...(signal === "SIGTERM" ? [] : ["/F"])], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}
