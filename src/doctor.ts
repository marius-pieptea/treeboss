/**
 * The setup check behind `trb doctor` and the UI's Engines page: what is installed, whether the MCP shim
 * every engine spawns actually answers, what the daemon is doing. Returns data; the CLI and the UI each
 * draw it their own way.
 */
import { ENGINES, installedEngines } from "./engines/registry";
import { runCmd } from "./git/run";
import { HydraPairs } from "./hydra/pairs";
import { McpStore, buildRunMcpConfig } from "./mcp/store";
import { probeStdio } from "./mcp/probe";
import { SkillStore } from "./skills/store";
import { home } from "./paths";
import { browserEnabled } from "./browser/chrome";
import { evidenceEnabled, totalEvidence } from "./evidence/store";
import { REA_VERSION, reaLaunch } from "./evidence/rea";
import { reaReadiness } from "./evidence/readiness";
import { getSetting } from "./settings";
import { realDeps } from "./emulator/deps";
import { createInstaller } from "./emulator/install";
import type { HostProbe, SdkState } from "./emulator/types";

export type DoctorLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  level: DoctorLevel;
  text: string;
}

export interface DoctorEngine {
  id: string;
  label: string;
  installed: boolean;
  bin: string | null;
  version: string;
  mcp: "config-file" | "cli-override" | "workspace-file" | "none";
  skills_dir: string | null;
  resume: boolean;
  /** Can lead a Hydra pair: trb's MCP tools reach it. */
  canLead: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  engines: DoctorEngine[];
  /** Worst level among the checks. */
  status: DoctorLevel;
  counts: { pairs: number; mcp: number; mcpEnabled: number; skills: number; skillsEnabled: number };
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** What the Android emulator needs from this computer, read from the disk and the OS only: this never downloads. Acceleration is a guess until the emulator is installed and `-accel-check` has run. */
export function emulatorChecks(host: HostProbe, sdk: SdkState): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (id: string, level: DoctorLevel, text: string) => checks.push({ id, level, text });
  if (sdk.kind === "installed") add("emulator", "ok", sdk.owned ? `Android emulator installed by treeboss in ${sdk.root}` : `Android emulator: using your Android SDK at ${sdk.root} (read-only)`);
  else add("emulator", "ok", `Android emulator not installed yet: the Emulator tab downloads it (about ${gb(host.needBytes)} of disk) after you accept Google's licenses.`);
  const accel = host.accel;
  const how = sdk.kind === "installed" ? "" : " (a guess from the OS until the emulator is installed)";
  if (accel.state === "ok") add("emulator:accel", "ok", `hardware acceleration: ${accel.kind}${how}`);
  else if (accel.state === "missing") add("emulator:accel", "warn", `hardware acceleration missing: ${accel.reason}. Fix: ${accel.fix}`);
  else add("emulator:accel", "ok", "hardware acceleration not checked yet: it is tested once the emulator is installed.");
  if (sdk.kind !== "installed" && host.diskFreeBytes < host.needBytes) add("emulator:disk", "warn", `${gb(host.diskFreeBytes)} free, the emulator needs about ${gb(host.needBytes)}. Fix: free disk space on the drive that holds the trb home.`);
  return checks;
}

export async function engineVersion(bin: string): Promise<string> {
  const r = await runCmd(bin, ["--version"], { cwd: "/", timeoutMs: 8000 });
  return ((r.stdout.toString() || r.stderr.toString()).trim().split("\n")[0] ?? "").slice(0, 60);
}

async function emulatorProbe(): Promise<DoctorCheck[] | null> {
  const installer = createInstaller(realDeps());
  const [host, sdk] = await Promise.all([installer.probe(), installer.reconcile()]).catch(() => [null, null] as const);
  return host && sdk ? emulatorChecks(host, sdk) : null;
}

export interface DaemonSnapshot {
  url: string;
  pid: number;
  startedAt: string;
}

export interface DoctorOptions {
  /** Run REA's own doctor (it may download the pinned package, up to 90 s). The CLI does; a page load does not. */
  reaDeep?: boolean;
}

export async function runDoctor(daemon: DaemonSnapshot | null, agoText: (iso: string) => string = (iso) => iso, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, level: DoctorLevel, text: string) => checks.push({ id, level, text });
  // REA's readiness: its own doctor can take up to 90 s, so it runs alongside the other checks and is awaited below.
  const rea = getSetting("rea_mcp") === "on" ? reaReadiness({ deep: opts.reaDeep ?? true }) : null;

  // Reads the OS and the disk (PowerShell on Windows takes about a second), so it runs alongside the other checks.
  const emulator = getSetting("emulator") === "on" ? emulatorProbe() : null;

  add("bun", "ok", `bun ${Bun.version} · home ${home()}`);
  const gitv = await runCmd("git", ["--version"], { cwd: "/", timeoutMs: 8000 }).catch(() => null);
  if (gitv && gitv.code === 0) add("git", "ok", gitv.stdout.toString().trim());
  else add("git", "fail", "git not found: worktree isolation and subagent_merge need it.");

  const installed = installedEngines();
  const versions = await Promise.all(installed.map((e) => (e.bin ? engineVersion(e.bin) : Promise.resolve(""))));
  const engines: DoctorEngine[] = installed.map((e, i) => {
    const def = ENGINES[e.id];
    return { id: e.id, label: e.label, installed: Boolean(e.bin), bin: e.bin, version: versions[i], mcp: def.mcp, skills_dir: def.skillsDir, resume: def.resume, canLead: def.mcp !== "none" };
  });
  const present = engines.filter((e) => e.installed);
  if (present.length === 0) add("engines", "fail", "No coding CLI found. Install one of: claude, codex, cursor-agent, opencode.");
  for (const e of engines) {
    if (e.installed) add(`engine:${e.id}`, "ok", `${e.id}: ${e.bin} (${e.version})`);
    else add(`engine:${e.id}`, "warn", `${e.id}: not installed`);
  }
  const noMcp = present.filter((e) => !e.canLead).map((e) => e.id);
  if (noMcp.length) add("no-mcp", "warn", `${noMcp.join(", ")} cannot reach trb's MCP servers: they can lead nothing and open no subagents (they work fine as heads).`);

  if (daemon) add("daemon", "ok", `daemon running at ${daemon.url} (pid ${daemon.pid}, ${agoText(daemon.startedAt)})`);
  else add("daemon", "warn", "daemon not running (it starts on demand, or `trb daemon start`).");

  const counts = {
    pairs: HydraPairs.list().length,
    mcp: McpStore.list().length,
    mcpEnabled: McpStore.list().filter((s) => s.enabled).length,
    skills: SkillStore.list().length,
    skillsEnabled: SkillStore.list().filter((s) => s.enabled).length,
  };
  add("counts", "ok", `${counts.pairs} pair(s), ${counts.mcp} MCP server(s), ${counts.skills} skill(s)`);

  if (evidenceEnabled()) {
    if (browserEnabled()) add("evidence", "ok", `evidence on: ${totalEvidence()} item(s) kept; agents can capture pages from the agent browser`);
    else add("evidence", "warn", "evidence is on but the agent browser is not available: agents can save notes, not capture pages (install Chrome, or trb config set agent_browser on).");
  }
  for (const c of (await emulator) ?? []) add(c.id, c.level, c.text);
  if (getSetting("rea_mcp") === "on") {
    const launch = reaLaunch();
    if (launch) add("rea", "ok", `REA ${launch.source === "override" ? "(custom command)" : REA_VERSION} offered to sessions: ${[launch.command, ...launch.args].join(" ")}`);
    else add("rea", "warn", "REA is on by default but cannot start: npx not found. Install Node, set rea_command, or trb config set rea_mcp off.");
    // What REA can and cannot do here: engines, APK tools, firmware, and REA's own doctor. The launcher is the line above.
    for (const c of (await rea)?.checks ?? []) {
      if (c.id === "launcher") continue;
      add(`rea:${c.id}`, c.level === "warn" ? "warn" : "ok", c.fix ? `${c.text.replace(/\.$/, "")}. Fix: ${c.fix}` : c.text);
    }
  }

  // The shim every engine spawns: prove it starts, here, the way an engine would start it.
  const cfg = buildRunMcpConfig({ sessionId: "s_doctor", subagents: true, daemonUrl: daemon?.url ?? "http://127.0.0.1:0", token: "doctor" }).trb;
  if (cfg && cfg.type === "stdio") {
    const r = await probeStdio(cfg.command, cfg.args, cfg.env ?? {}, { timeoutMs: 8000 });
    if (r.ok && r.tools.length) add("shim", "ok", `trb MCP shim answers (${r.tools.length} tools)`);
    else add("shim", "fail", `trb MCP shim did not answer: engines would run without subagent tools.${r.error ? ` ${r.error}` : ""}`);
  }

  const status: DoctorLevel = checks.some((c) => c.level === "fail") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "ok";
  return { checks, engines, status, counts };
}
