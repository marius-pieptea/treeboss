/**
 * The MCP registry: the servers trb hands to the engines it launches.
 *
 * For claude this list is the engine's ENTIRE tool surface (`--strict-mcp-config`), so a session's
 * tools are deterministic rather than whatever happens to sit in the operator's `~/.claude.json`.
 * `trb mcp import` copies those across when you want them. The `trb` server (the subagent tools)
 * is always injected per run and is not stored here.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { db } from "../db";
import { home } from "../paths";
import { selfInvocation } from "../self";
import type { McpRunConfig, McpServerSpec } from "../engines/registry";
import { parseList, UserError } from "../util";
import { codegraphFor } from "../codegraph/detect";
import { REA_NAME, reaLaunch } from "../evidence/rea";
import { reaEnv } from "../evidence/readiness";

export const RESERVED_MCP_NAMES = new Set(["trb", "codegraph"]);
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

export interface McpServerRecord {
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  created_at: string;
}

function parseObj(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function row(r: any): McpServerRecord {
  return {
    name: r.name,
    transport: r.transport,
    command: r.command,
    args: parseList(r.args_json),
    env: parseObj(r.env_json),
    url: r.url,
    headers: parseObj(r.headers_json),
    enabled: r.enabled === 1,
    created_at: r.created_at,
  };
}

export interface McpInput {
  name: string;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
}

export const McpStore = {
  list(): McpServerRecord[] {
    return (db().prepare("SELECT * FROM mcp_servers ORDER BY name").all() as any[]).map(row);
  },

  get(name: string): McpServerRecord | null {
    const r = db().prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name);
    return r ? row(r) : null;
  },

  /** Insert or replace. A stdio server needs a command; an http one a URL. */
  put(input: McpInput): McpServerRecord {
    const name = input.name.trim();
    if (!NAME_RE.test(name)) throw new UserError(`MCP name "${name}" must be 1-40 letters, digits, "_" or "-".`);
    if (RESERVED_MCP_NAMES.has(name)) throw new UserError(`"${name}" is reserved: trb injects its own server under that name.`);
    const command = input.command?.trim() || null;
    const url = input.url?.trim() || null;
    if (!command && !url) throw new UserError("An MCP server needs a command (stdio) or a url (http).");
    if (command && url) throw new UserError("Give either a command or a url, not both.");
    if (url && !/^https?:\/\//i.test(url)) throw new UserError(`url must start with http:// or https:// (got "${url}").`);
    const prev = this.get(name);
    db()
      .prepare(
        `INSERT INTO mcp_servers (name, transport, command, args_json, env_json, url, headers_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET transport = excluded.transport, command = excluded.command, args_json = excluded.args_json,
           env_json = excluded.env_json, url = excluded.url, headers_json = excluded.headers_json`,
      )
      .run(name, command ? "stdio" : "http", command, JSON.stringify(input.args ?? []), JSON.stringify(input.env ?? {}), url, JSON.stringify(input.headers ?? {}), prev ? (prev.enabled ? 1 : 0) : 1);
    return this.get(name)!;
  },

  remove(name: string): boolean {
    return db().prepare("DELETE FROM mcp_servers WHERE name = ?").run(name).changes > 0;
  },

  setEnabled(name: string, enabled: boolean): boolean {
    return db().prepare("UPDATE mcp_servers SET enabled = ? WHERE name = ?").run(enabled ? 1 : 0, name).changes > 0;
  },

  /**
   * Import `mcpServers` from a JSON file in the common shape (`~/.claude.json`, a project
   * `.mcp.json`, `.cursor/mcp.json`). Existing names are skipped unless `overwrite`.
   */
  importFile(file: string, opts: { overwrite?: boolean } = {}): { added: string[]; skipped: string[]; invalid: string[] } {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const servers: Record<string, any> = raw?.mcpServers ?? {};
    const added: string[] = [];
    const skipped: string[] = [];
    const invalid: string[] = [];
    for (const [name, s] of Object.entries(servers)) {
      if (!s || typeof s !== "object") {
        invalid.push(name);
        continue;
      }
      if (this.get(name) && !opts.overwrite) {
        skipped.push(name);
        continue;
      }
      try {
        this.put({
          name,
          command: typeof s.command === "string" ? s.command : null,
          args: Array.isArray(s.args) ? s.args.map(String) : [],
          env: s.env && typeof s.env === "object" ? s.env : {},
          url: typeof s.url === "string" ? s.url : null,
          headers: s.headers && typeof s.headers === "object" ? s.headers : {},
        });
        added.push(name);
      } catch {
        invalid.push(name);
      }
    }
    return { added, skipped, invalid };
  },

  /** The default place `trb mcp import --from claude` reads. */
  claudeUserConfig(): string {
    return path.join(os.homedir(), ".claude.json");
  },
};

/**
 * The servers one turn runs with: every enabled registry entry, plus trb's own `trb` server
 * (the subagent tools) when the session may open subagents. `TRB_URL`/`TRB_TOKEN`/`TRB_SESSION`
 * tell that child process which daemon and which caller it speaks for.
 */
export function buildRunMcpConfig(opts: { sessionId: string; subagents: boolean; daemonUrl: string; token: string; allowed?: string[] | null; browser?: boolean; emulator?: boolean; computer?: boolean; evidence?: boolean; rea?: boolean; plan?: boolean; title?: boolean; treeboss?: boolean; checklists?: boolean; qa?: boolean; ask?: boolean; codegraphDir?: string | null }): McpRunConfig {
  const out: McpRunConfig = {};
  // Ask mode is lean: the operator's own servers, the subagent shim and the browser stay out. Only CodeGraph's read tools.
  for (const s of opts.ask ? [] : McpStore.list()) {
    if (!s.enabled) continue;
    if (opts.allowed && !opts.allowed.includes(s.name)) continue;
    const spec: McpServerSpec =
      s.transport === "stdio"
        ? { type: "stdio", command: s.command!, args: s.args, env: s.env }
        : { type: "http", url: s.url!, headers: s.headers };
    out[s.name] = spec;
  }
  // Built in, like `trb`: present only when the project already has an index and the setting is on.
  const cg = opts.codegraphDir ? codegraphFor(opts.codegraphDir, opts.allowed) : null;
  if (cg) out.codegraph = { type: "stdio", command: cg.bin, args: ["serve", "--mcp", "--path", cg.root], env: {} };
  // REA (on by default, third party): a plain stdio server like any registry entry, unless the operator registered one under that name.
  const rea = opts.rea && !opts.ask && !out[REA_NAME] && (!opts.allowed || opts.allowed.includes(REA_NAME)) ? reaLaunch() : null;
  if (rea) out[REA_NAME] = { type: "stdio", command: rea.command, args: rea.args, env: reaEnv() };
  if (!opts.ask && (opts.subagents || opts.plan || opts.emulator || opts.computer || opts.title || opts.evidence || opts.treeboss || opts.checklists || opts.qa)) {
    const self = selfInvocation();
    out.trb = {
      type: "stdio",
      command: self.command,
      args: [...self.args, "mcp-serve"],
      env: { TRB_URL: opts.daemonUrl, TRB_TOKEN: opts.token, TRB_SESSION: opts.sessionId, TRB_HOME: home(), TRB_BROWSER: opts.browser ? "1" : "0", TRB_EMULATOR: opts.emulator ? "1" : "0", TRB_COMPUTER: opts.computer ? "1" : "0", TRB_EVIDENCE: opts.evidence ? "1" : "0", TRB_PLAN: opts.plan ? "1" : "0", TRB_TITLE: opts.title ? "1" : "0", TRB_TREEBOSS: opts.treeboss ? "1" : "0", TRB_CHECKLISTS: opts.checklists ? "1" : "0", TRB_QA: opts.qa ? "1" : "0", TRB_SUBAGENTS: opts.subagents ? "1" : "0" },
    };
  }
  return out;
}
