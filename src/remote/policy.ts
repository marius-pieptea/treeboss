/**
 * What a remote token may call. Default deny: a route not listed here is refused for remote tokens, so a
 * route added to the daemon later is owner-only until someone decides otherwise.
 *
 * The list is the compact remote view: look at sessions, follow them live, send a follow-up, interrupt, answer
 * and decide plans. Terminals and workspace files are separate grants the owner sets in settings
 * (`remote_allow_terminal`, `remote_allow_files`) and are checked live, so switching one off takes effect on
 * the next request.
 *
 * No long-lived HTTP stream is listed (`/events`, `/stream`): a revoked token cannot cut those, only sockets it can
 * track. The phone follows sessions through the live socket instead.
 *
 * Matches `url.pathname` exactly as the router sees it, with the same case and no normalisation of its own.
 */

export interface Grants {
  terminal: boolean;
  files: "off" | "read" | "write";
}

export type Decision = { ok: true } | { ok: false; reason: string };

type Method = "GET" | "POST";
interface Rule {
  method: Method;
  re: RegExp;
}

const RULES: Rule[] = [
  { method: "GET", re: /^\/api\/remote\/me$/ },
  { method: "GET", re: /^\/api\/remote\/workspaces$/ },
  { method: "GET", re: /^\/api\/sessions$/ },
  { method: "GET", re: /^\/api\/sessions\/[^/]+$/ },
  { method: "GET", re: /^\/api\/sessions\/[^/]+\/(logs|turns|diff|plan-state|plan\/file)$/ },
  { method: "POST", re: /^\/api\/sessions\/[^/]+\/(send|interrupt)$/ },
  { method: "POST", re: /^\/api\/sessions\/[^/]+\/plan\/answer$/ },
  { method: "POST", re: /^\/api\/sessions\/[^/]+\/plan\/plans\/[^/]+\/(approve|request-changes|skip)$/ },
];

const norm = (m: string): string => (m === "HEAD" ? "GET" : m.toUpperCase());

export function remoteAllowed(methodIn: string, path: string, grants: Grants): Decision {
  const method = norm(methodIn);
  for (const r of RULES) if (r.method === method && r.re.test(path)) return { ok: true };

  if (/^\/api\/terminals(\/|$)/.test(path)) return grants.terminal ? { ok: true } : { ok: false, reason: "Terminals are not enabled for remote devices (settings: remote_allow_terminal)." };

  if (/^\/api\/fs\//.test(path)) {
    if (method === "GET") return grants.files !== "off" ? { ok: true } : { ok: false, reason: "File access is not enabled for remote devices (settings: remote_allow_files)." };
    return grants.files === "write" ? { ok: true } : { ok: false, reason: "Changing files is not enabled for remote devices (settings: remote_allow_files = write)." };
  }

  return { ok: false, reason: "Not available to a remote device." };
}

/** The live socket (`/api/live`): allowed for any remote token; its streams are restricted in live.ts. */
export function remoteMaySocket(path: string, grants: Grants): Decision {
  if (path === "/api/live") return { ok: true };
  if (/^\/api\/terminals\/[^/]+\/ws$/.test(path)) return grants.terminal ? { ok: true } : { ok: false, reason: "Terminals are not enabled for remote devices (settings: remote_allow_terminal)." };
  return { ok: false, reason: "Not available to a remote device." };
}
