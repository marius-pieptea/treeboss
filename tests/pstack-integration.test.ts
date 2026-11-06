import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { BUILTIN_AGENTS, seedBuiltinAgents } from "../src/agents/builtin";
import { Agents } from "../src/agents/store";
import { db } from "../src/db";
import { HydraPairs, PAIR_COOKBOOK } from "../src/hydra/pairs";
import { home, paths } from "../src/paths";
import { packById } from "../src/practices/packs";
import { builtinSkills, seedBuiltinSkills } from "../src/skills/builtin";

/** The two Hydra recipes that run pstack, and the recipe entries they are. */
const RECIPE_IDS = ["pstack-claude", "pstack-claude-codex"];
const RECIPES = PAIR_COOKBOOK.filter((r) => RECIPE_IDS.includes(r.id));
/** The skill names trb ships: the ones written in builtin.ts and the ones the packs list. */
const shipped = (): Set<string> => new Set(builtinSkills().map((b) => b.name));

/** A home with no built-ins in it: no skills, agents or pairs in the database, and no seed state. */
function emptyHome(): void {
  db().exec("DELETE FROM pairs; DELETE FROM agents; DELETE FROM skills;");
  fs.rmSync(path.join(home(), "builtin-skills.json"), { force: true });
  fs.rmSync(path.join(home(), "builtin-agents.json"), { force: true });
  for (const n of shipped()) fs.rmSync(path.join(paths.skills(), n), { recursive: true, force: true });
}

beforeEach(emptyHome);
afterAll(emptyHome);

describe("what the pstack set names is shipped", () => {
  test("every skill a built-in agent names is shipped by builtinSkills()", () => {
    const missing = BUILTIN_AGENTS.flatMap((a) => (a.skills ?? []).filter((s) => !shipped().has(s)).map((s) => `${a.name} → ${s}`));
    expect(missing).toEqual([]);
  });

  test("every role agent in the two pstack recipes is a built-in agent", () => {
    expect(RECIPES.map((r) => r.id)).toEqual(RECIPE_IDS);
    const agents = new Set(BUILTIN_AGENTS.map((a) => a.name));
    const unknown = RECIPES.flatMap((r) =>
      Object.entries(r.roles ?? {})
        .filter(([, cfg]) => !cfg.agent || !agents.has(cfg.agent))
        .map(([role]) => `${r.id} ${role}`),
    );
    expect(unknown).toEqual([]);
  });

  test("every skill of the pstack practice pack is shipped", () => {
    const skills = packById("pstack")?.skills ?? [];
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.filter((s) => !shipped().has(s))).toEqual([]);
  });

  test("the treeboss adapter ships with the pstack pack, and nothing in its frontmatter hides it from the model", () => {
    const adapter = builtinSkills().find((b) => b.name === "pstack-treeboss")!;
    expect(adapter.pack).toBe("pstack");
    const frontmatter = adapter.files["SKILL.md"]!.split("---")[1]!;
    expect(frontmatter).not.toContain("disable-model-invocation");
  });

  test("the skills PSTACK_LEAD names, poteto-mode and pstack-treeboss, ship", () => {
    for (const name of ["poteto-mode", "pstack-treeboss"]) {
      expect(RECIPES.every((r) => r.lead_instructions?.includes(name))).toBe(true);
      expect(shipped().has(name)).toBe(true);
    }
  });
});

describe("on an empty home", () => {
  test("seeding the skills and then the agents keeps every skill each agent names, and both pstack recipes build", () => {
    // The order daemon/lifecycle.ts seeds in: skills first, so an agent's skills exist when the agent is written.
    seedBuiltinSkills();
    seedBuiltinAgents();
    expect(Agents.list().map((a) => a.name).sort()).toEqual(BUILTIN_AGENTS.map((a) => a.name).sort());
    for (const a of BUILTIN_AGENTS) expect(Agents.get(a.name)!.skills).toEqual(a.skills ?? null);

    const agentOf = (roles: Record<string, { agent?: string | null }> | null | undefined) =>
      Object.fromEntries(Object.entries(roles ?? {}).map(([role, cfg]) => [role, cfg.agent]));
    for (const r of RECIPES) {
      const pair = HydraPairs.fromCookbook(r.id);
      expect(pair.mode).toBe("roles");
      expect(pair.lead_instructions).toBe(r.lead_instructions);
      expect(agentOf(pair.roles)).toEqual(agentOf(r.roles));
    }
  });
});
