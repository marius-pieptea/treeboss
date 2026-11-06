/**
 * Configuration commands: Hydra pairs, MCP servers, skills, settings, engines, doctor, daemon.
 *
 * These edit trb's SQLite directly rather than going through the daemon: the daemon reads the same
 * file at the start of every turn, so a change applies to the next turn either way, and `trb pair
 * add` works with no daemon running.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { opts } from "../args";
import { spawnSync } from "child_process";
import { allSettings, getSetting, isSettingKey, resetSetting, setSetting } from "../../settings";
import { HydraPairs, PAIR_COOKBOOK, type HydraHeadRoles, type HydraPair } from "../../hydra/pairs";
import { PAIR_ROLE_LIBRARY } from "../../hydra/roles";
import { Agents, type AgentRecord } from "../../agents/store";
import { listModels } from "../../engines/models";
import { McpStore } from "../../mcp/store";
import { SkillStore } from "../../skills/store";
import { scanSkills } from "../../skills/import";
import { listSkillPacks, setSkillPackEnabled } from "../../skill-packs";
import { ENGINES, engineIds, installedEngines, resolveBinary } from "../../engines/registry";
import { liveDaemon, readInfo, startDetached, stopDaemon, runDaemon } from "../../daemon/lifecycle";
import { paths } from "../../paths";
import { probeHttp, probeStdio, type ProbeResult } from "../../mcp/probe";
import { runDoctor } from "../../doctor";
import { c, die, table, ago, printJson, printLine } from "../fmt";

/* -------------------------------------------------------------------------- */
/* pair                                                                       */
/* -------------------------------------------------------------------------- */

/** `engine/model@effort`, each part optional after the engine: `claude`, `claude/claude-opus-5-5`, `codex@high`. */
function parseSpec(spec: string): { engine: string; model: string | null; effort: string | null } {
  const [head, effort] = spec.split("@");
  const [engine, ...rest] = head.split("/");
  if (!engine) die(`Bad spec "${spec}". Use engine[/model][@effort], e.g. claude/claude-opus-5-5@high.`);
  return { engine, model: rest.length ? rest.join("/") || null : null, effort: effort || null };
}

function specOf(engine: string | null, model: string | null, effort: string | null): string {
  if (!engine && !model) return c.dim("—");
  return `${engine ?? "?"}${model ? `/${model}` : ""}${effort ? `@${effort}` : ""}`;
}

function printPair(p: HydraPair): void {
  console.log(`${c.bold(p.title)}  ${c.dim(p.id)}  ${c.dim(`[${p.mode}${p.max_heads ? `, max ${p.max_heads} heads` : ""}]`)}`);
  console.log(`  lead   ${specOf(p.lead_engine, p.lead_model, p.lead_effort)}`);
  if (p.mode === "heads") console.log(`  heads  ${specOf(p.heads_engine, p.heads_model, p.heads_effort)}`);
  else for (const [role, cfg] of Object.entries(p.roles ?? {})) console.log(`  ${role.padEnd(8)} ${specOf(cfg.engine ?? null, cfg.model ?? null, cfg.effort ?? null)}${cfg.instructions ? c.dim("  (custom instructions)") : ""}`);
}

function engineWarnings(specs: Array<{ engine?: string | null }>): void {
  const bad = new Set<string>();
  for (const s of specs) {
    if (!s.engine) continue;
    const def = ENGINES[s.engine];
    if (!def) bad.add(`${s.engine} (unknown engine)`);
    else if (!resolveBinary(def)) bad.add(`${s.engine} (not installed)`);
  }
  if (bad.size) console.error(c.yellow(`warning: ${[...bad].join(", ")}. Run \`trb engines\`.`));
}

export function cmdPair(argv: string[]): number {
  const [sub = "list", ...rest] = argv;
  switch (sub) {
    case "list":
    case "ls": {
      const { values } = opts(rest, { json: { type: "boolean" } });
      const pairs = HydraPairs.list();
      if (values.json) return printJson(pairs);
      if (pairs.length === 0) {
        console.log(c.dim("No pairs yet. Try: trb pair add --recipe claude-codex   (trb pair recipes)"));
        return 0;
      }
      pairs.forEach(printPair);
      return 0;
    }
    case "show": {
      const p = HydraPairs.find(rest[0]);
      if (!p) die(`No pair "${rest[0] ?? ""}".`);
      printPair(p);
      for (const [role, cfg] of Object.entries(p.roles ?? {})) if (cfg.instructions) console.log(c.dim(`\n[${role}] ${cfg.instructions}`));
      return 0;
    }
    case "recipes":
      console.log(table(PAIR_COOKBOOK.map((r) => [c.bold(r.id), r.title, c.dim(r.tagline)]), ["RECIPE", "TITLE", ""]));
      return 0;
    case "roles":
      console.log(table(PAIR_ROLE_LIBRARY.map((r) => [c.bold(r.id), `${r.engine}@${r.effort}`, c.dim(r.description)]), ["ROLE", "SUGGESTED", ""]));
      return 0;
    case "add":
    case "edit": {
      const editing = sub === "edit";
      const { values, positionals } = opts(rest, {
        title: { type: "string", short: "t" },
        recipe: { type: "string" },
        lead: { type: "string" },
        heads: { type: "string" },
        role: { type: "string", multiple: true, short: "r" },
        "max-heads": { type: "string" },
        "clear-roles": { type: "boolean" },
      });
      const target = editing ? HydraPairs.find(positionals[0]) : null;
      if (editing && !target) die(`No pair "${positionals[0] ?? ""}". See \`trb pair list\`.`);
      if (!editing && values.recipe) {
        const made = HydraPairs.fromCookbook(values.recipe);
        engineWarnings([{ engine: made.lead_engine }, { engine: made.heads_engine }, ...Object.values(made.roles ?? {})]);
        printPair(made);
        return 0;
      }
      const input: Record<string, any> = {};
      if (values.title) input.title = values.title;
      if (values.lead) {
        const l = parseSpec(values.lead);
        Object.assign(input, { lead_engine: l.engine, lead_model: l.model, lead_effort: l.effort });
      }
      if (values.heads) {
        const h = parseSpec(values.heads);
        Object.assign(input, { heads_engine: h.engine, heads_model: h.model, heads_effort: h.effort, mode: "heads", roles: null });
      }
      if (values.role?.length) {
        // `--role scout=claude/claude-haiku-5-5@low`: the library's instructions for that role id come along.
        const roles: HydraHeadRoles = editing && !values["clear-roles"] ? { ...(target!.roles ?? {}) } : {};
        for (const r of values.role) {
          const eq = r.indexOf("=");
          const name = (eq === -1 ? r : r.slice(0, eq)).trim().toLowerCase();
          const spec = eq === -1 ? { engine: null, model: null, effort: null } : parseSpec(r.slice(eq + 1));
          const preset = PAIR_ROLE_LIBRARY.find((p) => p.id === name);
          roles[name] = { engine: spec.engine ?? preset?.engine ?? null, model: spec.model, effort: spec.effort ?? preset?.effort ?? null, instructions: roles[name]?.instructions ?? preset?.instructions ?? null, label: preset?.label ?? name };
        }
        Object.assign(input, { roles, mode: "roles" });
      }
      if (values["max-heads"]) input.max_heads = Number(values["max-heads"]);
      let result: HydraPair | null;
      try {
        if (editing) result = HydraPairs.update(target!.id, input);
        else {
          if (!input.title) die('Give a title: trb pair add --title "Opus + Codex" --lead claude/claude-opus-5-5@high --role worker=codex  (or --recipe <id>)');
          result = HydraPairs.create(input as any);
        }
      } catch (err: any) {
        die(err.message);
      }
      engineWarnings([{ engine: result!.lead_engine }, { engine: result!.heads_engine }, ...Object.values(result!.roles ?? {})]);
      printPair(result!);
      return 0;
    }
    case "rm":
    case "remove": {
      const p = HydraPairs.find(rest[0]);
      if (!p) die(`No pair "${rest[0] ?? ""}".`);
      HydraPairs.remove(p.id);
      console.log(`removed ${p.title}`);
      return 0;
    }
    default:
      die(`Unknown: trb pair ${sub}. Subcommands: list, show, add, edit, rm, recipes, roles.`);
  }
}

/* -------------------------------------------------------------------------- */
/* mcp                                                                        */
/* -------------------------------------------------------------------------- */

function kv(list: string[] | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list ?? []) {
    const eq = item.indexOf("=");
    if (eq < 1) die(`Bad ${what} "${item}": use KEY=VALUE.`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

export async function cmdMcp(argv: string[]): Promise<number> {
  const [sub = "list", ...rest] = argv;
  switch (sub) {
    case "list":
    case "ls": {
      const servers = McpStore.list();
      if (servers.length === 0) {
        console.log(c.dim("No MCP servers. Add one:  trb mcp add <name> -- <command> [args…]   or   trb mcp import --from claude"));
        return 0;
      }
      console.log(
        table(
          servers.map((s) => [c.bold(s.name), s.enabled ? c.green("on") : c.gray("off"), s.transport, s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url ?? ""]),
          ["NAME", "", "TYPE", "TARGET"],
        ),
      );
      console.log(c.dim(`\n(plus the built-in "trb" server, which gives sessions the subagent_* tools)`));
      return 0;
    }
    case "add": {
      const { values, positionals } = opts(rest, { url: { type: "string" }, header: { type: "string", multiple: true, short: "H" }, env: { type: "string", multiple: true, short: "e" } });
      const [name, ...cmd] = positionals;
      if (!name) die("Usage: trb mcp add <name> -- <command> [args…]   |   trb mcp add <name> --url <https://…> [-H Key=Value]");
      try {
        const rec = McpStore.put({ name, command: values.url ? null : cmd[0] ?? null, args: values.url ? [] : cmd.slice(1), env: kv(values.env, "env"), url: values.url ?? null, headers: kv(values.header, "header") });
        console.log(`added ${c.bold(rec.name)} (${rec.transport})`);
      } catch (err: any) {
        die(err.message);
      }
      return 0;
    }
    case "rm":
    case "remove":
      if (!rest[0]) die("Usage: trb mcp rm <name>");
      if (!McpStore.remove(rest[0])) die(`No MCP server "${rest[0]}".`);
      console.log(`removed ${rest[0]}`);
      return 0;
    case "enable":
    case "disable":
      if (!rest[0]) die(`Usage: trb mcp ${sub} <name>`);
      if (!McpStore.setEnabled(rest[0], sub === "enable")) die(`No MCP server "${rest[0]}".`);
      console.log(`${rest[0]} ${sub}d`);
      return 0;
    case "import": {
      const { values, positionals } = opts(rest, { from: { type: "string" }, overwrite: { type: "boolean" } });
      const file = values.from === "claude" || (!values.from && positionals.length === 0) ? McpStore.claudeUserConfig() : path.resolve((values.from ?? positionals[0]).replace(/^~(?=$|\/)/, os.homedir()));
      if (!fs.existsSync(file)) die(`${file} does not exist.`);
      try {
        const r = McpStore.importFile(file, { overwrite: values.overwrite });
        console.log(`from ${file}`);
        if (r.added.length) console.log(c.green(`  added:   ${r.added.join(", ")}`));
        if (r.skipped.length) console.log(c.dim(`  skipped: ${r.skipped.join(", ")} (already present; --overwrite)`));
        if (r.invalid.length) console.log(c.yellow(`  invalid: ${r.invalid.join(", ")}`));
        if (!r.added.length && !r.skipped.length && !r.invalid.length) console.log(c.dim("  no mcpServers found."));
      } catch (err: any) {
        die(`Could not read ${file}: ${err.message}`);
      }
      return 0;
    }
    case "test": {
      // Spawn the server the way an engine would and ask for its tools: proves the command runs and speaks MCP.
      const rec = McpStore.get(rest[0] ?? "");
      if (!rec) die(`No MCP server "${rest[0] ?? ""}".`);
      return printProbe(rec.transport === "stdio" ? await probeStdio(rec.command!, rec.args, rec.env) : await probeHttp(rec.url!, rec.headers));
    }
    default:
      die(`Unknown: trb mcp ${sub}. Subcommands: list, add, rm, enable, disable, import, test.`);
  }
}

/** Print a probe result the way `trb mcp test` always has. Returns the exit code. */
function printProbe(r: ProbeResult): number {
  if (!r.ok) {
    console.log(c.red(`✗ ${r.error ?? "no answer"}`));
    if (r.stderrTail) console.log(c.dim(r.stderrTail.slice(-600)));
    return 1;
  }
  const names = r.tools.map((t) => t.name);
  console.log(c.green(`✓ ${r.server?.name ?? "server"} ${r.server?.version ?? ""} · ${names.length} tool${names.length === 1 ? "" : "s"}`));
  if (names.length) console.log(c.dim("  " + names.slice(0, 30).join(", ") + (names.length > 30 ? ", …" : "")));
  if (r.error) console.log(c.yellow(`  ${r.error}`));
  return 0;
}

/* -------------------------------------------------------------------------- */
/* skill                                                                      */
/* -------------------------------------------------------------------------- */

export function cmdSkill(argv: string[]): number {
  const [sub = "list", ...rest] = argv;
  switch (sub) {
    case "list":
    case "ls": {
      const skills = SkillStore.list();
      if (skills.length === 0) {
        console.log(c.dim("No skills. Add one: trb skill add <dir>   |   trb skill import ~/.claude/skills   |   trb skill new <name>"));
        return 0;
      }
      console.log(table(skills.map((s) => [c.bold(s.name), s.enabled ? c.green("on") : c.gray("off"), c.dim(s.description.length > 80 ? s.description.slice(0, 79) + "…" : s.description)]), ["NAME", "", "DESCRIPTION"]));
      return 0;
    }
    case "add": {
      const { values, positionals } = opts(rest, { name: { type: "string", short: "n" }, force: { type: "boolean", short: "f" } });
      if (!positionals[0]) die("Usage: trb skill add <dir-with-SKILL.md> [--name n] [--force]");
      try {
        const s = SkillStore.add(positionals[0], { name: values.name, overwrite: values.force });
        console.log(`added ${c.bold(s.name)}`);
      } catch (err: any) {
        die(err.message);
      }
      return 0;
    }
    case "new": {
      const { values, positionals } = opts(rest, { description: { type: "string", short: "d" } });
      if (!positionals[0]) die('Usage: trb skill new <name> [-d "when to use it"]');
      try {
        const s = SkillStore.create(positionals[0], values.description ?? "");
        console.log(`created ${c.bold(s.name)}: edit ${path.join(s.path, "SKILL.md")}`);
      } catch (err: any) {
        die(err.message);
      }
      return 0;
    }
    case "import": {
      const { values, positionals } = opts(rest, { overwrite: { type: "boolean" }, "dry-run": { type: "boolean" } });
      const root = positionals[0] ?? path.join(os.homedir(), ".claude", "skills");
      let scan;
      try {
        scan = scanSkills(root);
      } catch (err: any) {
        die(err.message);
      }
      const files = scan.skills.reduce((n, s) => n + s.files, 0);
      const mb = scan.skills.reduce((n, s) => n + s.bytes, 0) / 1048576;
      console.log(`${c.bold(String(scan.skills.length))} skill${scan.skills.length === 1 ? "" : "s"} in ${scan.root} ${c.dim(`(${files} files, ${mb.toFixed(1)} MB)`)}`);
      if (scan.skills.length === 0) return 1;
      if (values["dry-run"]) {
        for (const s of scan.skills) console.log(`  ${s.exists ? c.dim("•") : c.green("+")} ${s.name}${s.relDir !== "." ? c.dim(`  ${s.relDir}`) : ""} ${c.dim(`${s.files} files`)}${s.error ? c.red(`  ${s.error}`) : ""}`);
        return 0;
      }
      const r = SkillStore.importDir(root, { overwrite: values.overwrite, onProgress: (m) => process.stderr.write(c.dim(`${m}\n`)) });
      if (r.added.length) console.log(c.green(`  added:   ${r.added.length} (${r.added.slice(0, 12).join(", ")}${r.added.length > 12 ? ", …" : ""})`));
      if (r.skipped.length) console.log(c.dim(`  skipped: ${r.skipped.length} already present (--overwrite)`));
      for (const f of r.failed) console.log(c.yellow(`  failed:  ${f.name}: ${f.error}`));
      for (const n of r.notes.slice(0, 8)) console.log(c.dim(`  note:    ${n}`));
      return r.failed.length ? 1 : 0;
    }
    case "show": {
      const s = SkillStore.get(rest[0] ?? "");
      if (!s) die(`No skill "${rest[0] ?? ""}".`);
      console.log(fs.readFileSync(path.join(s.path, "SKILL.md"), "utf-8"));
      return 0;
    }
    case "rm":
    case "remove":
      if (!rest[0]) die("Usage: trb skill rm <name>");
      if (!SkillStore.remove(rest[0])) die(`No skill "${rest[0]}".`);
      console.log(`removed ${rest[0]}`);
      return 0;
    case "enable":
    case "disable":
      if (!rest[0]) die(`Usage: trb skill ${sub} <name>`);
      if (!SkillStore.setEnabled(rest[0], sub === "enable")) die(`No skill "${rest[0]}".`);
      console.log(`${rest[0]} ${sub}d`);
      return 0;
    case "packs": {
      const packs = listSkillPacks();
      if (packs.length === 0) {
        console.log(c.dim("No skill packs ship with this build."));
        return 0;
      }
      console.log(table(packs.map((p) => [c.bold(p.id), c.dim(p.version || "—"), p.license || c.dim("—"), `${p.enabled}/${p.installed}`]), ["PACK", "VERSION", "LICENSE", "ENABLED"]));
      return 0;
    }
    case "pack": {
      const [id, state] = rest;
      if (!id || (state !== "on" && state !== "off")) die("Usage: trb skill pack <id> on|off   (the packs: trb skill packs)");
      const counts = setSkillPackEnabled(id, state === "on");
      if (!counts) die(`No skill pack "${id}". See trb skill packs.`);
      console.log(`${c.bold(id)}: ${counts.enabled} of ${counts.installed} skills ${state}`);
      return 0;
    }
    default:
      die(`Unknown: trb skill ${sub}. Subcommands: list, add, new, import, show, rm, enable, disable, packs, pack.`);
  }
}

/* -------------------------------------------------------------------------- */
/* config                                                                     */
/* -------------------------------------------------------------------------- */

export function cmdConfig(argv: string[]): number {
  const [sub = "list", ...rest] = argv;
  switch (sub) {
    case "list":
    case "ls":
      console.log(table(allSettings().map((s) => [c.bold(s.key), String(s.value === "" ? '""' : s.value) + (s.custom ? "" : c.dim(" (default)")), c.dim(s.help)]), ["SETTING", "VALUE", ""]));
      return 0;
    case "get":
      if (!rest[0] || !isSettingKey(rest[0])) die(`Usage: trb config get <setting>. Settings: ${allSettings().map((s) => s.key).join(", ")}`);
      console.log(String(getSetting(rest[0])));
      return 0;
    case "set":
      if (rest.length < 2) die("Usage: trb config set <setting> <value>");
      try {
        setSetting(rest[0], rest.slice(1).join(" "));
      } catch (err: any) {
        die(err.message);
      }
      console.log(`${rest[0]} = ${getSetting(rest[0] as any) === "" ? '""' : getSetting(rest[0] as any)}`);
      return 0;
    case "reset":
      if (!rest[0]) die("Usage: trb config reset <setting>");
      resetSetting(rest[0]);
      console.log(`${rest[0]} reset to default`);
      return 0;
    default:
      die(`Unknown: trb config ${sub}. Subcommands: list, get, set, reset.`);
  }
}

/* -------------------------------------------------------------------------- */
/* engines / doctor                                                           */
/* -------------------------------------------------------------------------- */

function versionOf(bin: string): string {
  const r = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: 8000, windowsHide: true });
  return ((r.stdout || r.stderr || "").trim().split("\n")[0] ?? "").slice(0, 60);
}

export function cmdEngines(argv: string[]): number {
  const { values } = opts(argv, { json: { type: "boolean" } });
  const rows = installedEngines().map((e) => {
    const def = ENGINES[e.id];
    return { id: e.id, label: e.label, installed: Boolean(e.bin), bin: e.bin, version: e.bin ? versionOf(e.bin) : "", mcp: def.mcp, skills: def.skillsDir, resume: def.resume };
  });
  if (values.json) return printJson(rows);
  console.log(
    table(
      rows.map((r) => [c.bold(r.id), r.installed ? c.green("installed") : c.gray("missing"), r.version || c.dim("—"), r.mcp === "none" ? c.yellow("no MCP/subagents") : c.dim(`mcp: ${r.mcp}`), r.skills ? c.dim(r.skills) : c.dim("skills: via prompt")]),
      ["ENGINE", "", "VERSION", "MCP", "SKILLS"],
    ),
  );
  return 0;
}

export async function cmdDoctor(): Promise<number> {
  const info = await liveDaemon();
  const report = await runDoctor(info ? { url: info.url, pid: info.pid, startedAt: info.startedAt } : null, (iso) => ago(iso));
  const mark = { ok: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗") };
  for (const check of report.checks) console.log(`${mark[check.level]} ${check.text}`);
  return report.checks.some((x) => x.level === "fail") ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* daemon                                                                     */
/* -------------------------------------------------------------------------- */

export async function cmdDaemon(argv: string[]): Promise<number> {
  const [sub = "status", ...rest] = argv;
  switch (sub) {
    case "run": {
      const { values } = opts(rest, { port: { type: "string" } });
      await runDaemon({ port: values.port ? Number(values.port) : undefined });
      await new Promise(() => {}); // runs until a signal handler exits
      return 0;
    }
    case "start": {
      const before = await liveDaemon();
      const info = await startDetached();
      console.log(before ? `already running at ${info.url} (pid ${info.pid})` : `started ${info.url} (pid ${info.pid})`);
      return 0;
    }
    case "stop": {
      const r = await stopDaemon();
      console.log(r.stopped ? `stopped (pid ${r.pid})` : "not running");
      return 0;
    }
    case "restart": {
      await stopDaemon();
      const info = await startDetached();
      console.log(`started ${info.url} (pid ${info.pid})`);
      return 0;
    }
    case "status": {
      const info = await liveDaemon();
      if (!info) {
        console.log(readInfo() ? "not running (stale state cleaned up)" : "not running");
        return 1;
      }
      console.log(`running · ${info.url} · pid ${info.pid} · v${info.version} · up ${ago(info.startedAt).replace(" ago", "")}`);
      return 0;
    }
    case "logs": {
      const file = paths.daemonLog();
      if (!fs.existsSync(file)) die("No daemon log yet.");
      const r = spawnSync("tail", ["-n", "80", ...(rest.includes("-f") ? ["-f"] : []), file], { stdio: "inherit" });
      return r.status ?? 0;
    }
    default:
      die(`Unknown: trb daemon ${sub}. Subcommands: start, stop, restart, status, logs, run.`);
  }
}

export { engineIds };


/* -------------------------------------------------------------------------- */
/* agent                                                                      */
/* -------------------------------------------------------------------------- */

function printAgent(a: AgentRecord, full = false): void {
  console.log(`${c.bold(a.name)}  ${a.title !== a.name ? c.dim(a.title) : ""}  ${a.description ? c.dim(`: ${a.description}`) : ""}`);
  const defaults = [a.engine, a.model, a.effort && `@${a.effort}`].filter(Boolean).join(" ");
  console.log(`  defaults  ${defaults || c.dim("none (the session's own)")}`);
  console.log(`  skills    ${a.skills === null ? c.dim("default set") : a.skills.length ? a.skills.join(", ") : c.dim("none")}`);
  console.log(`  mcp       ${a.mcp === null ? c.dim("all enabled") : a.mcp.length ? a.mcp.join(", ") : c.dim("none")}`);
  if (full) console.log(`\n${a.instructions || c.dim("(no instructions)")}`);
  else if (a.instructions) console.log(`  ${c.dim(a.instructions.replace(/\s+/g, " ").slice(0, 90) + (a.instructions.length > 90 ? "…" : ""))}`);
}

export async function cmdAgent(argv: string[]): Promise<number> {
  const [sub = "list", ...rest] = argv;
  const flags = {
    title: { type: "string", short: "t" },
    description: { type: "string", short: "d" },
    instructions: { type: "string", short: "i" },
    "instructions-file": { type: "string", short: "f" },
    engine: { type: "string", short: "e" },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    skill: { type: "string", multiple: true, short: "s" },
    "all-skills": { type: "boolean" },
    "no-skills": { type: "boolean" },
    mcp: { type: "string", multiple: true },
    "all-mcp": { type: "boolean" },
    "no-mcp": { type: "boolean" },
    "from-role": { type: "string" },
  } as const;

  const patchFrom = async (values: Record<string, any>): Promise<Record<string, any>> => {
    const p: Record<string, any> = {};
    if (values.title !== undefined) p.title = values.title;
    if (values.description !== undefined) p.description = values.description;
    if (values.instructions !== undefined) p.instructions = values.instructions;
    if (values["instructions-file"]) {
      const file = path.resolve(String(values["instructions-file"]).replace(/^~(?=$|\/)/, os.homedir()));
      if (values["instructions-file"] === "-") p.instructions = await new Response(Bun.stdin.stream()).text();
      else if (!fs.existsSync(file)) die(`${file} does not exist.`);
      else p.instructions = fs.readFileSync(file, "utf-8");
    }
    for (const k of ["engine", "model", "effort"]) if (values[k] !== undefined) p[k] = values[k];
    if (values["all-skills"]) p.skills = null;
    else if (values["no-skills"]) p.skills = [];
    else if (values.skill?.length) p.skills = values.skill;
    if (values["all-mcp"]) p.mcp = null;
    else if (values["no-mcp"]) p.mcp = [];
    else if (values.mcp?.length) p.mcp = values.mcp;
    return p;
  };

  switch (sub) {
    case "list":
    case "ls": {
      const agents = Agents.list();
      if (agents.length === 0) {
        console.log(c.dim('No agents. Create one:  trb agent add reviewer -d "reviews diffs" -i "Review, don\'t rewrite."   or   trb agent add --from-role reviewer'));
        return 0;
      }
      agents.forEach((a) => printAgent(a));
      return 0;
    }
    case "show": {
      const a = Agents.get(rest[0]);
      if (!a) die(`No agent "${rest[0] ?? ""}".`);
      printAgent(a, true);
      const used = Agents.usedByPairs(a.name);
      if (used.length) console.log(c.dim(`\nused by: ${used.map((u) => `${u.pair}/${u.role}`).join(", ")}`));
      return 0;
    }
    case "add": {
      const { values, positionals } = opts(rest, flags);
      try {
        const fromRole = values["from-role"];
        const name = positionals[0];
        if (!name && !fromRole) die('Usage: trb agent add <name> [-t title] [-d description] [-i "instructions" | -f file] [-s skill]… [--mcp server]…   |   trb agent add --from-role <role>');
        const base = fromRole ? Agents.fromRole(fromRole, name ?? null) : Agents.create({ name });
        const patch = await patchFrom(values);
        printAgent(Object.keys(patch).length ? Agents.update(base.name, patch) : base, false);
      } catch (err: any) {
        die(err.message);
      }
      return 0;
    }
    case "edit": {
      const { values, positionals } = opts(rest, flags);
      if (!positionals[0]) die("Usage: trb agent edit <name> [flags as for add]");
      try {
        printAgent(Agents.update(positionals[0], await patchFrom(values)));
      } catch (err: any) {
        die(err.message);
      }
      return 0;
    }
    case "rm":
    case "remove": {
      const a = Agents.get(rest[0]);
      if (!a) die(`No agent "${rest[0] ?? ""}".`);
      const used = Agents.usedByPairs(a.name);
      if (used.length && !rest.includes("--force")) die(`"${a.name}" is used by ${used.map((u) => `${u.pair}/${u.role}`).join(", ")}. Remove it there first, or pass --force.`);
      Agents.remove(a.name);
      console.log(`removed ${a.name}`);
      return 0;
    }
    default:
      die(`Unknown: trb agent ${sub}. Subcommands: list, show, add, edit, rm.`);
  }
}

/* -------------------------------------------------------------------------- */
/* models                                                                     */
/* -------------------------------------------------------------------------- */

export async function cmdModels(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { refresh: { type: "boolean", short: "r" }, json: { type: "boolean" } });
  const engine = positionals[0];
  if (!engine || !engineIds().includes(engine)) die(`Usage: trb models <engine> [--refresh]. Engines: ${engineIds().join(", ")}`);
  const cat = await listModels(engine, { refresh: values.refresh });
  if (values.json) return printJson(cat);
  if (cat.error) console.error(c.yellow(`warning: ${cat.error}`));
  console.log(c.dim(`${engine}: ${cat.models.length} model${cat.models.length === 1 ? "" : "s"} (${cat.source === "cli" ? "from the CLI" : "built in"})${cat.efforts.length ? `, efforts: ${cat.efforts.join(", ")}` : ""}`));
  let group = "";
  for (const m of cat.models) {
    if ((m.group ?? "") !== group) {
      group = m.group ?? "";
      if (group) console.log(c.bold(`\n${group}`));
    }
    console.log(`  ${m.id}${m.default ? c.green("  (default)") : ""}${m.label && m.label !== m.id ? c.dim(`  ${m.label}`) : ""}`);
  }
  return 0;
}
