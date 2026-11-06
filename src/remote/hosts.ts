/**
 * Which hosts and peers the daemon talks to, and the one remote switch that decides it: `remote_mode`.
 *
 *  - `off`: loopback only. Any non-loopback Host is refused.
 *  - `lan`: also the one detected LAN IPv4 literal, exactly (not "any private address").
 *  - `tailscale`: also the tailnet MagicDNS name and the tailnet IPv4, exactly.
 *  Anything else, such as a hostile name that resolves to this machine (DNS rebinding), is refused.
 *
 * The owner's credentials (the 0600 token and its cookie) count only for a loopback Host from a loopback
 * peer. Over a LAN or a tailnet the only way in is a remote token.
 */
import { db } from "../db";
import { getSetting } from "../settings";
import { detectTailscale, lanTarget } from "./network";
import type { Grants } from "./policy";

export type RemoteMode = "off" | "lan" | "tailscale";

export interface RemoteConfig {
  mode: RemoteMode;
  on: boolean;
  grants: Grants;
}

export function remoteMode(): RemoteMode {
  const m = getSetting("remote_mode");
  return m === "lan" || m === "tailscale" ? m : "off";
}

export function remoteConfig(): RemoteConfig {
  const files = String(getSetting("remote_allow_files"));
  return {
    mode: remoteMode(),
    on: remoteMode() !== "off",
    grants: { terminal: getSetting("remote_allow_terminal") === "on", files: files === "read" || files === "write" ? files : "off" },
  };
}

export function isRemoteOn(): boolean {
  return remoteMode() !== "off";
}

/**
 * Old model -> new: remote_access + remote_bind + remote_hosts became remote_mode. on+lan is lan; on+loopback
 * (a tunnel) and off are off. The old rows are removed. Idempotent; runs at daemon start.
 */
export function migrateRemoteMode(): void {
  const get = (k: string) => (db().prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  const old = ["remote_access", "remote_bind", "remote_hosts"];
  if (!old.some((k) => get(k) !== undefined)) return;
  if (get("remote_mode") === undefined) {
    const mode: RemoteMode = get("remote_access") === "on" && get("remote_bind") === "lan" ? "lan" : "off";
    db().prepare("INSERT INTO settings (key, value) VALUES ('remote_mode', ?)").run(mode);
  }
  for (const k of old) db().prepare("DELETE FROM settings WHERE key = ?").run(k);
}

export const stripPort = (host: string): string => host.replace(/:\d+$/, "");

export function isLoopbackName(host: string): boolean {
  const h = stripPort(host).toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
}

export function isLoopbackPeer(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** The non-loopback Host names a remote device may use in the current mode (lowercase, no port). */
export function allowedRemoteHosts(mode: RemoteMode = remoteMode()): string[] {
  if (mode === "lan") {
    const lan = lanTarget();
    return lan ? [lan.ip] : [];
  }
  if (mode === "tailscale") {
    const t = detectTailscale();
    return t.state === "ok" ? [t.dnsName, t.ip].filter((x): x is string => !!x) : [];
  }
  return [];
}

/** May a request with this Host header be served at all? */
export function hostAllowed(hostHeader: string): boolean {
  if (isLoopbackName(hostHeader)) return true;
  return allowedRemoteHosts().includes(stripPort(hostHeader).toLowerCase());
}

/** The owner's own credentials only count on loopback, from loopback. */
export function ownerMayAuthenticate(hostHeader: string, peer: string | null | undefined): boolean {
  return isLoopbackName(hostHeader) && isLoopbackPeer(peer);
}
