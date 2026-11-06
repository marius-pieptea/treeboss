import { describe, expect, test } from "bun:test";
import { BUILTIN_SYSTEMS } from "../../src/design/builtins";
import { parseTokens } from "../../src/design/contract";
import { designProblem, intentLabel, needsText, parseDesignCommand } from "../../web/src/features/design/composer";
import { splitInstructions, splitSkillCall } from "../../web/src/features/agent/chat-logic";
import { blankForm, defaultSystemFor, duplicateForm, firstFamily, formProblem, inputProblem, moveId, sameForm, slug, stripColors, toForm, toSystem, tokenLabel } from "../../web/src/features/design/logic";

describe("design logic", () => {
  test("New app suggests none for APIs, else the last system used, else the first", () => {
    const ids = ["neutral", "soft"];
    expect(defaultSystemFor("api", "soft", ids)).toBe("");
    expect(defaultSystemFor("CLI", null, ids)).toBe("");
    expect(defaultSystemFor("web", "soft", ids)).toBe("soft");
    expect(defaultSystemFor("web", "", ids)).toBe(""); // they chose none last time
    expect(defaultSystemFor("web", "deleted", ids)).toBe("neutral");
    expect(defaultSystemFor("mobile", null, [])).toBe("");
  });

  test("session input checks", () => {
    expect(inputProblem("brief", " ")).toMatch(/Describe/);
    expect(inputProblem("brief", "A CRM")).toBeNull();
    expect(inputProblem("url", "example.com")).toMatch(/URL/);
    expect(inputProblem("url", "https://example.com/x")).toBeNull();
    expect(inputProblem("review", "")).toBeNull();
  });

  test("swatch helpers", () => {
    const s = parseTokens(BUILTIN_SYSTEMS[0]!.tokens);
    expect(stripColors(s).map((c) => c.name)).toEqual(["--color-bg", "--color-surface", "--color-text", "--color-primary", "--color-accent", "--color-border"]);
    expect(stripColors(parseTokens(":root{--brand:#123456}")).map((c) => c.name)).toEqual(["--brand"]);
    expect(firstFamily(`"Inter", ui-sans-serif`)).toBe("Inter");
    expect(tokenLabel("--color-text-muted")).toBe("text-muted");
  });

  test("the library form", () => {
    const f = toForm({ id: "neutral", name: "Neutral", description: "d", design: "# N\n", tokens: "", builtinId: "neutral" });
    expect(sameForm(f, { ...f })).toBe(true);
    expect(sameForm(f, { ...f, design: "# M\n" })).toBe(false);
    const d = duplicateForm(f, ["neutral", "neutral-copy"]);
    expect(d).toMatchObject({ id: "neutral-copy-2", name: "Neutral copy", isNew: true, builtinId: undefined });
    expect(toSystem({ ...d, name: "  X  " }).name).toBe("X");
    expect(blankForm([]).id).toBe("new-system");
    expect(formProblem({ ...f, name: " " })).toMatch(/name/);
    expect(formProblem({ ...f, design: "" })).toMatch(/DESIGN/);
    expect(slug("Reorder", [])).toBe("reorder-1");
    expect(moveId(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b"], "a", -1)).toEqual(["a", "b"]);
  });
});

describe("design turns in the composer", () => {
  test("/design parses into a kind, its text, and whether to send now", () => {
    expect(parseDesignCommand("/design")).toEqual({ intent: { kind: "brief", brainstorm: true }, input: "", send: false });
    expect(parseDesignCommand("/design A booking app\nfor yoga studios")).toEqual({ intent: { kind: "brief", brainstorm: true }, input: "A booking app\nfor yoga studios", send: true });
    expect(parseDesignCommand("/design https://example.com")).toMatchObject({ intent: { kind: "url", brainstorm: true }, input: "https://example.com", send: true });
    expect(parseDesignCommand("/design --quick a CRM")).toMatchObject({ intent: { kind: "brief", brainstorm: false }, input: "a CRM", send: true });
    expect(parseDesignCommand("/design code only apps/web")).toMatchObject({ intent: { kind: "codebase", brainstorm: false }, input: "only apps/web", send: true });
    expect(parseDesignCommand("/design review")).toMatchObject({ intent: { kind: "review" }, input: "", send: true });
    expect(parseDesignCommand("/design url")).toMatchObject({ intent: { kind: "url" }, send: false });
    expect(parseDesignCommand("/designer stuff")).toBeNull();
    expect(parseDesignCommand("please /design this")).toBeNull();
  });

  test("labels, text requirements and problems", () => {
    expect(intentLabel({ kind: "brief", brainstorm: true })).toBe("Design system · brainstorm");
    expect(intentLabel({ kind: "url", brainstorm: false })).toBe("Design from a site · one go");
    expect(intentLabel({ kind: "review", brainstorm: false })).toBe("Design review");
    expect(needsText("brief")).toBe(true);
    expect(needsText("wire")).toBe(false);
    expect(designProblem({ kind: "url", brainstorm: true }, "nope")).toMatch(/URL/);
    expect(designProblem({ kind: "review", brainstorm: false }, "")).toBeNull();
  });

  test("the thread folds the daemon's instructions away from the operator's words", () => {
    expect(splitInstructions("just a prompt")).toEqual({ text: "just a prompt", label: null, instructions: null });
    const p = "A CRM for florists\n\n<!-- trb:instructions Design · brief · brainstorm -->\nDesign discovery…\nmore";
    expect(splitInstructions(p)).toEqual({ text: "A CRM for florists", label: "Design · brief · brainstorm", instructions: "Design discovery…\nmore" });
    expect(splitInstructions("x\n\n<!-- trb:instructions broken")).toMatchObject({ label: null });
  });

  test("a typed /skill call is told apart from the person's own words", () => {
    const skills = ["review-code", "seo", "web-copy"];
    expect(splitSkillCall("/seo audit my page", skills)).toEqual({ skill: "seo", text: "audit my page" });
    expect(splitSkillCall("/SEO", skills)).toEqual({ skill: "seo", text: "" });
    expect(splitSkillCall("/rev look at this\nand that", skills)).toEqual({ skill: "review-code", text: "look at this\nand that" });
    expect(splitSkillCall("/copy hero", skills)).toEqual({ skill: "web-copy", text: "hero" });
    expect(splitSkillCall("/nope hi", skills)).toEqual({ skill: null, text: "/nope hi" });
    expect(splitSkillCall("hello /seo", skills)).toEqual({ skill: null, text: "hello /seo" });
    expect(splitSkillCall("/s hi", ["seo", "stripe"])).toEqual({ skill: null, text: "/s hi" }); // two matches: the daemon would not pick one either
  });
});
