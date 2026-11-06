import { describe, expect, test } from "bun:test";
import { blankForm, blankItem, checkFor, DISABLED_NOTE, formProblem, forkForm, idFrom, isDisabledItem, moveItem, sameForm, splitTags, toDefinition, toForm, type ChecklistForm } from "../../web/src/features/checklists/editor-logic";
import type { CatalogDef } from "../../web/src/features/checklists/data";

const def: CatalogDef = {
  id: "launch-extra",
  title: "Launch extra",
  summary: "Things to check.",
  appliesTo: ["api", "marketing"],
  items: [
    { id: "meta-title", text: "Meta title", category: "Metadata", severity: "required", kind: "auto", check: "meta-title", hint: "Set a title." },
    { id: "ask-team", text: "Team agrees", category: "Process", severity: "recommended", kind: "manual", hint: "Ask the team." },
  ],
};

describe("the checklist editor's form", () => {
  test("a definition round-trips through the form, and a check is kept only on an auto item", () => {
    const form = toForm(def);
    expect(form.appliesTo).toBe("api, marketing");
    expect(toDefinition(form)).toEqual(def);
    const moved = { ...form, items: form.items.map((i) => ({ ...i, kind: "agent" as const })) };
    expect(toDefinition(moved).items[0]).not.toHaveProperty("check");
  });

  test("the first problem is named, and a valid form has none", () => {
    const form = toForm(def);
    expect(formProblem(form)).toBeNull();
    expect(formProblem({ ...form, id: "Bad_Id" })).toMatch(/lowercase/);
    expect(formProblem({ ...form, title: "  " })).toMatch(/title/);
    expect(formProblem({ ...form, items: [form.items[0]!, { ...form.items[1]!, id: "meta-title" }] })).toMatch(/used by another item/);
    expect(formProblem({ ...form, items: [{ ...form.items[0]!, kind: "auto", check: "" }] })).toMatch(/needs its check/);
    expect(formProblem({ ...form, items: [{ ...form.items[0]!, hint: "" }] })).toMatch(/hint/);
    expect(formProblem({ ...form, items: [] })).toMatch(/at least one/);
  });

  test("moving an item swaps it with its neighbour, and stops at the ends", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });

  test("a form and its copy compare by definition, not by the row keys", () => {
    const a = toForm(def);
    const b = toForm(def);
    expect(sameForm(a, b)).toBe(true);
    expect(sameForm(a, { ...a, title: "Other" })).toBe(false);
  });

  test("a fork is a new form under a new id, with the same items", () => {
    const fork: ChecklistForm = forkForm(toForm(def), "launch-copy", "Launch copy");
    expect(fork).toMatchObject({ id: "launch-copy", title: "Launch copy", isNew: true });
    expect(toDefinition(fork).items).toEqual(def.items);
    expect(blankForm().isNew).toBe(true);
  });

  test("tags split on commas, trimmed and unique; a check belongs to an auto item only", () => {
    expect(splitTags(" api, marketing ,api,, ")).toEqual(["api", "marketing"]);
    expect(checkFor("auto", "meta-title")).toBe("meta-title");
    expect(checkFor("agent", "meta-title")).toBe("");
    expect(blankItem().kind).toBe("agent");
  });

  test("an id is made from a title, and a disabled item is recognised by its pinned answer", () => {
    expect(idFrom("Launch: extra checks!")).toBe("launch-extra-checks");
    expect(isDisabledItem({ status: "na", source: "manual", note: DISABLED_NOTE })).toBe(true);
    expect(isDisabledItem({ status: "na", source: "agent", note: DISABLED_NOTE })).toBe(false);
  });
});
