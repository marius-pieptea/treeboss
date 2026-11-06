import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START skills-builtin\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END skills-builtin\n"); });
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { home, paths } from "../src/paths";
import { db } from "../src/db";
import { startServer } from "../src/daemon/server";
import { BUILTIN_SKILLS, BUILTIN_SOURCE, builtinStatus, missingBuiltinSkills, resetBuiltinSkill, restoreBuiltinSkills, seedBuiltinSkills } from "../src/skills/builtin";
import { parseSkillFrontmatter, SkillStore } from "../src/skills/store";
import { CANDIDATES_FILE } from "../src/treeboss/research";

const NAMES = ["design-discovery", "design-critique", "brand-extract", "clone-from-evidence", "product-teardown"];
const TOKEN = "builtin-skills-token";

function clean(): void {
  db().exec("DELETE FROM skills");
  fs.rmSync(path.join(home(), "builtin-skills.json"), { force: true });
  for (const n of NAMES) fs.rmSync(path.join(paths.skills(), n), { recursive: true, force: true });
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
    expect(seedBuiltinSkills()).toEqual(NAMES);
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
    expect(seedBuiltinSkills()).toEqual(["design-discovery", "brand-extract", "clone-from-evidence", "product-teardown"]);
    const mine = SkillStore.get("design-critique")!;
    expect(mine.description).toBe("mine");
    expect(builtinStatus(mine)).toEqual({ builtin: false, modified: false });
    expect(() => resetBuiltinSkill("design-critique")).toThrow(/you added/);
    expect(() => resetBuiltinSkill("nope")).toThrow(/ships with trb/);
  });

  test("edits show as modified; reset restores the text and keeps the enabled flag", () => {
    seedBuiltinSkills();
    const rec = SkillStore.get("design-discovery")!;
    expect(builtinStatus(rec)).toEqual({ builtin: true, modified: false });
    fs.appendFileSync(path.join(rec.path, "SKILL.md"), "\nMy extra rule.\n");
    expect(builtinStatus(rec).modified).toBe(true);
    SkillStore.setEnabled("design-discovery", false);
    const back = resetBuiltinSkill("design-discovery");
    expect(back.enabled).toBe(false);
    expect(SkillStore.get("design-discovery")!.enabled).toBe(false);
    expect(builtinStatus(SkillStore.get("design-discovery")!).modified).toBe(false);
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
