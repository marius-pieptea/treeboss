/**
 * `trb mcp-serve`: the MCP server a CLI engine spawns to reach the daemon's subagent tools.
 *
 * Hand-rolled JSON-RPC over stdio (initialize, tools/list, tools/call, ping) rather than an SDK:
 * the surface is four methods, and it keeps the shim's startup, which is paid on every turn of
 * every session, to a single small process. It holds no state. Each tool call is forwarded to the
 * daemon with the caller's session id (`TRB_SESSION`), which is how ownership and depth are
 * decided server-side: the agent cannot claim to be somebody else's parent.
 *
 * Newline-delimited JSON (the MCP stdio transport).
 */
import { subagentToolDefs } from "../sessions/tools";
import { browserToolDefs } from "../browser/defs";
import { computerToolDefs } from "../computer/defs";
import { emulatorToolDefs } from "../emulator/defs";
import { devserverToolDefs } from "../devserver/defs";
import { evidenceToolDefs } from "../evidence/defs";
import { planToolDefs } from "../sessions/planq";
import { titleToolDefs } from "../sessions/title";
import { treebossToolDefs } from "../treeboss/tools";
import { checklistToolDefs } from "../checklists/tools";
import { qaToolDefs } from "../qa/defs";

const PROTOCOL_VERSION = "2025-06-18";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * The tools this shim serves: the subagent tools (unless the session may not open subagents), the browser
 * and computer tools and the evidence tools when the daemon turned them on for this turn, the plan questionnaire tools in plan mode,
 * `session_title` on a lead, the spec and roadmap tools in treeboss mode, checklist_record in a checklist audit, and
 * qa_record and bug_log in a QA agent session.
 */
function toolDefs() {
  const defs: Array<{ name: string; description: string; inputSchema: unknown }> = [];
  if (process.env.TRB_SUBAGENTS !== "0") defs.push(...subagentToolDefs());
  if (process.env.TRB_BROWSER === "1") defs.push(...browserToolDefs(), ...devserverToolDefs());
  if (process.env.TRB_EMULATOR === "1") defs.push(...emulatorToolDefs());
  if (process.env.TRB_EVIDENCE === "1") defs.push(...evidenceToolDefs());
  if (process.env.TRB_COMPUTER === "1") defs.push(...computerToolDefs());
  if (process.env.TRB_PLAN === "1") defs.push(...planToolDefs());
  if (process.env.TRB_TITLE === "1") defs.push(...titleToolDefs());
  if (process.env.TRB_TREEBOSS === "1") defs.push(...treebossToolDefs());
  if (process.env.TRB_CHECKLISTS === "1") defs.push(...checklistToolDefs());
  if (process.env.TRB_QA === "1") defs.push(...qaToolDefs());
  return defs;
}

type CallResult = { text: string; isError: boolean; images?: Array<{ data: string; mimeType: string }>; pending?: string };

async function callDaemon(name: string, args: Record<string, unknown>): Promise<CallResult> {
  const url = process.env.TRB_URL;
  const token = process.env.TRB_TOKEN;
  const session = process.env.TRB_SESSION;
  if (!url || !token || !session) return { text: "trb MCP server is missing TRB_URL / TRB_TOKEN / TRB_SESSION.", isError: true };
  try {
    const res = await fetch(`${url}/api/tools/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-trb-session": session },
      body: JSON.stringify({ name, args }),
    });
    const body = (await res.json().catch(() => null)) as { text?: string; error?: string; images?: Array<{ data: string; mimeType: string }>; pending?: string } | null;
    if (!res.ok) return { text: `trb daemon error (${res.status}): ${body?.error ?? res.statusText}`, isError: true };
    const text = body?.text ?? "";
    return { text, isError: text.startsWith("Error:"), images: body?.images, pending: body?.pending };
  } catch (err: any) {
    return { text: `Could not reach the trb daemon at ${url}: ${err?.message ?? err}. Is it running? (trb daemon status)`, isError: true };
  }
}

async function handle(req: RpcRequest): Promise<void> {
  const reply = (result: unknown) => req.id !== undefined && req.id !== null && send({ jsonrpc: "2.0", id: req.id, result });
  const fail = (code: number, message: string) => req.id !== undefined && req.id !== null && send({ jsonrpc: "2.0", id: req.id, error: { code, message } });

  switch (req.method) {
    case "initialize":
      return void reply({
        protocolVersion: req.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "trb", version: "0.1.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      return void reply({});
    case "tools/list":
      return void reply({ tools: toolDefs().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      if (!toolDefs().some((t) => t.name === name)) return void fail(-32602, `Unknown tool "${name}".`);
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      // A tool that waits on a person (plan_ask) comes back `pending` every few minutes: ask again for the same
      // question, and tell the engine we are alive meanwhile so its own tool timeout does not fire.
      const token = req.params?._meta?.progressToken;
      let ticks = 0;
      const keepalive = token === undefined ? null : setInterval(() => send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++ticks, message: "waiting for the user" } }), 20_000);
      let out = await callDaemon(name, args);
      try {
        while (out.pending) out = await callDaemon(name, { ...args, _resume: out.pending });
      } finally {
        if (keepalive) clearInterval(keepalive);
      }
      return void reply({ content: [{ type: "text", text: out.text }, ...(out.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))], isError: out.isError });
    }
    default:
      if (req.method.startsWith("notifications/")) return;
      return void fail(-32601, `Method not found: ${req.method}`);
  }
}

export async function serveMcp(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const inflight = new Set<Promise<void>>();
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let req: RpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      // Calls run concurrently: a subagent_wait must not block another tool call on the same connection.
      const p = handle(req).catch((err) => {
        if (req.id !== undefined && req.id !== null) send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(err?.message ?? err) } });
      });
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }
  }
  await Promise.allSettled([...inflight]);
}
