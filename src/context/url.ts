/**
 * `@url`: fetch a page for the prompt, safely.
 *
 * The daemon runs on the operator's machine, so a URL typed into a prompt must not become a way to reach
 * what only that machine can: loopback services, the LAN, a cloud metadata address. Every host is resolved
 * and every address checked, redirects are followed by hand so each hop is checked again, only http(s)
 * without credentials is allowed, the body is read up to a byte cap, and only text-like content is kept.
 *
 * The one exception is the app preview: the caller may name an origin (`allowOrigin`) and a loopback URL on
 * exactly that origin is then allowed. Nothing else on loopback, and never private LAN ranges, link-local or
 * metadata addresses, and never the daemon's own port (`selfPort`).
 */
import dns from "dns/promises";
import net from "net";

export const MAX_URL_BYTES = 1_000_000;
export const MAX_URL_TEXT_CHARS = 20_000;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 10_000;

export class UrlRefused extends Error {}

/** True for an address that is not a public, routable unicast one. */
export function isBlockedAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const v = net.isIP(a);
  if (v === 4) return blockedV4(a);
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return blockedV4(mapped[1]);
    // IPv4-mapped in hex form (::ffff:7f00:1) and the NAT64 prefix carry an IPv4 inside: refuse both.
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a) || a.startsWith("64:ff9b:")) return true;
    if (a === "::" || a === "::1") return true;
    const first = parseInt(a.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (first === 0x2001 && a.startsWith("2001:db8")) return true; // documentation
    return false;
  }
  return true; // not an IP at all: refuse
}

function blockedV4(a: string): boolean {
  const [p, q] = a.split(".").map(Number);
  if (p === 0 || p === 10 || p === 127) return true;
  if (p === 100 && q >= 64 && q <= 127) return true; // CGNAT
  if (p === 169 && q === 254) return true; // link local, cloud metadata
  if (p === 172 && q >= 16 && q <= 31) return true;
  if (p === 192 && q === 168) return true;
  if (p === 192 && q === 0 && Number(a.split(".")[2]) === 0) return true;
  if (p === 198 && (q === 18 || q === 19)) return true;
  if (p >= 224) return true; // multicast, reserved, broadcast
  return false;
}

export function isLoopbackAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "").toLowerCase();
  return a === "::1" || a === "localhost" || /^127\./.test(a);
}

export interface FetchGuard {
  /** An origin (`http://localhost:5173`) the operator named as the preview; loopback is allowed there only. */
  allowOrigin?: string | null;
  /** The daemon's own port: refused even on loopback. */
  selfPort?: number | null;
  /** Test seam: replaces DNS. */
  lookup?: (host: string) => Promise<string[]>;
  /** Test seam: replaces fetch. */
  fetchImpl?: typeof fetch;
}

async function addressesOf(host: string, g: FetchGuard): Promise<string[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return [bare];
  if (bare.toLowerCase() === "localhost" || bare.toLowerCase().endsWith(".localhost")) return ["127.0.0.1"];
  if (g.lookup) return g.lookup(bare);
  const all = await dns.lookup(bare, { all: true });
  return all.map((x) => x.address);
}

/** Throws UrlRefused unless the URL may be fetched. Returns the parsed URL. */
export async function checkFetchable(raw: string, g: FetchGuard = {}): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UrlRefused(`"${raw.trim().slice(0, 80)}" is not a valid URL.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UrlRefused(`Only http and https URLs can be attached (not ${u.protocol}).`);
  if (u.username || u.password) throw new UrlRefused("URLs with a username or password are refused.");
  const host = u.hostname;
  if (!host) throw new UrlRefused("The URL has no host.");
  const addrs = await addressesOf(host, g);
  if (!addrs.length) throw new UrlRefused(`Could not resolve ${host}.`);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const loopbackOnly = addrs.every(isLoopbackAddress);
  if (loopbackOnly) {
    if (g.selfPort && port === g.selfPort) throw new UrlRefused("That is the treeboss daemon itself.");
    const allowed = g.allowOrigin ? safeOrigin(g.allowOrigin) : null;
    if (allowed && allowed === u.origin) return u; // the preview, named explicitly
    throw new UrlRefused("Local addresses are refused unless it is the preview URL.");
  }
  if (addrs.some(isBlockedAddress)) throw new UrlRefused("Private, link-local and internal network addresses are refused.");
  return u;
}

function safeOrigin(s: string): string | null {
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

/** A readable text rendering of an HTML page: no scripts or styles, tags removed, whitespace tidied. */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let t = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title ? `${decodeTitle(title)}\n\n${t}` : t;
}

const decodeTitle = (s: string) => s.replace(/\s+/g, " ").replace(/&amp;/g, "&").trim();

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  text: string;
  /** The body or the text was cut to a cap. */
  truncated: boolean;
}

/** Fetch a guarded URL and return its text. Throws UrlRefused for a policy refusal, Error for a network one. */
export async function fetchUrlText(raw: string, g: FetchGuard = {}): Promise<FetchedPage> {
  const doFetch = g.fetchImpl ?? fetch;
  let current = await checkFetchable(raw, g);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(current.toString(), { redirect: "manual", signal: ctl.signal, headers: { "user-agent": "treeboss-context/1", accept: "text/html,text/plain,application/json,text/markdown;q=0.9,*/*;q=0.1" } });
    } catch (err: any) {
      clearTimeout(timer);
      throw new Error(`Could not fetch ${current.host}: ${err?.name === "AbortError" ? "timed out" : (err?.message ?? err)}`);
    }
    try {
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop === MAX_REDIRECTS) throw new UrlRefused("Too many redirects.");
        current = await checkFetchable(new URL(res.headers.get("location")!, current).toString(), g);
        continue;
      }
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const texty = !contentType || /^text\//.test(contentType) || /(json|xml|javascript|yaml|markdown)/.test(contentType);
      if (!texty) throw new UrlRefused(`Not a text page (${contentType}).`);
      const { body, cut } = await readCapped(res, MAX_URL_BYTES);
      let text = /html/.test(contentType) || /^\s*<(!doctype|html)/i.test(body.slice(0, 200)) ? htmlToText(body) : body.trim();
      let truncated = cut;
      if (text.length > MAX_URL_TEXT_CHARS) {
        text = text.slice(0, MAX_URL_TEXT_CHARS);
        truncated = true;
      }
      return { url: current.toString(), status: res.status, contentType: contentType || "text/plain", text, truncated };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new UrlRefused("Too many redirects.");
}

async function readCapped(res: Response, max: number): Promise<{ body: string; cut: boolean }> {
  if (!res.body) return { body: "", cut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      chunks.push(value.slice(0, value.length - (total - max)));
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return { body: Buffer.concat(chunks).toString("utf-8"), cut };
}
