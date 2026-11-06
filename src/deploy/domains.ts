/**
 * Domains on Cloudflare DNS, through the REST API with fetch. The API token is CLOUDFLARE_API_TOKEN from the
 * secrets for the environment. It is sent only in the Authorization header and never logged or returned.
 *
 * Kept small on purpose: list zones, add or update a CNAME to a deploy host, and check that the name
 * resolves to it. `fetchFn` is injectable so the tests never reach the network.
 */
import { UserError } from "../util";
import { secretsFor } from "./store";

const API = "https://api.cloudflare.com/client/v4";
const DOH = "https://cloudflare-dns.com/dns-query";
const HOST = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,63}$/i;

type FetchFn = typeof fetch;

export interface Zone {
  id: string;
  name: string;
  status: string;
}

export interface DnsRecord {
  id: string;
  name: string;
  content: string;
  proxied: boolean;
}

/** A deploy host from a URL or a bare host: lowercase, no scheme, no path, no trailing dot. */
export function hostOf(value: string): string {
  const raw = value.trim().replace(/^https?:\/\//i, "").split("/")[0]!.replace(/\.$/, "").toLowerCase();
  if (!HOST.test(raw)) throw new UserError(`"${value}" is not a hostname.`);
  return raw;
}

async function cf<T>(token: string, route: string, init: RequestInit, f: FetchFn): Promise<T> {
  const res = await f(`${API}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || body?.success === false) {
    // The API's message is useful; the token is never part of it.
    const msg = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new UserError(`Cloudflare refused the request: ${msg}.`);
  }
  return body.result as T;
}

export async function listZones(token: string, f: FetchFn = fetch): Promise<Zone[]> {
  const rows = await cf<any[]>(token, "/zones?per_page=50", { method: "GET" }, f);
  return rows.map((z) => ({ id: z.id, name: z.name, status: z.status }));
}

/** The zone that holds a name: the longest zone name the host ends with. */
export function zoneFor(host: string, zones: Zone[]): Zone | null {
  let best: Zone | null = null;
  for (const z of zones) {
    if ((host === z.name || host.endsWith(`.${z.name}`)) && (!best || z.name.length > best.name.length)) best = z;
  }
  return best;
}

/** Add the CNAME, or point an existing one at `target`. Returns what happened. */
export async function upsertCname(
  token: string,
  zone: Zone,
  input: { name: string; target: string; proxied?: boolean },
  f: FetchFn = fetch,
): Promise<{ action: "created" | "updated"; record: DnsRecord }> {
  const name = hostOf(input.name);
  const content = hostOf(input.target);
  const proxied = input.proxied ?? true;
  const body = JSON.stringify({ type: "CNAME", name, content, proxied, ttl: 1 });
  const existing = await cf<any[]>(token, `/zones/${zone.id}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`, { method: "GET" }, f);
  const found = existing[0];
  const r = found
    ? await cf<any>(token, `/zones/${zone.id}/dns_records/${found.id}`, { method: "PATCH", body }, f)
    : await cf<any>(token, `/zones/${zone.id}/dns_records`, { method: "POST", body }, f);
  return { action: found ? "updated" : "created", record: { id: r.id, name: r.name, content: r.content, proxied: !!r.proxied } };
}

export interface Propagation {
  name: string;
  expected: string;
  /** True when the name answers with the expected host (a CNAME), or with addresses while it is proxied. */
  resolved: boolean;
  /** The CNAME answers seen. */
  cname: string[];
  /** Address answers, which a proxied record gives instead of a CNAME. */
  addresses: string[];
}

/** Ask the public resolver (DNS over HTTPS) whether `name` reaches `expected`. */
export async function checkPropagation(name: string, expected: string, f: FetchFn = fetch): Promise<Propagation> {
  const host = hostOf(name);
  const want = hostOf(expected);
  const ask = async (type: string): Promise<string[]> => {
    const res = await f(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => ({}))) as { Answer?: Array<{ data: string }> };
    return (body.Answer ?? []).map((a) => String(a.data).replace(/\.$/, "").toLowerCase());
  };
  const cname = await ask("CNAME");
  const addresses = cname.length ? [] : await ask("A");
  return { name: host, expected: want, resolved: cname.includes(want) || addresses.length > 0, cname, addresses };
}

/** The Cloudflare token for an environment, from its secrets. */
export function tokenFor(workspaceId: string, env: string): string {
  const token = secretsFor(workspaceId, env).CLOUDFLARE_API_TOKEN;
  if (!token) throw new UserError(`CLOUDFLARE_API_TOKEN is not set for ${env}. Add it in the secrets, then try again.`);
  return token;
}

/** Add or update a CNAME for a domain in the account that holds it. */
export async function addDomain(
  input: { workspaceId: string; env: string; domain: string; target: string; proxied?: boolean },
  f: FetchFn = fetch,
): Promise<{ zone: Zone; action: "created" | "updated"; record: DnsRecord }> {
  const token = tokenFor(input.workspaceId, input.env);
  const host = hostOf(input.domain);
  const zone = zoneFor(host, await listZones(token, f));
  if (!zone) throw new UserError(`No Cloudflare zone in this account holds ${host}.`);
  const r = await upsertCname(token, zone, { name: host, target: input.target, proxied: input.proxied }, f);
  return { zone, ...r };
}
