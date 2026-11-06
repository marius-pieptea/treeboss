/**
 * Specialized agents: a named profile a session can run as.
 *
 * An agent is instructions (who it is and how it works) plus the engine/model/effort it prefers plus what
 * it may use: which skills and which MCP servers. Leaving skills or MCP unset means "everything that is
 * enabled", so a new agent is useful immediately; naming a list narrows it, which is how a reviewer is kept
 * away from the deploy skill and a docs writer from the database MCP.
 *
 * An agent is applied three ways: a lead can be started as one (`trb run --agent reviewer`), a lead can open
 * a subagent as one (`subagent_create({ agent })`), and a Hydra pair role can point at one.
 */
import { db } from "../db";
import { PAIR_ROLE_LIBRARY } from "../hydra/roles";
import { McpStore } from "../mcp/store";
import { SkillStore } from "../skills/store";
import { UserError, parseList } from "../util";

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MAX_INSTRUCTIONS_CHARS = 20_000;

export interface AgentRecord {
  name: string;
  title: string;
  description: string;
  instructions: string;
  engine: string | null;
  model: string | null;
  effort: string | null;
  /** null: every enabled skill. */
  skills: string[] | null;
  /** null: every enabled MCP server. */
  mcp: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface AgentInput {
  name: string;
  title?: string | null;
  description?: string | null;
  instructions?: string | null;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  skills?: string[] | null;
  mcp?: string[] | null;
}

function row(r: any): AgentRecord {
  return {
    name: r.name,
    title: r.title,
    description: r.description,
    instructions: r.instructions,
    engine: r.engine,
    model: r.model,
    effort: r.effort,
    skills: r.skills_json === null || r.skills_json === undefined ? null : parseList(r.skills_json),
    mcp: r.mcp_json === null || r.mcp_json === undefined ? null : parseList(r.mcp_json),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function uniq(list: unknown, what: string): string[] | null {
  if (list === null || list === undefined) return null;
  if (!Array.isArray(list)) throw new UserError(`${what} must be a list of names, or null for "all enabled".`);
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
}

export type AgentFields = Omit<AgentRecord, "created_at" | "updated_at">;

/** The fields an agent is kept with. `write` saves exactly these, so a definition and its saved copy compare equal (agents/builtin.ts). */
export function agentFields(name: string, input: AgentInput): AgentFields {
  return {
    name,
    title: (clean(input.title) ?? name).slice(0, 80),
    description: (input.description ?? "").toString().slice(0, 400),
    instructions: (input.instructions ?? "").toString(),
    engine: clean(input.engine),
    model: clean(input.model),
    effort: clean(input.effort),
    skills: uniq(input.skills, "skills"),
    mcp: uniq(input.mcp, "mcp"),
  };
}

/** Names that do not exist would silently grant nothing; refuse them so a typo is loud. */
function checkAssignments(skills: string[] | null, mcp: string[] | null): void {
  if (skills) {
    const known = new Set(SkillStore.list().map((s) => s.name));
    const bad = skills.filter((s) => !known.has(s));
    if (bad.length) throw new UserError(`Unknown skill${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}. See \`trb skill list\`.`);
  }
  if (mcp) {
    const known = new Set(McpStore.list().map((s) => s.name));
    const bad = mcp.filter((s) => !known.has(s));
    if (bad.length) throw new UserError(`Unknown MCP server${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}. See \`trb mcp list\`.`);
  }
}

export const Agents = {
  list(): AgentRecord[] {
    return (db().prepare("SELECT * FROM agents ORDER BY title COLLATE NOCASE, name").all() as any[]).map(row);
  },

  get(name: string | null | undefined): AgentRecord | null {
    if (!name) return null;
    const r = db().prepare("SELECT * FROM agents WHERE name = ?").get(name);
    return r ? row(r) : null;
  },

  /** An agent by name, or a UserError that says what exists. */
  require(name: string): AgentRecord {
    const a = this.get(name);
    if (!a) {
      const names = this.list().map((x) => x.name);
      throw new UserError(`No agent "${name}".${names.length ? ` Agents: ${names.join(", ")}.` : " Create one with `trb agent add`."}`);
    }
    return a;
  },

  create(input: AgentInput): AgentRecord {
    const name = String(input.name ?? "").trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new UserError(`Agent name "${input.name}" must be lowercase letters, digits, "-" or "_" (max 40).`);
    if (this.get(name)) throw new UserError(`Agent "${name}" already exists. Edit it instead.`);
    return this.write(name, input, null);
  },

  update(name: string, patch: Partial<AgentInput>): AgentRecord {
    const cur = this.require(name);
    return this.write(name, { ...cur, ...patch, name }, cur);
  },

  /** Insert or replace, validating assignments. `cur` is the existing record for an update. */
  write(name: string, input: AgentInput, cur: AgentRecord | null): AgentRecord {
    const instructions = (input.instructions ?? "").toString();
    if (instructions.length > MAX_INSTRUCTIONS_CHARS) throw new UserError(`Instructions are too long (${instructions.length} chars; the limit is ${MAX_INSTRUCTIONS_CHARS}).`);
    const f = agentFields(name, input);
    checkAssignments(f.skills, f.mcp);
    db()
      .prepare(
        `INSERT INTO agents (name, title, description, instructions, engine, model, effort, skills_json, mcp_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET title = excluded.title, description = excluded.description, instructions = excluded.instructions,
           engine = excluded.engine, model = excluded.model, effort = excluded.effort, skills_json = excluded.skills_json,
           mcp_json = excluded.mcp_json, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(f.name, f.title, f.description, f.instructions, f.engine, f.model, f.effort, f.skills ? JSON.stringify(f.skills) : null, f.mcp ? JSON.stringify(f.mcp) : null);
    void cur;
    return this.get(name)!;
  },

  remove(name: string): boolean {
    return db().prepare("DELETE FROM agents WHERE name = ?").run(name).changes > 0;
  },

  /** A starting point from the role library (scout, reviewer, …): its instructions and suggested engine/effort. */
  fromRole(roleId: string, name?: string | null): AgentRecord {
    const role = PAIR_ROLE_LIBRARY.find((r) => r.id === roleId);
    if (!role) throw new UserError(`No role "${roleId}". Roles: ${PAIR_ROLE_LIBRARY.map((r) => r.id).join(", ")}.`);
    return this.create({ name: name ?? role.id, title: role.label, description: role.description, instructions: role.instructions, engine: null, effort: role.effort });
  },

  /** Which pairs reference this agent in a role, so deleting or renaming it is not a surprise. */
  usedByPairs(name: string): Array<{ pair: string; role: string }> {
    const out: Array<{ pair: string; role: string }> = [];
    for (const r of db().prepare("SELECT title, roles_json FROM pairs WHERE roles_json IS NOT NULL").all() as Array<{ title: string; roles_json: string }>) {
      try {
        for (const [role, cfg] of Object.entries(JSON.parse(r.roles_json) as Record<string, { agent?: string | null }>)) if (cfg?.agent === name) out.push({ pair: r.title, role });
      } catch {}
    }
    return out;
  },
};

/** The block a session's first turn carries so the model knows who it is. */
export function agentPromptBlock(a: AgentRecord): string {
  const text = a.instructions.trim();
  if (!text) return "";
  return `# You are the "${a.title}" agent\n${text}\n\n`;
}
