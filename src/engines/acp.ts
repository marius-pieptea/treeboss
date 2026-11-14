/**
 * Minimal ACP (Agent Client Protocol) driver, ported from Omni's `harness/acp`.
 *
 * `devin acp` is a session server, not a one-shot printer: a turn is a request sequence (`initialize`,
 * `session/new` or `session/load`, `session/prompt`) as JSON-RPC on stdin, with progress arriving as
 * `session/update` notifications on stdout. The stream accumulator reads that same stdout for progress
 * and the answer; this client reads it for the request/response lifecycle.
 *
 * A message with both an id and a method is a server→client request and must be answered or the agent
 * blocks: `session/request_permission` is approved (or refused, for a read-only turn), anything else gets
 * a JSON-RPC method-not-found so the agent can decide rather than hang.
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { DETACH_GROUP, killTree } from "../proctree";
import { shimInvocation } from "./win-shim";

export interface AcpStdin {
  write: (s: string) => unknown;
  end: () => unknown;
}

export class AcpStdioClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private lineBuffer = "";

  /** allowTools false: permission requests are refused (plan and ask turns are read-only). */
  constructor(
    private stdin: AcpStdin,
    private allowTools = true,
  ) {}

  /** Feed stdout bytes; complete JSON-RPC lines are dispatched. */
  feed(chunk: string): void {
    this.lineBuffer += chunk;
    let idx: number;
    while ((idx = this.lineBuffer.indexOf("\n")) !== -1) {
      const line = this.lineBuffer.slice(0, idx).trim();
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (!line.startsWith("{")) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && typeof msg.method === "string") {
        this.answerServerRequest(msg);
        continue;
      }
      if (msg.id === undefined) continue;
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(typeof msg.error?.message === "string" ? msg.error.message : "ACP error"));
      else waiter.resolve(msg.result);
    }
  }

  private answerServerRequest(msg: any): void {
    if (msg.method === "session/request_permission") {
      const list: any[] = Array.isArray(msg.params?.options) ? msg.params.options : [];
      const pick = (re: RegExp) => list.find((o) => re.test(`${o?.kind ?? ""} ${o?.name ?? ""} ${o?.optionId ?? ""}`));
      const chosen = this.allowTools ? (pick(/allow|approve|yes|always/i) ?? list[0]) : pick(/reject|deny|no\b/i);
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId ?? chosen.id } } : { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not implemented: ${msg.method}` } });
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Half-close stdin so the server exits once the turn is over. */
  end(): void {
    try {
      this.stdin.end();
    } catch {}
  }

  /** Unblock every outstanding request when the process dies mid-handshake. */
  abort(reason: string): void {
    const err = new Error(reason);
    for (const w of this.pending.values()) w.reject(err);
    this.pending.clear();
  }

  private send(msg: Record<string, unknown>): void {
    try {
      this.stdin.write(JSON.stringify(msg) + "\n");
    } catch {}
  }
}

/** Start the server in a scratch directory, ask for a session, read its models, and tear the tree down. Rejects on failure or timeout. */
export async function discoverAcpModels(cmd: string, args: string[], timeoutMs: number): Promise<AcpModel[]> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trb-acp-"));
  const inv = shimInvocation(cmd, args);
  const child = spawn(inv.file, inv.args, { cwd: scratch, env: { ...process.env, CI: "true", NO_COLOR: "1" }, detached: DETACH_GROUP, windowsHide: true, windowsVerbatimArguments: inv.verbatim, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  child.stderr.resume(); // a chatty server must not block on a full pipe
  const client = new AcpStdioClient(child.stdin);
  child.stdout.on("data", (d: Buffer) => client.feed(d.toString()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "trb", version: "0.1.0" } });
        return modelsFromSession(await client.request("session/new", { cwd: scratch, mcpServers: [] }));
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no session in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
        child.on("error", reject);
        child.on("exit", () => reject(new Error("exited before answering")));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    client.abort("done");
    killTree(child.pid, "SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }
}

export interface AcpModel {
  id: string;
  name?: string;
  description?: string;
  isDefault?: boolean;
}

function flattenSelect(options: unknown): Array<{ value: string; name?: string; description?: string }> {
  if (!Array.isArray(options)) return [];
  return options.flatMap((o: any) => (typeof o?.value === "string" ? [o] : flattenSelect(o?.options)));
}

/**
 * The models a `session/new` result advertises: the `model` config option (current protocol), or the older
 * `models.availableModels`. This is what a static list can never know, since the agent adds models without a release here.
 */
export function modelsFromSession(res: any): AcpModel[] {
  const opts: any[] = Array.isArray(res?.configOptions) ? res.configOptions : [];
  const opt = opts.find((o) => o?.category === "model" || o?.id === "model");
  if (opt) return flattenSelect(opt.options).map((c) => ({ id: c.value, name: c.name, description: c.description, isDefault: c.value === opt.currentValue }));
  const legacy = res?.models?.availableModels;
  if (Array.isArray(legacy)) {
    return legacy.filter((m: any) => m?.modelId).map((m: any) => ({ id: String(m.modelId), name: m.name, description: m.description, isDefault: m.modelId === res.models.currentModelId }));
  }
  return [];
}

/**
 * Drive one session lifecycle against a spawned server. The workspace travels as the session's `cwd`, never
 * as a flag. The prompt response ends the turn. `onSettled` fires once, with ok false when any request in
 * the lifecycle failed: the error response has already reached the accumulator through stdout, which is
 * where a refused resume is recognised, so the caller only needs to stop waiting for the process.
 */
export function driveAcpSession(opts: {
  client: AcpStdioClient;
  cwd: string;
  mcpServers?: unknown[];
  prompt: string;
  resumeId?: string | null;
  onSessionId?: (id: string) => void;
  /** Fired just before `session/prompt`: history replayed by `session/load` is over. */
  onPromptStarted?: () => void;
  onLog?: (line: string) => void;
  onSettled: (ok: boolean) => void;
}): void {
  const { client } = opts;
  void (async () => {
    try {
      const init = await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "trb", version: "0.1.0" },
      });
      // An absent loadSession flag may just be an unadvertised feature; a real error beats silently dropping the history.
      const canLoad = init?.agentCapabilities?.loadSession !== false;
      const useLoad = Boolean(opts.resumeId) && canLoad;
      const res = await client.request(useLoad ? "session/load" : "session/new", {
        ...(useLoad ? { sessionId: opts.resumeId } : {}),
        cwd: opts.cwd,
        mcpServers: opts.mcpServers ?? [],
      });
      const sessionId: string | null = res?.sessionId ?? (useLoad ? opts.resumeId! : null);
      if (!sessionId) throw new Error("ACP session did not return a sessionId");
      opts.onSessionId?.(sessionId);
      opts.onPromptStarted?.();
      await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: opts.prompt }] });
      client.end();
      opts.onSettled(true);
    } catch (err: any) {
      opts.onLog?.(`[trb] ACP session failed: ${err?.message ?? err}`);
      opts.onSettled(false);
    }
  })();
}
