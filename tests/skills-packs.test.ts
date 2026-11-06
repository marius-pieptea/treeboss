import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { home, paths } from "../src/paths";
import { db } from "../src/db";
import { startServer } from "../src/daemon/server";
import { BUILTIN_SOURCE, builtinSkills, builtinStatus, contentHash, missingBuiltinSkills, resetBuiltinSkill, restoreBuiltinSkills, seedBuiltinSkills } from "../src/skills/builtin";
import { loadPacks, packSkillNames, packsRoot, readPacks, verifyPackFiles } from "../src/skills/packs";
import { parseSkillFrontmatter, SkillStore } from "../src/skills/store";
import { walkSkillDir } from "../src/skills/files";
import { BUILTIN_AGENTS } from "../src/agents/builtin";
import { PAIR_COOKBOOK } from "../src/hydra/pairs";
import { PAIR_ROLE_LIBRARY } from "../src/hydra/roles";
import { SUBAGENT_TOOL_NAMES } from "../src/sessions/tools";

const PACKS = path.resolve(import.meta.dir, "..", "src", "skills", "packs");
const PSTACK = path.join(PACKS, "pstack");
const PACK_JSON = JSON.parse(fs.readFileSync(path.join(PSTACK, "pack.json"), "utf-8"));
/** The vendored skills the pack lists (under skills/), then the skills written here (under local/): what the loader returns. */
const LISTED: string[] = PACK_JSON.skills;
const LOCAL: string[] = PACK_JSON.local ?? [];
const SHIPPED: string[] = [...LISTED, ...LOCAL];
/** The two Hydra recipes built on pstack, and the recipe each id names. */
const PSTACK_RECIPES = ["pstack-claude", "pstack-claude-codex"];
const recipe = (id: string) => PAIR_COOKBOOK.find((r) => r.id === id)!;
/** A checkout with core.autocrlf keeps CRLF on disk; the loader reads LF, so compare against LF. */
const lf = (text: string): string => text.replace(/\r\n/g, "\n");
const STATE = () => path.join(home(), "builtin-skills.json");
const ALL = (): string[] => builtinSkills().map((b) => b.name);
const TOKEN = "skills-packs-token";

function clean(): void {
  db().exec("DELETE FROM skills");
  fs.rmSync(STATE(), { force: true });
  for (const n of ALL()) fs.rmSync(path.join(paths.skills(), n), { recursive: true, force: true });
}

beforeEach(clean);
afterAll(clean);

/** A skill folder with a SKILL.md, the way a pack ships one. */
function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} from a test pack\n---\n\nBody.\n`);
}

/** A pack root in a temp dir: each key is a pack folder, its value the pack.json (a string is written as it is). */
function packRoot(packs: Record<string, object | string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trb-packs-"));
  for (const [dir, manifest] of Object.entries(packs)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "pack.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  return root;
}

/** The built-ins as a new trb would ship them: the same list, with one skill's SKILL.md changed. */
function shipping(name: string, edit: (text: string) => string): ReturnType<typeof builtinSkills> {
  return builtinSkills().map((b) => (b.name === name ? { ...b, files: { ...b.files, "SKILL.md": edit(b.files["SKILL.md"]!) } } : b));
}

describe("the pstack pack", () => {
  test("loads every skill it lists, with the subfolders each one has", () => {
    const loaded = loadPacks(PACKS).filter((b) => b.pack === "pstack");
    expect(loaded.map((b) => b.name)).toEqual(SHIPPED);
    const mode = loaded.find((b) => b.name === "poteto-mode")!;
    const playbooks = fs.readdirSync(path.join(PSTACK, "skills", "poteto-mode", "playbooks"));
    expect(playbooks.length).toBeGreaterThan(0);
    for (const f of playbooks) {
      expect(mode.files[`playbooks/${f}`]).toBe(lf(fs.readFileSync(path.join(PSTACK, "skills", "poteto-mode", "playbooks", f), "utf-8")));
    }
    expect(mode.description).toBe(parseSkillFrontmatter(mode.files["SKILL.md"]!).description ?? "");
  });

  test("the manifest reader names the skills the loader ships, vendored then local", () => {
    const manifest = readPacks(PACKS).find((p) => p.manifest.id === "pstack")!.manifest;
    expect(packSkillNames(manifest)).toEqual(SHIPPED);
  });

  test("each skill's frontmatter names its folder, and its text has LF line endings", () => {
    for (const b of loadPacks(PACKS)) {
      expect(parseSkillFrontmatter(b.files["SKILL.md"]!).name).toBe(b.name);
      expect(b.description.length).toBeGreaterThan(0);
      for (const text of Object.values(b.files)) expect(text).not.toContain("\r");
    }
  });

  test("ships from the source tree when run from a checkout", () => {
    expect(packsRoot()).toBe(PACKS);
    expect(loadPacks().filter((b) => b.pack === "pstack").map((b) => b.name)).toEqual(SHIPPED);
  });

  test("the curated list drops two skills and the statechart test corpus", () => {
    const names = loadPacks(PACKS).map((b) => b.name);
    expect(names).not.toContain("setup-pstack");
    expect(names).not.toContain("make-bot-ui");
    const statechart = Object.keys(loadPacks(PACKS).find((b) => b.name === "statechart")!.files);
    expect(statechart.some((f) => f.startsWith("scripts/test/"))).toBe(false);
    expect(statechart).toContain("scripts/statechart");
  });

  test("every skill the pack lists has its folder with a SKILL.md, vendored or local", () => {
    for (const name of LISTED) expect(fs.existsSync(path.join(PSTACK, "skills", name, "SKILL.md"))).toBe(true);
    for (const name of LOCAL) expect(fs.existsSync(path.join(PSTACK, "local", name, "SKILL.md"))).toBe(true);
  });

  test("the treeboss adapter ships as a local skill, with the upstream reference beside it", () => {
    const adapter = loadPacks(PACKS).find((b) => b.name === "pstack-treeboss")!;
    expect(adapter.pack).toBe("pstack");
    expect(adapter.description).toBe(
      "How to run pstack (poteto-mode and its skills) inside treeboss: where the skill files are, how pstack's Cursor names map to treeboss heads, roles and tools, and which steps treeboss skips. Read it before following any pstack playbook.",
    );
    expect(Object.keys(adapter.files).sort()).toEqual(["SKILL.md", "references/claude-code-adapter.md"]);
    expect(adapter.files["SKILL.md"]!.split("\n").length).toBeLessThan(150);
    const frontmatter = adapter.files["SKILL.md"]!.split("---")[1]!;
    expect(frontmatter.match(/^[a-z-]+(?=:)/gm)).toEqual(["name", "description"]);
    expect(frontmatter).not.toContain("disable-model-invocation");
    expect(adapter.files["references/claude-code-adapter.md"]!.split("\n")[0]).toContain("Lauren Tan, MIT");
  });

  test("the adapter names only subagent tools, Hydra roles and built-in agents that treeboss has", () => {
    const text = loadPacks(PACKS).find((b) => b.name === "pstack-treeboss")!.files["SKILL.md"]!;
    // `subagent_type` is Cursor's field name in the mapping table, not a tool: the lookahead leaves it out.
    for (const tool of new Set(text.match(/subagent_(?!type\b)[a-z]+/g) ?? [])) expect(SUBAGENT_TOOL_NAMES).toContain(tool as (typeof SUBAGENT_TOOL_NAMES)[number]);
    // The adapter writes each role and agent as the parameter subagent_create takes: `role: <id>` and `agent: <name>`.
    const named = (key: "role" | "agent") => [...text.matchAll(new RegExp(`\`${key}: ([a-z-]+)\``, "g"))].map((m) => m[1]!);
    const roles = new Set([...PAIR_ROLE_LIBRARY.map((r) => r.id), ...PSTACK_RECIPES.flatMap((id) => Object.keys(recipe(id).roles ?? {}))]);
    const agents = new Set(BUILTIN_AGENTS.map((a) => a.name));
    expect(named("role").length).toBeGreaterThan(0);
    expect(named("agent").length).toBeGreaterThan(0);
    expect(named("role").filter((r) => !roles.has(r))).toEqual([]);
    expect(named("agent").filter((a) => !agents.has(a))).toEqual([]);
  });

  test("the adapter's pstack table gives each recipe role the agent the recipe runs it as", () => {
    const text = loadPacks(PACKS).find((b) => b.name === "pstack-treeboss")!.files["SKILL.md"]!;
    for (const id of PSTACK_RECIPES) {
      for (const [role, cfg] of Object.entries(recipe(id).roles ?? {})) expect(text).toContain(`| \`role: ${role}\` | \`agent: ${cfg.agent}\` |`);
    }
  });

  test("the adapter names only CLI commands that treeboss has", () => {
    const text = loadPacks(PACKS).find((b) => b.name === "pstack-treeboss")!.files["SKILL.md"]!;
    const cli = fs.readFileSync(path.resolve(import.meta.dir, "..", "src", "cli", "main.ts"), "utf-8");
    const named = [...text.matchAll(/`trb ([a-z]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const cmd of new Set(named)) expect(cli).toContain(`case "${cmd}":`);
  });

  test.skipIf(process.platform === "win32")("keeps the executable scripts executable", () => {
    const mode = loadPacks(PACKS).find((b) => b.name === "poteto-mode")!;
    expect(mode.executable).toContain("scripts/worktree-audit.sh");
  });
});

describe("loading packs", () => {
  test("a pack that is broken, has no manifest or names a skill outside itself is skipped; the rest load", () => {
    const root = packRoot({
      broken: '{"id": "broken", "skills": [',
      unsafe: { id: "unsafe", title: "u", version: "1", author: "a", license: "MIT", upstream: "u", commit: "c", skills: ["../escape"] },
      good: { id: "good", title: "g", version: "1", author: "a", license: "MIT", upstream: "u", commit: "c", skills: ["one", "absent"] },
    });
    fs.mkdirSync(path.join(root, "nomanifest"));
    writeSkill(path.join(root, "good", "skills", "one"), "one");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = loadPacks(root);
      expect(loaded.map((b) => [b.pack, b.name])).toEqual([["good", "one"]]);
      // broken, unsafe, nomanifest, and the listed folder that is not there
      expect(warn.mock.calls.length).toBe(4);
    } finally {
      warn.mockRestore();
    }
  });

  test("what a skill folder leaves out (dependencies, version control) is said, not silently dropped", () => {
    const root = packRoot({
      good: { id: "good", title: "g", version: "1", author: "a", license: "MIT", upstream: "u", commit: "c", skills: ["one"] },
    });
    writeSkill(path.join(root, "good", "skills", "one"), "one");
    fs.mkdirSync(path.join(root, "good", "skills", "one", "node_modules"));
    fs.writeFileSync(path.join(root, "good", "skills", "one", "node_modules", "x.js"), "x");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const [one] = loadPacks(root);
      expect(Object.keys(one!.files)).toEqual(["SKILL.md"]);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("leaves out node_modules");
    } finally {
      warn.mockRestore();
    }
  });

  test("exclude globs drop matching files from a skill folder and keep the rest", () => {
    const root = packRoot({
      good: { id: "good", title: "g", version: "1", author: "a", license: "MIT", upstream: "u", commit: "c", skills: ["one"], exclude: ["one/scripts/test/**"] },
    });
    writeSkill(path.join(root, "good", "skills", "one"), "one");
    fs.mkdirSync(path.join(root, "good", "skills", "one", "scripts", "test", "corpus"), { recursive: true });
    fs.writeFileSync(path.join(root, "good", "skills", "one", "scripts", "test", "corpus", "a.out"), "x");
    fs.writeFileSync(path.join(root, "good", "skills", "one", "scripts", "keep.txt"), "y");
    const [one] = loadPacks(root);
    expect(Object.keys(one!.files).sort()).toEqual(["SKILL.md", "scripts/keep.txt"]);
  });

  test("a root that is not there gives nothing rather than throwing", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadPacks(path.join(os.tmpdir(), "trb-no-such-packs"))).toEqual([]);
      expect(loadPacks(null)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("TRB_PACKS_DIR names the packs when set (the desktop app sets it)", () => {
    const root = packRoot({});
    process.env.TRB_PACKS_DIR = root;
    try {
      expect(packsRoot()).toBe(path.resolve(root));
    } finally {
      delete process.env.TRB_PACKS_DIR;
    }
  });
});

describe("seeding and updates", () => {
  test("installs a pack skill with its subfolders, enabled, as a built-in", () => {
    seedBuiltinSkills();
    expect(fs.existsSync(path.join(paths.skills(), "poteto-mode", "playbooks", "bug-fix.md"))).toBe(true);
    const rec = SkillStore.get("poteto-mode")!;
    expect(rec).toMatchObject({ enabled: true, source: BUILTIN_SOURCE });
    expect(builtinStatus(rec)).toEqual({ builtin: true, modified: false, pack: "pstack" });
  });

  test("a skill of yours with a pack skill's name is never overwritten", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "trb-skill-"));
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: tdd\ndescription: mine\n---\nMine.\n");
    SkillStore.add(src);
    seedBuiltinSkills();
    const mine = SkillStore.get("tdd")!;
    expect(mine.description).toBe("mine");
    expect(builtinStatus(mine)).toEqual({ builtin: false, modified: false, pack: null });
    expect(fs.readFileSync(path.join(mine.path, "SKILL.md"), "utf-8")).toContain("Mine.");
    expect(() => resetBuiltinSkill("tdd")).toThrow(/you added/);
  });

  test("reset puts an edited pack skill back, subfolders and all", () => {
    seedBuiltinSkills();
    const rec = SkillStore.get("poteto-mode")!;
    const bug = path.join(rec.path, "playbooks", "bug-fix.md");
    fs.appendFileSync(bug, "\nmy own line\n");
    expect(builtinStatus(rec).modified).toBe(true);
    resetBuiltinSkill("poteto-mode");
    expect(fs.readFileSync(bug, "utf-8")).toBe(lf(fs.readFileSync(path.join(PSTACK, "skills", "poteto-mode", "playbooks", "bug-fix.md"), "utf-8")));
    expect(builtinStatus(SkillStore.get("poteto-mode")!).modified).toBe(false);
  });

  test("an unedited copy follows the text a later trb ships, and keeps its enabled flag", () => {
    seedBuiltinSkills();
    SkillStore.setEnabled("poteto-mode", false);
    const next = shipping("poteto-mode", (t) => `${t}\nA rule added upstream later.\n`);
    expect(seedBuiltinSkills(next)).toEqual([]);
    const rec = SkillStore.get("poteto-mode")!;
    expect(fs.readFileSync(path.join(rec.path, "SKILL.md"), "utf-8")).toContain("A rule added upstream later.");
    expect(rec.enabled).toBe(false);
    expect(JSON.parse(fs.readFileSync(STATE(), "utf-8")).hashes["poteto-mode"]).toBe(contentHash(next.find((b) => b.name === "poteto-mode")!.files));
    expect(seedBuiltinSkills(next)).toEqual([]);
  });

  test("an edited copy is left alone and shows as modified", () => {
    seedBuiltinSkills();
    const rec = SkillStore.get("poteto-mode")!;
    fs.appendFileSync(path.join(rec.path, "SKILL.md"), "\nmy edit\n");
    const next = shipping("poteto-mode", (t) => `${t}\nA rule added upstream later.\n`);
    expect(seedBuiltinSkills(next)).toEqual([]);
    const text = fs.readFileSync(path.join(rec.path, "SKILL.md"), "utf-8");
    expect(text).toContain("my edit");
    expect(text).not.toContain("A rule added upstream later.");
    expect(builtinStatus(rec).modified).toBe(true);
  });

  test("a copy you edited and then put back by hand is updated like an unedited one", () => {
    seedBuiltinSkills();
    const rec = SkillStore.get("poteto-mode")!;
    const original = fs.readFileSync(path.join(rec.path, "SKILL.md"), "utf-8");
    fs.appendFileSync(path.join(rec.path, "SKILL.md"), "\nmy edit\n");
    fs.writeFileSync(path.join(rec.path, "SKILL.md"), original);
    seedBuiltinSkills(shipping("poteto-mode", (t) => `${t}\nA rule added upstream later.\n`));
    expect(fs.readFileSync(path.join(rec.path, "SKILL.md"), "utf-8")).toContain("A rule added upstream later.");
  });

  test("a pack skill you deleted stays deleted until restored", () => {
    seedBuiltinSkills();
    SkillStore.remove("tdd");
    expect(seedBuiltinSkills()).toEqual([]);
    expect(missingBuiltinSkills()).toEqual(["tdd"]);
    expect(restoreBuiltinSkills()).toEqual(["tdd"]);
    expect(SkillStore.get("tdd")).toMatchObject({ enabled: true, source: BUILTIN_SOURCE });
  });

  test("a state file from before digests were kept still works, and gains them for unedited copies", () => {
    seedBuiltinSkills();
    fs.writeFileSync(STATE(), JSON.stringify({ seeded: ALL() }, null, 2));
    expect(seedBuiltinSkills()).toEqual([]);
    expect(Object.keys(JSON.parse(fs.readFileSync(STATE(), "utf-8")).hashes).sort()).toEqual([...ALL()].sort());
  });

  test("an old state file does not vouch for a copy you edited", () => {
    seedBuiltinSkills();
    fs.writeFileSync(STATE(), JSON.stringify({ seeded: ALL() }));
    const rec = SkillStore.get("poteto-mode")!;
    fs.appendFileSync(path.join(rec.path, "SKILL.md"), "\nmine\n");
    seedBuiltinSkills();
    expect(JSON.parse(fs.readFileSync(STATE(), "utf-8")).hashes?.["poteto-mode"]).toBeUndefined();
    expect(builtinStatus(rec).modified).toBe(true);
  });

  test("a digest ignores line endings", () => {
    expect(contentHash({ "SKILL.md": "a\r\nb\r\n" })).toBe(contentHash({ "SKILL.md": "a\nb\n" }));
    expect(contentHash({ "SKILL.md": "a\n" })).not.toBe(contentHash({ "SKILL.md": "b\n" }));
  });
});

describe("status", () => {
  /** Moves a folder's files a minute into the past, so a status read remembers them (builtin.ts does not trust files written moments ago). */
  function ageFolder(dir: string): void {
    const past = new Date(Date.now() - 60_000);
    for (const f of walkSkillDir(dir).files) fs.utimesSync(f.abs, past, past);
  }

  test("an edit after a status is read still flips modified, and a reset flips it back", () => {
    seedBuiltinSkills();
    const rec = SkillStore.get("poteto-mode")!;
    ageFolder(rec.path);
    expect(builtinStatus(rec).modified).toBe(false);
    expect(builtinStatus(rec).modified).toBe(false);
    fs.appendFileSync(path.join(rec.path, "SKILL.md"), "\nmy edit\n");
    expect(builtinStatus(rec).modified).toBe(true);
    resetBuiltinSkill("poteto-mode");
    expect(builtinStatus(SkillStore.get("poteto-mode")!).modified).toBe(false);
  });

  test("a same-size edit in the same clock tick as the last write is seen", () => {
    // Timestamps here move in coarse steps. A one-file skill reads fast enough that the next write still shares its step.
    seedBuiltinSkills();
    const rec = SkillStore.get("design-critique")!;
    const skill = path.join(rec.path, "SKILL.md");
    const shipped = fs.readFileSync(skill, "utf-8");
    const edited = shipped.replace("a", "b");
    expect(edited.length).toBe(shipped.length);
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(skill, edited);
      expect(builtinStatus(rec).modified).toBe(true);
      fs.writeFileSync(skill, shipped);
      expect(builtinStatus(rec).modified).toBe(false);
    }
  });

  test("an unchanged installed copy is not read again for its status", () => {
    seedBuiltinSkills();
    const rec = SkillStore.get("poteto-mode")!;
    ageFolder(rec.path);
    expect(builtinStatus(rec).modified).toBe(false);
    const read = spyOn(fs, "readFileSync");
    try {
      expect(builtinStatus(rec).modified).toBe(false);
      expect(read.mock.calls.filter((c) => String(c[0]).startsWith(rec.path)).length).toBe(0);
    } finally {
      read.mockRestore();
    }
  });
});

describe("HTTP", () => {
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());

  test("the skill list says which pack each built-in came from", async () => {
    seedBuiltinSkills();
    const res = await fetch(`${srv.url}/api/skills`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await res.json();
    expect(body.skills.find((s: any) => s.name === "poteto-mode")).toMatchObject({ builtin: true, modified: false, pack: "pstack" });
    expect(body.skills.find((s: any) => s.name === "design-critique")).toMatchObject({ builtin: true, modified: false, pack: null });
  });
});

describe("vendored file integrity (FR-004)", () => {
  /** A copy of the real pack in a temp folder, to damage without touching the repo. */
  function copyPack(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-pack-"));
    fs.cpSync(PSTACK, dir, { recursive: true });
    return dir;
  }
  const manifestOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "pack.json"), "utf-8"));

  test("the shipped pack matches its recorded hashes", () => {
    expect(verifyPackFiles(PSTACK, PACK_JSON)).toEqual([]);
  });

  test("a changed vendored file fails, naming the file", () => {
    const dir = copyPack();
    try {
      fs.appendFileSync(path.join(dir, "skills", "poteto-mode", "SKILL.md"), "\ntampered\n");
      expect(verifyPackFiles(dir, manifestOf(dir))).toEqual(["skills/poteto-mode/SKILL.md differs from its recorded hash"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CRLF on disk does not count as a change", () => {
    const dir = copyPack();
    try {
      const file = path.join(dir, "skills", "poteto-mode", "SKILL.md");
      fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace(/\n/g, "\r\n"));
      expect(verifyPackFiles(dir, manifestOf(dir))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an excluded file or an unlisted skill folder fails, naming the file", () => {
    const dir = copyPack();
    try {
      const corpus = path.join(dir, "skills", "statechart", "scripts", "test", "case.md");
      fs.mkdirSync(path.dirname(corpus), { recursive: true });
      fs.writeFileSync(corpus, "x\n");
      fs.mkdirSync(path.join(dir, "skills", "setup-pstack"));
      fs.writeFileSync(path.join(dir, "skills", "setup-pstack", "SKILL.md"), "---\nname: setup-pstack\n---\n");
      expect(verifyPackFiles(dir, manifestOf(dir)).sort()).toEqual([
        "skills/setup-pstack/SKILL.md is not recorded in pack.json hashes",
        "skills/statechart/scripts/test/case.md is excluded by pack.json but is present",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a deleted vendored file fails, naming the file", () => {
    const dir = copyPack();
    try {
      fs.rmSync(path.join(dir, "LICENSE"));
      expect(verifyPackFiles(dir, manifestOf(dir))).toEqual(["LICENSE is recorded in pack.json hashes but missing"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
