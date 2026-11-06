import { describe, expect, test } from "bun:test";
import {
  INSTRUCTIONS_LIMIT,
  agentToForm,
  agentsUsingSkill,
  applyTemplate,
  assignToMode,
  assignmentLabel,
  emptyAgentForm,
  formToAgentPayload,
  instructionsCount,
  instructionsPreview,
  modeToAssign,
  normalizeAgentName,
  previewAssignment,
  sameAssignment,
  seesSummary,
  validateAgentForm,
} from "../../web/src/features/settings/agents-logic";
import { emptyPairForm, formToPayload, pairToForm } from "../../web/src/features/settings/logic";
import { agentPickerPatch, buildCreatePayload, effectiveSkills, matchAgent, normalizeSkillsOverride, parseSlash, skillsChipLabel, slashSuggestions } from "../../web/src/features/agent/composer-logic";
import type { Agent } from "../../web/src/lib/types";

const agent = (over: Partial<Agent> = {}): Agent => ({ name: "reviewer", title: "Reviewer", description: "", instructions: "", engine: null, model: null, effort: null, skills: null, mcp: null, created_at: "", updated_at: "", used_by_pairs: [], ...over });

describe("assignment modes <-> API values", () => {
  test("null is all, a list is only, an empty list is none", () => {
    expect(assignToMode(null)).toBe("all");
    expect(assignToMode(undefined)).toBe("all");
    expect(assignToMode(["a"])).toBe("only");
    expect(assignToMode([])).toBe("none");
  });

  test("and back: all sends null, none sends [], only sends the unique ticks", () => {
    expect(modeToAssign("all", ["a"])).toBeNull();
    expect(modeToAssign("none", ["a"])).toEqual([]);
    expect(modeToAssign("only", ["a", "b", "a"])).toEqual(["a", "b"]);
    // "only" with nothing ticked is stored as "none": a list that grants nothing says so.
    expect(assignToMode(modeToAssign("only", []))).toBe("none");
  });

  test("round trips for every mode", () => {
    for (const v of [null, [], ["x"], ["x", "y"]] as Array<string[] | null>) expect(modeToAssign(assignToMode(v), v ?? [])).toEqual(v);
  });
});

describe("labels", () => {
  test("cards say what an agent may use", () => {
    expect(assignmentLabel(null, "skill")).toBe("default skills");
    expect(assignmentLabel([], "skill")).toBe("no skills");
    expect(assignmentLabel(["a"], "skill")).toBe("1 skill");
    expect(assignmentLabel(["a", "b", "c"], "skill")).toBe("3 skills");
    expect(assignmentLabel([], "MCP server")).toBe("no MCP servers");
    expect(assignmentLabel(["db"], "MCP server")).toBe("1 MCP server");
  });

  test("the skills chip counts only enabled skills: a disabled one stays off", () => {
    const enabled = ["a", "b", "c"];
    expect(skillsChipLabel(null, enabled)).toBe("all enabled");
    expect(skillsChipLabel(["a", "b"], enabled)).toBe("2 of 3");
    expect(skillsChipLabel(["a", "gone"], enabled)).toBe("1 of 3");
    expect(skillsChipLabel([], enabled)).toBe("none");
    expect(skillsChipLabel(["disabled-one"], enabled)).toBe("none");
  });
});

describe("what an agent will actually see", () => {
  const skills = [
    { name: "deploy", enabled: true },
    { name: "tests", enabled: true },
    { name: "legacy", enabled: false },
  ];

  test("all enabled means the enabled ones, and nothing disabled", () => {
    expect(previewAssignment(null, skills)).toEqual({ effective: ["deploy", "tests"], disabled: [], missing: [] });
  });

  test("an assigned but disabled skill stays off, a deleted one is reported", () => {
    expect(previewAssignment(["deploy", "legacy", "ghost"], skills)).toEqual({ effective: ["deploy"], disabled: ["legacy"], missing: ["ghost"] });
    expect(previewAssignment([], skills).effective).toEqual([]);
  });

  test("the summary line reads like a sentence", () => {
    const s = previewAssignment(["deploy", "tests"], skills);
    const m = previewAssignment([], [{ name: "db", enabled: true }]);
    expect(seesSummary(s, m)).toBe("Sees 2 skills (deploy, tests) and no MCP servers");
    const many = previewAssignment(null, ["a", "b", "c", "d", "e"].map((name) => ({ name, enabled: true })));
    expect(seesSummary(many, previewAssignment(null, [{ name: "db", enabled: true }]))).toBe("Sees 5 skills (a, b, c, +2) and 1 MCP server (db)");
  });
});

describe("the editor form", () => {
  const stored = agent({ name: "auditor", title: "Auditor", description: "audits", instructions: "Audit only.", engine: "claude", model: "m", effort: "high", skills: ["deploy"], mcp: [] });

  test("an agent loads into the form and saves back identically", () => {
    const f = agentToForm(stored);
    expect(f).toMatchObject({ skillsMode: "only", skills: ["deploy"], mcpMode: "none", mcp: [], engine: "claude" });
    expect(formToAgentPayload(f)).toEqual({ name: "auditor", title: "Auditor", description: "audits", instructions: "Audit only.", engine: "claude", model: "m", effort: "high", skills: ["deploy"], mcp: [] });
  });

  test("assignments are always sent explicitly, so an edit cannot leave the old one behind", () => {
    const f = { ...agentToForm(stored), skillsMode: "all" as const, mcpMode: "only" as const, mcp: ["db"] };
    const p = formToAgentPayload(f);
    expect(p.skills).toBeNull();
    expect(p.mcp).toEqual(["db"]);
  });

  test("blank defaults become null; the title falls back to the name", () => {
    const p = formToAgentPayload({ ...emptyAgentForm(), name: "Scribe Bot" });
    expect(p).toMatchObject({ name: "scribe-bot", title: "scribe-bot", engine: null, model: null, effort: null, skills: null, mcp: null });
  });

  test("names are slugged the way the daemon accepts them", () => {
    expect(normalizeAgentName("  Code Reviewer!  ")).toBe("code-reviewer");
    expect(normalizeAgentName("_x")).toBe("x");
    expect(normalizeAgentName("a".repeat(60))).toHaveLength(40);
    expect(normalizeAgentName("***")).toBe("");
  });

  test("validation: a name is needed and must be free; instructions have a limit; editing skips the name", () => {
    expect(validateAgentForm(emptyAgentForm(), { editing: false })).toEqual(["give the agent a name"]);
    expect(validateAgentForm({ ...emptyAgentForm(), name: "***" }, { editing: false })[0]).toContain("lowercase letters");
    expect(validateAgentForm({ ...emptyAgentForm(), name: "Taken" }, { editing: false, existing: ["taken"] })).toEqual(['agent "taken" already exists']);
    expect(validateAgentForm({ ...emptyAgentForm(), name: "ok", instructions: "x".repeat(INSTRUCTIONS_LIMIT + 1) }, { editing: false })[0]).toContain("too long");
    expect(validateAgentForm({ ...emptyAgentForm(), name: "" }, { editing: true })).toEqual([]);
  });

  test("the character counter warns near the limit and flags overflow", () => {
    expect(instructionsCount("hi")).toMatchObject({ used: 2, near: false, over: false });
    expect(instructionsCount("x".repeat(18_500))).toMatchObject({ near: true, over: false });
    expect(instructionsCount("x".repeat(20_001))).toMatchObject({ near: false, over: true });
  });
});

describe("templates", () => {
  const t = { id: "reviewer", label: "Reviewer", description: "Reviews a diff.", effort: "high", instructions: "Review, don't rewrite." };

  test("a template fills an empty form: name, title, description, instructions, effort", () => {
    expect(applyTemplate(emptyAgentForm(), t)).toMatchObject({ name: "reviewer", title: "Reviewer", description: "Reviews a diff.", instructions: "Review, don't rewrite.", effort: "high" });
  });

  test("it never overwrites a name or title the user typed, nor a chosen effort", () => {
    const f = { ...emptyAgentForm(), name: "my-reviewer", title: "My reviewer", effort: "low" };
    expect(applyTemplate(f, t)).toMatchObject({ name: "my-reviewer", title: "My reviewer", effort: "low", instructions: "Review, don't rewrite." });
  });

  test("an existing agent's name is locked while editing", () => {
    expect(applyTemplate({ ...emptyAgentForm(), name: "" }, t, { lockName: true }).name).toBe("");
  });
});

describe("small helpers", () => {
  test("sameAssignment ignores order and duplicates; null only equals null", () => {
    expect(sameAssignment(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameAssignment(["a"], ["a", "b"])).toBe(false);
    expect(sameAssignment(null, null)).toBe(true);
    expect(sameAssignment(null, [])).toBe(false);
  });

  test("which agents name a skill (agents on 'all enabled' say nothing)", () => {
    const list = [agent({ name: "a", skills: ["deploy"] }), agent({ name: "b", skills: null }), agent({ name: "c", skills: [] }), agent({ name: "d", skills: ["deploy", "tests"] })];
    expect(agentsUsingSkill(list, "deploy").map((x) => x.name)).toEqual(["a", "d"]);
    expect(agentsUsingSkill(list, "nope")).toEqual([]);
  });

  test("an instructions preview collapses whitespace and clips", () => {
    expect(instructionsPreview("a\n\n  b   c")).toBe("a b c");
    expect(instructionsPreview("x".repeat(200), 20)).toHaveLength(20);
  });
});

describe("pair roles carry an agent", () => {
  test("it is sent only when set, and survives a round trip", () => {
    const pair = { title: "P", mode: "roles" as const, lead_engine: "claude", roles: { worker: { engine: "codex", agent: "tester" }, scout: { engine: "claude" } } };
    const form = pairToForm(pair);
    expect(form.roles.map((r) => r.agent)).toEqual(["tester", ""]);
    const p = formToPayload(form) as any;
    expect(p.roles.worker.agent).toBe("tester");
    expect("agent" in p.roles.scout).toBe(false); // no agent, no key: the daemon replaces the whole roles object
  });

  test("clearing the agent on a role removes it from the payload", () => {
    const form = pairToForm({ title: "P", mode: "roles", roles: { worker: { engine: "codex", agent: "tester" } } });
    form.roles[0].agent = "";
    expect("agent" in (formToPayload(form) as any).roles.worker).toBe(false);
    expect(formToPayload({ ...emptyPairForm(), title: "H" }).roles).toBeNull();
  });
});

describe("the composer's agent and skills", () => {
  test("/agent is a command that needs a name, and is suggested while typing", () => {
    expect(parseSlash("/agent reviewer")).toEqual({ name: "agent", arg: "reviewer" });
    expect(parseSlash("/agent none")).toEqual({ name: "agent", arg: "none" });
    expect(parseSlash("/agent")).toBeNull();
    expect(slashSuggestions("/ag").map((c) => c.name)).toEqual(["agent"]);
  });

  test("an agent is matched by name or title, exact before partial", () => {
    const list = [agent({ name: "code-review", title: "Code review" }), agent({ name: "review", title: "Reviewer" })];
    expect(matchAgent(list, "review")?.name).toBe("review");
    expect(matchAgent(list, "Code Review")?.name).toBe("code-review");
    expect(matchAgent(list, "code")?.name).toBe("code-review");
    expect(matchAgent(list, "zzz")).toBeNull();
    expect(matchAgent(list, "  ")).toBeNull();
  });

  test("choosing an agent with an engine moves the pickers, unless a pair is chosen", () => {
    const a = agent({ engine: "codex", model: "gpt-x", effort: "high" });
    expect(agentPickerPatch(a, false)).toEqual({ engine: "codex", model: "gpt-x", effort: "high" });
    expect(agentPickerPatch(a, true)).toBeNull();
    expect(agentPickerPatch(agent({ engine: null }), false)).toBeNull();
    expect(agentPickerPatch(null, false)).toBeNull();
    expect(agentPickerPatch(agent({ engine: "claude" }), false)).toEqual({ engine: "claude", model: "" }); // a model id means nothing to another engine
  });

  test("the skills in effect: the user's list, else the agent's, else everything", () => {
    expect(effectiveSkills(["a"], agent({ skills: ["b"] }))).toEqual(["a"]);
    expect(effectiveSkills(null, agent({ skills: ["b"] }))).toEqual(["b"]);
    expect(effectiveSkills(null, agent({ skills: [] }))).toEqual([]);
    expect(effectiveSkills(null, agent({ skills: null }))).toBeNull();
    expect(effectiveSkills(null, null)).toBeNull();
  });

  test("an override equal to the baseline is no override, so nothing extra is sent", () => {
    const enabled = ["a", "b", "c"];
    expect(normalizeSkillsOverride(["a", "b", "c"], null, enabled)).toBeNull(); // everything enabled is the default
    expect(normalizeSkillsOverride(["a", "b"], null, enabled)).toEqual(["a", "b"]);
    expect(normalizeSkillsOverride(["b", "a"], ["a", "b"], enabled)).toBeNull(); // the agent's own assignment, reordered
    expect(normalizeSkillsOverride(["a"], ["a", "b"], enabled)).toEqual(["a"]);
    // A disabled skill in the agent's list changes nothing: it is off either way.
    expect(normalizeSkillsOverride(["a"], ["a", "legacy"], enabled)).toBeNull();
  });

  test("the create body sends agent and skills only when they mean something", () => {
    const base = { prompt: "do it", cwd: "/w", worktree: false, pairId: "", engine: "claude", model: "", effort: "", agent: "", skills: null };
    expect(buildCreatePayload(base)).toEqual({ prompt: "do it", cwd: "/w", isolate: false, engine: "claude", model: undefined, effort: undefined });
    expect(buildCreatePayload({ ...base, agent: "reviewer" })).toMatchObject({ agent: "reviewer" });
    expect("skills" in buildCreatePayload(base)).toBe(false);
    expect(buildCreatePayload({ ...base, skills: [] })).toMatchObject({ skills: [] }); // an empty list is a real choice: no skills
    expect(buildCreatePayload({ ...base, skills: ["a"], agent: "x" })).toMatchObject({ agent: "x", skills: ["a"] });
  });

  test("a pair decides the lead's engine; the agent still rides along", () => {
    const p = buildCreatePayload({ prompt: "x", cwd: "/w", worktree: true, pairId: "p1", engine: "claude", model: "m", effort: "high", agent: "reviewer", skills: null });
    expect(p).toMatchObject({ pair: "p1", agent: "reviewer", isolate: true });
    expect("engine" in p).toBe(false);
  });
});
