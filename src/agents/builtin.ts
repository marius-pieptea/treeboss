/**
 * Agents that ship with trb. They are seeded into the agent store once (when the daemon starts) as ordinary agents:
 * editable, deletable. Mirrors skills/builtin.ts.
 *
 * `<trb home>/builtin-agents.json` keeps, per name, a fingerprint of the copy trb last wrote, or null when the name was
 * already one of yours (yours wins, now and later). A deleted built-in stays deleted until "Restore built-in agents".
 * When the shipped definition changes, a copy you never edited follows it on the next start; an edited copy is kept.
 * A skill or MCP server that is not installed is left out of the copy, with a log line, so seeding never throws.
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { home } from "../paths";
import { McpStore } from "../mcp/store";
import { SkillStore } from "../skills/store";
import { UserError } from "../util";
import { Agents, agentFields, type AgentFields, type AgentRecord } from "./store";
import { PSTACK_AGENTS } from "./pstack";

export interface BuiltinAgent {
  name: string;
  title: string;
  description: string;
  instructions: string;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  /** null or absent: every enabled skill. */
  skills?: string[] | null;
  /** null or absent: every enabled MCP server. */
  mcp?: string[] | null;
}

/** The agents that ship with trb: the pstack set (agents/pstack.ts). A release adds one by adding it to that list; the rules below need no change. */
export const BUILTIN_AGENTS: BuiltinAgent[] = [...PSTACK_AGENTS];

/** name → fingerprint of the copy trb last wrote; null: the name is one of yours. */
interface State {
  seeded: Map<string, string | null>;
}

const stateFile = (): string => path.join(home(), "builtin-agents.json");

function readState(): State {
  try {
    const v = JSON.parse(fs.readFileSync(stateFile(), "utf-8"));
    const seeded = new Map<string, string | null>();
    for (const [name, fp] of Object.entries(v?.seeded ?? {})) if (typeof fp === "string" || fp === null) seeded.set(name, fp);
    return { seeded };
  } catch {
    return { seeded: new Map() };
  }
}

function writeState(s: State): void {
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ seeded: Object.fromEntries(s.seeded) }, null, 2) + "\n");
  fs.renameSync(tmp, stateFile());
}

/** A short, stable hash of what an agent is kept as. */
const fingerprint = (f: AgentFields): string => createHash("sha256").update(JSON.stringify(f)).digest("hex").slice(0, 16);
const copyOf = (r: AgentRecord): string => fingerprint(agentFields(r.name, r));

/**
 * The shipped definition as the store will keep it: a skill or MCP server that is not installed is left out, and named
 * in `dropped`. The store refuses unknown names, so this is what keeps a built-in from making seeding throw.
 */
function storable(b: BuiltinAgent): { def: BuiltinAgent; dropped: string[] } {
  const dropped: string[] = [];
  const keep = (names: string[] | null | undefined, installed: (n: string) => boolean, kind: string): string[] | null => {
    if (!names) return null;
    for (const n of names) if (!installed(n)) dropped.push(`${kind} "${n}"`);
    return names.filter(installed);
  };
  const def: BuiltinAgent = {
    ...b,
    skills: keep(b.skills, (n) => !!SkillStore.get(n), "skill"),
    mcp: keep(b.mcp, (n) => !!McpStore.get(n), "MCP server"),
  };
  return { def, dropped };
}

/** Write a built-in's copy over `cur` (or as a new agent) and return the fingerprint of what was kept. */
function install(b: BuiltinAgent, cur: AgentRecord | null): string {
  const { def, dropped } = storable(b);
  for (const d of dropped) console.log(`[trb] built-in agent "${b.name}" leaves out ${d}: it is not installed`);
  Agents.write(def.name, def, cur);
  return copyOf(Agents.get(def.name)!);
}

/** What the shipped definition would be kept as, now. */
const shippedFp = (b: BuiltinAgent): string => fingerprint(agentFields(b.name, storable(b).def));

/**
 * Seed every built-in whose name is free, and bring an unedited copy up to a changed shipped definition. Returns the
 * names added. `list` is the shipped set; tests pass their own.
 */
export function seedBuiltinAgents(list: BuiltinAgent[] = BUILTIN_AGENTS): string[] {
  const s = readState();
  const added: string[] = [];
  let changed = false;
  for (const b of list) {
    const cur = Agents.get(b.name);
    const fp = s.seeded.get(b.name);
    if (fp === undefined) {
      // Never seen: install it, unless the name is already one of yours.
      if (cur) s.seeded.set(b.name, null);
      else {
        s.seeded.set(b.name, install(b, null));
        added.push(b.name);
      }
      changed = true;
    } else if (cur && fp !== null && copyOf(cur) === fp && shippedFp(b) !== fp) {
      // Still the copy trb wrote, and the shipped text has moved on: follow it. Edited, yours, or deleted: left alone.
      s.seeded.set(b.name, install(b, cur));
      changed = true;
    }
  }
  if (changed) writeState(s);
  return added;
}

/** For the UI: whether an agent is a built-in, and whether its copy differs from what trb last wrote. */
export function builtinAgentStatus(r: AgentRecord, list: BuiltinAgent[] = BUILTIN_AGENTS): { builtin: boolean; modified: boolean } {
  const fp = readState().seeded.get(r.name);
  if (typeof fp !== "string" || !list.some((b) => b.name === r.name)) return { builtin: false, modified: false };
  return { builtin: true, modified: copyOf(r) !== fp };
}

/** Built-ins with no agent of that name now: deleted, or never seeded because the name was yours and is now free. */
export function missingBuiltinAgents(list: BuiltinAgent[] = BUILTIN_AGENTS): string[] {
  return list.filter((b) => !Agents.get(b.name)).map((b) => b.name);
}

/** Put a built-in back to the shipped definition. Refuses an agent of yours that happens to share the name. */
export function resetBuiltinAgent(name: string, list: BuiltinAgent[] = BUILTIN_AGENTS): AgentRecord {
  const b = list.find((x) => x.name === name);
  if (!b) throw new UserError(`"${name}" is not an agent that ships with trb.`);
  const cur = Agents.get(name);
  const s = readState();
  if (cur && typeof s.seeded.get(name) !== "string") throw new UserError(`"${name}" is an agent you added; trb will not overwrite it. Rename or remove it first.`);
  s.seeded.set(name, install(b, cur));
  writeState(s);
  return Agents.get(name)!;
}

/** Add back the built-ins that are missing. Returns the names added. */
export function restoreBuiltinAgents(list: BuiltinAgent[] = BUILTIN_AGENTS): string[] {
  const added = missingBuiltinAgents(list);
  if (!added.length) return added;
  const s = readState();
  for (const name of added) s.seeded.set(name, install(list.find((b) => b.name === name)!, null));
  writeState(s);
  return added;
}

/** You named a new agent after a built-in: the name is yours from now on, so a later restore leaves your agent alone. */
export function claimBuiltinName(name: string): void {
  const s = readState();
  if (typeof s.seeded.get(name) !== "string") return;
  s.seeded.set(name, null);
  writeState(s);
}
