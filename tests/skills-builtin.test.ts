import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { home, paths } from "../src/paths";
import { db } from "../src/db";
import { startServer } from "../src/daemon/server";
import { BUILTIN_SKILLS, BUILTIN_SOURCE, builtinSkills, builtinStatus, missingBuiltinSkills, resetBuiltinSkill, restoreBuiltinSkills, seedBuiltinSkills } from "../src/skills/builtin";
import { readPacks, type LoadedPack } from "../src/skills/packs";
import { parseSkillFrontmatter, SkillStore } from "../src/skills/store";
import { CANDIDATES_FILE } from "../src/treeboss/research";

const NAMES = ["design-discovery", "design-critique", "brand-extract", "clone-from-evidence", "product-teardown"];
/** Every built-in, the five above and the pack skills: what a fresh seed installs, in order. */
const ALL = (): string[] => builtinSkills().map((b) => b.name);
const TOKEN = "builtin-skills-token";

function clean(): void {
  db().exec("DELETE FROM skills");
  fs.rmSync(path.join(home(), "builtin-skills.json"), { force: true });
  for (const n of ALL()) fs.rmSync(path.join(paths.skills(), n), { recursive: true, force: true });
}

beforeEach(clean);
afterAll(clean);

describe("built-in skills", () => {
  test("ship with valid frontmatter and the shared design guidance", () => {
    expect(BUILTIN_SKILLS.map((b) => b.name)).toEqual(NAMES);
    for (const b of BUILTIN_SKILLS) {
      const fm = parseSkillFrontmatter(b.files["SKILL.md"]!);
      expect(fm.name).toBe(b.name);
      expect(fm.description).toBe(b.description);
      // A plain YAML scalar: no ": " or leading characters that would need quoting.
      expect(b.description).not.toMatch(/: |^[\[{&*!|>'"%@`#]/);
    }
    expect(BUILTIN_SKILLS[0]!.files["SKILL.md"]).toContain("At most five questions");
    expect(BUILTIN_SKILLS[1]!.files["SKILL.md"]).toContain("**Restraint**");
    expect(BUILTIN_SKILLS[2]!.files["SKILL.md"]).toContain("Extract, never guess");
    expect(BUILTIN_SKILLS[3]!.files["SKILL.md"]).toContain("evidence_capture_page");
    expect(BUILTIN_SKILLS[3]!.files["SKILL.md"]).toContain("Whose work is it?");
    expect(BUILTIN_SKILLS[4]!.files["SKILL.md"]).toContain(CANDIDATES_FILE);
    expect(BUILTIN_SKILLS[4]!.files["SKILL.md"]).toContain("investigation_start");
    expect(BUILTIN_SKILLS[4]!.files["SKILL.md"]).toContain("## After the pick");
  });

  test("are seeded once, enabled; a deleted one stays deleted until restored", () => {
    expect(seedBuiltinSkills()).toEqual(ALL());
    for (const n of NAMES) expect(SkillStore.get(n)).toMatchObject({ enabled: true, source: BUILTIN_SOURCE });
    expect(fs.existsSync(path.join(paths.skills(), "design-critique", "SKILL.md"))).toBe(true);
    expect(seedBuiltinSkills()).toEqual([]);
    SkillStore.remove("brand-extract");
    expect(seedBuiltinSkills()).toEqual([]);
    expect(missingBuiltinSkills()).toEqual(["brand-extract"]);
    expect(restoreBuiltinSkills()).toEqual(["brand-extract"]);
    expect(missingBuiltinSkills()).toEqual([]);
  });

  test("a skill of yours with the same name is never overwritten", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "trb-skill-"));
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: design-critique\ndescription: mine\n---\nMine.\n");
    SkillStore.add(src);
    expect(seedBuiltinSkills()).toEqual(ALL().filter((n) => n !== "design-critique"));
    const mine = SkillStore.get("design-critique")!;
    expect(mine.description).toBe("mine");
    expect(builtinStatus(mine)).toEqual({ builtin: false, modified: false, pack: null });
    expect(() => resetBuiltinSkill("design-critique")).toThrow(/you added/);
    expect(() => resetBuiltinSkill("nope")).toThrow(/ships with trb/);
  });

  test("edits show as modified; reset restores the text and keeps the enabled flag", () => {
    seedBuiltinSkills();
    const rec = SkillStore.get("design-discovery")!;
    expect(builtinStatus(rec)).toEqual({ builtin: true, modified: false, pack: null });
    fs.appendFileSync(path.join(rec.path, "SKILL.md"), "\nMy extra rule.\n");
    expect(builtinStatus(rec).modified).toBe(true);
    SkillStore.setEnabled("design-discovery", false);
    const back = resetBuiltinSkill("design-discovery");
    expect(back.enabled).toBe(false);
    expect(SkillStore.get("design-discovery")!.enabled).toBe(false);
    expect(builtinStatus(SkillStore.get("design-discovery")!).modified).toBe(false);
  });
});

describe("a built-in the list no longer names", () => {
  const gone = (name: string) => builtinSkills().filter((b) => b.name !== name);
  const seededNames = (): string[] => JSON.parse(fs.readFileSync(path.join(home(), "builtin-skills.json"), "utf-8")).seeded;

  test("an unedited copy is removed from the store and the disk", () => {
    seedBuiltinSkills();
    const dir = SkillStore.get("brand-extract")!.path;
    seedBuiltinSkills(gone("brand-extract"));
    expect(SkillStore.get("brand-extract")).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
    expect(seededNames()).not.toContain("brand-extract");
    expect(SkillStore.get("design-critique")).toBeTruthy();
  });

  test("an edited copy is kept and flagged retired", () => {
    seedBuiltinSkills();
    const rec = SkillStore.get("brand-extract")!;
    fs.appendFileSync(path.join(rec.path, "SKILL.md"), "\nMine.\n");
    seedBuiltinSkills(gone("brand-extract"));
    expect(fs.existsSync(path.join(rec.path, "SKILL.md"))).toBe(true);
    expect(SkillStore.get("brand-extract")).toBeTruthy();
    expect(seededNames()).toContain("brand-extract");
  });

  test("a skill of yours under another name is untouched", () => {
    seedBuiltinSkills();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "trb-skill-"));
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: my-own-skill\ndescription: mine\n---\nMine.\n");
    SkillStore.add(src);
    seedBuiltinSkills(gone("brand-extract"));
    expect(SkillStore.get("my-own-skill")).toBeTruthy();
    SkillStore.remove("my-own-skill");
  });

  test("a copy you replaced with a skill of yours is not removed", () => {
    seedBuiltinSkills();
    SkillStore.remove("brand-extract");
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "trb-skill-"));
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: brand-extract\ndescription: mine\n---\nMine.\n");
    SkillStore.add(src);
    seedBuiltinSkills(gone("brand-extract"));
    expect(SkillStore.get("brand-extract")?.description).toBe("mine");
  });

  test("seeding twice changes nothing more", () => {
    seedBuiltinSkills();
    fs.appendFileSync(path.join(SkillStore.get("design-critique")!.path, "SKILL.md"), "\nMine.\n");
    const list = builtinSkills().filter((b) => b.name !== "brand-extract" && b.name !== "design-critique");
    seedBuiltinSkills(list);
    const state = fs.readFileSync(path.join(home(), "builtin-skills.json"), "utf-8");
    const names = SkillStore.list().map((x) => x.name).sort();
    expect(seedBuiltinSkills(list)).toEqual([]);
    expect(fs.readFileSync(path.join(home(), "builtin-skills.json"), "utf-8")).toBe(state);
    expect(SkillStore.list().map((x) => x.name).sort()).toEqual(names);
  });

  test("builtinStatus flags a kept copy as retired", () => {
    seedBuiltinSkills();
    const rec = SkillStore.get("brand-extract")!;
    expect(builtinStatus(rec).retired).toBeUndefined();
    const fake = { ...rec, name: "dropped-skill" };
    expect(builtinStatus(fake)).toEqual({ builtin: false, modified: false, pack: null });
    const file = path.join(home(), "builtin-skills.json");
    const state = JSON.parse(fs.readFileSync(file, "utf-8"));
    state.origin["dropped-skill"] = "inline";
    fs.writeFileSync(file, JSON.stringify(state));
    expect(builtinStatus(fake)).toMatchObject({ builtin: true, modified: true, retired: true });
  });

  describe("when a pack does not load", () => {
    const packSkills = () => builtinSkills().filter((b) => b.pack);
    const withoutPacks = () => builtinSkills().filter((b) => !b.pack);
    const state = () => fs.readFileSync(path.join(home(), "builtin-skills.json"), "utf-8");
    const failures: Array<[string, () => LoadedPack[]]> = [
      ["a missing folder", () => readPacks(path.join(os.tmpdir(), "trb-no-such-packs"), () => {})],
      [
        "a broken pack.json",
        () => {
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "trb-packs-"));
          fs.mkdirSync(path.join(root, "pstack"));
          fs.writeFileSync(path.join(root, "pstack", "pack.json"), "{ not json");
          return readPacks(root, () => {});
        },
      ],
    ];

    for (const [label, loaded] of failures) {
      test(`${label} removes nothing and flags nothing`, () => {
        seedBuiltinSkills();
        expect(packSkills().length).toBeGreaterThan(0);
        const edited = SkillStore.get(packSkills()[0]!.name)!;
        fs.appendFileSync(path.join(edited.path, "SKILL.md"), "\nMine.\n");
        const before = state();
        seedBuiltinSkills(withoutPacks(), loaded);
        for (const b of packSkills()) expect(SkillStore.get(b.name)).toBeTruthy();
        expect(state()).toBe(before);
        expect(builtinStatus(edited).retired).toBeUndefined();
      });
    }

    test("a pack that loads and no longer lists a skill retires it", () => {
      seedBuiltinSkills();
      const [gone, ...rest] = packSkills();
      const pack = { dir: "x", manifest: { id: gone!.pack!, skills: rest.map((b) => b.name) } } as unknown as LoadedPack;
      seedBuiltinSkills(builtinSkills().filter((b) => b.name !== gone!.name), () => [pack]);
      expect(SkillStore.get(gone!.name)).toBeNull();
      expect(SkillStore.get(rest[0]!.name)).toBeTruthy();
    });
  });
});

describe("HTTP", () => {
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };

  test("list marks built-ins and what is missing; reset and restore", async () => {
    seedBuiltinSkills();
    SkillStore.remove("brand-extract");
    let r = await call("GET", "/api/skills");
    expect(r.data.skills.find((s: any) => s.name === "design-discovery")).toMatchObject({ builtin: true, modified: false });
    expect(r.data.missingBuiltins).toEqual(["brand-extract"]);
    fs.appendFileSync(path.join(paths.skills(), "design-critique", "SKILL.md"), "\nedit\n");
    r = await call("POST", "/api/skills/design-critique/reset");
    expect(r.data.skill).toMatchObject({ name: "design-critique", builtin: true, modified: false });
    expect((await call("POST", "/api/skills/nope/reset")).status).toBe(400);
    r = await call("POST", "/api/skills/restore-builtins");
    expect(r.data.added).toEqual(["brand-extract"]);
  });
});
