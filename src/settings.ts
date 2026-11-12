import { UserError } from "./util";
import { db } from "./db";
import { assertModeAvailable } from "./remote/network";
import { LLM_SETTING_DEFS, validateLlmSetting } from "./llm/settings";

/**
 * Operator-tunable knobs. Stored in SQLite (`trb config set key value`), with
 * defaults here, so a fresh install needs no config file and a setting never
 * has two homes.
 */
export const SETTING_DEFS = {
  default_engine: { type: "string", def: "claude", help: "Engine used when `trb run` is given no --engine and no pair." },
  max_depth: { type: "number", def: 2, help: "How deep subagents may nest. 2: children may open grandchildren; grandchildren may not." },
  max_per_parent: { type: "number", def: 6, help: "Open subagents one session may hold at once." },
  max_concurrent: { type: "number", def: 6, help: "Subagent turns running at once, daemon-wide." },
  wait_default_sec: { type: "number", def: 45, help: "Default block for a direct `trb` wait (CLI/API). Agents' subagent_wait uses wait_total_sec." },
  wait_max_sec: { type: "number", def: 240, help: "Longest single daemon block of a wait (bounded by the daemon's HTTP idle timeout). A longer wait is split into several blocks the MCP shim chains invisibly." },
  wait_total_sec: { type: "number", def: 900, help: "Longest one subagent_wait call the agent sees: it costs the agent a single tool call however long it blocks, up to this. Past it, the call returns 'still running'." },
  turn_idle_timeout_sec: { type: "number", def: 900, help: "Stop a turn that prints nothing for this long (and has no working subagents)." },
  turn_ceiling_sec: { type: "number", def: 3600, help: "Longest one turn may work. Time it spends in subagent_wait on subagents that are still working does not count (turn_hard_ceiling_sec does)." },
  turn_hard_ceiling_sec: { type: "number", def: 14400, help: "Absolute limit for one turn, time spent waiting on subagents included." },
  claude_max_turns: { type: "number", def: 0, help: "`claude --max-turns` ceiling. 0 = uncapped." },
  default_skills: { type: "string", def: "all", help: "Skills a session gets when it has none of its own (no agent or per-session list): `all` (every enabled skill), `builtin` (the ones that ship with trb), `none`, or comma-separated names (which may include builtin). A session or agent that lists skills gets exactly those. An engine with no skills folder only gets the built-ins from `all`: its skills are listed in the prompt. /name always adds one." },
  skills_link: { type: "string", def: "on", help: "on: skills are linked into the workspace (one entry each, fast, nothing copied). off: copied file by file. Falls back to a copy by itself if the filesystem refuses links." },
  mcp_isolation: { type: "string", def: "strict", help: "strict: claude sees only trb's MCP servers. merge: also its own user config." },
  worktree_setup_cmd: { type: "string", def: "", help: "Shell command run in each new subagent worktree (e.g. `bun install`), instead of worktree_deps. Empty: worktree_deps decides." },
  worktree_deps: { type: "string", def: "clone", help: "How a subagent worktree gets the repo's node_modules. clone: a copy-on-write clone (macOS APFS, Linux reflink) when the lockfile matches, so an install in the head never touches the repo's copy. link: a shared symlink (an `npm ci` in a head empties the repo's node_modules through it). off: none, the head installs its own." },
  cargo_shared_target: { type: "string", def: "on", help: "on: every worktree of a repo builds Rust into one shared CARGO_TARGET_DIR under the trb home, instead of a full target/ per head (tens of GB each). Skipped when CARGO_TARGET_DIR is already set. off: each worktree keeps its own target/." },
  test_policy: { type: "string", def: "focused", help: "focused: every session is told, once per conversation, to run only the tests its change affects, no full suite or end-to-end tests unless asked, and to write tests sparingly. off: agents test however the project and their own judgment say." },
  cargo_build_jobs: { type: "number", def: 0, help: "CARGO_BUILD_JOBS for agent turns and for terminals and dev servers in worktrees, so parallel heads cannot each start a compiler per core. 0: auto (half the cores, at most one per 4 GB of RAM). Skipped when CARGO_BUILD_JOBS is already set." },
  cargo_lean_debug: { type: "string", def: "on", help: "on: Rust builds in worktrees use line-tables-only debug info (CARGO_PROFILE_DEV_DEBUG), which keeps backtraces with line numbers but cuts target size and linker memory a lot. Never applied to your own checkout. off: the project's own debug setting." },
  cargo_target_max_gb: { type: "number", def: 30, help: "A repo's shared Rust target dir is deleted at daemon start when it is bigger than this many GB and none of its sessions is live. 0: never." },
  idle_close_hours: { type: "number", def: 6, help: "Close idle subagents after this many hours without a turn." },
  leftover_reap_hours: { type: "number", def: 24, help: "Stop the background processes an agent left running (dev servers, watchers, browsers) once a session's last turn ended this many hours ago. The session stays open. 0: never." },
  min_free_memory_mb: { type: "number", def: 1500, help: "A new turn is refused while less memory than this (MB) is available: a lead's turn, or a subagent's launch or follow-up. Available means MemAvailable on Linux, free + inactive + speculative + purgeable pages on macOS, free memory elsewhere. 0: no guard." },
  lead_idle_close_hours: { type: "number", def: 0, help: "Close a lead (with its subagents) after this many hours without a turn. Pinned leads are kept. 0: leads are never closed automatically." },
  next_steps: { type: "string", def: "on", help: "on: a lead's build turns end with up to three suggested follow-ups, shown as chips under the answer. off: agents are not asked." },
  treeboss_mode: { type: "string", def: "off", help: "on: new sessions start in treeboss mode (tier triage, design and docs gates, specs on the roadmap). Each session can still switch it." },
  session_titles: { type: "string", def: "on", help: "on: a lead session's first turn asks the agent to name the session with a short title (a tool call, no extra turn). off: titles stay the first line of the prompt." },
  agent_browser: { type: "string", def: "on", help: "on: sessions get browser_* tools (a headless Chrome the daemon owns, shown live in the UI). off: no browser tools." },
  browser_signins: { type: "string", def: "on", help: "on: the agent browser keeps its cookies and local storage per project in the trb home (0600), so a login made in the live view survives idle closes, new sessions and daemon restarts, and is shared by the sessions of that project. off: every session starts with a clean browser and nothing is written." },
  computer_use: { type: "string", def: "off", help: "on: sessions get computer_* tools that see and control the operator's real main display, mouse and keyboard (macOS and Windows; macOS needs Screen Recording and Accessibility for the app running trb; Windows needs the daemon in the logged-in desktop session). off: no computer tools. Every action is logged to computer-use.log in the trb home." },
  emulator: { type: "string", def: "on", help: "on: the emulator_* tools appear once the Android emulator is installed from the Emulator tab. off: no emulator tools." },
  evidence: { type: "string", def: "on", help: "on: sessions get evidence_* tools to capture the page open in the agent browser (DOM, styles, assets, network, screenshot) and to save cited findings, kept per project. On by default: a capture can contain whatever a signed-in page showed, and it is stored in the trb home on this computer. off: no evidence tools." },
  rea_mcp: { type: "string", def: "on", help: "on: sessions also get REA, a third-party reverse-engineering MCP server (binaries, Electron apps, APKs, websites), started with npx on demand. On by default: sessions download and run that npm package through npx. off: not offered (`trb config set rea_mcp off`)." },
  rea_command: { type: "string", def: "", help: "Command that starts REA's MCP server, split on spaces (e.g. `rea mcp` for a global install). Empty: `npx -y rea-agents@6.4.0 mcp`." },
  codegraph: { type: "string", def: "auto", help: "auto: sessions in a project that already has a .codegraph/ index get the codegraph MCP tools. off: never." },
  codegraph_bin: { type: "string", def: "", help: "Path to a codegraph executable to use instead of the one bundled with the app. Empty: bundled, then PATH." },
  codegraph_timeout_min: { type: "number", def: 30, help: "Stop a CodeGraph init/re-index that runs longer than this many minutes. 0: no limit." },
  docs_engine: { type: "string", def: "", help: "Engine the Docs module generates and refreshes pages with when none is chosen in the dialog. Empty: the app default." },
  docs_model: { type: "string", def: "", help: "Model for docs_engine. Empty: that engine's default." },
  ask_models: { type: "string", def: "", help: "Ask mode: the model a NEW ask session starts on, per engine, as engine=model pairs (claude=claude-haiku-5-5,codex=gpt-5-mini). Empty: claude uses Haiku, codex picks a mini model from its catalog, others use their default." },
  ask_model_override: { type: "string", def: "off", help: "on: an ask turn inside an EXISTING session runs on the ask model for that engine (claude and codex only). Off by default: switching models mid-session invalidates the prompt cache." },
  context_window: { type: "number", def: 0, help: "Override the context window (tokens) the meter measures against. 0: use what the engine reports, else the model table." },
  port: { type: "number", def: 4477, help: "Daemon port (127.0.0.1). Takes effect on the next daemon start." },
  remote_mode: { type: "string", def: "off", help: "off: this computer only, no pairing. lan: phones on the same local network (plain http) via the machine's LAN address. tailscale: only devices on your tailnet, via the tailscale address. Applies immediately." },
  remote_allow_terminal: { type: "string", def: "off", help: "on: remote devices may open and drive terminals. Off by default: a terminal is a shell on this machine." },
  remote_allow_files: { type: "string", def: "off", help: "off | read | write: whether remote devices may read, or also change, workspace files." },
  remote_token_days: { type: "number", def: 30, help: "How long a paired device stays signed in before it must pair again." },
  ...LLM_SETTING_DEFS,
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTING_DEFS;
}

export function getSetting<K extends SettingKey>(key: K): (typeof SETTING_DEFS)[K]["def"] extends number ? number : string {
  const def = SETTING_DEFS[key];
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return def.def as any;
  if (def.type === "number") {
    const n = Number(row.value);
    return (Number.isFinite(n) ? n : def.def) as any;
  }
  return row.value as any;
}

export function setSetting(key: string, value: string): void {
  if (!isSettingKey(key)) throw new UserError(`Unknown setting "${key}". Known: ${Object.keys(SETTING_DEFS).join(", ")}.`);
  const def = SETTING_DEFS[key];
  if (def.type === "number" && !Number.isFinite(Number(value))) throw new UserError(`${key} must be a number.`);
  if (key === "default_skills") for (const t of value.split(",")) if (t.trim() && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(t.trim())) throw new UserError(`default_skills: "${t.trim()}" is not a skill name. Use names, "builtin", "all" or "none", separated by commas.`);
  if (key === "skills_link" && value !== "on" && value !== "off") throw new UserError(`skills_link must be "on" or "off".`);
  if (key === "worktree_deps" && value !== "clone" && value !== "link" && value !== "off") throw new UserError(`worktree_deps must be "clone", "link" or "off".`);
  if (key === "mcp_isolation" && value !== "strict" && value !== "merge") throw new UserError(`mcp_isolation must be "strict" or "merge".`);
  if (key === "codegraph" && value !== "auto" && value !== "off") throw new UserError(`codegraph must be "auto" or "off".`);
  if (key === "ask_model_override" && value !== "on" && value !== "off") throw new UserError(`ask_model_override must be "on" or "off".`);
  if (key === "ask_models") for (const part of value.split(",")) if (part.trim() && !/^[A-Za-z0-9_.-]+\s*=\s*\S+$/.test(part.trim())) throw new UserError(`ask_models: "${part.trim()}" is not engine=model. Example: claude=claude-haiku-5-5,codex=gpt-5-mini`);
  if (key === "next_steps" && value !== "on" && value !== "off") throw new UserError(`next_steps must be "on" or "off".`);
  if (key === "treeboss_mode" && value !== "on" && value !== "off") throw new UserError(`treeboss_mode must be "on" or "off".`);
  if (key === "session_titles" && value !== "on" && value !== "off") throw new UserError(`session_titles must be "on" or "off".`);
  if (key === "agent_browser" && value !== "on" && value !== "off") throw new UserError(`agent_browser must be "on" or "off".`);
  if (key === "browser_signins" && value !== "on" && value !== "off") throw new UserError(`browser_signins must be "on" or "off".`);
  if (key === "emulator" && value !== "on" && value !== "off") throw new UserError(`emulator must be "on" or "off".`);
  if (key === "evidence" && value !== "on" && value !== "off") throw new UserError(`evidence must be "on" or "off".`);
  if (key === "rea_mcp" && value !== "on" && value !== "off") throw new UserError(`rea_mcp must be "on" or "off".`);
  if (key === "computer_use" && value !== "on" && value !== "off") throw new UserError(`computer_use must be "on" or "off".`);
  if (key === "remote_mode") {
    if (value !== "off" && value !== "lan" && value !== "tailscale") throw new UserError(`remote_mode must be "off", "lan" or "tailscale".`);
    if (value !== "off") assertModeAvailable(value);
  }
  if (key === "remote_allow_terminal" && value !== "on" && value !== "off") throw new UserError(`remote_allow_terminal must be "on" or "off".`);
  if (key === "remote_allow_files" && value !== "off" && value !== "read" && value !== "write") throw new UserError(`remote_allow_files must be "off", "read" or "write".`);
  if (key === "remote_token_days" && !(Number(value) >= 1 && Number(value) <= 365)) throw new UserError("remote_token_days must be between 1 and 365.");
  validateLlmSetting(key, value);
  db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  notify(key);
}

export function resetSetting(key: string): void {
  db().prepare("DELETE FROM settings WHERE key = ?").run(key);
  notify(key);
}

const listeners = new Set<(key: string) => void>();
/** Run `fn` after a setting changes (the daemon uses it to move the remote listener at once). Returns an unsubscribe. */
export function onSettingChanged(fn: (key: string) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
function notify(key: string): void {
  for (const fn of listeners) {
    try {
      fn(key);
    } catch {}
  }
}

export function allSettings(): Array<{ key: string; value: string | number; default: string | number; custom: boolean; help: string }> {
  return (Object.keys(SETTING_DEFS) as SettingKey[]).map((key) => {
    const def = SETTING_DEFS[key];
    const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return { key, value: getSetting(key) as any, default: def.def, custom: Boolean(row), help: def.help };
  });
}
