/**
 * One-time pairing codes and the rate limiter that guards redeeming them.
 *
 * A code is minted by the owner (bearer token or the owner's own signed-in UI), lives two minutes, and is
 * spent by its first redemption. Codes are kept in memory, hashed: a daemon restart invalidates them, which
 * is the right failure. Anyone can POST guesses at /_pair, so guesses are limited per peer address and
 * globally, and a code is 192 random bits besides.
 */
import { createHash, randomBytes } from "crypto";
import { UserError } from "../util";

export const PAIR_TTL_MS = 120_000;
const MAX_OUTSTANDING = 5;

interface Pending {
  exp: number;
  label: string | null;
}
const codes = new Map<string, Pending>();
const keyOf = (code: string) => createHash("sha256").update(code).digest("hex");

function purge(now: number): void {
  for (const [k, p] of codes) if (p.exp <= now) codes.delete(k);
}

export function createPairCode(o: { label?: string | null; now?: number } = {}): { code: string; expiresAt: number } {
  const now = o.now ?? Date.now();
  purge(now);
  if (codes.size >= MAX_OUTSTANDING) throw new UserError("Too many unused pairing codes. Wait for one to expire or restart pairing.");
  const code = randomBytes(24).toString("base64url");
  const exp = now + PAIR_TTL_MS;
  codes.set(keyOf(code), { exp, label: o.label?.trim() || null });
  return { code, expiresAt: exp };
}

/** Is this code live? Does not spend it (the confirm page uses this). */
export function peekPairCode(code: string, now = Date.now()): boolean {
  const p = codes.get(keyOf(code));
  return !!p && p.exp > now;
}

/** Spend a code. Returns its label ("" when none was given) on success, null when unknown, used or expired. */
export function redeemPairCode(code: string, now = Date.now()): { label: string } | null {
  const k = keyOf(code);
  const p = codes.get(k);
  codes.delete(k);
  if (!p || p.exp <= now) return null;
  return { label: p.label ?? "" };
}

export function outstandingCodes(now = Date.now()): number {
  purge(now);
  return codes.size;
}

/** Sliding window: at most `max` hits per `windowMs` for a key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  /** Count a hit. ok:false means over the limit; retryAfterSec says when the oldest hit leaves the window. */
  hit(key: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 2000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return { ok: true, retryAfterSec: 0 };
  }
  reset(): void {
    this.hits.clear();
  }
}

// Per peer address and across everyone: a reverse proxy such as `tailscale serve` makes every visitor look like one
// address, so the global cap is what protects the code space there.
export const pairPerPeer = new RateLimiter(10, 60_000);
export const pairGlobal = new RateLimiter(40, 60_000);

export function pairRateCheck(peer: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  const a = pairPerPeer.hit(peer || "unknown", now);
  if (!a.ok) return a;
  return pairGlobal.hit("*", now);
}

/** Test seam. */
export function resetPairingForTests(): void {
  codes.clear();
  pairPerPeer.reset();
  pairGlobal.reset();
}
