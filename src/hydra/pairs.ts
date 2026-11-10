/**
 * Hydra pairs: which engine/model leads, and what its heads run on.
 *
 * A pair is the operator's choice, and it is binding: a lead cannot swap a head's
 * engine (see `assertWithinPair` in the session manager). A pair is exactly one of:
 *  - `heads`: every head runs the one heads config (engine/model/effort).
 *  - `roles`: every head names a role and runs that role's config.
 * Mixing them made a hidden third worker config in Omni (role-less heads quietly
 * ran the heads config and filled any blank role field), so the two are exclusive.
 */
import { UserError } from "../util";
import { randomUUID } from "crypto";
import { db } from "../db";
import { PAIR_ROLE_LIBRARY, normalizeRoleKey } from "./roles";
import { Agents } from "../agents/store";

export const MAX_HEADS_RANGE = { min: 1, max: 8 } as const;
/** The standing brief for a pair's lead. It is read at the top of every lead turn, so it is capped. */
export const LEAD_INSTRUCTIONS_CHARS = 2_000;

export interface HydraHeadRoleConfig {
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  /** A specialized agent this role runs as (its instructions, skills and MCP assignment). */
  agent?: string | null;
  /** Standing brief appended to every head opened in this role. */
  instructions?: string | null;
  label?: string | null;
}

export type HydraPairMode = "heads" | "roles";
export type HydraHeadRoles = Record<string, HydraHeadRoleConfig>;

export interface HydraPair {
  id: string;
  title: string;
  mode: HydraPairMode;
  lead_engine: string | null;
  lead_model: string | null;
  lead_effort: string | null;
  heads_engine: string | null;
  heads_model: string | null;
  heads_effort: string | null;
  roles: HydraHeadRoles | null;
  max_heads: number | null;
  /** A standing brief for the lead of this pair, read at the top of every lead turn (null: none). */
  lead_instructions?: string | null;
  created_at?: string;
}

export interface HydraPairInput {
  title: string;
  mode?: HydraPairMode | null;
  lead_engine?: string | null;
  lead_model?: string | null;
  lead_effort?: string | null;
  heads_engine?: string | null;
  heads_model?: string | null;
  heads_effort?: string | null;
  roles?: HydraHeadRoles | null;
  max_heads?: number | null;
  /** A standing brief for the lead, at most LEAD_INSTRUCTIONS_CHARS characters. */
  lead_instructions?: string | null;
}

function withPreset(id: string, cfg: HydraHeadRoleConfig): HydraHeadRoleConfig {
  const p = PAIR_ROLE_LIBRARY.find((r) => r.id === id);
  return { label: p?.label ?? id, instructions: p?.instructions ?? null, ...cfg };
}

/** The lead brief both pstack recipes carry: how the lead works pstack's way, and which head is which role. */
const PSTACK_LEAD = [
  "Work the pstack way (pstack by Lauren Tan, MIT). On each new task, read two skills in full by path from your skills folder (for example .claude/skills/<name>/SKILL.md): poteto-mode, the router, and pstack-treeboss, which maps pstack's Cursor names onto treeboss. pstack skills are hidden from the skill list, so read them by path.",
  "Then follow poteto-mode: restate the goal, the problem and the smallest change; route to one playbook and copy its steps into your todo list verbatim (a skipped step stays as `skip: <reason>`); read each principle you apply.",
  "pstack's subagents are your heads, by role:",
  "- explorer: how, why and recall explorers, read-only grounding",
  "- architect: architect and arena runners, design sketches",
  "- builder: poteto-agent code delegates, one unit each",
  "- verifier: independent verdicts, interrogate and swarm gauntlets; never the head that wrote the code",
  "- cleaner: comment-sicko, no-comments and unslop passes",
  "Brief each head with file pointers, the named data shape and the success criteria. Open a fresh head per new unit; fixes to a unit go back to the head that built it with subagent_send, and a verifier is never that head. You own every diff: review it and run the checks before you merge. Pause only for irreversible actions: force-push, deploys, data deletion, customer messages.",
].join("\n");

/** One line per pstack role. Each role carries its own line, so the library's text for a role is never appended. */
const PSTACK_ROLE_NOTE = {
  explorer: "Read-only grounding: answer the question with cited findings, and change nothing.",
  architect: "Design only: sketch at least two distinct candidates, screen them and recommend one, with no implementation.",
  builder: "Build one unit with small verified commits, and report what you verified.",
  verifier: "Prove or refute on the real surface, and never be the author of the code you check.",
  cleaner: "Report the comments to cut, and delete them only when your brief explicitly asks you to.",
};

/** Starting points, applied only when the operator picks one (`trb pair add --recipe <id>`). */
export const PAIR_COOKBOOK: Array<HydraPairInput & { id: string; tagline: string }> = [
  {
    id: "claude-codex",
    title: "Claude leads Codex",
    tagline: "Claude reasons and reviews; Codex builds slices in parallel.",
    lead_engine: "claude",
    lead_model: "claude-opus-5-5",
    lead_effort: "high",
    mode: "roles",
    max_heads: 4,
    roles: {
      scout: withPreset("scout", { engine: "claude", model: "claude-haiku-5-5", effort: "low" }),
      worker: withPreset("worker", { engine: "codex", model: "default", effort: "medium" }),
      reviewer: withPreset("reviewer", { engine: "claude", model: "claude-opus-5-5", effort: "high" }),
    },
  },
  {
    id: "super-hydra-trio",
    title: "Super Hydra: Opus Trio",
    tagline: "Opus 5.5 reasons, Cursor scouts, Gemini Flash executes in parallel.",
    lead_engine: "claude",
    lead_model: "claude-opus-5-5",
    lead_effort: "high",
    mode: "roles",
    max_heads: 6,
    roles: {
      scout: withPreset("scout", { engine: "cursor", model: "default", effort: "medium" }),
      worker: withPreset("worker", { engine: "agy", model: "gemini-3.8-flash-high", effort: "medium" }),
      reviewer: withPreset("reviewer", { engine: "claude", model: "claude-opus-5-5", effort: "high" }),
    },
  },
  {
    id: "opus-sonnet",
    title: "Opus leads Sonnet",
    tagline: "Careful lead, cheaper heads on the same engine.",
    lead_engine: "claude",
    lead_model: "claude-opus-5-5",
    lead_effort: "high",
    heads_engine: "claude",
    heads_model: "claude-sonnet-5-5",
    heads_effort: "medium",
    max_heads: 6,
  },
  {
    id: "sonnet-haiku",
    title: "Sonnet leads Haiku",
    tagline: "The cheapest useful Hydra: Sonnet plans, Haiku heads do the legwork.",
    lead_engine: "claude",
    lead_model: "claude-sonnet-5-5",
    lead_effort: "high",
    heads_engine: "claude",
    heads_model: "claude-haiku-5-5",
    heads_effort: "medium",
    max_heads: 4,
  },
  {
    id: "grok-opencode",
    title: "Grok leads OpenCode",
    tagline: "Grok plans; OpenCode heads build.",
    lead_engine: "grok",
    lead_model: "grok-4.6",
    lead_effort: "high",
    heads_engine: "opencode",
    heads_model: "zai/glm-5",
    heads_effort: "medium",
    max_heads: 4,
  },
  {
    id: "pstack-claude",
    title: "pstack (Claude)",
    tagline: "pstack's playbook on Claude: Opus plans and judges; Sonnet explores, builds and cleans.",
    lead_engine: "claude",
    lead_model: "claude-opus-5-5",
    lead_effort: "xhigh",
    lead_instructions: PSTACK_LEAD,
    mode: "roles",
    max_heads: 6,
    roles: {
      explorer: { engine: "claude", model: "claude-sonnet-5-5", effort: "medium", agent: "pstack-explorer", label: "Explorer", instructions: PSTACK_ROLE_NOTE.explorer },
      architect: { engine: "claude", model: "claude-opus-5-5", effort: "high", agent: "pstack-architect", label: "Architect", instructions: PSTACK_ROLE_NOTE.architect },
      builder: { engine: "claude", model: "claude-sonnet-5-5", effort: "high", agent: "poteto-agent", label: "Builder", instructions: PSTACK_ROLE_NOTE.builder },
      verifier: { engine: "claude", model: "claude-opus-5-5", effort: "high", agent: "pstack-verifier", label: "Verifier", instructions: PSTACK_ROLE_NOTE.verifier },
      cleaner: { engine: "claude", model: "claude-sonnet-5-5", effort: "medium", agent: "comment-sicko", label: "Cleaner", instructions: PSTACK_ROLE_NOTE.cleaner },
    },
  },
  {
    id: "pstack-claude-codex",
    title: "pstack (Claude + Codex)",
    tagline: "pstack's split across model families: Codex builds, Claude Opus judges, so the verifier never shares the builder's family.",
    lead_engine: "claude",
    lead_model: "claude-opus-5-5",
    lead_effort: "xhigh",
    lead_instructions: PSTACK_LEAD,
    mode: "roles",
    max_heads: 6,
    roles: {
      explorer: { engine: "claude", model: "claude-sonnet-5-5", effort: "medium", agent: "pstack-explorer", label: "Explorer", instructions: PSTACK_ROLE_NOTE.explorer },
      architect: { engine: "claude", model: "claude-opus-5-5", effort: "high", agent: "pstack-architect", label: "Architect", instructions: PSTACK_ROLE_NOTE.architect },
      builder: { engine: "codex", model: "default", effort: "high", agent: "poteto-agent", label: "Builder", instructions: PSTACK_ROLE_NOTE.builder },
      verifier: { engine: "claude", model: "claude-opus-5-5", effort: "high", agent: "pstack-verifier", label: "Verifier", instructions: PSTACK_ROLE_NOTE.verifier },
      cleaner: { engine: "claude", model: "claude-sonnet-5-5", effort: "medium", agent: "comment-sicko", label: "Cleaner", instructions: PSTACK_ROLE_NOTE.cleaner },
    },
  },
];

/** The agent each pstack role runs as, from the pstack recipe: a pstack lead asking for `explorer` in another pair means the role running that agent. */
const PSTACK_ROLE_AGENTS: Record<string, string> = Object.fromEntries(
  Object.entries(PAIR_COOKBOOK.find((r) => r.id === "pstack-claude")!.roles!).map(([id, c]) => [id, c.agent ?? ""]),
);

/**
 * The pair role a lead's `role` names: the id itself, else the one role whose label is that name (`worker` finds a role
 * labelled "Worker" whatever its id), else the one role running the agent that pstack role names (`explorer` finds the
 * role running pstack-explorer). Null when nothing, or more than one role, matches.
 */
export function resolveRole(roles: HydraHeadRoles, asked: string): string | null {
  if (roles[asked]) return asked;
  const name = asked.trim().toLowerCase();
  const only = (pred: (c: HydraHeadRoleConfig) => boolean): string | null => {
    const hits = Object.entries(roles).filter(([, c]) => pred(c));
    return hits.length === 1 ? hits[0]![0] : null;
  };
  const agent = PSTACK_ROLE_AGENTS[name];
  return only((c) => c.label?.trim().toLowerCase() === name) ?? (agent ? only((c) => c.agent === agent) : null);
}

/** What a role is for, in one line: the first sentence of its instructions, else its preset's description, else its agent's. */
export function roleSummary(id: string, c: HydraHeadRoleConfig): string | null {
  const first = c.instructions?.trim().split(/(?<=[.!?])\s/)[0]?.trim();
  if (first) return first.length > 200 ? `${first.slice(0, 199)}…` : first;
  const label = c.label?.trim().toLowerCase();
  const preset = PAIR_ROLE_LIBRARY.find((p) => p.id === id || (label && p.label.toLowerCase() === label));
  return preset?.description ?? Agents.get(c.agent ?? null)?.description ?? null;
}

function clampCap(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.min(MAX_HEADS_RANGE.max, Math.max(MAX_HEADS_RANGE.min, Math.round(n)));
}

function row(r: any): HydraPair {
  let roles: HydraHeadRoles | null = null;
  if (r.roles_json) {
    try {
      roles = JSON.parse(r.roles_json);
    } catch {}
  }
  const mode: HydraPairMode = r.mode === "roles" ? "roles" : "heads";
  const { roles_json: _drop, ...rest } = r;
  if (mode === "roles") {
    // A roles pair must never see heads fields, even stale ones.
    return { ...rest, mode, roles, heads_engine: null, heads_model: null, heads_effort: null, max_heads: clampCap(r.max_heads) };
  }
  return { ...rest, mode, roles: null, max_heads: clampCap(r.max_heads) };
}

/** The lead brief as stored: trimmed, null when blank. Refused past the cap, in the operator's words. */
function leadInstructionsOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new UserError("lead_instructions must be text.");
  if (v.length > LEAD_INSTRUCTIONS_CHARS) throw new UserError(`Lead instructions are too long (${v.length} chars; the limit is ${LEAD_INSTRUCTIONS_CHARS}).`);
  return v.trim() || null;
}

/** One mode's fields, the other's cleared. Roles mode needs at least one role; role keys are normalised. */
function normalizeInput(input: HydraPairInput): HydraPairInput & { mode: HydraPairMode } {
  const lead_instructions = leadInstructionsOf(input.lead_instructions);
  const cleanRoles: HydraHeadRoles = {};
  for (const [key, cfg] of Object.entries(input.roles ?? {})) {
    const k = normalizeRoleKey(key);
    if (!k || !cfg) continue;
    if (cleanRoles[k]) throw new UserError(`duplicate role "${k}"`);
    cleanRoles[k] = {
      engine: cfg.engine || null,
      model: cfg.model || null,
      effort: cfg.effort || null,
      agent: cfg.agent?.trim() || null,
      instructions: cfg.instructions?.trim() || null,
      label: cfg.label?.trim() || null,
    };
  }
  const mode: HydraPairMode = input.mode ?? (Object.keys(cleanRoles).length > 0 ? "roles" : "heads");
  if (mode === "roles") {
    if (Object.keys(cleanRoles).length === 0) throw new UserError("a roles pair needs at least one role");
    for (const [k, cfg] of Object.entries(cleanRoles)) if (cfg.agent && !Agents.get(cfg.agent)) throw new UserError(`Role "${k}" uses agent "${cfg.agent}", which does not exist.`);
    return { ...input, mode, roles: cleanRoles, heads_engine: null, heads_model: null, heads_effort: null, lead_instructions };
  }
  return { ...input, mode, roles: null, lead_instructions };
}

export const HydraPairs = {
  list(): HydraPair[] {
    return (db().prepare("SELECT * FROM pairs ORDER BY created_at DESC, rowid DESC").all() as any[]).map(row);
  },

  get(id: string | null | undefined): HydraPair | null {
    if (!id) return null;
    const found = db().prepare("SELECT * FROM pairs WHERE id = ?").get(id);
    return found ? row(found) : null;
  },

  /** By id, else by case-insensitive title. `trb run --pair "Opus leads Sonnet"` works. */
  find(idOrTitle: string | null | undefined): HydraPair | null {
    if (!idOrTitle) return null;
    const byId = this.get(idOrTitle);
    if (byId) return byId;
    const byTitle = db().prepare("SELECT * FROM pairs WHERE lower(title) = lower(?)").get(idOrTitle);
    return byTitle ? row(byTitle) : null;
  },

  create(input: HydraPairInput): HydraPair {
    const title = String(input.title || "").trim();
    if (!title) throw new UserError("pair needs a title");
    const n = normalizeInput(input);
    const id = randomUUID().slice(0, 8);
    db()
      .prepare(
        `INSERT INTO pairs (id, title, mode, lead_engine, lead_model, lead_effort, heads_engine, heads_model, heads_effort, roles_json, max_heads, lead_instructions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, title, n.mode, n.lead_engine || null, n.lead_model || null, n.lead_effort || null, n.heads_engine || null, n.heads_model || null, n.heads_effort || null, n.roles ? JSON.stringify(n.roles) : null, clampCap(n.max_heads), n.lead_instructions ?? null);
    return this.get(id)!;
  },

  update(id: string, input: Partial<HydraPairInput>): HydraPair | null {
    const existing = this.get(id);
    if (!existing) return null;
    // A mode switch must not inherit the other mode's fields from the row.
    const base: HydraPairInput = { ...existing };
    if (input.mode === "heads") base.roles = null;
    // Roles sent without a mode mean "make this a roles pair", not "drop them".
    if (input.mode === undefined && input.roles !== undefined) delete base.mode;
    const merged = normalizeInput({ ...base, ...input, title: String(input.title ?? existing.title).trim() || existing.title });
    db()
      .prepare(
        `UPDATE pairs SET title = ?, mode = ?, lead_engine = ?, lead_model = ?, lead_effort = ?,
           heads_engine = ?, heads_model = ?, heads_effort = ?, roles_json = ?, max_heads = ?, lead_instructions = ? WHERE id = ?`,
      )
      .run(merged.title, merged.mode, merged.lead_engine || null, merged.lead_model || null, merged.lead_effort || null, merged.heads_engine || null, merged.heads_model || null, merged.heads_effort || null, merged.roles ? JSON.stringify(merged.roles) : null, clampCap(merged.max_heads), merged.lead_instructions ?? null, id);
    return this.get(id);
  },

  remove(id: string): boolean {
    return db().prepare("DELETE FROM pairs WHERE id = ?").run(id).changes > 0;
  },

  /** A recipe that names an agent this install does not have says how to get it back, not a generic refusal. */
  fromCookbook(recipeId: string, recipes: typeof PAIR_COOKBOOK = PAIR_COOKBOOK): HydraPair {
    const recipe = recipes.find((r) => r.id === recipeId);
    if (!recipe) throw new UserError(`unknown recipe "${recipeId}". Recipes: ${recipes.map((r) => r.id).join(", ")}`);
    for (const [role, cfg] of Object.entries(recipe.roles ?? {})) {
      if (cfg.agent && !Agents.get(cfg.agent)) throw new UserError(`The "${recipe.title}" recipe runs its ${role} role as agent "${cfg.agent}", which is not installed: restore built-in agents in Settings > Agents.`);
    }
    const { id: _id, tagline: _tagline, ...input } = recipe;
    return this.create(input);
  },

  summary(pair: HydraPair): string {
    const lead = [pair.lead_model, pair.lead_effort].filter(Boolean).join(" ");
    const heads = [pair.heads_model, pair.heads_effort].filter(Boolean).join(" ");
    const cap = pair.max_heads != null ? ` · ${pair.max_heads} heads` : "";
    if (pair.mode === "roles" && pair.roles && Object.keys(pair.roles).length > 0) {
      const roleDescs = Object.entries(pair.roles)
        .map(([r, c]) => `${r}:${c.model?.split("/").pop() || c.engine || "head"}`)
        .join(", ");
      return `${lead || "lead"} → [${roleDescs}]${cap}`;
    }
    return `${lead || "lead"} → ${heads || "heads"}${cap}`;
  },

  /**
   * The lead contract at the TOP of every lead turn's prompt. Buried in a long context file a
   * capable lead reads it as background and does the work itself, so no heads open. Leading the
   * turn with it, plus a concrete first step that loads the deferred subagent tools, is what makes
   * it act on it. (Lesson from Omni, measured: the fix was position, not wording.)
   */
  leadTurnPreamble(
    pair: HydraPair,
    engine?: string | null,
    openHeads: Array<{ id: string; title: string; status: string; engine: string; role?: string | null }> = [],
  ): string {
    const loadStep =
      engine === "claude"
        ? `Your FIRST tool call: load the subagent tools with ToolSearch \`select:mcp__trb__subagent_create,mcp__trb__subagent_wait,mcp__trb__subagent_send,mcp__trb__subagent_merge,mcp__trb__subagent_close\`.`
        : `Your first step: find the trb MCP server's subagent_create / subagent_wait / subagent_send / subagent_merge / subagent_close tools.`;
    const heads =
      pair.mode === "roles"
        ? `Heads take one of the pair's roles (${Object.keys(pair.roles ?? {}).join(", ")}).`
        : `Heads run ${[pair.heads_engine, pair.heads_model].filter(Boolean).join(" / ") || "the heads config"}.`;
    return [
      `# You are the LEAD of the Hydra pair "${pair.title}" — read this before anything else`,
      `You are the tech lead, not the coder. You do NOT write code or tests and you do NOT do the investigation yourself: every code change, however small, and every non-trivial look into the codebase or the web goes to a head (a live subagent). ${heads} A glance at a file or two to scope the work is fine. Answering a plain question needs no heads.`,
      loadStep,
      ...(this.agentsLine() ? [this.agentsLine()] : []),
      `Then open one head per independent slice (several subagent_create calls in one response). Pass \`files\` with each head: the repo-relative paths or directory prefixes it will touch. Heads that touch the same files do not run in parallel: open one, and when it finishes send the follow-up to that same head with subagent_send, instead of a second head on those files.`,
      `Then collect with subagent_wait using mode "any", and merge each head as soon as it finishes and passes: run the tests/typecheck yourself, subagent_merge it, then move on. Do not wait for every head before merging, and do not wait on one id while others have already finished. Send fixes back to the same head with subagent_send, and report what changed and which head did it.`,
      ...(pair.lead_instructions ? [`How this pair works:\n${pair.lead_instructions}`] : []),
      ...(openHeads.length
        ? [
            `Heads still open from earlier turns — they keep their context, so send follow-up work in their area to them with subagent_send instead of opening new ones:`,
            ...openHeads.map((h) => `- ${h.id} "${h.title}"${h.role ? ` (${h.role})` : ""} — ${h.engine}, ${h.status === "running" ? "working" : h.status === "failed" ? "last turn failed" : "idle"}`),
          ]
        : []),
      `---`,
      ``,
    ].join("\n");
  },

  /** One line naming the agents a lead may assign (`agent`), when any exist. */
  agentsLine(): string {
    const list = Agents.list().slice(0, 12);
    if (!list.length) return "";
    return `Specialized agents you can assign a head with \`agent\`: ${list.map((a) => `${a.name}${a.description ? ` (${a.description})` : ""}`).join("; ")}.`;
  },

  leadBrief(pair: HydraPair, role: "lead" | "head", headRole?: string): string {
    const cap = pair.max_heads ?? "no cap";
    if (role === "head") {
      const roleDesc = headRole ? ` (${headRole} role)` : "";
      return `You are a Hydra head${roleDesc}. Do the assigned slice. Report what changed, how far it got, and what is left. Do not merge, push, or re-plan the whole job.`;
    }
    const tools =
      `Heads are live subagents on the trb MCP server — \`subagent_create\`, \`subagent_wait\`, \`subagent_send\`, ` +
      `\`subagent_merge\`, \`subagent_close\` (in Claude Code: \`mcp__trb__subagent_create\` etc.; search for them if they are deferred).`;
    // The line is drawn by KIND of work, not size — otherwise a capable lead model judges every job
    // "one slice" and does it alone, and the heads the operator chose never run.
    const rules = [
      `Your one hard rule: you do NOT write code. Every change to source code or tests, however small — a one-line fix included — goes to a head. Docs and plain-text edits are yours to make.`,
      `Investigation, debugging and audits go to heads too. A quick look at a file or two to scope the work is fine; a sprawling read of the codebase is not — send a head.`,
      `Fan out: split the work into independent, parallel-safe slices and open one head per slice in the same response (several \`subagent_create\` calls at once). Cap ${cap} open at once; if there is more, go in waves. Each brief is a self-contained contract: goal, files, constraints, acceptance criteria, how to verify. Heads never see this thread.`,
      `Then collect them with \`subagent_wait\` using mode "any", so you review each head as soon as it finishes instead of idling until the slowest is done. Review each answer and diff yourself: run the test / typecheck / lint gates, and read what changed. When the pair offers a reviewer on another engine, send it the diff for a second opinion.`,
      `Blocking problems go back to the SAME head with \`subagent_send\` — it keeps its context. Do not fix them yourself.`,
      `\`subagent_merge\` the work that passes, then give the operator the combined result: what changed, which head did what, how it was verified, what is left.`,
      `Reuse heads for their own work: a head keeps its whole context, so fixes and follow-ups to what a head did go back to that head with \`subagent_send\`. A separate unit of work gets its own head. Close a head with \`subagent_close\` only when its work is merged or dropped AND no more work in its area is likely; open heads carry over to your next turn.`,
      `Never dead-end on a gap in your own knowledge: open a head to find out.`,
      `Heads run only on this pair's engines and models — the operator chose them, and \`subagent_create\` refuses anything else. When a head fails on a provider error (503, rate limit, auth), you may retry it once on the same config. If it fails again, do not switch engines and do not do the work yourself: stop, tell the operator which heads failed and the exact error, and ask whether to wait or switch engine/model.`,
    ];
    if (pair.mode === "roles" && pair.roles && Object.keys(pair.roles).length > 0) {
      const specs = Object.entries(pair.roles)
        .map(([r, c]) => {
          const runs = [c.engine, c.model].filter(Boolean).join("/") || "default";
          const label = c.label?.trim();
          const named = label && label.toLowerCase() !== r ? ` "${label}"` : "";
          const agent = c.agent ? `, as agent \`${c.agent}\`` : "";
          const what = roleSummary(r, c);
          return `- \`${r}\`${named} (${runs} @ ${c.effort || "medium"}${agent})${what ? `: ${what}` : ""}`;
        })
        .join("\n");
      return (
        `You are the tech lead of a Hydra pair (${this.summary(pair)}), not the coder. ${tools} ` +
        `Every head takes one of this pair's roles — pass \`role\`; a head without one is refused:\n${specs}\n` +
        `Pick the role that fits each slice; open several heads of one role when slices are parallel.\n` +
        rules.map((r) => `- ${r}`).join("\n")
      );
    }
    return (
      `You are the tech lead of a Hydra pair (${this.summary(pair)}), not the coder. ${tools} ` +
      `Heads run on ${pair.heads_engine || "the heads engine"} ${pair.heads_model ? `(${pair.heads_model}) ` : ""}at ${pair.heads_effort || "inherited"} effort.\n` +
      rules.map((r) => `- ${r}`).join("\n")
    );
  },
};
