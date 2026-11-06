import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { BUILTIN_AGENTS, restoreBuiltinAgents, seedBuiltinAgents } from "../src/agents/builtin";
import { Agents } from "../src/agents/store";
import { db } from "../src/db";
import { effortsFor } from "../src/engines/models";
import { HydraPairs, LEAD_INSTRUCTIONS_CHARS, PAIR_COOKBOOK } from "../src/hydra/pairs";
import { PAIR_ROLE_LIBRARY } from "../src/hydra/roles";
import { home } from "../src/paths";

beforeEach(() => {
  db().exec("DELETE FROM pairs");
});

/** A fresh install's agents: none in the table, and nothing remembered about the built-ins. */
function freshAgents(): void {
  db().exec("DELETE FROM agents");
  fs.rmSync(path.join(home(), "builtin-agents.json"), { force: true });
}

/** Seed the shipped agents as the daemon does at start, without the "left out" log lines. */
function seedShipped(): void {
  const log = console.log;
  console.log = () => {};
  try {
    seedBuiltinAgents();
  } finally {
    console.log = log;
  }
}

describe("pair modes are exclusive", () => {
  test("a heads pair keeps heads fields and drops roles", () => {
    const p = HydraPairs.create({ title: "H", lead_engine: "claude", heads_engine: "codex", heads_model: "gpt-x", roles: { scout: { engine: "claude" } }, mode: "heads" });
    expect(p.mode).toBe("heads");
    expect(p.roles).toBeNull();
    expect(p.heads_engine).toBe("codex");
  });

  test("a pair given roles is a roles pair and has no heads config", () => {
    const p = HydraPairs.create({ title: "R", heads_engine: "codex", roles: { Scout: { engine: "claude", model: "m" } } });
    expect(p.mode).toBe("roles");
    expect(p.heads_engine).toBeNull();
    expect(Object.keys(p.roles!)).toEqual(["scout"]); // key normalised: the lead's `role` argument must match
  });

  test("a roles pair needs a role", () => {
    expect(() => HydraPairs.create({ title: "X", mode: "roles" })).toThrow(/at least one role/);
  });

  test("duplicate role names after normalisation are refused", () => {
    expect(() => HydraPairs.create({ title: "X", roles: { "Code Review": {}, "code-review": {} } })).toThrow(/duplicate role/);
  });

  test("switching mode on update does not inherit the other mode's fields", () => {
    const p = HydraPairs.create({ title: "Sw", heads_engine: "codex", max_heads: 3 });
    const r = HydraPairs.update(p.id, { roles: { worker: { engine: "claude" } } })!;
    expect(r.mode).toBe("roles");
    expect(r.heads_engine).toBeNull();
    const back = HydraPairs.update(p.id, { mode: "heads", heads_engine: "claude" })!;
    expect(back.mode).toBe("heads");
    expect(back.roles).toBeNull();
    expect(back.max_heads).toBe(3);
  });
});

describe("lookup and caps", () => {
  test("find by id and by title (case-insensitive)", () => {
    const p = HydraPairs.create({ title: "Opus leads Sonnet", heads_engine: "claude" });
    expect(HydraPairs.find(p.id)?.id).toBe(p.id);
    expect(HydraPairs.find("opus LEADS sonnet")?.id).toBe(p.id);
    expect(HydraPairs.find("nope")).toBeNull();
  });

  test("max_heads is clamped to 1..8", () => {
    expect(HydraPairs.create({ title: "a", heads_engine: "c", max_heads: 99 }).max_heads).toBe(8);
    expect(HydraPairs.create({ title: "b", heads_engine: "c", max_heads: 0 }).max_heads).toBe(1);
    expect(HydraPairs.create({ title: "c", heads_engine: "c" }).max_heads).toBeNull();
  });

  test("a title is required", () => {
    expect(() => HydraPairs.create({ title: "  " })).toThrow(/title/);
  });
});

describe("cookbook and roles", () => {
  test("every recipe creates a valid pair, with the shipped agents seeded as they are at daemon start", () => {
    freshAgents();
    seedShipped();
    for (const r of PAIR_COOKBOOK) {
      const p = HydraPairs.fromCookbook(r.id);
      expect(p.title).toBe(r.title);
      expect(p.lead_engine).toBeTruthy();
    }
    expect(() => HydraPairs.fromCookbook("nope")).toThrow(/unknown recipe/);
  });

  test("role library entries all carry instructions and a valid effort", () => {
    for (const r of PAIR_ROLE_LIBRARY) {
      expect(r.instructions.length).toBeGreaterThan(40);
      expect(["low", "medium", "high"]).toContain(r.effort);
    }
  });
});

describe("the lead contract", () => {
  test("the preamble leads with the contract and lists open heads so the lead reuses them", () => {
    const p = HydraPairs.create({ title: "T", lead_engine: "claude", roles: { worker: { engine: "codex" } } });
    const text = HydraPairs.leadTurnPreamble(p, "claude", [{ id: "s_1", title: "fix bug", status: "idle", engine: "codex", role: "worker" }]);
    expect(text.startsWith('# You are the LEAD of the Hydra pair "T"')).toBe(true);
    expect(text).toContain("mcp__trb__subagent_create");
    expect(text).toContain("s_1");
    expect(text).toContain("subagent_send");
  });

  test("the preamble has the lead merge each head as it passes (mode any), pass files, and serialize heads on the same files", () => {
    const p = HydraPairs.create({ title: "T", lead_engine: "claude", roles: { worker: { engine: "codex" } } });
    const text = HydraPairs.leadTurnPreamble(p, "claude");
    expect(text).toContain('subagent_wait using mode "any"');
    expect(text).toContain("subagent_merge it");
    expect(text).toContain("Do not wait for every head before merging");
    expect(text).toContain("Pass `files` with each head");
    expect(text).toContain("do not run in parallel");
  });

  test("a roles pair's brief tells the lead to pass a role; a heads pair's names the heads engine", () => {
    const roles = HydraPairs.create({ title: "R", roles: { scout: { engine: "claude" } } });
    expect(HydraPairs.leadBrief(roles, "lead")).toContain("pass `role`");
    const heads = HydraPairs.create({ title: "H", heads_engine: "codex", heads_model: "gpt-x" });
    expect(HydraPairs.leadBrief(heads, "lead")).toContain("codex");
  });
});

describe("lead instructions", () => {
  test("saved trimmed, kept by an edit that does not mention them, cleared by a blank or null", () => {
    const p = HydraPairs.create({ title: "L", heads_engine: "claude", lead_instructions: "  Split by file.  " });
    expect(p.lead_instructions).toBe("Split by file.");
    expect(HydraPairs.get(p.id)!.lead_instructions).toBe("Split by file.");
    expect(HydraPairs.update(p.id, { max_heads: 3 })!.lead_instructions).toBe("Split by file.");
    expect(HydraPairs.update(p.id, { lead_instructions: "   " })!.lead_instructions).toBeNull();
    expect(HydraPairs.create({ title: "N", heads_engine: "claude" }).lead_instructions).toBeNull();
  });

  test("capped at 2,000 characters, and a longer edit is refused and leaves the pair as it was", () => {
    expect(HydraPairs.create({ title: "ok", heads_engine: "claude", lead_instructions: "x".repeat(2_000) }).lead_instructions).toHaveLength(2_000);
    expect(() => HydraPairs.create({ title: "big", heads_engine: "claude", lead_instructions: "x".repeat(2_001) })).toThrow(/too long \(2001 chars; the limit is 2000\)/);
    const p = HydraPairs.create({ title: "small", heads_engine: "claude" });
    expect(() => HydraPairs.update(p.id, { lead_instructions: "x".repeat(2_001) })).toThrow(/too long/);
    expect(HydraPairs.get(p.id)!.lead_instructions).toBeNull();
  });

  test("the preamble carries them after the load step and the fan-out and collect rules; without them it is unchanged", () => {
    const base = { title: "T", lead_engine: "claude", roles: { worker: { engine: "codex" } } };
    const plain = HydraPairs.create(base);
    const briefed = HydraPairs.create({ ...base, lead_instructions: "Split by file. Never merge red." });
    const before = HydraPairs.leadTurnPreamble(plain, "claude");
    const after = HydraPairs.leadTurnPreamble(briefed, "claude");
    const section = "How this pair works:\nSplit by file. Never merge red.\n";
    expect(after.split(section)).toHaveLength(2);
    expect(after.replace(section, "")).toBe(before);
    expect(before).not.toContain("How this pair works:");
    const at = after.indexOf("How this pair works:");
    expect(at).toBeGreaterThan(after.indexOf("Your FIRST tool call"));
    expect(at).toBeGreaterThan(after.indexOf("Pass `files` with each head"));
    expect(at).toBeGreaterThan(after.indexOf('subagent_wait using mode "any"'));
    expect(at).toBeLessThan(after.indexOf("\n---\n"));
  });

  test("a cookbook recipe copies them into the pair it creates", () => {
    const recipes: typeof PAIR_COOKBOOK = [{ id: "brief", title: "Briefed", tagline: "t", lead_engine: "claude", heads_engine: "claude", lead_instructions: "Brief me." }];
    expect(HydraPairs.fromCookbook("brief", recipes).lead_instructions).toBe("Brief me.");
  });

  test("a recipe that names an agent this install no longer has says how to get it back", () => {
    const recipes: typeof PAIR_COOKBOOK = [{ id: "review", title: "Review team", tagline: "t", lead_engine: "claude", mode: "roles", roles: { reviewer: { engine: "claude", agent: "reviewer-gone" } } }];
    expect(() => HydraPairs.fromCookbook("review", recipes)).toThrow(/agent "reviewer-gone", which is not installed: restore built-in agents in Settings > Agents/);
    expect(db().prepare("SELECT COUNT(*) AS n FROM pairs WHERE title = 'Review team'").get()).toEqual({ n: 0 });
  });
});

describe("the pstack recipes", () => {
  const PSTACK_IDS = ["pstack-claude", "pstack-claude-codex"];
  beforeEach(freshAgents);

  test("every role a recipe names an agent for is one of the shipped agents", () => {
    const shipped = new Set(BUILTIN_AGENTS.map((b) => b.name));
    for (const r of PAIR_COOKBOOK) for (const cfg of Object.values(r.roles ?? {})) if (cfg.agent) expect(shipped.has(cfg.agent)).toBe(true);
  });

  test("each recipe is a six-head roles pair on an xhigh Claude lead, and its brief fits the cap", () => {
    for (const id of PSTACK_IDS) {
      const r = PAIR_COOKBOOK.find((x) => x.id === id)!;
      expect(r).toMatchObject({ mode: "roles", max_heads: 6, lead_engine: "claude", lead_model: "claude-opus-5-5", lead_effort: "xhigh" });
      expect(r.lead_instructions!.length).toBeLessThanOrEqual(LEAD_INSTRUCTIONS_CHARS);
    }
  });

  test("every effort a recipe names is one its engine accepts", () => {
    for (const id of PSTACK_IDS) {
      const r = PAIR_COOKBOOK.find((x) => x.id === id)!;
      expect(effortsFor(r.lead_engine!)).toContain(r.lead_effort!);
      for (const cfg of Object.values(r.roles!)) expect(effortsFor(cfg.engine!)).toContain(cfg.effort!);
    }
  });

  test("every role has its own one-line instructions, never the library's text", () => {
    for (const id of PSTACK_IDS) {
      const roles = PAIR_COOKBOOK.find((x) => x.id === id)!.roles!;
      expect(Object.keys(roles)).toEqual(["explorer", "architect", "builder", "verifier", "cleaner"]);
      expect(Object.values(roles).map((c) => c.label)).toEqual(["Explorer", "Architect", "Builder", "Verifier", "Cleaner"]);
      for (const [key, cfg] of Object.entries(roles)) {
        expect(cfg.instructions).toBeTruthy();
        expect(cfg.instructions).not.toContain("\n");
        const library = PAIR_ROLE_LIBRARY.find((p) => p.id === key);
        if (library) expect(cfg.instructions).not.toBe(library.instructions);
      }
    }
  });

  test("with the shipped agents seeded, both recipes create their pairs with roles, agents and the brief stored", () => {
    seedShipped();
    const made = Object.fromEntries(PSTACK_IDS.map((id) => [id, HydraPairs.fromCookbook(id)]));
    for (const id of PSTACK_IDS) {
      const recipe = PAIR_COOKBOOK.find((x) => x.id === id)!;
      expect(made[id]).toMatchObject({ title: recipe.title, mode: "roles", max_heads: 6, lead_engine: "claude", lead_effort: "xhigh", lead_instructions: recipe.lead_instructions });
      expect(Object.fromEntries(Object.entries(made[id]!.roles!).map(([role, cfg]) => [role, cfg.agent]))).toEqual({ explorer: "pstack-explorer", architect: "pstack-architect", builder: "poteto-agent", verifier: "pstack-verifier", cleaner: "comment-sicko" });
    }
    expect(made["pstack-claude"]!.roles!.builder).toMatchObject({ engine: "claude", model: "claude-sonnet-5-5", effort: "high" });
    expect(made["pstack-claude-codex"]!.roles!.builder).toMatchObject({ engine: "codex", model: "default", effort: "high" });
    expect(made["pstack-claude-codex"]!.roles!.verifier).toMatchObject({ engine: "claude", model: "claude-opus-5-5" });
  });

  test("a missing built-in agent makes the recipe say how to get it back, and restoring brings it back", () => {
    seedShipped();
    Agents.remove("poteto-agent");
    expect(() => HydraPairs.fromCookbook("pstack-claude-codex")).toThrow(/agent "poteto-agent", which is not installed: restore built-in agents in Settings > Agents/);
    restoreBuiltinAgents();
    expect(HydraPairs.fromCookbook("pstack-claude-codex").roles!.builder.agent).toBe("poteto-agent");
  });

  test("the brief comes after the load step and the fan-out and collect rules, and before the heads still open", () => {
    seedShipped();
    const pair = HydraPairs.fromCookbook("pstack-claude");
    const text = HydraPairs.leadTurnPreamble(pair, "claude", [{ id: "s_1", title: "build the unit", status: "idle", engine: "codex", role: "builder" }]);
    const brief = text.indexOf("How this pair works:");
    expect(brief).toBeGreaterThan(text.indexOf("Your FIRST tool call"));
    expect(brief).toBeGreaterThan(text.indexOf("Pass `files` with each head"));
    expect(brief).toBeGreaterThan(text.indexOf('subagent_wait using mode "any"'));
    expect(text.indexOf("Heads still open from earlier turns")).toBeGreaterThan(brief);
    expect(text.slice(brief)).toContain(pair.lead_instructions!.split("\n")[0]);
  });
});
