/**
 * Dev servers listening on this machine, for the browser panel's "what is running?" list. Uses `lsof`
 * (present on macOS and most Linux; netstat/tasklist on Windows); where unavailable the list is simply empty.
 */
import { runCmd } from "../git/run";
import { terminalRoots } from "./pty";

export interface ListeningPort {
  port: number;
  pid: number;
  command: string;
  cwd: string | null;
  address: string;
}

/** Windows has no lsof: netstat gives port + pid, tasklist gives the process name. No working directory. */
async function listeningPortsWindows(): Promise<ListeningPort[]> {
  const n = await runCmd("netstat", ["-ano", "-p", "tcp"], { cwd: process.cwd(), timeoutMs: 8000 });
  if (n.code !== 0) return [];
  const out: ListeningPort[] = [];
  for (const line of n.stdout.toString().split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const address = m[1];
    if (!["127.0.0.1", "0.0.0.0", "[::1]", "[::]"].includes(address)) continue;
    const port = Number(m[2]);
    const pid = Number(m[3]);
    if (!pid || out.some((p) => p.port === port && p.pid === pid)) continue;
    out.push({ port, pid, command: "", cwd: null, address: address === "0.0.0.0" || address === "[::]" ? "*" : address });
  }
  if (out.length) {
    const t = await runCmd("tasklist", ["/FO", "CSV", "/NH"], { cwd: process.cwd(), timeoutMs: 8000 });
    const names = new Map<number, string>();
    for (const line of t.stdout.toString().split(/\r?\n/)) {
      const m = /^"([^"]*)","(\d+)"/.exec(line);
      if (m) names.set(Number(m[2]), m[1].replace(/\.exe$/i, ""));
    }
    for (const p of out) p.command = names.get(p.pid) ?? "";
    // No lsof-style cwd on Windows: a server started from one of our terminals belongs to that terminal's directory.
    const roots = terminalRoots();
    if (roots.length) {
      const ps = await runCmd("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }"], { cwd: process.cwd(), timeoutMs: 10000 });
      const parent = new Map<number, number>();
      for (const line of ps.stdout.toString().split(/\r?\n/)) {
        const m = /^(\d+),(\d+)/.exec(line.trim());
        if (m) parent.set(Number(m[1]), Number(m[2]));
      }
      const rootOf = new Map(roots.map((r) => [r.pid, r.cwd]));
      for (const p of out) {
        let cur: number | undefined = p.pid;
        for (let hops = 0; cur && hops < 32; hops++) {
          const hit = rootOf.get(cur);
          if (hit) {
            p.cwd = hit;
            break;
          }
          cur = parent.get(cur);
        }
      }
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

export async function listeningPorts(): Promise<ListeningPort[]> {
  if (process.platform === "win32") return listeningPortsWindows();
  if (!Bun.which("lsof")) return [];
  const r = await runCmd("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { cwd: "/", timeoutMs: 8000 });
  if (r.code > 1) return [];
  const out: ListeningPort[] = [];
  let pid = 0;
  let command = "";
  for (const line of r.stdout.toString().split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n")) {
      const m = /^(.*):(\d+)$/.exec(line.slice(1));
      if (!m) continue;
      const address = m[1];
      // Only what a local browser can reach: loopback or all interfaces.
      if (!["127.0.0.1", "*", "[::1]", "[::]", "localhost"].includes(address)) continue;
      const port = Number(m[2]);
      if (!out.some((p) => p.port === port && p.pid === pid)) out.push({ port, pid, command, cwd: null, address });
    }
  }
  // Working directories, in one call, so the list can say which project a server belongs to.
  if (out.length) {
    const pids = [...new Set(out.map((p) => p.pid))].join(",");
    const c = await runCmd("lsof", ["-a", "-p", pids, "-d", "cwd", "-Fpn"], { cwd: "/", timeoutMs: 8000 });
    let cur = 0;
    const cwds = new Map<number, string>();
    for (const line of c.stdout.toString().split("\n")) {
      if (line.startsWith("p")) cur = Number(line.slice(1));
      else if (line.startsWith("n") && cur) cwds.set(cur, line.slice(1));
    }
    for (const p of out) p.cwd = cwds.get(p.pid) ?? null;
  }
  return out.sort((a, b) => a.port - b.port);
}
