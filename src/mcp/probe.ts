/**
 * Probe an MCP server the way an engine would meet it: start it (or reach it), complete the handshake,
 * list its tools. Used by `trb mcp test`, the UI's Test button and `trb doctor`.
 *
 * A probe never throws: a server that does not start, does not speak MCP, or hangs is a result with
 * `ok: false` and the reason, because that is exactly what the operator is trying to find out.
 */

import { VERSION } from "../version";

export interface ProbeTool {
  name: string;
  description: string;
}

export interface ProbeResult {
  ok: boolean;
  transport: "stdio" | "http";
  server?: { name: string; version: string };
  tools: ProbeTool[];
  /** Handshake plus tools/list, wall clock. */
  latencyMs: number;
  error?: string;
  /** http: the server answered 401 and no credentials were sent, so signing in (OAuth) is the likely fix. */
  authRequired?: boolean;
  /** The last of the server's stderr, which is where a crash says why. */
  stderrTail?: string;
}

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "trb", version: VERSION };
const STDERR_CAP = 8 * 1024;

function toolsOf(msg: any): ProbeTool[] {
  const list = msg?.result?.tools;
  if (!Array.isArray(list)) return [];
  return list.map((t: any) => ({ name: String(t?.name ?? ""), description: String(t?.description ?? "").trim() })).filter((t) => t.name);
}

/** Resolves with the response to `id`, or null at the deadline / when the stream ends. */
function rpcReader(stream: ReadableStream<Uint8Array>) {
  const waiters = new Map<number, (m: any) => void>();
  const early = new Map<number, any>();
  let ended = false;
  const dec = new TextDecoder();
  let buf = "";
  const finish = () => {
    ended = true;
    for (const w of waiters.values()) w(null);
    waiters.clear();
  };
  (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("{")) continue; // servers sometimes log to stdout; only JSON-RPC matters
          try {
            const m = JSON.parse(line);
            if (typeof m.id === "number") {
              const w = waiters.get(m.id);
              if (w) {
                waiters.delete(m.id);
                w(m);
              } else early.set(m.id, m);
            }
          } catch {}
        }
      }
    } catch {}
    finish();
  })();
  return {
    wait(id: number, ms: number): Promise<any | null> {
      if (early.has(id)) {
        const m = early.get(id);
        early.delete(id);
        return Promise.resolve(m);
      }
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          waiters.delete(id);
          resolve(null);
        }, ms);
        waiters.set(id, (m) => {
          clearTimeout(t);
          resolve(m);
        });
      });
    },
  };
}

async function collectStderr(stream: ReadableStream<Uint8Array>, sink: { text: string }): Promise<void> {
  const dec = new TextDecoder();
  try {
    for await (const chunk of stream as any as AsyncIterable<Uint8Array>) {
      sink.text = (sink.text + dec.decode(chunk, { stream: true })).slice(-STDERR_CAP);
    }
  } catch {}
}

export async function probeStdio(command: string, args: string[], env: Record<string, string> = {}, opts: { timeoutMs?: number; cwd?: string } = {}): Promise<ProbeResult> {
  const started = Date.now();
  const base: ProbeResult = { ok: false, transport: "stdio", tools: [], latencyMs: 0 };
  const stderr = { text: "" };
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([command, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env }, cwd: opts.cwd, windowsHide: true });
  } catch (err: any) {
    // A missing executable fails here, before any handshake.
    return { ...base, latencyMs: Date.now() - started, error: err?.code === "ENOENT" ? `Command not found: ${command}` : String(err?.message ?? err) };
  }
  const stderrDone = collectStderr(child.stderr as ReadableStream<Uint8Array>, stderr);
  const rpc = rpcReader(child.stdout as ReadableStream<Uint8Array>);
  const send = (msg: unknown) => {
    try {
      (child.stdin as any).write(JSON.stringify(msg) + "\n");
      (child.stdin as any).flush?.();
    } catch {}
  };
  const timeout = opts.timeoutMs ?? 15_000;
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
    const init = await Promise.race([rpc.wait(1, timeout), child.exited.then(() => rpc.wait(1, 200))]);
    if (!init) {
      // Stdout closing is not the same instant as the process being reaped: give the exit a moment to register.
      await Promise.race([child.exited, new Promise((r) => setTimeout(r, 400))]);
      const exited = child.exitCode !== null;
      await Promise.race([stderrDone, new Promise((r) => setTimeout(r, 150))]);
      return {
        ...base,
        latencyMs: Date.now() - started,
        error: exited ? `The server exited${child.exitCode ? ` with code ${child.exitCode}` : ""} before answering.` : `No answer to initialize within ${Math.round(timeout / 1000)}s: is this an MCP server over stdio?`,
        stderrTail: stderr.text.trim() || undefined,
      };
    }
    if (init.error) return { ...base, latencyMs: Date.now() - started, error: `initialize failed: ${init.error.message ?? JSON.stringify(init.error)}`, stderrTail: stderr.text.trim() || undefined };
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await rpc.wait(2, Math.min(timeout, 10_000));
    const result: ProbeResult = {
      ok: true,
      transport: "stdio",
      server: { name: String(init.result?.serverInfo?.name ?? "server"), version: String(init.result?.serverInfo?.version ?? "") },
      tools: toolsOf(list),
      latencyMs: Date.now() - started,
    };
    if (!list) result.error = "Connected, but tools/list did not answer.";
    else if (list.error) result.error = `Connected, but tools/list failed: ${list.error.message ?? "error"}`;
    return result;
  } finally {
    try {
      child.kill();
    } catch {}
  }
}

/** Parse a response that is either plain JSON or an SSE stream carrying one JSON-RPC message. */
async function readHttpRpc(res: Response): Promise<any | null> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    for (const block of text.split("\n\n")) {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        return JSON.parse(data);
      } catch {}
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function probeHttp(url: string, headers: Record<string, string> = {}, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  const started = Date.now();
  const base: ProbeResult = { ok: false, transport: "http", tools: [], latencyMs: 0 };
  const timeout = opts.timeoutMs ?? 15_000;
  const common = { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers };
  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { ...common, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  try {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
    if (res.status === 401 || res.status === 403) {
      const sent = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
      const authRequired = res.status === 401 && !sent;
      return { ...base, latencyMs: Date.now() - started, authRequired, error: `The server refused the credentials (HTTP ${res.status}). ${authRequired ? "Sign in, or add an Authorization header." : "Sign in again, or check the headers."}` };
    }
    if (!res.ok) return { ...base, latencyMs: Date.now() - started, error: `HTTP ${res.status} ${res.statusText}`.trim() };
    const sid = res.headers.get("mcp-session-id");
    const init = await readHttpRpc(res);
    if (!init?.result) return { ...base, latencyMs: Date.now() - started, error: "Reachable, but the response is not an MCP initialize result." };
    const extra: Record<string, string> = sid ? { "mcp-session-id": sid } : {};
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, extra).then((r) => r.arrayBuffer()).catch(() => {});
    let tools: ProbeTool[] = [];
    let note: string | undefined;
    try {
      const lr = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, extra);
      tools = toolsOf(await readHttpRpc(lr));
    } catch {
      note = "Connected, but tools/list failed.";
    }
    return { ok: true, transport: "http", server: { name: String(init.result?.serverInfo?.name ?? "server"), version: String(init.result?.serverInfo?.version ?? "") }, tools, latencyMs: Date.now() - started, error: note };
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ...base, latencyMs: Date.now() - started, error: timedOut ? `No answer within ${Math.round(timeout / 1000)}s.` : `Could not reach ${url}: ${err?.cause?.code ?? err?.message ?? err}` };
  }
}
