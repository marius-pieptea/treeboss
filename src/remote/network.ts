/**
 * Where a phone can reach this computer: the LAN address, or the Tailscale address and MagicDNS name.
 * Detection only. Nothing here listens on anything.
 *
 * Test seams (never needed in normal use):
 *  - TRB_REMOTE_INTERFACES: JSON in the shape of os.networkInterfaces(), used instead of the real interfaces.
 *  - TRB_TAILSCALE_BIN: the only tailscale executable to try ("none" or empty: not installed).
 */
import os from "os";
import { UserError } from "../util";
import { drive, driveAsync, runCmd } from "../git/run";

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

export interface LanPick {
  ip: string;
  iface: string;
}

/** Interface names that are never "the Wi-Fi/Ethernet a phone is on": containers, VMs, VPNs, tunnels, AirDrop and friends. */
const VIRTUAL_NAME = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|vnic|utun|tun|tap|tailscale|ts|zt|wg|ppp|bridge|awdl|llw|anpi|gif|stf|ap|ipsec|cni|flannel|cali|kube|lxc|lxd|podman|wsl|vEthernet)/i;
const PREFERRED_NAME = /^(en\d|eth|wl|wlan|wlp|enp|eno|ens|Wi-?Fi|Ethernet)/i;

export const isRfc1918 = (ip: string): boolean => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
};

/** 100.64.0.0/10, the range Tailscale hands out. */
export const isTailnetIPv4 = (ip: string): boolean => {
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c] = m.slice(1).map(Number);
  return a >= 64 && a <= 127 && b <= 255 && c <= 255;
};

function interfaces(): Ifaces {
  const fake = process.env.TRB_REMOTE_INTERFACES;
  if (fake) {
    try {
      return JSON.parse(fake) as Ifaces;
    } catch {
      return {};
    }
  }
  return os.networkInterfaces();
}

/** The private IPv4 of the physical network this machine is on. Skips docker, VM, VPN and tailscale interfaces. */
export function pickLan(ifaces: Ifaces = interfaces()): LanPick | null {
  const found: Array<LanPick & { rank: number }> = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL_NAME.test(name)) continue;
    for (const a of addrs ?? []) {
      const v4 = a.family === "IPv4" || (a.family as unknown) === 4;
      if (!v4 || a.internal || !isRfc1918(a.address)) continue;
      found.push({ ip: a.address, iface: name, rank: PREFERRED_NAME.test(name) ? 0 : 1 });
    }
  }
  found.sort((x, y) => x.rank - y.rank);
  return found[0] ? { ip: found[0].ip, iface: found[0].iface } : null;
}

let lanCache: { at: number; value: LanPick | null } | null = null;
/** pickLan with a 2s cache: the Host check calls it on every request. */
export function lanTarget(fresh = false): LanPick | null {
  const now = Date.now();
  if (!fresh && lanCache && now - lanCache.at < 2000) return lanCache.value;
  lanCache = { at: now, value: pickLan() };
  return lanCache.value;
}

/* -------------------------------- Tailscale -------------------------------- */

export interface TailscaleInfo {
  state: "ok" | "not-installed" | "not-running";
  /** The tailnet IPv4, set when state is ok. */
  ip?: string;
  /** The MagicDNS name without the trailing dot, when the tailnet has one. */
  dnsName?: string;
  /** A plain sentence for the person, no links. */
  message: string;
}

const NOT_INSTALLED = "Tailscale is not installed on this computer. Install Tailscale and sign in, then choose this option again.";
const NOT_RUNNING = "Tailscale is installed but not running or not signed in. Start Tailscale and sign in (run: tailscale up), then choose this option again.";

function candidates(): string[] {
  const forced = process.env.TRB_TAILSCALE_BIN;
  if (forced !== undefined) return forced && forced !== "none" ? [forced] : [];
  const list: string[] = [];
  const onPath = Bun.which("tailscale");
  if (onPath) list.push(onPath);
  if (process.platform === "darwin") list.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  return list;
}

interface Probe {
  ok: boolean;
  out: string;
  missing: boolean;
}

/** One Tailscale CLI call, as the synchronous fresh probe runs it. */
function runSync(bin: string, args: string[]): Probe {
  try {
    const r = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 4000, env: process.env, windowsHide: true });
    return { ok: r.exitCode === 0, out: r.stdout.toString(), missing: false };
  } catch {
    return { ok: false, out: "", missing: true };
  }
}

/** The same call off the daemon's thread. */
async function runAsync(bin: string, args: string[]): Promise<Probe> {
  const r = await runCmd(bin, args, { timeoutMs: 4000 }).catch(() => null);
  return r ? { ok: r.code === 0, out: r.stdout.toString(), missing: false } : { ok: false, out: "", missing: true };
}

const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The Tailscale probe as steps: each CLI call is handed out and its result comes back, so the same logic runs
 * synchronously (fresh) or off the thread (the background refresh).
 */
function* tailscaleSteps(): Generator<{ bin: string; args: string[] }, TailscaleInfo, Probe> {
  for (const bin of candidates()) {
    const ip = yield { bin, args: ["ip", "-4"] };
    if (ip.missing) continue;
    const addr = ip.out.split(/\s+/).find((s) => isTailnetIPv4(s));
    if (!ip.ok || !addr) return { state: "not-running", message: NOT_RUNNING };
    let dnsName: string | undefined;
    const st = yield { bin, args: ["status", "--json"] };
    if (st.ok) {
      try {
        const j = JSON.parse(st.out);
        if (j.BackendState && j.BackendState !== "Running") return { state: "not-running", message: NOT_RUNNING };
        const name = String(j.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
        if (DNS_NAME.test(name)) dnsName = name;
      } catch {}
    }
    return { state: "ok", ip: addr, dnsName, message: dnsName ? `Tailscale is running as ${dnsName} (${addr}).` : `Tailscale is running at ${addr}. MagicDNS names are off, so the link will use the address.` };
  }
  return { state: "not-installed", message: NOT_INSTALLED };
}

/** Shown until the first probe has answered. */
const CHECKING: TailscaleInfo = { state: "not-running", message: "Checking Tailscale…" };
const CACHE_MS = 10_000;

let tsCache: { at: number; value: TailscaleInfo } | null = null;
let tsProbe: Promise<TailscaleInfo> | null = null;

/** Probe Tailscale in the background and store the answer. One probe at a time: callers share it. */
export function refreshTailscale(): Promise<TailscaleInfo> {
  tsProbe ??= driveAsync(tailscaleSteps(), (a) => runAsync(a.bin, a.args))
    .then((value) => {
      tsCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      tsProbe = null;
    });
  return tsProbe;
}

/**
 * The last known Tailscale state. Never waits on the CLI: the Host check and the sweeper read this, so a stale answer is
 * returned at once while a refresh runs behind it (and `CHECKING` until the first one). `fresh` probes now, on this thread.
 */
export function detectTailscale(fresh = false): TailscaleInfo {
  if (fresh) {
    tsCache = { at: Date.now(), value: drive(tailscaleSteps(), (a) => runSync(a.bin, a.args)) };
    return tsCache.value;
  }
  if (!tsCache || Date.now() - tsCache.at >= CACHE_MS) void refreshTailscale().catch(() => {});
  return tsCache?.value ?? CHECKING;
}

export function resetNetworkCacheForTests(): void {
  lanCache = null;
  tsCache = null;
}

/** Throws a UserError with a plain instruction when this mode cannot work right now. */
export function assertModeAvailable(mode: "lan" | "tailscale"): void {
  if (mode === "lan") {
    if (!lanTarget(true)) throw new UserError("No local network address found. Connect this computer to Wi-Fi or Ethernet (docker, VM and VPN interfaces are ignored), then choose this option again.");
    return;
  }
  const t = detectTailscale(true);
  if (t.state !== "ok") throw new UserError(t.message);
}
