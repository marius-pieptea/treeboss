import { describe, expect, test } from "bun:test";
import { blankDraft, checkOn, draftOf, draftProblem, inputOf, MAX_RULES, ruleOn, sameDraft, switchedOf, toggled, unknownSkills, withSwitched } from "../../web/src/features/practices/logic";
import type { Pack, Switched } from "../../web/src/features/practices/data";

const pack = (over: Partial<Pack> = {}): Pack => ({ id: "strict", title: "Strict", summary: "s", appliesTo: ["web"], rules: ["No any.", "No bang."], skills: ["types-skill"], checks: ["no-any"], custom: false, modified: false, knownChecks: ["no-any"], ...over });
const edit = { isNew: false, builtin: true };

describe("the draft a pack edit holds", () => {
  test("a draft of a pack, saved unchanged, is the same draft; a change makes it differ", () => {
    const p = pack();
    const d = draftOf(p);
    expect(sameDraft(d, draftOf(p))).toBe(true);
    expect(sameDraft({ ...d, rules: [...d.rules, "New."] }, d)).toBe(false);
  });

  test("a blank pack starts with a free id and one empty rule to fill in", () => {
    const d = blankDraft(["my-pack"]);
    expect(d.id).toBe("my-pack-2");
    expect(d.rules).toEqual([""]);
    expect(d.appliesTo).toEqual(["any"]);
  });

  test("the first problem with a draft is named in words; a good draft has none", () => {
    const good = draftOf(pack());
    expect(draftProblem(good, edit)).toBeNull();
    expect(draftProblem({ ...good, title: "  " }, edit)).toMatch(/title/);
    expect(draftProblem({ ...good, rules: ["", "  "] }, edit)).toMatch(/at least one rule/);
    expect(draftProblem({ ...good, rules: Array.from({ length: MAX_RULES + 1 }, (_, i) => `r${i}`) }, edit)).toMatch(/at most 8 rules/);
    expect(draftProblem({ ...good, rules: ["a --> b"] }, edit)).toMatch(/comment markers/);
    expect(draftProblem({ ...good, skills: ["-bad"] }, edit)).toMatch(/skill name/);
    expect(draftProblem({ ...good, appliesTo: [] }, edit)).toMatch(/stack/);
    expect(draftProblem({ ...good, id: "Not Ok" }, { isNew: true, builtin: false })).toMatch(/pack id/);
    // A built-in's id is fixed, so only a new pack's id is checked.
    expect(draftProblem({ ...good, id: "Not Ok" }, edit)).toBeNull();
  });

  test("the body of a save trims, drops blank rules, and carries checks only for a built-in pack", () => {
    const d = { ...draftOf(pack()), title: "  Strict  ", rules: [" No any. ", "", "No bang."], skills: ["a", "a", " "] };
    expect(inputOf(d, edit)).toEqual({ title: "Strict", summary: "s", appliesTo: ["web"], rules: ["No any.", "No bang."], skills: ["a"], checks: ["no-any"] });
    const custom = inputOf({ ...d, id: "mine" }, { isNew: true, builtin: false });
    expect(custom).toMatchObject({ id: "mine" });
    expect(custom).not.toHaveProperty("checks");
  });

  test("a skill the daemon does not have is flagged; nothing is flagged before the list is known", () => {
    expect(unknownSkills(["types-skill", "gone"], ["types-skill"])).toEqual(["gone"]);
    expect(unknownSkills(["types-skill"], undefined)).toEqual([]);
  });
});

describe("what a workspace switches off", () => {
  test("a rule is on unless its pack has it off here; switching it back on empties the entry", () => {
    const off: Record<string, Switched> = {};
    expect(ruleOn(off, "strict", "No any.")).toBe(true);
    const next = withSwitched(off, "strict", { rules: toggled(switchedOf(off, "strict").rules, "No any.", false), checks: [] });
    expect(ruleOn(next, "strict", "No any.")).toBe(false);
    expect(ruleOn(next, "strict", "No bang.")).toBe(true);
    const back = withSwitched(next, "strict", { rules: toggled(switchedOf(next, "strict").rules, "No any.", true), checks: [] });
    expect(back).toEqual({});
  });

  test("a check is on only when the pack carries it and the workspace has not switched it off", () => {
    const p = pack();
    expect(checkOn(p, {}, "no-any")).toBe(true);
    expect(checkOn(p, { strict: { rules: [], checks: ["no-any"] } }, "no-any")).toBe(false);
    expect(checkOn(pack({ checks: [] }), {}, "no-any")).toBe(false);
  });

  test("toggling adds once and removes cleanly", () => {
    expect(toggled(["a"], "b", false)).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "b", false)).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "b", true)).toEqual(["a"]);
  });
});
