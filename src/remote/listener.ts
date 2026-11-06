/**
 * The second listener. The daemon always listens on 127.0.0.1. For `lan` and `tailscale` it also listens on
 * ONE specific address, never 0.0.0.0:
 *   lan        the detected LAN IPv4 (so other interfaces, the tailnet included, are not exposed)
 *   tailscale  the tailnet IPv4 (so the LAN is not exposed)
 * It is started and stopped live when the mode changes (no daemon restart), moved when the address changes,
 * and closes every remote socket whenever the mode or address changes.
 *
 * Test seams: startServer takes `remoteServe`, which tests replace so nothing real is bound.
 * TRB_REMOTE_NO_LISTEN=1 makes the daemon never open the second listener at all (the CLI tests and
 * scripts/ui-remote.ts use it together with a Host header or a host-resolver rule on loopback).
 */
import { closeAllRemoteSockets } from "./auth";
import { allowedRemoteHosts, remoteMode, type RemoteMode } from "./hosts";
import { detectTailscale, lanTarget } from "./network";

export type ServeFn = (host: string, port: number) => { stop(): void };

export interface ListenStatus {
  mode: RemoteMode;
  /** The address the second listener is bound to, or null. */
  address: string | null;
  port: number | null;
  /** Why it is not listening when it should be, in plain words. */
  error: string | null;
  /** True when TRB_REMOTE_NO_LISTEN is set: nothing is opened, links are for Host-header testing. */
  simulated: boolean;
}

let current: { key: string; host: string; port: number; stop(): void } | null = null;
let appliedKey = "off";
let lastError: string | null = null;

/** The address the second listener should be on right now, or null. */
export function desiredListenHost(mode: RemoteMode = remoteMode()): string | null {
  if (mode === "lan") return lanTarget()?.ip ?? null;
  if (mode === "tailscale") {
    const t = detectTailscale();
    return t.state === "ok" ? (t.ip ?? null) : null;
  }
  return null;
}

const noListen = () => process.env.TRB_REMOTE_NO_LISTEN === "1";

/** Make the second listener match the current mode. Cheap when nothing changed; safe to call often. */
export function reconcileListener(port: number, serve: ServeFn): void {
  const mode = remoteMode();
  const host = desiredListenHost(mode);
  const key = `${mode}|${host ?? ""}`;
  if (key === appliedKey && (current !== null || host === null || noListen())) return;
  if (key !== appliedKey) {
    // Mode or address changed: every open remote connection ends, whatever it was.
    closeAllRemoteSockets("Remote access changed.");
    try {
      current?.stop();
    } catch {}
    current = null;
    lastError = null;
    appliedKey = key;
  }
  if (!host) {
    if (mode === "lan") lastError = "No local network address found.";
    else if (mode === "tailscale") lastError = detectTailscale().message;
    return;
  }
  if (noListen()) return;
  try {
    const s = serve(host, port);
    current = { key, host, port, stop: () => s.stop() };
    lastError = null;
  } catch (err: any) {
    lastError =
      mode === "tailscale"
        ? `Could not listen on the tailnet address ${host}:${port} (${err?.code ?? err?.message}). Tailscale may be running without a network interface; see docs/REMOTE.md for the tailscale serve fallback.`
        : `Could not listen on ${host}:${port} (${err?.code ?? err?.message}).`;
  }
}

export function stopListener(): void {
  try {
    current?.stop();
  } catch {}
  current = null;
  appliedKey = "off";
  lastError = null;
}

export function listenStatus(): ListenStatus {
  return { mode: remoteMode(), address: current?.host ?? null, port: current?.port ?? null, error: lastError, simulated: noListen() };
}

/** Is a phone able to connect right now? The listener is up, or (simulated) the address is known. */
export function listening(): boolean {
  return current !== null || (noListen() && allowedRemoteHosts().length > 0);
}
