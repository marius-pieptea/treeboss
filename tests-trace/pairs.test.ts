import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START pairs\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END pairs\n"); });
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { HydraPairs, PAIR_COOKBOOK } from "../src/hydra/pairs";
import { PAIR_ROLE_LIBRARY } from "../src/hydra/roles";

beforeEach(() => {
  db().exec("DELETE FROM pairs");
});

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
  test("every recipe creates a valid pair", () => {
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

  test("a roles pair's brief tells the lead to pass a role; a heads pair's names the heads engine", () => {
    const roles = HydraPairs.create({ title: "R", roles: { scout: { engine: "claude" } } });
    expect(HydraPairs.leadBrief(roles, "lead")).toContain("pass `role`");
    const heads = HydraPairs.create({ title: "H", heads_engine: "codex", heads_model: "gpt-x" });
    expect(HydraPairs.leadBrief(heads, "lead")).toContain("codex");
  });
});
