import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { db } from "../src/db";
import { McpStore, buildRunMcpConfig } from "../src/mcp/store";
import { SkillStore, defaultSkillNames, materializeSkills, parseSkillFrontmatter } from "../src/skills/store";
import { sweepStaleRuns } from "../src/skills/scaffold";
import { paths } from "../src/paths";
import { spawnSync } from "child_process";
import { ENGINES } from "../src/engines/registry";
import { allSettings, getSetting, resetSetting, setSetting } from "../src/settings";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `trb-${p}-`));

beforeEach(() => {
  db().exec("DELETE FROM mcp_servers; DELETE FROM skills; DELETE FROM settings;");
});

describe("settings", () => {
  test("defaults, overrides and reset", () => {
    expect(getSetting("max_depth")).toBe(2);
    setSetting("max_depth", "3");
    expect(getSetting("max_depth")).toBe(3);
    expect(allSettings().find((s) => s.key === "max_depth")).toMatchObject({ custom: true, value: 3, default: 2 });
    resetSetting("max_depth");
    expect(getSetting("max_depth")).toBe(2);
  });
  test("unknown keys and bad values are refused", () => {
    expect(() => setSetting("nope", "1")).toThrow(/Unknown setting/);
    expect(() => setSetting("max_depth", "lots")).toThrow(/number/);
    expect(() => setSetting("mcp_isolation", "sometimes")).toThrow(/strict/);
  });
});

describe("mcp registry", () => {
  test("stdio and http servers round-trip", () => {
    McpStore.put({ name: "ctx", command: "npx", args: ["-y", "ctx-mcp"], env: { K: "v" } });
    McpStore.put({ name: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } });
    expect(McpStore.get("ctx")).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "ctx-mcp"], env: { K: "v" }, enabled: true });
    expect(McpStore.get("remote")).toMatchObject({ transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } });
  });

  test("validation: name charset, reserved name, command xor url, url scheme", () => {
    expect(() => McpStore.put({ name: "bad name!", command: "x" })).toThrow(/letters/);
    expect(() => McpStore.put({ name: "trb", command: "x" })).toThrow(/reserved/);
    expect(() => McpStore.put({ name: "a" })).toThrow(/command .* or a url/);
    expect(() => McpStore.put({ name: "a", command: "x", url: "https://y" })).toThrow(/not both/);
    expect(() => McpStore.put({ name: "a", url: "ftp://y" })).toThrow(/http/);
  });

  test("re-adding keeps the enabled flag; disabled servers are left out of a run", () => {
    McpStore.put({ name: "a", command: "x" });
    McpStore.put({ name: "b", command: "y" });
    McpStore.setEnabled("a", false);
    McpStore.put({ name: "a", command: "x2" });
    expect(McpStore.get("a")!.enabled).toBe(false);
    const cfg = buildRunMcpConfig({ sessionId: "s_1", subagents: false, daemonUrl: "http://x", token: "t" });
    expect(Object.keys(cfg)).toEqual(["b"]);
  });

  test("the trb server is added for sessions that may open subagents, and tells the shim who is calling", () => {
    const cfg = buildRunMcpConfig({ sessionId: "s_abc", subagents: true, daemonUrl: "http://127.0.0.1:9", token: "tok" });
    const trb = cfg.trb as any;
    expect(trb.type).toBe("stdio");
    expect(trb.args.at(-1)).toBe("mcp-serve");
    expect(trb.env).toMatchObject({ TRB_URL: "http://127.0.0.1:9", TRB_TOKEN: "tok", TRB_SESSION: "s_abc" });
  });

  test("import reads the common mcpServers shape, skipping duplicates and bad entries", () => {
    const file = path.join(tmp("imp"), "mcp.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { one: { command: "a", args: ["1"] }, two: { url: "https://h/mcp" }, bad: { nothing: true }, trb: { command: "x" } } }));
    McpStore.put({ name: "one", command: "existing" });
    const r = McpStore.importFile(file);
    expect(r.added).toEqual(["two"]);
    expect(r.skipped).toEqual(["one"]);
    expect(r.invalid.sort()).toEqual(["bad", "trb"]);
    expect(McpStore.get("one")!.command).toBe("existing");
    expect(McpStore.importFile(file, { overwrite: true }).added).toContain("one");
  });
});

describe("skills", () => {
  const makeSkill = (dir: string, name: string, desc: string, extra = true) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\nbody\n`);
    if (extra) fs.writeFileSync(path.join(d, "helper.sh"), "echo hi\n");
    return d;
  };

  test("frontmatter: plain, quoted and folded descriptions", () => {
    expect(parseSkillFrontmatter("---\nname: a\ndescription: \"quoted: yes\"\n---\nbody")).toMatchObject({ name: "a", description: "quoted: yes", body: "body" });
    expect(parseSkillFrontmatter("---\nname: a\ndescription: >\n  folded over\n  two lines\n---\nx").description).toBe("folded over two lines");
    expect(parseSkillFrontmatter("no frontmatter").body).toBe("no frontmatter");
  });

  test("add copies the whole directory into trb's store; the original can go away", () => {
    const src = makeSkill(tmp("sk"), "deploy", "Deploy things");
    const s = SkillStore.add(src);
    fs.rmSync(src, { recursive: true });
    expect(s.description).toBe("Deploy things");
    expect(fs.existsSync(path.join(s.path, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(s.path, "helper.sh"))).toBe(true);
    expect(() => SkillStore.add(makeSkill(tmp("sk"), "deploy", "again"))).toThrow(/already exists/);
    expect(SkillStore.add(makeSkill(tmp("sk"), "deploy", "again"), { overwrite: true }).description).toBe("again");
  });

  test("import registers every skill directory under a root", () => {
    const root = tmp("root");
    makeSkill(root, "one", "1");
    makeSkill(root, "two", "2");
    fs.mkdirSync(path.join(root, "not-a-skill"));
    expect(SkillStore.importDir(root).added.sort()).toEqual(["one", "two"]);
    expect(SkillStore.importDir(root).skipped.sort()).toEqual(["one", "two"]);
  });

  test("create scaffolds a SKILL.md; bad names are refused", () => {
    const s = SkillStore.create("my-skill", "does a thing");
    expect(fs.readFileSync(path.join(s.path, "SKILL.md"), "utf-8")).toContain("name: my-skill");
    expect(() => SkillStore.create("Bad Name", "x")).toThrow(/lowercase/);
  });

  test("materialize puts enabled skills where the engine looks, and cleanup leaves no trace", () => {
    SkillStore.add(makeSkill(tmp("sk"), "alpha", "A"));
    SkillStore.add(makeSkill(tmp("sk"), "beta", "B"));
    SkillStore.setEnabled("beta", false);
    const cwd = tmp("ws");
    const m = materializeSkills(ENGINES.claude, cwd);
    expect(m.names).toEqual(["alpha"]);
    expect(fs.existsSync(path.join(cwd, ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".claude", "skills", "beta"))).toBe(false);
    m.cleanup();
    expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false); // the dirs trb created are removed too
  });

  test("a skill directory that already exists in the workspace is the repo's own and is never touched", () => {
    SkillStore.add(makeSkill(tmp("sk"), "alpha", "from trb"));
    const cwd = tmp("ws");
    const own = path.join(cwd, ".claude", "skills", "alpha");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "SKILL.md"), "THE REPO'S OWN");
    materializeSkills(ENGINES.claude, cwd).cleanup();
    expect(fs.readFileSync(path.join(own, "SKILL.md"), "utf-8")).toBe("THE REPO'S OWN");
  });

  test("two concurrent turns in one workspace share the copy; the last to finish removes it", () => {
    SkillStore.add(makeSkill(tmp("sk"), "alpha", "A"));
    const cwd = tmp("ws");
    const a = materializeSkills(ENGINES.claude, cwd);
    const b = materializeSkills(ENGINES.claude, cwd);
    a.cleanup();
    expect(fs.existsSync(path.join(cwd, ".claude", "skills", "alpha"))).toBe(true); // b still needs it
    b.cleanup();
    expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
  });

  test("the default set follows default_skills: all by default, built-ins, none or names", () => {
    SkillStore.add(makeSkill(tmp("sk"), "alpha", "A"));
    SkillStore.add(makeSkill(tmp("sk"), "beta", "B"));
    db().prepare("UPDATE skills SET source = 'trb:builtin' WHERE name = 'beta'").run();
    expect(defaultSkillNames().sort()).toEqual(["alpha", "beta"]);
    setSetting("default_skills", "builtin");
    expect(defaultSkillNames()).toEqual(["beta"]);
    setSetting("default_skills", "none");
    expect(defaultSkillNames()).toEqual([]);
    setSetting("default_skills", "builtin, alpha");
    expect(defaultSkillNames().sort()).toEqual(["alpha", "beta"]);
    expect(() => setSetting("default_skills", "Not A Name")).toThrow(/skill name/);
    expect(() => setSetting("skills_link", "maybe")).toThrow(/on" or "off/);
  });

  test("an engine whose skills are listed in the prompt gets only the built-ins from `all`, not the whole library", () => {
    SkillStore.add(makeSkill(tmp("sk"), "alpha", "A"));
    SkillStore.add(makeSkill(tmp("sk"), "beta", "B"));
    db().prepare("UPDATE skills SET source = 'trb:builtin' WHERE name = 'beta'").run();
    expect(defaultSkillNames(ENGINES.opencode)).toEqual(["beta"]);
    expect(defaultSkillNames(ENGINES.claude).sort()).toEqual(["alpha", "beta"]);
  });

  test("skills are linked, not copied; cleanup removes the link and never the skill store", () => {
    const src = makeSkill(tmp("sk"), "alpha", "A");
    const rec = SkillStore.add(src);
    const cwd = tmp("ws");
    const m = materializeSkills(ENGINES.claude, cwd);
    const dest = path.join(cwd, ".claude", "skills", "alpha");
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf-8")).toContain("alpha");
    m.cleanup();
    expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(rec.path, "SKILL.md"))).toBe(true); // the store is untouched
  });

  test("skills_link off copies real files", () => {
    SkillStore.add(makeSkill(tmp("sk"), "alpha", "A"));
    setSetting("skills_link", "off");
    const cwd = tmp("ws");
    const m = materializeSkills(ENGINES.claude, cwd);
    expect(fs.lstatSync(path.join(cwd, ".claude", "skills", "alpha")).isSymbolicLink()).toBe(false);
    m.cleanup();
    expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
  });

  test("a dangling link already there is not ours and is left alone", () => {
    SkillStore.add(makeSkill(tmp("sk"), "alpha", "A"));
    const cwd = tmp("ws");
    const dest = path.join(cwd, ".claude", "skills", "alpha");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync("/nonexistent/target", dest);
    const m = materializeSkills(ENGINES.claude, cwd);
    expect(m.names).toEqual(["alpha"]);
    m.cleanup();
    expect(fs.readlinkSync(dest)).toBe("/nonexistent/target");
  });

  test("while skills are in a repo git ignores just those folders, and the exclude entry goes with them", () => {
    SkillStore.add(makeSkill(tmp("sk"), "alpha", "A"));
    const cwd = tmp("ws");
    spawnSync("git", ["init", "-q"], { cwd });
    fs.mkdirSync(path.join(cwd, ".claude", "skills", "mine"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "mine", "SKILL.md"), "mine");
    const untracked = () => spawnSync("git", ["status", "--porcelain", "-uall"], { cwd, encoding: "utf-8" }).stdout;
    const m = materializeSkills(ENGINES.claude, cwd);
    expect(untracked()).toContain(".claude/skills/mine/SKILL.md"); // the user's own skill stays visible
    expect(untracked()).not.toContain("alpha"); // a link to a folder, which git would otherwise list as an untracked file
    m.cleanup();
    expect(fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8")).not.toContain("trb skills");
    expect(fs.existsSync(path.join(cwd, ".claude", "skills", "mine"))).toBe(true);
  });

  test("a daemon killed mid-turn leaves nothing behind: the next start sweeps the copies and the exclude entry", () => {
    SkillStore.add(makeSkill(tmp("sk"), "alpha", "A"));
    const cwd = tmp("ws");
    spawnSync("git", ["init", "-q"], { cwd });
    materializeSkills(ENGINES.claude, cwd); // never cleaned up: the process "died"
    expect(fs.existsSync(path.join(cwd, ".claude", "skills", "alpha"))).toBe(true);
    expect(fs.readdirSync(paths.skillRuns()).length).toBeGreaterThan(0);
    expect(sweepStaleRuns()).toBe(1);
    expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
    expect(fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8")).not.toContain("trb skills");
    expect(fs.readdirSync(paths.skillRuns())).toEqual([]);
  });

  test("an engine with no skills directory gets an index in the prompt, not a directory it would never read", () => {
    SkillStore.add(makeSkill(tmp("sk"), "alpha", "Does A"));
    const cwd = tmp("ws");
    const m = materializeSkills(ENGINES.opencode, cwd);
    expect(m.promptBlock).toContain("alpha: Does A");
    expect(m.promptBlock).toContain("SKILL.md");
    expect(fs.readdirSync(cwd)).toEqual([]);
  });
});
