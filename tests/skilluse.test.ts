import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { skillOf, skillsUsed } from "../src/sessions/skilluse";
import { appendLog, createLead, setTurnRunner } from "../src/sessions/manager";
import { makeDir, resetState, settled } from "./helpers";

const known = new Set(["alpha", "beta"]);

describe("skillOf", () => {
  test("a Skill call, bare or JSON, and a plugin-prefixed name", () => {
    expect(skillOf({ kind: "tool", name: "Skill", arg: '{"skill":"alpha","args":"x"}' }, known)).toBe("alpha");
    expect(skillOf({ kind: "tool", name: "Skill", arg: "beta" }, known)).toBe("beta");
    expect(skillOf({ kind: "tool", name: "Skill", arg: '{"skill":"plug:alpha"}' }, known)).toBe("alpha");
    expect(skillOf({ kind: "tool", name: "Skill", arg: '{"args":"x"}' }, known)).toBeNull();
  });
  test("a Read of a known skill's SKILL.md counts; any other file does not", () => {
    expect(skillOf({ kind: "tool", name: "Read", arg: "C:\\x\\skills\\alpha\\SKILL.md" }, known)).toBe("alpha");
    expect(skillOf({ kind: "tool", name: "Read", arg: "/x/skills/other/SKILL.md" }, known)).toBeNull();
    expect(skillOf({ kind: "tool", name: "Read", arg: "/x/alpha/notes.md" }, known)).toBeNull();
    expect(skillOf({ kind: "tool_ok", name: "Skill", arg: "alpha" }, known)).toBeNull();
  });
});

describe("skillsUsed", () => {
  beforeEach(() => {
    resetState();
    setTurnRunner(null);
  });

  test("counts per skill across a lead and its subagent", async () => {
    setTurnRunner(async () => ({ success: true, output: "ok", sessionId: "c", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" }));
    const lead = createLead({ prompt: "go", engine: "fake", cwd: makeDir() });
    const kid = createLead({ prompt: "go", engine: "fake", cwd: makeDir() });
    await settled(lead.id);
    await settled(kid.id);
    db().prepare("INSERT OR REPLACE INTO skills (name, description, path, enabled) VALUES ('alpha', '', '/x/skills/alpha', 1)").run();
    appendLog(lead, null, '[claude] → Skill({"skill":"alpha"})');
    appendLog(lead, null, '[claude] → Skill({"skill":"alpha"})');
    appendLog(kid, null, "[codex] → Read(/x/skills/alpha/SKILL.md)");
    appendLog(kid, null, "[codex] → Read(/x/skills/zzz/SKILL.md)");

    expect(skillsUsed([lead.id]).map((u) => [u.skill, u.count])).toEqual([["alpha", 2]]);
    const both = skillsUsed([lead.id, kid.id]);
    expect(both).toHaveLength(1);
    expect(both[0].count).toBe(3);
    expect(both[0].bySession).toEqual({ [lead.id]: 2, [kid.id]: 1 });
    expect(skillsUsed([])).toEqual([]);
  });
});
