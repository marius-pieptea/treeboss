/** Pure rules behind the compact remote view. No React, so they are unit-tested directly. */
import type { SessionStatus, SessionView } from "../lib/types";

export type Tone = "accent" | "green" | "amber" | "red" | "muted";

export interface Chip {
  label: string;
  tone: Tone;
}

/** One chip that says what a session is doing, most specific first. */
export function statusChip(s: Pick<SessionView, "status" | "mode" | "waiting_on">, plan?: { pending: boolean; draft: boolean } | null): Chip {
  if (s.status === "failed") return { label: "Failed", tone: "red" };
  if (s.status === "closed") return { label: "Closed", tone: "muted" };
  if (plan?.pending) return { label: "Needs your answer", tone: "amber" };
  if (plan?.draft && s.status !== "running") return { label: "Plan ready", tone: "amber" };
  if (s.status === "running") return s.waiting_on?.length ? { label: `Waiting on ${s.waiting_on.length} head${s.waiting_on.length === 1 ? "" : "s"}`, tone: "accent" } : { label: "Working", tone: "accent" };
  if (s.mode === "plan") return { label: "Planning", tone: "muted" };
  return { label: "Idle", tone: "green" };
}

/** Leads first, the ones that are working at the top, then the rest by recency (the API returns newest first). */
export function sortLeads(all: SessionView[]): SessionView[] {
  const rank = (s: SessionView) => (s.status === "running" ? 0 : s.status === "failed" ? 1 : s.status === "idle" ? 2 : 3);
  return all
    .filter((s) => s.depth === 0)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map((x) => x.s);
}

/** "now", "5m", "3h", "2d": short enough for a phone row. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso.includes("T") || iso.includes("Z") ? iso : iso.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** A follow-up can go to a session that is idle; while it works the phone offers Interrupt instead. */
export function sendState(status: SessionStatus, text: string): { canSend: boolean; hint: string | null } {
  if (status === "closed") return { canSend: false, hint: "This session is closed." };
  if (status === "running") return { canSend: false, hint: "Working. Interrupt it to send a follow-up." };
  return { canSend: text.trim().length > 0, hint: null };
}

/** How many of the newest items to draw, and whether there are older ones to reveal. */
export function windowItems<T>(items: T[], shown: number): { items: T[]; hidden: number } {
  const hidden = Math.max(0, items.length - shown);
  return { items: hidden ? items.slice(hidden) : items, hidden };
}

/** Is the reader within `slop` pixels of the bottom, so new lines should keep it pinned there? */
export function nearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slop = 120): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slop;
}

/** The session id in `#s_abc…` (or a path-style hash), or null. */
export function sessionFromHash(hash: string): string | null {
  const m = /^#\/?(s_[0-9a-f]{6,})$/.exec(hash);
  return m ? m[1] : null;
}

export function modelLabel(s: Pick<SessionView, "engine" | "model" | "effort">): string {
  const m = s.model ? s.model.split("/").pop() : null;
  return [s.engine, m, s.effort ? `@${s.effort}` : null].filter(Boolean).join(" · ");
}

/** What the grants line says to someone looking at the device list. */
export function grantsLabel(g: { terminal: boolean; files: "off" | "read" | "write" }): string {
  const parts = ["sessions, plans, follow-ups"];
  if (g.files !== "off") parts.push(g.files === "write" ? "files (read and write)" : "files (read)");
  if (g.terminal) parts.push("terminals");
  return parts.join(", ");
}

/** Seconds left on a pairing code, never negative. */
export function secondsLeft(expiresAtIso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAtIso) - now) / 1000));
}

export const countdown = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** A pairing link is only ever shown (as text or QR) when it points at a network address, never at this computer. */
export function pairingShowable(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return !(h === "localhost" || h === "[::1]" || h === "::1" || h === "0.0.0.0" || /^127\./.test(h) || h.endsWith(".localhost"));
  } catch {
    return false;
  }
}

export type RemoteModeId = "off" | "lan" | "tailscale";

export interface ModeInfo {
  id: RemoteModeId;
  title: string;
  blurb: string;
}

export const MODES: ModeInfo[] = [
  { id: "off", title: "Off", blurb: "This computer only. No pairing, every paired device is refused." },
  { id: "lan", title: "Local network", blurb: "Phones on the same Wi-Fi or Ethernet. Plain http, visible to anyone on that network." },
  { id: "tailscale", title: "Tailscale", blurb: "Only devices on your tailnet. The LAN is not exposed." },
];

/** Why a mode cannot be chosen right now, in plain words, or null when it can. */
export function modeBlocked(id: RemoteModeId, d: { lan: { ip: string } | null; tailscale: { state: string; message: string } }): string | null {
  if (id === "lan") return d.lan ? null : "No local network address found. Connect to Wi-Fi or Ethernet.";
  if (id === "tailscale") return d.tailscale.state === "ok" ? null : d.tailscale.message;
  return null;
}

/** What the phone's switcher knows about a workspace: its name and the work running or failed in it. */
export interface RemoteWorkspace {
  id: string;
  name: string;
  running: number;
  failed: number;
}

/** The remembered workspace if it still exists, else null (all workspaces). A removed workspace must not leave the list empty. */
export function pickWorkspace(saved: string | null, list: Pick<RemoteWorkspace, "id">[] | undefined): string | null {
  return saved && list?.some((w) => w.id === saved) ? saved : null;
}

/** Work in the workspaces other than the one being looked at, so the switcher can say something finished elsewhere. Nothing is "elsewhere" while all workspaces are shown. */
export function elsewhere(list: RemoteWorkspace[], current: string | null): { running: number; failed: number } {
  if (!current) return { running: 0, failed: 0 };
  return list.filter((w) => w.id !== current).reduce((n, w) => ({ running: n.running + w.running, failed: n.failed + w.failed }), { running: 0, failed: 0 });
}
