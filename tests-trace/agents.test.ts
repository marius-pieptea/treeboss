import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START agents\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END agents\n"); });
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { Agents } from "../src/agents/store";
import { HydraPairs } from "../src/hydra/pairs";
import { McpStore } from "../src/mcp/store";
import { setSetting } from "../src/settings";
import { SkillStore } from "../src/skills/store";
import { createChild, createLead, getSession, interruptAll, send, setTurnRunner, viewSession } from "../src/sessions/manager";
import { executeSubagentTool } from "../src/sessions/tools";
import { db } from "../src/db";
import { makeDir, makeRepo, resetState, settled } from "./helpers";

beforeEach(() => {
  resetState();
  db().exec("DELETE FROM agents");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
});

function skill(name: string, description = `skill ${name}`) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trb-sk-")), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  return SkillStore.add(dir);
}

describe("agent profiles", () => {
  test("create, read, update, delete", () => {
    const a = Agents.create({ name: "reviewer", title: "Code reviewer", description: "reviews diffs", instructions: "Review, don't rewrite." });
    expect(a).toMatchObject({ name: "reviewer", title: "Code reviewer", skills: null, mcp: null, engine: null });
    expect(Agents.update("reviewer", { instructions: "Be terse.", effort: "high" })).toMatchObject({ instructions: "Be terse.", effort: "high", title: "Code reviewer" });
    expect(Agents.list().map((x) => x.name)).toEqual(["reviewer"]);
    expect(Agents.remove("reviewer")).toBe(true);
    expect(Agents.get("reviewer")).toBeNull();
  });

  test("names are slugs; duplicates and unknown agents are refused with a useful message", () => {
    expect(() => Agents.create({ name: "Bad Name" })).toThrow(/lowercase/);
    Agents.create({ name: "a1" });
    expect(() => Agents.create({ name: "a1" })).toThrow(/already exists/);
    expect(() => Agents.require("ghost")).toThrow(/No agent "ghost"\. Agents: a1/);
  });

  test("assignments must name skills and MCP servers that exist", () => {
    skill("deploy");
    McpStore.put({ name: "db", command: "x" });
    expect(Agents.create({ name: "ok", skills: ["deploy"], mcp: ["db"] })).toMatchObject({ skills: ["deploy"], mcp: ["db"] });
    expect(() => Agents.create({ name: "bad1", skills: ["nope"] })).toThrow(/Unknown skill: nope/);
    expect(() => Agents.create({ name: "bad2", mcp: ["nope", "nada"] })).toThrow(/Unknown MCP servers: nope, nada/);
  });

  test("an empty list is different from null: it means none", () => {
    expect(Agents.create({ name: "none", skills: [], mcp: [] })).toMatchObject({ skills: [], mcp: [] });
    expect(Agents.create({ name: "all" })).toMatchObject({ skills: null, mcp: null });
  });

  test("instructions have a size limit", () => {
    expect(() => Agents.create({ name: "big", instructions: "x".repeat(20_001) })).toThrow(/too long/);
  });

  test("a starting point from the role library", () => {
    const a = Agents.fromRole("reviewer");
    expect(a).toMatchObject({ name: "reviewer", title: "Reviewer", effort: "high" });
    expect(a.instructions).toContain("Review, don't rewrite");
    expect(() => Agents.fromRole("ghost")).toThrow(/No role/);
  });

  test("pair roles may reference agents, which must exist; usage is reported", () => {
    Agents.create({ name: "tester" });
    const pair = HydraPairs.create({ title: "P", lead_engine: "fake", roles: { worker: { engine: "fake", agent: "tester" } } });
    expect(pair.roles!.worker.agent).toBe("tester");
    expect(Agents.usedByPairs("tester")).toEqual([{ pair: "P", role: "worker" }]);
    expect(() => HydraPairs.create({ title: "Q", roles: { worker: { agent: "ghost" } } })).toThrow(/agent "ghost", which does not exist/);
  });
});

describe("skill assignment reaches the engine", () => {
  const run = async (prompt: string, over: Record<string, unknown> = {}) => (await settled(createLead({ prompt, engine: "fake", cwd: makeDir(), ...over }).id)).last_output;

  test("with no agent every enabled skill is visible; a disabled one is not", async () => {
    skill("alpha");
    skill("beta");
    SkillStore.setEnabled("beta", false);
    expect(await run("SKILLS")).toBe("skills=alpha");
  });

  test("an agent sees only the skills assigned to it", async () => {
    skill("alpha");
    skill("beta");
    Agents.create({ name: "only-beta", skills: ["beta"] });
    Agents.create({ name: "no-skills", skills: [] });
    Agents.create({ name: "everything" });
    expect(await run("SKILLS", { agent: "only-beta" })).toBe("skills=beta");
    expect(await run("SKILLS", { agent: "no-skills" })).toBe("skills=");
    expect(await run("SKILLS", { agent: "everything" })).toBe("skills=alpha,beta");
  });

  test("assigning a globally disabled skill does not turn it back on", async () => {
    skill("alpha");
    SkillStore.setEnabled("alpha", false);
    Agents.create({ name: "wants-alpha", skills: ["alpha"] });
    expect(await run("SKILLS", { agent: "wants-alpha" })).toBe("skills=");
  });

  test("a per-session skill list overrides the agent's", async () => {
    skill("alpha");
    skill("beta");
    Agents.create({ name: "a", skills: ["alpha"] });
    expect(await run("SKILLS", { agent: "a", skills: ["beta"] })).toBe("skills=beta");
    expect(await run("SKILLS", { skills: ["alpha"] })).toBe("skills=alpha");
    expect(() => createLead({ prompt: "x", engine: "fake", cwd: makeDir(), skills: ["ghost"] })).toThrow(/Unknown skill: ghost/);
  });

  test("the assignment follows the session across follow-ups", async () => {
    skill("alpha");
    skill("beta");
    Agents.create({ name: "only-beta", skills: ["beta"] });
    const s = await settled(createLead({ prompt: "SKILLS", engine: "fake", cwd: makeDir(), agent: "only-beta" }).id);
    send({ operator: true }, s.id, "SKILLS");
    expect((await settled(s.id)).last_output).toBe("skills=beta");
  });

  test("the session view reports what it is restricted to", async () => {
    skill("alpha");
    Agents.create({ name: "a", skills: ["alpha"] });
    const s = await settled(createLead({ prompt: "SAY x", engine: "fake", cwd: makeDir(), agent: "a" }).id);
    expect(viewSession(s)).toMatchObject({ agent: "a", skills: ["alpha"] });
    expect(viewSession(await settled(createLead({ prompt: "SAY x", engine: "fake", cwd: makeDir() }).id)).skills).toBeNull();
  });
});

describe("MCP assignment reaches the engine", () => {
  test("an agent gets only its MCP servers; without one, every enabled server", async () => {
    setSetting("rea_mcp", "off"); // REA is on by default and would join the list; this test is about the registry's servers
    McpStore.put({ name: "db", command: "x" });
    McpStore.put({ name: "docs", command: "y" });
    Agents.create({ name: "db-only", mcp: ["db"] });
    const all = await settled(createLead({ prompt: "MCPS", engine: "fake", cwd: makeDir() }).id);
    expect(all.last_output).toBe("mcps=db,docs");
    const one = await settled(createLead({ prompt: "MCPS", engine: "fake", cwd: makeDir(), agent: "db-only" }).id);
    expect(one.last_output).toBe("mcps=db");
  });
});

describe("instructions", () => {
  test("a lead gets its agent's instructions on the first turn, not repeated on a resumed one", async () => {
    Agents.create({ name: "pirate", title: "Pirate", instructions: "Always answer like a pirate: ARRR-MARKER." });
    const s = await settled(createLead({ prompt: "ECHO_PROMPT ARRR-MARKER", engine: "fake", cwd: makeDir(), agent: "pirate" }).id);
    expect(s.last_output).toBe("prompt-has[ARRR-MARKER]=yes");
    send({ operator: true }, s.id, "ECHO_PROMPT ARRR-MARKER");
    expect((await settled(s.id)).last_output).toBe("prompt-has[ARRR-MARKER]=no"); // the engine session already knows
  });

  test("a subagent opened as an agent receives its instructions in its brief", async () => {
    Agents.create({ name: "auditor", title: "Auditor", instructions: "Audit only. AUDIT-MARKER." });
    const lead = await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeRepo() }).id);
    const c = createChild({ caller: { sessionId: lead.id }, brief: "ECHO_PROMPT AUDIT-MARKER", agent: "auditor" });
    expect(c.agent).toBe("auditor");
    expect((await settled(c.id)).last_output).toBe("prompt-has[AUDIT-MARKER]=yes");
  });

  test("a head gets agent-restricted skills too", async () => {
    skill("alpha");
    skill("beta");
    Agents.create({ name: "a", skills: ["alpha"] });
    const lead = await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeRepo() }).id);
    const c = createChild({ caller: { sessionId: lead.id }, brief: "SKILLS", agent: "a" });
    expect((await settled(c.id)).last_output).toBe("skills=alpha");
  });
});

describe("how an agent combines with engines, pairs and roles", () => {
  test("an agent's engine/model/effort are defaults: used when nothing more specific is set", () => {
    Agents.create({ name: "a", engine: "fake", model: "agent-model", effort: "high" });
    const s = createLead({ prompt: "SAY x", cwd: makeDir(), agent: "a" });
    expect(s).toMatchObject({ engine: "fake", model: "agent-model", effort: "high", agent: "a" });
    const o = createLead({ prompt: "SAY x", cwd: makeDir(), agent: "a", model: "explicit" });
    expect(o.model).toBe("explicit");
  });

  test("a pair is the operator's binding choice and beats an agent's preference", () => {
    Agents.create({ name: "a", engine: "fake", model: "agent-model" });
    const pair = HydraPairs.create({ title: "P", lead_engine: "fake", lead_model: "pair-model", heads_engine: "fake" });
    expect(createLead({ prompt: "SAY x", cwd: makeDir(), agent: "a", pairId: pair.id }).model).toBe("pair-model");
  });

  test("a role that names an agent runs its heads as that agent, with the role's own settings winning", async () => {
    Agents.create({ name: "tester", instructions: "Write tests. TESTER-MARKER.", model: "agent-model", effort: "low" });
    const pair = HydraPairs.create({ title: "P", lead_engine: "fake", roles: { worker: { engine: "fake", effort: "high", agent: "tester" }, plain: { engine: "fake" } } });
    const lead = await settled(createLead({ prompt: "SAY ready", cwd: makeRepo(), pairId: pair.id }).id);
    const c = createChild({ caller: { sessionId: lead.id }, brief: "ECHO_PROMPT TESTER-MARKER", role: "worker" });
    expect(c).toMatchObject({ agent: "tester", effort: "high", model: "agent-model" });
    expect((await settled(c.id)).last_output).toBe("prompt-has[TESTER-MARKER]=yes");
    expect(createChild({ caller: { sessionId: lead.id }, brief: "SAY x", role: "plain" }).agent).toBeNull();
  });

  test("an unknown agent is refused before anything starts", () => {
    expect(() => createLead({ prompt: "x", engine: "fake", cwd: makeDir(), agent: "ghost" })).toThrow(/No agent "ghost"/);
  });

  test("the subagent tool accepts `agent`, refuses an unknown one as text, and the lead brief lists the agents", async () => {
    Agents.create({ name: "scribe", description: "writes docs" });
    const pair = HydraPairs.create({ title: "P", lead_engine: "fake", heads_engine: "fake" });
    const lead = await settled(createLead({ prompt: "SAY ready", cwd: makeRepo(), pairId: pair.id }).id);
    const made = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SAY hi", agent: "scribe" }, { sessionId: lead.id }));
    expect(made.agent).toBe("scribe");
    expect(await executeSubagentTool("subagent_create", { brief: "SAY hi", agent: "ghost" }, { sessionId: lead.id })).toMatch(/^Error: No agent "ghost"/);
    expect(HydraPairs.leadTurnPreamble(pair, "claude")).toContain("scribe (writes docs)");
    await settled(made.id);
    void getSession;
  });
});
