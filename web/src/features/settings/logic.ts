/**
 * Pure logic behind the settings pages: no React, no network, relative imports only, so it can be unit
 * tested with `bun test` and reused by any page.
 */

/* -------------------------------------------------------------------------- */
/* Command-line arguments                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Split a command line the way a shell would, minus expansion: whitespace separates, single quotes are
 * literal, double quotes allow `\"` and `\\`, and a backslash outside quotes escapes the next character.
 * An unterminated quote runs to the end (the field is being typed, not submitted).
 */
export function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) cur += input[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** The inverse, for showing stored args back in one input: quote only what needs it. */
export function joinArgs(args: string[]): string {
  return args
    .map((a) => {
      if (a === "") return "''";
      if (!/[\s'"\\]/.test(a)) return a;
      return `'${a.replace(/'/g, `'\\''`)}'`;
    })
    .join(" ");
}

/* -------------------------------------------------------------------------- */
/* Pasted MCP configuration                                                   */
/* -------------------------------------------------------------------------- */

export interface ParsedMcpServer {
  /** null: a single server pasted without a name; the form asks for one. */
  name: string | null;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
}

export interface McpPasteResult {
  servers: ParsedMcpServer[];
  errors: string[];
  warnings: string[];
}

const MCP_NAME = /^[A-Za-z0-9_-]{1,40}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const [k, val] of Object.entries(v)) if (val !== null && val !== undefined) out[k] = String(val);
  return out;
};
const looksLikeServer = (v: unknown): v is Record<string, unknown> => isObj(v) && (typeof v.command === "string" || typeof v.url === "string" || typeof v.serverUrl === "string");

function normalizeServer(name: string | null, raw: Record<string, unknown>, res: McpPasteResult): ParsedMcpServer | null {
  const label = name ?? "server";
  const url = typeof raw.url === "string" ? raw.url : typeof raw.serverUrl === "string" ? raw.serverUrl : undefined;
  let command = typeof raw.command === "string" ? raw.command.trim() : undefined;
  if (command && url) {
    res.errors.push(`"${label}": has both a command and a url; a server is one or the other.`);
    return null;
  }
  if (!command && !url) {
    res.errors.push(`"${label}": needs a command (stdio) or a url (http).`);
    return null;
  }
  if (name !== null) {
    if (name === "trb") {
      res.errors.push(`"trb" is reserved: trb injects its own server under that name.`);
      return null;
    }
    if (!MCP_NAME.test(name)) {
      res.errors.push(`"${name}": a name is 1-40 letters, digits, "_" or "-".`);
      return null;
    }
  }
  let args: string[] = [];
  if (Array.isArray(raw.args)) args = raw.args.map(String);
  else if (typeof raw.args === "string") args = tokenizeArgs(raw.args);
  else if (command && /\s/.test(command) && !/^([A-Za-z]:\\|\/|~)/.test(command)) {
    // "command": "npx -y some-server": a common paste. A path with spaces is left alone.
    const parts = tokenizeArgs(command);
    command = parts[0];
    args = parts.slice(1);
  }
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  if (url && type === "sse") res.warnings.push(`"${label}": declared as SSE; trb connects over streamable HTTP, which most servers also accept at the same URL.`);
  if (url && !/^https?:\/\//i.test(url)) {
    res.errors.push(`"${label}": url must start with http:// or https://.`);
    return null;
  }
  return { name, command, args: command ? args : [], env: strMap(raw.env), url, headers: strMap(raw.headers) };
}

/**
 * Read whatever someone copied from a README or another tool's config: `{"mcpServers": {...}}`, the `{"servers": {...}}` shape
 * some editors use, a bare name -> server map, one server on its own, or an array of named servers.
 */
export function parseMcpPaste(text: string): McpPasteResult {
  const res: McpPasteResult = { servers: [], errors: [], warnings: [] };
  const src = text.trim();
  if (!src) return res;
  let doc: unknown;
  try {
    doc = JSON.parse(src);
  } catch (err: any) {
    // A README snippet is often a fragment: `"name": { ... }`. Try it as the inside of an object.
    try {
      doc = JSON.parse(`{${src.replace(/^,|,$/g, "")}}`);
    } catch {
      res.errors.push(`Not valid JSON: ${String(err?.message ?? err).replace(/^JSON Parse error:\s*/i, "")}`);
      return res;
    }
  }
  const add = (name: string | null, raw: unknown) => {
    if (!isObj(raw)) {
      res.errors.push(`"${name ?? "server"}": expected an object.`);
      return;
    }
    const s = normalizeServer(name, raw, res);
    if (s) res.servers.push(s);
  };

  if (Array.isArray(doc)) {
    doc.forEach((item) => add(isObj(item) && typeof item.name === "string" ? item.name : null, item));
    if (!doc.length) res.errors.push("The list is empty.");
    return res;
  }
  if (!isObj(doc)) {
    res.errors.push("Expected a JSON object.");
    return res;
  }
  const container = isObj(doc.mcpServers) ? doc.mcpServers : isObj(doc.servers) ? doc.servers : null;
  if (container) {
    const entries = Object.entries(container);
    if (!entries.length) res.errors.push("No servers found in the list.");
    for (const [name, raw] of entries) add(name, raw);
    return res;
  }
  if (looksLikeServer(doc)) {
    add(typeof doc.name === "string" ? doc.name : null, doc);
    return res;
  }
  // A bare map: every value is a server.
  const entries = Object.entries(doc);
  if (entries.length && entries.every(([, v]) => looksLikeServer(v))) {
    for (const [name, raw] of entries) add(name, raw);
    return res;
  }
  res.errors.push('Could not find a server here. Expected {"mcpServers": {...}}, a name -> server map, or one server with a "command" or "url".');
  return res;
}

/** Heuristic: does a key or header name look like it holds a credential? Used to mask values by default. */
export function looksSecret(key: string): boolean {
  return /(key|token|secret|password|passwd|auth|bearer|credential|cookie|session)/i.test(key);
}

/* -------------------------------------------------------------------------- */
/* Hydra pairs: form <-> API                                                  */
/* -------------------------------------------------------------------------- */

export interface RoleForm {
  /** What the lead passes as `role`. */
  key: string;
  engine: string;
  model: string;
  effort: string;
  /** A specialized agent this role runs as ("" for none). */
  agent: string;
  instructions: string;
  label: string;
}

export interface PairForm {
  title: string;
  mode: "heads" | "roles";
  leadEngine: string;
  leadModel: string;
  leadEffort: string;
  headsEngine: string;
  headsModel: string;
  headsEffort: string;
  roles: RoleForm[];
  /** null: no cap. */
  maxHeads: number | null;
  /** A standing brief for the lead ("" for none). Capped at LEAD_INSTRUCTIONS_MAX. */
  leadInstructions: string;
}

export interface PairLike {
  title: string;
  mode: "heads" | "roles";
  lead_engine?: string | null;
  lead_model?: string | null;
  lead_effort?: string | null;
  heads_engine?: string | null;
  heads_model?: string | null;
  heads_effort?: string | null;
  roles?: Record<string, { engine?: string | null; model?: string | null; effort?: string | null; agent?: string | null; instructions?: string | null; label?: string | null }> | null;
  max_heads?: number | null;
  lead_instructions?: string | null;
}

export const MAX_HEADS = { min: 1, max: 8 } as const;
/** The same cap the daemon enforces (hydra/pairs.ts LEAD_INSTRUCTIONS_CHARS). */
export const LEAD_INSTRUCTIONS_MAX = 2_000;

/** The same normalisation the daemon applies to role keys, so the form shows what will be stored. */
export function normalizeRoleKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The preset a role came from: the one its key names, else the one its label names (a preset role given its own key). */
export function presetOfRole<P extends { id: string; label: string }>(role: Pick<RoleForm, "key" | "label">, presets: P[]): P | undefined {
  const key = normalizeRoleKey(role.key);
  const label = role.label.trim().toLowerCase();
  return presets.find((p) => p.id === key) ?? (label ? presets.find((p) => p.label.toLowerCase() === label) : undefined);
}

/**
 * The role with `agent` picked. A preset's untouched text is dropped: it was written for a plain role, the agent's own
 * instructions replace it (as when a role is created with an agent), and kept it would be appended after them.
 */
export function withAgent(role: RoleForm, agent: string, preset: { instructions: string } | undefined): RoleForm {
  const untouched = !!preset && role.instructions.trim() === preset.instructions.trim();
  return { ...role, agent, instructions: agent && untouched ? "" : role.instructions };
}

/**
 * A warning when a role runs an agent and its instructions are still a preset's text: heads get the agent's instructions,
 * then this text, and the two were written apart (a "Docs" preset says write docs; the comment-sicko agent, never write).
 */
export function presetAgentConflict(role: RoleForm, preset: { label: string; instructions: string } | undefined, agentTitle: string | null): string | null {
  if (!agentTitle || !preset || !role.instructions.trim() || role.instructions.trim() !== preset.instructions.trim()) return null;
  return `These instructions are the ${preset.label} preset's text. Heads get the agent “${agentTitle}” instructions first, then this, so the two may contradict. Clear it unless the role needs both.`;
}

/** What /api/cli-link reports (src/cli-link.ts). */
export interface CliLinkStatus {
  binary: string | null;
  installed: boolean;
  targets: Array<{ path: string; state: "absent" | "ours" | "stale" | "other"; writable: boolean; onPath: boolean }>;
}

/**
 * The settings card for the `trb` command: null when there is nothing to say (already on PATH, or a daemon run from
 * source), else a line and, when trb can do it, the folder to link into: one on PATH first, then any writable one.
 */
export function cliLinkOffer(s: CliLinkStatus): { text: string; target: string | null } | null {
  if (!s.binary || s.installed) return null;
  const usable = s.targets.filter((t) => t.writable && t.state !== "other");
  const target = usable.find((t) => t.onPath) ?? usable[0] ?? null;
  if (!target) return { text: `The trb command is not on your PATH, and neither ${s.targets.map((t) => t.path).join(" nor ")} can be written. Run: sudo ln -sf "${s.binary}" /usr/local/bin/trb`, target: null };
  const linked = s.targets.find((t) => t.state === "ours");
  if (linked && !linked.onPath) return { text: `trb is linked at ${linked.path}, but that folder is not on your PATH. Add it to your shell profile: export PATH="${linked.path.replace(/\/trb$/, "")}:$PATH"`, target: null };
  return { text: `The trb command is not on your PATH, so commands like \`trb config set\` do not work in a terminal. Link it into ${target.path.replace(/\/trb$/, "")}${target.onPath ? "" : " (then add that folder to your PATH)"}.`, target: target.path };
}

export const emptyPairForm = (): PairForm => ({ title: "", mode: "heads", leadEngine: "claude", leadModel: "", leadEffort: "", headsEngine: "claude", headsModel: "", headsEffort: "", roles: [], maxHeads: null, leadInstructions: "" });

export function pairToForm(p: PairLike): PairForm {
  const roles: RoleForm[] = p.mode === "roles" ? Object.entries(p.roles ?? {}).map(([key, r]) => ({ key, engine: r.engine ?? "", model: r.model ?? "", effort: r.effort ?? "", agent: r.agent ?? "", instructions: r.instructions ?? "", label: r.label ?? "" })) : [];
  return {
    title: p.title,
    mode: p.mode,
    leadEngine: p.lead_engine ?? "",
    leadModel: p.lead_model ?? "",
    leadEffort: p.lead_effort ?? "",
    headsEngine: p.heads_engine ?? "",
    headsModel: p.heads_model ?? "",
    headsEffort: p.heads_effort ?? "",
    roles,
    maxHeads: p.max_heads ?? null,
    leadInstructions: p.lead_instructions ?? "",
  };
}

const orNull = (s: string): string | null => (s.trim() ? s.trim() : null);

/**
 * The request body. A pair is exactly one mode: a heads pair carries no roles, a roles pair carries no
 * heads config (the daemon would clear it anyway; sending it clean keeps the intent visible).
 */
export function formToPayload(f: PairForm): Record<string, unknown> {
  const base = {
    title: f.title.trim(),
    mode: f.mode,
    lead_engine: orNull(f.leadEngine),
    lead_model: orNull(f.leadModel),
    lead_effort: orNull(f.leadEffort),
    max_heads: f.maxHeads,
    lead_instructions: orNull(f.leadInstructions),
  };
  if (f.mode === "heads") {
    return { ...base, heads_engine: orNull(f.headsEngine), heads_model: orNull(f.headsModel), heads_effort: orNull(f.headsEffort), roles: null };
  }
  const roles: Record<string, unknown> = {};
  for (const r of f.roles) {
    const key = normalizeRoleKey(r.key);
    if (!key) continue;
    // `agent` is only sent when set: a role without one simply has none (the daemon replaces the whole roles object).
    roles[key] = { engine: orNull(r.engine), model: orNull(r.model), effort: orNull(r.effort), ...(r.agent.trim() ? { agent: r.agent.trim() } : {}), instructions: orNull(r.instructions), label: orNull(r.label) };
  }
  return { ...base, heads_engine: null, heads_model: null, heads_effort: null, roles };
}

/** Problems the daemon would reject, caught before the round trip, in the daemon's words. */
export function validatePairForm(f: PairForm): string[] {
  const errors: string[] = [];
  if (!f.title.trim()) errors.push("pair needs a title");
  if (f.maxHeads !== null && (!Number.isInteger(f.maxHeads) || f.maxHeads < MAX_HEADS.min || f.maxHeads > MAX_HEADS.max)) errors.push(`heads cap must be ${MAX_HEADS.min}-${MAX_HEADS.max}`);
  if (f.leadInstructions.length > LEAD_INSTRUCTIONS_MAX) errors.push(`lead instructions are ${f.leadInstructions.length.toLocaleString()} characters; the limit is ${LEAD_INSTRUCTIONS_MAX.toLocaleString()}`);
  if (f.mode === "roles") {
    const seen = new Set<string>();
    let named = 0;
    for (const r of f.roles) {
      const key = normalizeRoleKey(r.key);
      if (!key) {
        errors.push("every role needs a name");
        continue;
      }
      named++;
      if (seen.has(key)) errors.push(`duplicate role "${key}"`);
      seen.add(key);
    }
    if (named === 0) errors.push("a roles pair needs at least one role");
  }
  return errors;
}

/** Switching mode keeps what makes sense: heads fields seed the first role, the first role seeds heads. */
export function switchPairMode(f: PairForm, mode: "heads" | "roles"): PairForm {
  if (f.mode === mode) return f;
  if (mode === "roles") {
    const roles = f.roles.length ? f.roles : [{ key: "worker", engine: f.headsEngine || f.leadEngine, model: f.headsModel, effort: f.headsEffort, agent: "", instructions: "", label: "" }];
    return { ...f, mode, roles };
  }
  const first = f.roles[0];
  return { ...f, mode, headsEngine: f.headsEngine || first?.engine || f.leadEngine, headsModel: f.headsModel || first?.model || "", headsEffort: f.headsEffort || first?.effort || "" };
}

/* -------------------------------------------------------------------------- */
/* Daemon settings                                                            */
/* -------------------------------------------------------------------------- */

export interface SettingMeta {
  key: string;
  /** toggle: a two-value setting shown as a switch; options are [off value, on value]. */
  kind: "number" | "string" | "enum" | "toggle";
  options?: string[];
  min?: number;
  max?: number;
  restart?: boolean;
  group: string;
  label: string;
}

const TOGGLE = ["off", "on"];

/** What the daemon does not tell us: which strings are enumerations, sensible bounds, and how to group them. */
export const SETTING_META: Record<string, Omit<SettingMeta, "key" | "kind"> & { kind?: SettingMeta["kind"] }> = {
  default_engine: { group: "General", label: "Default engine" },
  port: { group: "General", label: "Daemon port", min: 1, max: 65535, restart: true },
  max_depth: { group: "Subagents", label: "Nesting depth", min: 1, max: 6 },
  max_per_parent: { group: "Subagents", label: "Open subagents per session", min: 1, max: 32 },
  max_concurrent: { group: "Subagents", label: "Concurrent turns", min: 1, max: 64 },
  wait_default_sec: { group: "Subagents", label: "Default wait (seconds)", min: 1, max: 600 },
  wait_max_sec: { group: "Subagents", label: "Longest wait (seconds)", min: 1, max: 600 },
  wait_total_sec: { group: "Subagents", label: "Longest single wait call (seconds)", min: 1, max: 7200 },
  idle_close_hours: { group: "Subagents", label: "Close idle subagents after (hours)", min: 1, max: 720 },
  lead_idle_close_hours: { group: "Subagents", label: "Close idle leads after (hours, 0 = never)", min: 0, max: 720 },
  min_free_memory_mb: { group: "General", label: "Refuse new turns below free memory (MB, 0 = never)", min: 0, max: 131072 },
  leftover_reap_hours: { group: "Subagents", label: "Stop leftover background processes after (hours, 0 = never)", min: 0, max: 720 },
  turn_idle_timeout_sec: { group: "Turns", label: "Stop a silent turn after (seconds)", min: 10, max: 86400 },
  turn_ceiling_sec: { group: "Turns", label: "Longest turn, waits excluded (seconds)", min: 10, max: 86400 },
  turn_hard_ceiling_sec: { group: "Turns", label: "Longest turn, waits included (seconds)", min: 10, max: 86400 },
  claude_max_turns: { group: "Turns", label: "Claude turn cap (0 = none)", min: 0, max: 100000 },
  mcp_isolation: { group: "Tools", label: "MCP isolation", kind: "enum", options: ["strict", "merge"] },
  worktree_setup_cmd: { group: "Tools", label: "Worktree setup command" },
  worktree_deps: { group: "Tools", label: "node_modules in subagent worktrees", kind: "enum", options: ["clone", "link", "off"] },
  skills_link: { group: "Tools", label: "Link skills into the workspace", kind: "toggle", options: TOGGLE },
  agent_browser: { group: "Tools", label: "Browser tools for agents", kind: "toggle", options: TOGGLE },
  computer_use: { group: "Tools", label: "Computer use (control the screen)", kind: "toggle", options: TOGGLE },
  session_titles: { group: "Turns", label: "Name sessions automatically", kind: "toggle", options: TOGGLE },
  next_steps: { group: "Turns", label: "Suggest next steps after a turn", kind: "toggle", options: TOGGLE },
  treeboss_mode: { group: "Turns", label: "Treeboss mode for new sessions", kind: "toggle", options: TOGGLE },
  evidence: { group: "Tools", label: "Evidence tools (capture pages, save findings)", kind: "toggle", options: TOGGLE },
  rea_mcp: { group: "Tools", label: "REA reverse-engineering server (third party)", kind: "toggle", options: TOGGLE },
  rea_command: { group: "Tools", label: "REA start command" },
  codegraph: { group: "Tools", label: "CodeGraph tools in indexed projects", kind: "toggle", options: ["off", "auto"] },
  llm_provider: { group: "Local model", label: "Local model for background tasks (Ollama)", kind: "toggle", options: ["off", "ollama"] },
  ollama_url: { group: "Local model", label: "Ollama address" },
  ollama_model: { group: "Local model", label: "Ollama model" },
  llm_timeout_sec: { group: "Local model", label: "Give up after (seconds)", min: 1, max: 120 },
  default_skills: { group: "Tools", label: "Default skills" },
  ask_models: { group: "Ask mode", label: "Models for new ask sessions (engine=model, comma separated)" },
  ask_model_override: { group: "Ask mode", label: "Use the ask model inside an existing session", kind: "toggle", options: TOGGLE },
  remote_mode: { group: "Remote access", label: "Remote access mode", kind: "enum", options: ["off", "lan", "tailscale"] },
  remote_allow_terminal: { group: "Remote access", label: "Allow terminals", kind: "toggle", options: TOGGLE },
  remote_allow_files: { group: "Remote access", label: "Allow workspace files", kind: "enum", options: ["off", "read", "write"] },
  remote_token_days: { group: "Remote access", label: "Device sign-in lasts (days)", min: 1, max: 365 },
};

export const SETTING_GROUPS = ["General", "Subagents", "Turns", "Tools", "Ask mode", "Local model", "Remote access"] as const;

export function settingMeta(key: string, def: string | number): SettingMeta {
  const m = SETTING_META[key];
  const kind: SettingMeta["kind"] = m?.kind ?? (typeof def === "number" ? "number" : "string");
  return { key, kind, group: m?.group ?? "Other", label: m?.label ?? key, options: m?.options, min: m?.min, max: m?.max, restart: m?.restart };
}

/** Whether a setting matches a search: its label, key, group or help text, case-insensitively, every word must match somewhere. */
export function settingMatches(query: string, s: { key: string; help: string; group: string; label: string }): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${s.label} ${s.key} ${s.group} ${s.help}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface Coerced {
  /** The string to send, or null when the input is not acceptable. */
  value: string | null;
  error?: string;
}

/** Validate what was typed before sending it; the daemon re-checks, but a typo should not cost a request. */
export function coerceSetting(meta: SettingMeta, input: string): Coerced {
  const text = input.trim();
  if (meta.kind === "number") {
    if (text === "") return { value: null, error: "Enter a number." };
    const n = Number(text);
    if (!Number.isFinite(n)) return { value: null, error: "Must be a number." };
    if (!Number.isInteger(n)) return { value: null, error: "Must be a whole number." };
    if (meta.min !== undefined && n < meta.min) return { value: null, error: `At least ${meta.min}.` };
    if (meta.max !== undefined && n > meta.max) return { value: null, error: `At most ${meta.max}.` };
    return { value: String(n) };
  }
  if (meta.kind === "enum" || meta.kind === "toggle") {
    if (!meta.options?.includes(text)) return { value: null, error: `Choose one of: ${meta.options?.join(", ")}.` };
    return { value: text };
  }
  return { value: input }; // free text keeps its spaces; empty is a valid "unset"
}

export function stepSetting(meta: SettingMeta, current: string, dir: 1 | -1): string {
  const n = Number(current);
  const base = Number.isFinite(n) ? n : (meta.min ?? 0);
  const next = base + dir;
  const lo = meta.min ?? Number.NEGATIVE_INFINITY;
  const hi = meta.max ?? Number.POSITIVE_INFINITY;
  return String(Math.min(hi, Math.max(lo, next)));
}
