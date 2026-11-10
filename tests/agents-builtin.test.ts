import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { Agents, MAX_INSTRUCTIONS_CHARS, NAME_RE } from "../src/agents/store";
import { BUILTIN_AGENTS, builtinAgentStatus, claimBuiltinName, missingBuiltinAgents, resetBuiltinAgent, restoreBuiltinAgents, seedBuiltinAgents, type BuiltinAgent } from "../src/agents/builtin";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import { home } from "../src/paths";
import { SkillStore } from "../src/skills/store";

const TOKEN = "builtin-agents-token";
const STATE = () => path.join(home(), "builtin-agents.json");

/** Two shipped versions of the same two agents. Version 2 changes both instructions and nothing else. */
const SHIPPED: BuiltinAgent[] = [
  { name: "tester", title: "Tester", description: "Writes tests.", instructions: "Write tests. v1.", effort: "high", skills: ["deploy", "ghost-skill"] },
  { name: "scribe", title: "Scribe", description: "Writes docs.", instructions: "Write docs. v1." },
];
const SHIPPED_V2: BuiltinAgent[] = [
  { ...SHIPPED[0]!, instructions: "Write tests. v2." },
  { ...SHIPPED[1]!, instructions: "Write docs. v2." },
];

function clean(): void {
  db().exec("DELETE FROM agents; DELETE FROM skills;");
  fs.rmSync(STATE(), { force: true });
}

function installSkill(name: string): void {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trb-sk-")), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: skill ${name}\n---\nbody\n`);
  SkillStore.add(dir);
}

beforeEach(clean);
afterAll(clean);

describe("seeding built-in agents", () => {
  test("seed creates each shipped agent once, with its assignments", () => {
    installSkill("deploy");
    expect(seedBuiltinAgents(SHIPPED)).toEqual(["tester", "scribe"]);
    expect(Agents.get("tester")).toMatchObject({ title: "Tester", description: "Writes tests.", instructions: "Write tests. v1.", effort: "high", skills: ["deploy"], mcp: null });
    expect(Agents.get("scribe")).toMatchObject({ instructions: "Write docs. v1.", skills: null });
    expect(seedBuiltinAgents(SHIPPED)).toEqual([]);
    expect(builtinAgentStatus(Agents.get("tester")!, SHIPPED)).toEqual({ builtin: true, modified: false });
    const state = JSON.parse(fs.readFileSync(STATE(), "utf-8"));
    expect(state.seeded.tester).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a name you already use is skipped, and stays yours when the shipped text changes", () => {
    Agents.create({ name: "scribe", instructions: "Mine." });
    expect(seedBuiltinAgents(SHIPPED)).toEqual(["tester"]);
    expect(seedBuiltinAgents(SHIPPED_V2)).toEqual([]);
    expect(Agents.get("scribe")!.instructions).toBe("Mine.");
    expect(builtinAgentStatus(Agents.get("scribe")!, SHIPPED_V2)).toEqual({ builtin: false, modified: false });
    expect(JSON.parse(fs.readFileSync(STATE(), "utf-8")).seeded.scribe).toBeNull();
  });

  test("an agent you deleted stays deleted until built-in agents are restored", () => {
    seedBuiltinAgents(SHIPPED);
    Agents.remove("scribe");
    expect(seedBuiltinAgents(SHIPPED)).toEqual([]);
    expect(Agents.get("scribe")).toBeNull();
    expect(missingBuiltinAgents(SHIPPED)).toEqual(["scribe"]);
    expect(restoreBuiltinAgents(SHIPPED)).toEqual(["scribe"]);
    expect(Agents.get("scribe")!.instructions).toBe("Write docs. v1.");
    expect(restoreBuiltinAgents(SHIPPED)).toEqual([]);
  });

  test("an unedited copy follows a changed shipped definition on the next start", () => {
    seedBuiltinAgents(SHIPPED);
    expect(seedBuiltinAgents(SHIPPED_V2)).toEqual([]);
    expect(Agents.get("tester")!.instructions).toBe("Write tests. v2.");
    expect(Agents.get("scribe")!.instructions).toBe("Write docs. v2.");
    expect(builtinAgentStatus(Agents.get("tester")!, SHIPPED_V2)).toEqual({ builtin: true, modified: false });
  });

  test("an edited copy is kept when the shipped definition changes, and shows as modified", () => {
    seedBuiltinAgents(SHIPPED);
    Agents.update("tester", { instructions: "Mine: unit tests only." });
    expect(seedBuiltinAgents(SHIPPED_V2)).toEqual([]);
    expect(Agents.get("tester")!.instructions).toBe("Mine: unit tests only.");
    expect(builtinAgentStatus(Agents.get("tester")!, SHIPPED_V2)).toEqual({ builtin: true, modified: true });
  });

  test("a skill or MCP server that is not installed is left out of the copy, with a log line, and does not throw", () => {
    installSkill("deploy");
    const logs: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      expect(() => seedBuiltinAgents([...SHIPPED, { name: "linker", title: "Linker", description: "", instructions: "Link.", mcp: ["ghost-server"] }])).not.toThrow();
    } finally {
      console.log = log;
    }
    expect(Agents.get("tester")!.skills).toEqual(["deploy"]);
    expect(Agents.get("linker")!.mcp).toEqual([]);
    expect(logs).toContain('[trb] built-in agent "tester" leaves out skill "ghost-skill": it is not installed');
    expect(logs).toContain('[trb] built-in agent "linker" leaves out MCP server "ghost-server": it is not installed');
    // The copy that was kept is what the next start compares against, so the dropped name is not a change.
    expect(builtinAgentStatus(Agents.get("tester")!, SHIPPED)).toEqual({ builtin: true, modified: false });
  });

  test("the shipped list seeds without error, and seeding it again changes nothing", () => {
    expect(seedBuiltinAgents()).toEqual(BUILTIN_AGENTS.map((b) => b.name));
    expect(seedBuiltinAgents()).toEqual([]);
  });
});

describe("reset and restore", () => {
  test("reset puts the shipped definition back, and refuses to overwrite an agent of yours", () => {
    Agents.create({ name: "scribe", instructions: "Mine." });
    seedBuiltinAgents(SHIPPED);
    expect(() => resetBuiltinAgent("scribe", SHIPPED)).toThrow(/you added; trb will not overwrite it/);
    expect(() => resetBuiltinAgent("nope", SHIPPED)).toThrow(/is not an agent that ships with trb/);
    Agents.update("tester", { instructions: "Mine." });
    expect(builtinAgentStatus(Agents.get("tester")!, SHIPPED)).toEqual({ builtin: true, modified: true });
    const back = resetBuiltinAgent("tester", SHIPPED);
    // No skill named in the shipped list is installed here, so the copy keeps an empty list: it may use none of them.
    expect(back).toMatchObject({ instructions: "Write tests. v1.", effort: "high", skills: [] });
    expect(builtinAgentStatus(back, SHIPPED)).toEqual({ builtin: true, modified: false });
  });

  test("naming a new agent after a deleted built-in makes the name yours", () => {
    seedBuiltinAgents(SHIPPED);
    Agents.remove("scribe");
    Agents.create({ name: "scribe", instructions: "Mine." });
    claimBuiltinName("scribe");
    expect(builtinAgentStatus(Agents.get("scribe")!, SHIPPED)).toEqual({ builtin: false, modified: false });
    expect(restoreBuiltinAgents(SHIPPED)).toEqual([]);
    expect(Agents.get("scribe")!.instructions).toBe("Mine.");
  });
});

describe("HTTP", () => {
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: (await res.json()) as any };
  };

  test("the list carries the built-in flags and what is missing; reset and restore answer", async () => {
    await call("POST", "/api/agents", { name: "reviewer-x", instructions: "Mine." });
    let r = await call("GET", "/api/agents");
    expect(r.data.agents.find((a: any) => a.name === "reviewer-x")).toMatchObject({ builtin: false, modified: false });
    expect(r.data.missingBuiltins).toEqual(BUILTIN_AGENTS.map((b) => b.name));
    expect((await call("POST", "/api/agents/reviewer-x/reset")).status).toBe(400);
    r = await call("POST", "/api/agents/restore-builtins");
    expect(r.data.added).toEqual(BUILTIN_AGENTS.map((b) => b.name));
    r = await call("GET", "/api/agents");
    expect(r.data.agents.find((a: any) => a.name === "poteto-agent")).toMatchObject({ builtin: true, modified: false });
    expect(r.data.missingBuiltins).toEqual([]);
  });
});

describe("the shipped pstack agents", () => {
  const ATTRIBUTION = "Adapted from pstack by Lauren Tan (MIT).";
  const PRINCIPLE_NAMES = [
    "attack-the-premise", "boundary-discipline", "build-the-lever", "encode-lessons-in-structure", "exhaust-the-design-space", "experience-first", "explain-the-number", "fix-root-causes", "foundational-thinking", "guard-the-context-window", "laziness-protocol", "make-operations-idempotent", "migrate-callers-then-delete-legacy-apis", "minimize-reader-load", "model-the-domain", "never-block-on-the-human", "outcome-oriented-execution", "prove-it-works", "redesign-from-first-principles", "separate-before-serializing-shared-state", "sequence-verifiable-units", "subtract-before-you-add", "test-behavior-not-implementation", "type-system-discipline",
  ];
  const principle = (...names: string[]) => names.map((n) => `principle-${n}`);
  const byName = (name: string) => BUILTIN_AGENTS.find((b) => b.name === name)!;

  test("the five agents have valid names, instructions within the cap, the attribution line last, and no pinned engine", () => {
    expect(BUILTIN_AGENTS.map((b) => b.name)).toEqual(["poteto-agent", "comment-sicko", "pstack-explorer", "pstack-architect", "pstack-verifier"]);
    for (const b of BUILTIN_AGENTS) {
      expect(b.name).toMatch(NAME_RE);
      expect(b.instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
      expect(b.instructions.split("\n").at(-1)).toBe(ATTRIBUTION);
      expect([b.engine, b.model, b.effort, b.mcp]).toEqual([null, null, null, null]);
    }
  });

  test("each agent names exactly the skills the brief gives it", () => {
    expect(byName("poteto-agent").skills).toEqual(["poteto-mode", "pstack-treeboss", "tdd", "typescript-best-practices", "blast-radius", "unslop", "technical-writing", ...principle(...PRINCIPLE_NAMES)]);
    expect(byName("comment-sicko").skills).toEqual(["how", "why", "no-comments", "unslop", "pstack-treeboss"]);
    expect(byName("pstack-explorer").skills).toEqual(["how", "why", "recall", "blast-radius", "teach", "in-your-own-words", "sharpen", "pstack-treeboss"]);
    expect(byName("pstack-architect").skills).toEqual(["architect", "arena", "figure-it-out", "statechart", "pstack-treeboss", ...principle("foundational-thinking", "model-the-domain", "boundary-discipline", "type-system-discipline", "exhaust-the-design-space", "redesign-from-first-principles", "make-operations-idempotent", "separate-before-serializing-shared-state", "experience-first", "subtract-before-you-add", "minimize-reader-load")]);
    expect(byName("pstack-verifier").skills).toEqual(["interrogate", "swarm", "blast-radius", "benchmark-checklist", "create-verification-skill", "maintain-verification-skill", "create-formal-verification-skill", "maintain-formal-verification-skill", "statechart", "pstack-treeboss", ...principle("prove-it-works", "test-behavior-not-implementation", "explain-the-number", "fix-root-causes", "attack-the-premise")]);
  });

  test("the rules the brief names survive the port: the write limits, the cleaner's report-only default, the verdict line", () => {
    expect(byName("poteto-agent").instructions).toContain("Never force-push, deploy, delete data or message customers.");
    expect(byName("poteto-agent").instructions).toContain("`.agents/skills/<name>/SKILL.md` for Codex and Antigravity");
    // OpenCode has no skills folder; its prompt's skill index carries the paths. Every pstack agent says so.
    for (const name of ["poteto-agent", "comment-sicko", "pstack-explorer", "pstack-architect", "pstack-verifier"]) {
      expect(byName(name).instructions).toContain('OpenCode has no skills folder: the "Available skills" index in your prompt');
    }
    expect(byName("comment-sicko").instructions).toContain("Report only, by default");
    expect(byName("comment-sicko").instructions).toContain("Only when your brief explicitly asks you to apply the deletions");
    expect(byName("pstack-explorer").instructions).toContain("never create, edit or delete files");
    expect(byName("pstack-explorer").instructions).toContain("git status");
    expect(byName("pstack-architect").instructions).toContain("Never write the implementation.");
    expect(byName("pstack-verifier").instructions).toContain("PASS, PASS+NOTES or FAIL");
  });
});
