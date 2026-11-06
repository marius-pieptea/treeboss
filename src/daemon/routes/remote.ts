/**
 * Managing remote access. Owner only: a remote device may call `GET /api/remote/me` and nothing else here
 * (the route policy denies the rest before dispatch; this module checks again).
 *
 *   GET    /api/remote/me                who am I: { kind, label?, grants }
 *   GET    /api/remote/workspaces        the workspaces' names and running/failed counts, for the phone's switcher (no paths)
 *   GET    /api/remote/status            switches, how a phone would reach this daemon, paired devices
 *   POST   /api/remote/pair  { label?, local? }  a one-time code, its link and QR (remote_mode must not be off). The link
 *                                 is the LAN address or tailnet name; { local: true } (CLI --local) gives a loopback link for tests
 *   GET    /api/remote/tokens            paired devices
 *   DELETE /api/remote/tokens/:id        revoke one device (its sockets close)
 *   POST   /api/remote/revoke-all        revoke every device
 */
import { closeSocketsFor, closeAllRemoteSockets, openSocketCount } from "../../remote/auth";
import { remoteConfig, type RemoteMode } from "../../remote/hosts";
import { listenStatus, listening } from "../../remote/listener";
import { detectTailscale, lanTarget } from "../../remote/network";
import { createPairCode, PAIR_TTL_MS } from "../../remote/pairing";
import { qrSvg, qrText } from "../../remote/qr";
import { listTokens, revokeAllTokens, revokeToken } from "../../remote/store";
import { UserError } from "../../util";
import { Workspaces } from "../../workspaces";
import { HttpError, json, type RouteModule } from "../http";
import { workspaceActivity } from "./workspaces";

export const LAN_WARNING = "Plain http on your local network: anyone on the same Wi-Fi or Ethernet can see the traffic, including the pairing link. Use it only on a network you trust.";

export interface PairBase {
  /** The origin a phone opens, or null when there is none to give. Never a loopback address. */
  origin: string | null;
  kind: "lan" | "tailscale" | null;
  reachable: boolean;
  note: string;
  /** Plain-words risk for this mode, shown beside the QR. */
  warning: string | null;
}

/** What a phone would open for the current mode. Loopback is never offered here (see `pairLocalOrigin`). */
export function pairBase(port: string, mode: RemoteMode = remoteConfig().mode): PairBase {
  if (mode === "off") return { origin: null, kind: null, reachable: false, note: "Remote access is off. Choose Local network or Tailscale first.", warning: null };
  if (mode === "lan") {
    const lan = lanTarget();
    if (!lan) return { origin: null, kind: "lan", reachable: false, note: "No local network address found. Connect to Wi-Fi or Ethernet.", warning: LAN_WARNING };
    const ls = listenStatus();
    const ok = listening();
    return { origin: `http://${lan.ip}:${port}`, kind: "lan", reachable: ok, note: ok ? `Phones on the same network open http://${lan.ip}:${port} (interface ${lan.iface}).` : (ls.error ?? "Not listening yet."), warning: LAN_WARNING };
  }
  const t = detectTailscale();
  if (t.state !== "ok") return { origin: null, kind: "tailscale", reachable: false, note: t.message, warning: null };
  const host = t.dnsName ?? t.ip!;
  const ls = listenStatus();
  const ok = listening();
  // The tailnet address could not be bound (userspace networking): the documented fallback is `tailscale serve`, which
  // fronts the loopback daemon on https://<name>/ (port 443), so that is the link to offer.
  if (!ok && ls.error && t.dnsName) return { origin: `https://${t.dnsName}`, kind: "tailscale", reachable: false, note: `${ls.error} If you ran "tailscale serve --bg ${port}", phones can open this link.`, warning: null };
  return { origin: `http://${host}:${port}`, kind: "tailscale", reachable: ok, note: ok ? `Reachable only from devices on your tailnet, through ${host}. The tailnet encrypts the traffic.` : (ls.error ?? "Not listening yet."), warning: null };
}

export const remoteRoutes: RouteModule = (c) => {
  if (!c.path.startsWith("/api/remote/")) return null;

  if (c.path === "/api/remote/me" && c.method === "GET") {
    const p = c.principal;
    const g = remoteConfig().grants;
    return json(p?.kind === "remote" ? { kind: "remote", label: p.label, grants: g } : { kind: "owner", grants: g });
  }

  if (c.path === "/api/remote/workspaces" && c.method === "GET") {
    const activity = workspaceActivity();
    return json({ workspaces: Workspaces.list().map((w) => ({ id: w.id, name: w.name, running: activity[w.id]?.running ?? 0, failed: activity[w.id]?.failed ?? 0 })) });
  }

  if (c.principal?.kind !== "owner") throw new HttpError(403, "Not available to a remote device.");

  if (c.path === "/api/remote/status" && c.method === "GET") {
    const cfg = remoteConfig();
    const base = pairBase(c.url.port);
    return json({
      mode: cfg.mode,
      enabled: cfg.on,
      listen: listenStatus(),
      detected: { lan: lanTarget(), tailscale: detectTailscale() },
      grants: cfg.grants,
      base,
      open_sockets: openSocketCount(),
      tokens: listTokens(),
    });
  }

  if (c.path === "/api/remote/pair" && c.method === "POST") {
    const mode = remoteConfig().mode;
    if (mode === "off") throw new UserError("Remote access is off. Choose Local network or Tailscale first (trb config set remote_mode lan|tailscale).");
    const local = c.body.local === true;
    const base = local
      ? { origin: `http://127.0.0.1:${c.url.port}`, kind: null, reachable: false, note: "Loopback only, for development and tests. A phone cannot open this address.", warning: null }
      : pairBase(c.url.port, mode);
    if (!base.origin) throw new UserError(base.note);
    const { code, expiresAt } = createPairCode({ label: typeof c.body.label === "string" ? c.body.label : null });
    const url = `${base.origin}/_pair?code=${code}`;
    return json({ url, expires_at: new Date(expiresAt).toISOString(), ttl_sec: Math.round(PAIR_TTL_MS / 1000), mode, local, reachable: base.reachable, kind: base.kind, note: base.note, warning: base.warning, qr_svg: qrSvg(url), qr_text: qrText(url) }, 201);
  }

  if (c.path === "/api/remote/tokens" && c.method === "GET") return json({ tokens: listTokens() });

  const m = c.match(/^\/api\/remote\/tokens\/([^/]+)$/);
  if (m && c.method === "DELETE") {
    const ok = revokeToken(m[1]);
    if (!ok) throw new HttpError(404, "No such device, or it was already revoked.");
    closeSocketsFor(m[1]);
    return json({ revoked: true });
  }

  if (c.path === "/api/remote/revoke-all" && c.method === "POST") {
    const ids = revokeAllTokens();
    closeAllRemoteSockets("Device revoked.");
    return json({ revoked: ids.length });
  }

  return null;
};
