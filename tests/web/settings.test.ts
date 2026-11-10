import { describe, expect, test } from "bun:test";
import {
  coerceSetting,
  emptyPairForm,
  formToPayload,
  joinArgs,
  LEAD_INSTRUCTIONS_MAX,
  looksSecret,
  normalizeRoleKey,
  pairToForm,
  parseMcpPaste,
  settingMatches,
  settingMeta,
  stepSetting,
  switchPairMode,
  tokenizeArgs,
  validatePairForm,
  presetAgentConflict,
  presetOfRole,
  withAgent,
} from "../../web/src/features/settings/logic";
import { HydraPairs } from "../../src/hydra/pairs";
import { PAIR_ROLE_LIBRARY, normalizeRoleKey as serverNormalize } from "../../src/hydra/roles";
import { db } from "../../src/db";

describe("tokenizeArgs", () => {
  test("plain words, runs of whitespace, empty input", () => {
    expect(tokenizeArgs("-y @scope/pkg --flag")).toEqual(["-y", "@scope/pkg", "--flag"]);
    expect(tokenizeArgs("  a   b\t c  ")).toEqual(["a", "b", "c"]);
    expect(tokenizeArgs("")).toEqual([]);
    expect(tokenizeArgs("   ")).toEqual([]);
  });
  test("single quotes are literal, double quotes allow escapes", () => {
    expect(tokenizeArgs(`--name 'hello world' "a b"`)).toEqual(["--name", "hello world", "a b"]);
    expect(tokenizeArgs(`'it\\s' "say \\"hi\\""`)).toEqual(["it\\s", 'say "hi"']);
    expect(tokenizeArgs(`"back\\\\slash"`)).toEqual(["back\\slash"]);
  });
  test("a backslash outside quotes escapes the next character", () => {
    expect(tokenizeArgs("path\\ with\\ spaces next")).toEqual(["path with spaces", "next"]);
  });
  test("empty quotes are an empty argument, not nothing", () => {
    expect(tokenizeArgs(`a '' b ""`)).toEqual(["a", "", "b", ""]);
  });
  test("adjacent quoted and bare text is one argument", () => {
    expect(tokenizeArgs(`--key="v v"x`)).toEqual(["--key=v vx"]);
  });
  test("an unterminated quote runs to the end instead of throwing", () => {
    expect(tokenizeArgs(`run "unfinished arg`)).toEqual(["run", "unfinished arg"]);
  });
  test("joinArgs round-trips through tokenizeArgs", () => {
    for (const args of [["-y", "pkg"], ["a b", "c"], ["it's", `say "hi"`], [""], ["back\\slash", "x y"], ["--k=v w"]]) {
      expect(tokenizeArgs(joinArgs(args))).toEqual(args);
    }
  });
});

describe("parseMcpPaste", () => {
  test("the standard {mcpServers} shape, stdio and http, env and headers coerced to strings", () => {
    const r = parseMcpPaste(JSON.stringify({ mcpServers: { ctx: { command: "npx", args: ["-y", "ctx"], env: { PORT: 3000, K: "v" } }, docs: { url: "https://h/mcp", headers: { Authorization: "Bearer x" } } } }));
    expect(r.errors).toEqual([]);
    expect(r.servers).toEqual([
      { name: "ctx", command: "npx", args: ["-y", "ctx"], env: { PORT: "3000", K: "v" }, url: undefined, headers: {} },
      { name: "docs", command: undefined, args: [], env: {}, url: "https://h/mcp", headers: { Authorization: "Bearer x" } },
    ]);
  });
  test("an editor's {servers} shape and a bare name -> server map", () => {
    expect(parseMcpPaste('{"servers":{"a":{"command":"x"}}}').servers.map((s) => s.name)).toEqual(["a"]);
    expect(parseMcpPaste('{"a":{"command":"x"},"b":{"url":"http://localhost:1/mcp"}}').servers.map((s) => s.name)).toEqual(["a", "b"]);
  });
  test("one server on its own has no name yet, or uses its own name field", () => {
    expect(parseMcpPaste('{"command":"node","args":["s.js"]}').servers[0]).toMatchObject({ name: null, command: "node", args: ["s.js"] });
    expect(parseMcpPaste('{"name":"mine","url":"https://x/mcp"}').servers[0].name).toBe("mine");
  });
  test("an array of named servers", () => {
    expect(parseMcpPaste('[{"name":"a","command":"x"},{"name":"b","command":"y"}]').servers.map((s) => s.name)).toEqual(["a", "b"]);
  });
  test("a README fragment (the inside of an object) is accepted", () => {
    const r = parseMcpPaste('"playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },');
    expect(r.errors).toEqual([]);
    expect(r.servers[0]).toMatchObject({ name: "playwright", command: "npx" });
  });
  test("a command line in `command` is split; a path with spaces is not", () => {
    expect(parseMcpPaste('{"x":{"command":"npx -y some-server"}}').servers[0]).toMatchObject({ command: "npx", args: ["-y", "some-server"] });
    expect(parseMcpPaste('{"x":{"command":"/Applications/My App/bin/srv"}}').servers[0]).toMatchObject({ command: "/Applications/My App/bin/srv", args: [] });
    expect(parseMcpPaste('{"x":{"command":"node","args":"a.js --flag \\"b c\\""}}').servers[0].args).toEqual(["a.js", "--flag", "b c"]);
  });
  test("invalid input is reported, per server, and valid siblings still come through", () => {
    const r = parseMcpPaste(JSON.stringify({ mcpServers: { good: { command: "x" }, both: { command: "x", url: "https://y" }, none: {}, "bad name": { command: "x" }, trb: { command: "x" }, ftp: { url: "ftp://z" } } }));
    expect(r.servers.map((s) => s.name)).toEqual(["good"]);
    expect(r.errors).toHaveLength(5);
    expect(r.errors.join("\n")).toMatch(/both a command and a url/);
    expect(r.errors.join("\n")).toMatch(/needs a command/);
    expect(r.errors.join("\n")).toMatch(/1-40 letters/);
    expect(r.errors.join("\n")).toMatch(/reserved/);
    expect(r.errors.join("\n")).toMatch(/http:\/\//);
  });
  test("garbage, empty and wrong shapes", () => {
    expect(parseMcpPaste("").servers).toEqual([]);
    expect(parseMcpPaste("   ").errors).toEqual([]);
    expect(parseMcpPaste("{not json").errors[0]).toMatch(/Not valid JSON/);
    expect(parseMcpPaste("42").errors[0]).toMatch(/JSON object/);
    expect(parseMcpPaste('{"hello":"world"}').errors[0]).toMatch(/Could not find a server/);
    expect(parseMcpPaste('{"mcpServers":{}}').errors[0]).toMatch(/No servers/);
    expect(parseMcpPaste("[]").errors[0]).toMatch(/empty/);
    expect(parseMcpPaste('{"mcpServers":{"a":"string"}}').errors[0]).toMatch(/expected an object/);
  });
  test("an SSE-typed server warns but is accepted", () => {
    const r = parseMcpPaste('{"a":{"type":"sse","url":"https://h/sse"}}');
    expect(r.servers).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/SSE/);
  });
  test("secret-looking keys", () => {
    for (const k of ["API_KEY", "GITHUB_TOKEN", "Authorization", "client_secret", "DB_PASSWORD"]) expect(looksSecret(k)).toBe(true);
    for (const k of ["PORT", "DEBUG", "NODE_ENV", "Content-Type"]) expect(looksSecret(k)).toBe(false);
  });
});

describe("pair form <-> payload", () => {
  const rolesPair = {
    title: "Mixed",
    mode: "roles" as const,
    lead_engine: "claude",
    lead_model: "claude-opus-5-5",
    lead_effort: "high",
    heads_engine: "stale",
    heads_model: "stale",
    roles: { worker: { engine: "codex", model: null, effort: "medium", instructions: "build it", label: "Worker" }, scout: { engine: "claude", model: "claude-haiku-5-5", effort: "low" } },
    max_heads: 4,
  };

  test("a roles pair round-trips and the payload carries no heads config", () => {
    const form = pairToForm(rolesPair);
    expect(form.roles.map((r) => r.key)).toEqual(["worker", "scout"]);
    const p = formToPayload(form) as any;
    expect(p.mode).toBe("roles");
    expect(p.heads_engine).toBeNull();
    expect(p.heads_model).toBeNull();
    expect(p.roles.worker).toEqual({ engine: "codex", model: null, effort: "medium", instructions: "build it", label: "Worker" });
    expect(p.roles.scout).toMatchObject({ engine: "claude", model: "claude-haiku-5-5", instructions: null });
    expect(p.max_heads).toBe(4);
  });

  test("a heads pair's payload carries no roles, and blank fields become null", () => {
    const form = { ...emptyPairForm(), title: " Opus leads Sonnet ", leadEngine: "claude", leadModel: " claude-opus-5-5 ", headsEngine: "claude", headsModel: "", headsEffort: "medium", roles: [{ key: "x", engine: "a", model: "", effort: "", agent: "", instructions: "", label: "" }] };
    const p = formToPayload(form) as any;
    expect(p.title).toBe("Opus leads Sonnet");
    expect(p.lead_model).toBe("claude-opus-5-5");
    expect(p.heads_model).toBeNull();
    expect(p.roles).toBeNull();
    expect(p.mode).toBe("heads");
  });

  test("a heads pair loaded from the API shows no roles even if stale ones were sent", () => {
    expect(pairToForm({ ...rolesPair, mode: "heads" }).roles).toEqual([]);
  });

  test("role keys are normalised the way the daemon does it", () => {
    for (const k of ["Code Review", "  Scout  ", "a/b", "--x--", "Ünï", "UPPER_case-1"]) expect(normalizeRoleKey(k)).toBe(serverNormalize(k));
    const form = { ...emptyPairForm(), title: "t", mode: "roles" as const, roles: [{ key: "Code Review", engine: "claude", model: "", effort: "", agent: "", instructions: "", label: "" }] };
    expect(Object.keys((formToPayload(form) as any).roles)).toEqual(["code-review"]);
  });

  test("validation matches the daemon's messages", () => {
    expect(validatePairForm(emptyPairForm())).toEqual(["pair needs a title"]);
    const roles = { ...emptyPairForm(), title: "t", mode: "roles" as const };
    expect(validatePairForm(roles)).toEqual(["a roles pair needs at least one role"]);
    const dupes = { ...roles, roles: [{ key: "Code Review", engine: "", model: "", effort: "", agent: "", instructions: "", label: "" }, { key: "code-review", engine: "", model: "", effort: "", agent: "", instructions: "", label: "" }] };
    expect(validatePairForm(dupes)).toEqual(['duplicate role "code-review"']);
    expect(validatePairForm({ ...roles, roles: [{ key: "  ", engine: "", model: "", effort: "", agent: "", instructions: "", label: "" }] })).toEqual(["every role needs a name", "a roles pair needs at least one role"]);
    expect(validatePairForm({ ...emptyPairForm(), title: "t", maxHeads: 12 })[0]).toMatch(/1-8/);
    expect(validatePairForm({ ...emptyPairForm(), title: "t", maxHeads: 3 })).toEqual([]);
  });

  test("what validatePairForm accepts, the daemon accepts; what it rejects, the daemon rejects", () => {
    db().exec("DELETE FROM pairs");
    const ok = { ...emptyPairForm(), title: "Works", mode: "roles" as const, roles: [{ key: "worker", engine: "codex", model: "", effort: "", agent: "", instructions: "", label: "" }], maxHeads: 2 };
    expect(validatePairForm(ok)).toEqual([]);
    const made = HydraPairs.create(formToPayload(ok) as any);
    expect(made).toMatchObject({ mode: "roles", max_heads: 2 });
    expect(pairToForm(made as any).roles[0].key).toBe("worker");
    const bad = { ...emptyPairForm(), title: "Nope", mode: "roles" as const };
    expect(validatePairForm(bad)).not.toEqual([]);
    expect(() => HydraPairs.create(formToPayload(bad) as any)).toThrow(/at least one role/);
  });

  test("lead instructions: the form sends them trimmed, the daemon keeps them, and the cap is the daemon's", () => {
    const form = { ...emptyPairForm(), title: "Briefed", headsEngine: "claude", leadInstructions: "  Split by file.  " };
    const made = HydraPairs.create(formToPayload(form) as any);
    expect(made.lead_instructions).toBe("Split by file.");
    expect(pairToForm(made as any).leadInstructions).toBe("Split by file.");
    expect((formToPayload(emptyPairForm()) as any).lead_instructions).toBeNull();
    expect(validatePairForm({ ...form, leadInstructions: "x".repeat(LEAD_INSTRUCTIONS_MAX) })).toEqual([]);
    const long = { ...form, leadInstructions: "x".repeat(LEAD_INSTRUCTIONS_MAX + 1) };
    expect(validatePairForm(long)).toEqual(["lead instructions are 2,001 characters; the limit is 2,000"]);
    expect(() => HydraPairs.create(formToPayload(long) as any)).toThrow(/too long \(2001 chars; the limit is 2000\)/);
  });

  test("switching mode carries over what is useful and never mixes the two", () => {
    const heads = { ...emptyPairForm(), title: "t", headsEngine: "codex", headsModel: "gpt-x", headsEffort: "low" };
    const toRoles = switchPairMode(heads, "roles");
    expect(toRoles.mode).toBe("roles");
    expect(toRoles.roles[0]).toMatchObject({ key: "worker", engine: "codex", model: "gpt-x", effort: "low" });
    expect((formToPayload(toRoles) as any).heads_engine).toBeNull();
    const back = switchPairMode({ ...toRoles, headsEngine: "", headsModel: "", headsEffort: "" }, "heads");
    expect(back).toMatchObject({ mode: "heads", headsEngine: "codex", headsModel: "gpt-x" });
    expect((formToPayload(back) as any).roles).toBeNull();
    expect(switchPairMode(heads, "heads")).toBe(heads);
  });
});

describe("settings", () => {
  const num = settingMeta("max_depth", 2);
  test("meta: kind from the default's type, enums and grouping from the table, unknown keys still work", () => {
    expect(num).toMatchObject({ kind: "number", group: "Subagents", min: 1 });
    expect(settingMeta("mcp_isolation", "strict")).toMatchObject({ kind: "enum", options: ["strict", "merge"] });
    expect(settingMeta("default_engine", "claude").kind).toBe("string");
    expect(settingMeta("port", 4477).restart).toBe(true);
    expect(settingMeta("something_new", 5)).toMatchObject({ kind: "number", group: "Other", label: "something_new" });
  });
  test("numbers: validated, bounded, integral", () => {
    expect(coerceSetting(num, " 3 ")).toEqual({ value: "3" });
    expect(coerceSetting(num, "")).toMatchObject({ value: null, error: "Enter a number." });
    expect(coerceSetting(num, "lots")).toMatchObject({ value: null, error: "Must be a number." });
    expect(coerceSetting(num, "2.5")).toMatchObject({ value: null, error: "Must be a whole number." });
    expect(coerceSetting(num, "0")).toMatchObject({ value: null, error: "At least 1." });
    expect(coerceSetting(num, "99")).toMatchObject({ value: null, error: "At most 6." });
    expect(coerceSetting(settingMeta("claude_max_turns", 0), "0")).toEqual({ value: "0" }); // 0 is meaningful: uncapped
  });
  test("enums accept only their options; free text keeps its whitespace and may be empty", () => {
    const iso = settingMeta("mcp_isolation", "strict");
    expect(coerceSetting(iso, "merge")).toEqual({ value: "merge" });
    expect(coerceSetting(iso, "sometimes").error).toMatch(/strict, merge/);
    const cmd = settingMeta("worktree_setup_cmd", "");
    expect(coerceSetting(cmd, "bun install --frozen-lockfile")).toEqual({ value: "bun install --frozen-lockfile" });
    expect(coerceSetting(cmd, "")).toEqual({ value: "" });
  });
  test("stepping clamps to the bounds and recovers from junk", () => {
    expect(stepSetting(num, "2", 1)).toBe("3");
    expect(stepSetting(num, "1", -1)).toBe("1");
    expect(stepSetting(num, "6", 1)).toBe("6");
    expect(stepSetting(num, "x", 1)).toBe("2");
  });
});

describe("daemon settings as toggles and search", () => {
  test("on/off settings are toggles; the rest keep their kind", () => {
    for (const key of ["computer_use", "agent_browser", "skills_link", "session_titles", "next_steps", "ask_model_override", "remote_allow_terminal"]) {
      expect(settingMeta(key, "off")).toMatchObject({ kind: "toggle", options: ["off", "on"] });
    }
    expect(settingMeta("codegraph", "auto")).toMatchObject({ kind: "toggle", options: ["off", "auto"] });
    expect(settingMeta("llm_provider", "off")).toMatchObject({ kind: "toggle", options: ["off", "ollama"] });
    expect(settingMeta("remote_mode", "off").kind).toBe("enum");
  });
  test("a toggle accepts only on or off", () => {
    const m = settingMeta("computer_use", "off");
    expect(coerceSetting(m, "on")).toEqual({ value: "on" });
    expect(coerceSetting(m, "off")).toEqual({ value: "off" });
    expect(coerceSetting(m, "maybe").error).toMatch(/off, on/);
  });
  test("search matches label, key, group and help, every word must match", () => {
    const row = { key: "computer_use", label: "Computer use (control the screen)", group: "Tools", help: "sessions get computer_* tools" };
    expect(settingMatches("screen", row)).toBe(true);
    expect(settingMatches("COMPUTER_USE", row)).toBe(true);
    expect(settingMatches("tools screen", row)).toBe(true);
    expect(settingMatches("screen browser", row)).toBe(false);
    expect(settingMatches("   ", row)).toBe(true);
  });
});

describe("role cards: preset text and agents", () => {
  const docs = PAIR_ROLE_LIBRARY.find((p) => p.id === "docs")!;
  const fromDocs = { key: "hermione", engine: "", model: "", effort: "", agent: "", instructions: docs.instructions, label: docs.label };

  test("a role keeps its preset when renamed: the label still names it", () => {
    expect(presetOfRole(fromDocs, PAIR_ROLE_LIBRARY)?.id).toBe("docs");
    expect(presetOfRole({ key: "docs", label: "" }, PAIR_ROLE_LIBRARY)?.id).toBe("docs");
    expect(presetOfRole({ key: "harry", label: "Wizard" }, PAIR_ROLE_LIBRARY)).toBeUndefined();
  });

  test("picking an agent drops the preset's untouched text, but keeps text the operator wrote", () => {
    expect(withAgent(fromDocs, "comment-sicko", docs)).toMatchObject({ agent: "comment-sicko", instructions: "" });
    const edited = { ...fromDocs, instructions: "Only touch docs/." };
    expect(withAgent(edited, "comment-sicko", docs).instructions).toBe("Only touch docs/.");
  });

  test("a saved role with an agent and the preset's text is flagged: the two are sent one after the other", () => {
    const saved = { ...fromDocs, agent: "comment-sicko" };
    expect(presetAgentConflict(saved, docs, "Comment sicko")).toContain("Docs preset's text");
    expect(presetAgentConflict({ ...saved, instructions: "" }, docs, "Comment sicko")).toBeNull();
    expect(presetAgentConflict(fromDocs, docs, null)).toBeNull(); // no agent: the preset text is the whole brief
  });
});
