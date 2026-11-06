import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import {
  GENERIC_EFFORTS,
  ROW_CAP,
  customRow,
  effortAfterEngineChange,
  effortChoices,
  effortOptions,
  inheritHint,
  inheritedEffort,
  inheritedEngine,
  inheritedModel,
  isCustomModel,
  modelAfterEngineChange,
  rankModel,
  searchModels,
  type InheritContext,
  type ModelCatalog,
  type ModelInfo,
  hintValue,
  showsModelMark,
  shortModelName,
} from "../../web/src/lib/models-logic";
import { parseCursorModels, parseOpencodeModels } from "../../src/engines/models";

const m = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, ...extra });
const catalog = (models: ModelInfo[], efforts: string[] = ["low", "high"]): ModelCatalog => ({ engine: "x", source: "cli", models, efforts, fetchedAt: "2026-01-01T00:00:00Z" });
const fx = (name: string) => fs.readFileSync(path.join(import.meta.dir, "..", "fixtures", "models", name), "utf-8");

describe("searching a catalog", () => {
  const models = [m("opencode/big-pickle", { group: "opencode" }), m("opencode-go/deepseek-v4-pro", { group: "opencode-go" }), m("opencode-go/claude-haiku-5-5", { group: "opencode-go", label: "Haiku" }), m("zai/glm-5", { group: "zai" })];

  test("no query: the catalog's own order under provider headings", () => {
    const r = searchModels(models, "");
    expect(r.grouped).toBe(true);
    expect(r.groups.map((g) => g.group)).toEqual(["opencode", "opencode-go", "zai"]);
    expect(r.groups[1].items.map((x) => x.id)).toEqual(["opencode-go/deepseek-v4-pro", "opencode-go/claude-haiku-5-5"]);
    expect(r).toMatchObject({ total: 4, shown: 4, more: 0 });
  });

  test("a query ranks one flat list: exact id, then prefix, then substring, then label, then provider", () => {
    const flat = (q: string) => searchModels(models, q).groups.flatMap((g) => g.items.map((x) => x.id));
    expect(searchModels(models, "glm").grouped).toBe(false);
    expect(flat("zai/glm-5")[0]).toBe("zai/glm-5"); // exact
    expect(flat("opencode-go")).toEqual(["opencode-go/deepseek-v4-pro", "opencode-go/claude-haiku-5-5"]); // prefix of both, catalog order breaks the tie
    expect(flat("deepseek")).toEqual(["opencode-go/deepseek-v4-pro"]); // substring after a word boundary
    expect(flat("haiku")[0]).toBe("opencode-go/claude-haiku-5-5"); // matches in the id and the label
    expect(flat("pickle")).toEqual(["opencode/big-pickle"]);
  });

  test("every word must match somewhere; case does not matter", () => {
    const flat = (q: string) => searchModels(models, q).groups.flatMap((g) => g.items.map((x) => x.id));
    expect(flat("OPENCODE-GO pro")).toEqual(["opencode-go/deepseek-v4-pro"]);
    expect(flat("opencode haiku")).toEqual(["opencode-go/claude-haiku-5-5"]);
    expect(flat("zai haiku")).toEqual([]);
  });

  test("letters in order are a last resort: they only show when nothing matches for real", () => {
    const list = [m("gpt-5.3-codex-high"), m("gpt-5.2")];
    expect(searchModels(list, "g53c").total).toBe(1); // nothing contains it, so the weak match is allowed
    const many = [m("model-29"), m("model-129"), m("model-290")];
    expect(searchModels(many, "model-29").groups.flatMap((g) => g.items.map((x) => x.id))).toEqual(["model-29", "model-290"]);
  });

  test("letters in order find a model the words do not (weakly)", () => {
    expect(rankModel(m("gpt-5.3-codex-high"), "g53c")).toBeGreaterThan(0);
    expect(rankModel(m("gpt-5.3-codex-high"), "zzz")).toBe(0);
    expect(rankModel(m("a"), "a")).toBe(100);
  });

  test("a hint or a provider is searchable too", () => {
    const list = [m("x1", { hint: "Z.ai's latest flagship" }), m("x2", { group: "Anthropic" })];
    expect(searchModels(list, "flagship").total).toBe(1);
    expect(searchModels(list, "anthropic").total).toBe(1);
  });

  test("the row cap: at most 100 shown, the rest counted for the 'N more' line", () => {
    const many = Array.from({ length: 300 }, (_, i) => m(`model-${i}`, { group: i < 150 ? "a" : "b" }));
    const r = searchModels(many, "");
    expect(r.shown).toBe(ROW_CAP);
    expect(r.more).toBe(200);
    expect(r.groups.reduce((n, g) => n + g.items.length, 0)).toBe(ROW_CAP);
    const q = searchModels(many, "model");
    expect(q.shown).toBe(ROW_CAP);
    expect(q.more).toBe(200);
    expect(searchModels(many, "model-29")).toMatchObject({ shown: 11, more: 0 }); // model-29 and model-290..299
  });

  test("a small cap can be set, and the cap never splits a header from every row", () => {
    const many = Array.from({ length: 10 }, (_, i) => m(`m${i}`, { group: i < 5 ? "a" : "b" }));
    const r = searchModels(many, "", 3);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].items).toHaveLength(3);
    expect(r.more).toBe(7);
  });

  test("real catalogs: searching the cursor and opencode fixtures", () => {
    const cursor = parseCursorModels(fx("cursor.txt"));
    const hits = searchModels(cursor, "codex high").groups.flatMap((g) => g.items.map((x) => x.id));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((id) => /codex/.test(id) && /high/.test(id))).toBe(true);
    const oc = parseOpencodeModels(fx("opencode.txt"));
    expect(searchModels(oc, "big pickle").total).toBeGreaterThanOrEqual(1);
  });

  test("nothing matches: an empty result, not a crash", () => {
    expect(searchModels(models, "qqqq")).toMatchObject({ groups: [], total: 0, shown: 0, more: 0 });
    expect(searchModels([], "")).toMatchObject({ groups: [], total: 0 });
  });
});

describe("custom entries", () => {
  const list = [m("opus"), m("sonnet")];
  test("offered for text that is not an exact id, trimmed", () => {
    expect(customRow("  claude-opus-9 ", list)).toBe("claude-opus-9");
    expect(customRow("opu", list)).toBe("opu"); // a prefix is not the id
  });
  test("not offered when empty or already an id", () => {
    expect(customRow("", list)).toBeNull();
    expect(customRow("   ", list)).toBeNull();
    expect(customRow("opus", list)).toBeNull();
  });
  test("ids are case-sensitive: Opus is not opus", () => {
    expect(customRow("Opus", list)).toBe("Opus");
  });
  test("a value the loaded list does not know is custom; unknown until a list is loaded", () => {
    expect(isCustomModel("claude-future-9", catalog(list))).toBe(true);
    expect(isCustomModel("opus", catalog(list))).toBe(false);
    expect(isCustomModel("", catalog(list))).toBe(false);
    expect(isCustomModel("anything", undefined)).toBe(false);
    expect(isCustomModel("anything", catalog([]))).toBe(false);
  });
});

describe("effort options", () => {
  test("a model's own levels beat the engine's list", () => {
    const c = catalog([m("glm-5.3", { efforts: ["low", "high", "max"] }), m("plain")], ["low", "medium", "high"]);
    expect(effortOptions(c, "glm-5.3")).toEqual(["low", "high", "max"]);
    expect(effortOptions(c, "plain")).toEqual(["low", "medium", "high"]);
    expect(effortOptions(c, "")).toEqual(["low", "medium", "high"]);
    expect(effortOptions(c, "not-in-the-list")).toEqual(["low", "medium", "high"]);
  });
  test("an engine with no effort control offers none; no catalog yet offers the common three", () => {
    expect(effortOptions(catalog([m("auto")], []), "auto")).toEqual([]);
    expect(effortOptions(undefined, "")).toEqual(GENERIC_EFFORTS);
  });
  test("the current value stays selectable even when the list does not know it; default is not a choice", () => {
    expect(effortChoices(["low", "high"], "xhigh")).toEqual(["low", "high", "xhigh"]);
    expect(effortChoices(["low", "high", "low"], "low")).toEqual(["low", "high"]);
    expect(effortChoices(["low", ""], "")).toEqual(["low"]);
  });
});

describe("changing the engine", () => {
  test("a model survives only if the new engine lists it", () => {
    const next = catalog([m("gpt-5.3-codex"), m("auto")]);
    expect(modelAfterEngineChange("gpt-5.3-codex", next)).toBe("gpt-5.3-codex");
    expect(modelAfterEngineChange("claude-opus-5-5", next)).toBe("");
    expect(modelAfterEngineChange("", next)).toBe("");
  });
  test("with no list for the new engine the model is dropped (a stray id is worse than the default)", () => {
    expect(modelAfterEngineChange("claude-opus-5-5", undefined)).toBe("");
  });
  test("an effort survives only if the new engine accepts it", () => {
    expect(effortAfterEngineChange("high", ["low", "high"])).toBe("high");
    expect(effortAfterEngineChange("xhigh", ["low", "high"])).toBe("");
    expect(effortAfterEngineChange("high", [])).toBe("");
    expect(effortAfterEngineChange("high", undefined)).toBe("");
    expect(effortAfterEngineChange("", ["low"])).toBe("");
  });
});

describe("where a role's blank fields come from", () => {
  const blank = { engine: "", model: "", effort: "" };
  const lead = { engine: "claude", model: "claude-opus-5-5", effort: "high" };
  const reviewer = { title: "Reviewer", engine: "codex", model: "gpt-x", effort: "low" };
  const ctx = (over: Partial<InheritContext> = {}): InheritContext => ({ heads: null, agent: null, lead, ...over });

  test("engine: role, then the pair's heads config, then the agent, then the lead", () => {
    expect(inheritedEngine({ ...blank, engine: "cursor" }, ctx({ agent: reviewer }))).toMatchObject({ source: "role", value: "cursor" });
    expect(inheritedEngine(blank, ctx({ heads: { engine: "opencode", model: "", effort: "" }, agent: reviewer }))).toMatchObject({ source: "heads", value: "opencode" });
    expect(inheritedEngine(blank, ctx({ agent: reviewer }))).toMatchObject({ source: "agent", value: "codex", from: "agent “Reviewer”" });
    expect(inheritedEngine(blank, ctx())).toMatchObject({ source: "lead", value: "claude" });
  });

  test("an agent with no engine preference falls through to the lead", () => {
    expect(inheritedEngine(blank, ctx({ agent: { ...reviewer, engine: null } }))).toMatchObject({ source: "lead", value: "claude" });
  });

  test("model: the agent's only counts when it belongs to the engine that will run", () => {
    expect(inheritedModel(blank, ctx({ agent: reviewer }))).toMatchObject({ source: "agent", value: "gpt-x" }); // codex runs, agent is codex
    // The role forces claude: the agent's codex model must not leak onto it.
    expect(inheritedModel({ ...blank, engine: "claude" }, ctx({ agent: reviewer }))).toMatchObject({ source: "lead", value: "claude-opus-5-5" });
    // The role forces cursor: nobody has a cursor model, so it is the engine's own default.
    expect(inheritedModel({ ...blank, engine: "cursor" }, ctx({ agent: reviewer }))).toMatchObject({ value: "", from: "the engine's own default" });
  });

  test("model: the role's own wins over everything, and the heads config applies to its own engine", () => {
    expect(inheritedModel({ ...blank, model: "mine" }, ctx({ agent: reviewer }))).toMatchObject({ source: "role", value: "mine" });
    const heads = { engine: "codex", model: "heads-model", effort: "" };
    expect(inheritedModel(blank, ctx({ heads, agent: { ...reviewer, model: "agent-model" } }))).toMatchObject({ source: "heads", value: "heads-model" });
  });

  test("an agent with a model but no engine applies it on the lead's engine", () => {
    expect(inheritedModel(blank, ctx({ agent: { title: "A", engine: null, model: "claude-haiku-5-5", effort: null } }))).toMatchObject({ source: "agent", value: "claude-haiku-5-5" });
  });

  test("effort: role, then heads config, then the agent, then the lead", () => {
    expect(inheritedEffort({ ...blank, effort: "max" }, ctx({ agent: reviewer })).source).toBe("role");
    expect(inheritedEffort(blank, ctx({ heads: { engine: "", model: "", effort: "medium" }, agent: reviewer }))).toMatchObject({ source: "heads", value: "medium" });
    expect(inheritedEffort(blank, ctx({ agent: reviewer }))).toMatchObject({ source: "agent", value: "low" });
    expect(inheritedEffort(blank, ctx())).toMatchObject({ source: "lead", value: "high" });
    expect(inheritedEffort(blank, ctx({ lead: { engine: "claude", model: "", effort: "" } }))).toMatchObject({ value: "", from: "the engine's own default" });
  });

  test("hint text says where it comes from; empty when the role sets it", () => {
    expect(inheritHint(inheritedEngine(blank, ctx({ agent: reviewer })))).toBe("from agent “Reviewer”: codex");
    expect(inheritHint(inheritedEngine(blank, ctx()))).toBe("from the lead: claude");
    expect(inheritHint(inheritedModel({ ...blank, engine: "cursor" }, ctx()))).toBe("engine default");
    expect(inheritHint(inheritedEngine({ ...blank, engine: "cursor" }, ctx()))).toBe("");
  });
});

describe("narrow-field helpers", () => {
  test("hintValue keeps only the value of an inheritance hint", () => {
    expect(hintValue("from the lead: high")).toBe("high");
    expect(hintValue("from agent “Code reviewer”: gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(hintValue("engine default")).toBe("engine default");
    expect(hintValue(undefined)).toBe("");
  });
  test("a model's own mark is only worth showing on engines that front other vendors", () => {
    expect(showsModelMark("cursor", "gpt-5.3-codex")).toBe(true);
    expect(showsModelMark("opencode", "anthropic/claude-sonnet")).toBe(true);
    expect(showsModelMark("claude", "opus")).toBe(false);
    expect(showsModelMark("cursor", "")).toBe(false);
  });
  test("shortModelName drops the vendor and joins version numbers", () => {
    expect(shortModelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(shortModelName("claude-opus-4-1-20250805")).toBe("Opus 4.1");
    expect(shortModelName("anthropic/claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(shortModelName("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(shortModelName("")).toBe("");
  });
});
