/**
 * The CLI's side of the daemon: find it (starting it if needed), call it, follow its event stream.
 */
import fs from "fs";
import { paths } from "../paths";
import { ensureToken, liveDaemon, startDetached, type DaemonInfo } from "../daemon/lifecycle";
import { c, die } from "./fmt";

export interface Conn {
  info: DaemonInfo;
  token: string;
}

let conn: Conn | null = null;

/** The running daemon, starting it on demand (`TRB_NO_AUTOSTART=1` to refuse). */
export async function connect(opts: { autostart?: boolean } = {}): Promise<Conn> {
  if (conn) return conn;
  let info = await liveDaemon();
  if (!info) {
    if (opts.autostart === false || process.env.TRB_NO_AUTOSTART) die("The daemon is not running. Start it with `trb daemon start`.");
    process.stderr.write(c.dim("starting daemon… "));
    try {
      info = await startDetached();
    } catch (err: any) {
      die(err.message);
    }
    process.stderr.write(c.dim("ok\n"));
  }
  conn = { info, token: ensureToken() };
  return conn;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const { info, token } = await connect();
  let res: Response;
  try {
    res = await fetch(`${info.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    die(`Could not reach the daemon at ${info.url}: ${err?.message ?? err}`);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) die(data?.error ?? `${method} ${path} failed (${res.status})`);
  return data as T;
}

/** Resolve a session id from a full id, a unique prefix, or `last` (the newest lead). */
export async function resolveSessionId(input: string): Promise<string> {
  if (/^s_[0-9a-f]{10}$/.test(input)) return input;
  const { sessions } = await api<{ sessions: Array<{ id: string }> }>("GET", "/api/sessions?all=1&closed=1&limit=500");
  if (input === "last" || input === "@") {
    const lead = (await api<{ sessions: Array<{ id: string }> }>("GET", "/api/sessions?closed=1&limit=1")).sessions[0];
    if (!lead) die("No sessions yet.");
    return lead.id;
  }
  const matches = sessions.filter((s) => s.id.startsWith(input) || s.id.startsWith(`s_${input}`));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) die(`No session matches "${input}". See \`trb ls\`.`);
  die(`"${input}" is ambiguous: ${matches.slice(0, 5).map((m) => m.id).join(", ")}${matches.length > 5 ? ", …" : ""}`);
}

export interface FollowEvent {
  event: string;
  data: any;
}

/**
 * Follow a session's SSE stream, calling `onEvent` for each. Resolves when the server sends `done`
 * (with `until=idle`) or the stream ends; `signal` aborts it (a detach).
 */
export async function follow(sessionId: string, opts: { tree?: boolean; untilIdle?: boolean; since?: number; fromTurn?: boolean; signal?: AbortSignal; onEvent: (e: FollowEvent) => void }): Promise<void> {
  const { info, token } = await connect();
  const qs = new URLSearchParams();
  if (opts.tree) qs.set("tree", "1");
  if (opts.untilIdle) qs.set("until", "idle");
  if (opts.since) qs.set("since", String(opts.since));
  if (opts.fromTurn) qs.set("from", "turn");
  const res = await fetch(`${info.url}/api/sessions/${sessionId}/events?${qs}`, { headers: { authorization: `Bearer ${token}` }, signal: opts.signal });
  if (!res.ok || !res.body) die(`Could not follow ${sessionId}: ${res.status} ${await res.text().catch(() => "")}`);
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed: any = data;
        try {
          parsed = JSON.parse(data);
        } catch {}
        opts.onEvent({ event, data: parsed });
        if (event === "done") return;
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError" || opts.signal?.aborted) return;
    throw err;
  }
}

export function tokenFileHint(): string {
  return fs.existsSync(paths.token()) ? paths.token() : "(not created yet)";
}
