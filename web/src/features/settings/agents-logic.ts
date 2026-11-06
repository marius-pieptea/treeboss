/**
 * Pure logic for specialized agents: the editor form <-> API payload, assignment modes, what an agent will
 * actually see, and the small labels the cards and the composer share. No React, no network, relative imports
 * only, so it is unit tested directly.
 */

/** An agent's instructions are capped by the daemon at this many characters. */
export const INSTRUCTIONS_LIMIT = 20_000;

/* -------------------------------------------------------------------------- */
/* Assignments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How an agent is allowed to use skills (or MCP servers):
 *  - `all`: every enabled one, including ones added later (the daemon stores null);
 *  - `only`: exactly the named ones (a list);
 *  - `none`: nothing (an empty list, which is different from null).
 */
export type AssignMode = "all" | "only" | "none";

export function assignToMode(list: string[] | null | undefined): AssignMode {
  if (list === null || list === undefined) return "all";
  return list.length === 0 ? "none" : "only";
}

/** The inverse. `only` with nothing ticked is `none`: a list that grants nothing must say so. */
export function modeToAssign(mode: AssignMode, selected: string[]): string[] | null {
  if (mode === "all") return null;
  if (mode === "none") return [];
  return [...new Set(selected)];
}

/** "all enabled" / "3 skills" / "1 MCP server" / "no skills": the one-line summary on cards. */
export function assignmentLabel(list: string[] | null | undefined, noun: "skill" | "MCP server"): string {
  if (list === null || list === undefined) return noun === "skill" ? "default skills" : "all enabled";
  if (list.length === 0) return `no ${noun}s`;
  return `${list.length} ${noun}${list.length === 1 ? "" : "s"}`;
}

export interface Assignable {
  name: string;
  enabled: boolean;
}

export interface AssignmentPreview {
  /** What the engine will really be given: assigned AND enabled. */
  effective: string[];
  /** Assigned but globally disabled: stays off. */
  disabled: string[];
  /** Assigned but no longer existing (deleted since): the daemon will refuse to save these. */
  missing: string[];
}

/**
 * What an assignment resolves to against what exists. A globally disabled item stays off even when assigned:
 * disabling is the kill switch, assignment only chooses among what is on.
 */
export function previewAssignment(list: string[] | null | undefined, available: Assignable[]): AssignmentPreview {
  if (list === null || list === undefined) return { effective: available.filter((a) => a.enabled).map((a) => a.name), disabled: [], missing: [] };
  const byName = new Map(available.map((a) => [a.name, a]));
  const effective: string[] = [];
  const disabled: string[] = [];
  const missing: string[] = [];
  for (const n of list) {
    const a = byName.get(n);
    if (!a) missing.push(n);
    else if (a.enabled) effective.push(n);
    else disabled.push(n);
  }
  return { effective, disabled, missing };
}

/** "Sees 3 skills (deploy, tests, +1) and 1 MCP server": a short preview line for the editor. */
export function seesSummary(skills: AssignmentPreview, mcp: AssignmentPreview): string {
  const part = (p: AssignmentPreview, noun: string, nounPlural: string): string => {
    const n = p.effective.length;
    if (n === 0) return `no ${nounPlural}`;
    const shown = p.effective.slice(0, 3).join(", ");
    const more = n > 3 ? `, +${n - 3}` : "";
    return `${n} ${n === 1 ? noun : nounPlural} (${shown}${more})`;
  };
  return `Sees ${part(skills, "skill", "skills")} and ${part(mcp, "MCP server", "MCP servers")}`;
}

/* -------------------------------------------------------------------------- */
/* The editor form                                                            */
/* -------------------------------------------------------------------------- */

export interface AgentForm {
  name: string;
  title: string;
  description: string;
  instructions: string;
  engine: string;
  model: string;
  effort: string;
  skillsMode: AssignMode;
  skills: string[];
  mcpMode: AssignMode;
  mcp: string[];
}

export interface AgentLike {
  name: string;
  title: string;
  description?: string;
  instructions?: string;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  skills?: string[] | null;
  mcp?: string[] | null;
}

export const emptyAgentForm = (): AgentForm => ({ name: "", title: "", description: "", instructions: "", engine: "", model: "", effort: "", skillsMode: "all", skills: [], mcpMode: "all", mcp: [] });

export function agentToForm(a: AgentLike): AgentForm {
  return {
    name: a.name,
    title: a.title,
    description: a.description ?? "",
    instructions: a.instructions ?? "",
    engine: a.engine ?? "",
    model: a.model ?? "",
    effort: a.effort ?? "",
    skillsMode: assignToMode(a.skills),
    skills: a.skills ?? [],
    mcpMode: assignToMode(a.mcp),
    mcp: a.mcp ?? [],
  };
}

const orNull = (s: string): string | null => (s.trim() ? s.trim() : null);

/**
 * The request body. Assignments are sent explicitly every time (null / list / []), so a saved edit can never
 * silently leave the previous assignment in place.
 */
export function formToAgentPayload(f: AgentForm): Record<string, unknown> {
  return {
    name: normalizeAgentName(f.name),
    title: f.title.trim() || normalizeAgentName(f.name),
    description: f.description.trim(),
    instructions: f.instructions,
    engine: orNull(f.engine),
    model: orNull(f.model),
    effort: orNull(f.effort),
    skills: modeToAssign(f.skillsMode, f.skills),
    mcp: modeToAssign(f.mcpMode, f.mcp),
  };
}

/** The same slug the daemon accepts: lowercase letters, digits, "-" and "_", starting with a letter or digit, 40 at most. */
export function normalizeAgentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 40);
}

/** Problems the daemon would reject, caught before the round trip, in the daemon's words where it has them. */
export function validateAgentForm(f: AgentForm, opts: { editing: boolean; existing?: string[] } = { editing: false }): string[] {
  const errors: string[] = [];
  const name = normalizeAgentName(f.name);
  if (!opts.editing) {
    if (!f.name.trim()) errors.push("give the agent a name");
    else if (!name) errors.push(`name "${f.name}" must be lowercase letters, digits, "-" or "_"`);
    else if (opts.existing?.includes(name)) errors.push(`agent "${name}" already exists`);
  }
  if (f.instructions.length > INSTRUCTIONS_LIMIT) errors.push(`instructions are too long (${f.instructions.length} of ${INSTRUCTIONS_LIMIT} characters)`);
  return errors;
}

/** The role-library entry the templates menu offers. */
export interface TemplateLike {
  id: string;
  label: string;
  description: string;
  effort?: string;
  instructions: string;
}

/**
 * Fill the form from a template without clobbering what the user already typed in the identity fields:
 * instructions and description are replaced (that is the point of a template), the name and title only when
 * they are still empty, and the suggested effort only when none is chosen.
 */
export function applyTemplate(f: AgentForm, t: TemplateLike, opts: { lockName?: boolean } = {}): AgentForm {
  return {
    ...f,
    name: opts.lockName || f.name.trim() ? f.name : t.id,
    title: f.title.trim() ? f.title : t.label,
    description: t.description,
    instructions: t.instructions,
    effort: f.effort || t.effort || "",
  };
}

/** "1,204 / 20,000": the live counter under the instructions box. */
export function instructionsCount(text: string): { used: number; limit: number; near: boolean; over: boolean } {
  const used = text.length;
  return { used, limit: INSTRUCTIONS_LIMIT, near: used >= INSTRUCTIONS_LIMIT * 0.9 && used <= INSTRUCTIONS_LIMIT, over: used > INSTRUCTIONS_LIMIT };
}

/** Whether `list` names the same set as `base` (null means "everything enabled"): order and duplicates do not matter. */
export function sameAssignment(list: string[] | null, base: string[] | null): boolean {
  if (list === null || base === null) return list === base;
  const a = new Set(list);
  const b = new Set(base);
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** A short line for an agent card's instructions: collapsed whitespace, clipped. */
export function instructionsPreview(text: string, max = 110): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The agents that name this skill in an explicit assignment ("all enabled" agents use it too, but say nothing of it). */
export function agentsUsingSkill<A extends { name: string; title: string; skills: string[] | null }>(agents: A[], skill: string): A[] {
  return agents.filter((a) => a.skills !== null && a.skills.includes(skill));
}
