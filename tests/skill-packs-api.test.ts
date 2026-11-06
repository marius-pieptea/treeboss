import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { home, paths } from "../src/paths";
import { db } from "../src/db";
import { startServer } from "../src/daemon/server";
import { BUILTIN_SOURCE, builtinSkills, seedBuiltinSkills } from "../src/skills/builtin";
import { packSkillNames, readPacks } from "../src/skills/packs";
import { SkillStore } from "../src/skills/store";

const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
/** The pstack manifest, and every skill it lists (vendored, then local), as the reader the API uses gives them. */
const MANIFEST = readPacks().find((p) => p.manifest.id === "pstack")!.manifest;
const LISTED: string[] = packSkillNames(MANIFEST);
const TOKEN = "skill-packs-api-token";
const ALL = (): string[] => builtinSkills().map((b) => b.name);

function clean(): void {
  db().exec("DELETE FROM skills");
  fs.rmSync(path.join(home(), "builtin-skills.json"), { force: true });
  for (const n of ALL()) fs.rmSync(path.join(paths.skills(), n), { recursive: true, force: true });
}

beforeEach(clean);
afterAll(clean);

describe("skill packs over HTTP", () => {
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());

  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const pack = async (): Promise<any> => (await call("GET", "/api/skills/packs")).body.find((p: any) => p.id === "pstack");

  test("the list names each pack from its manifest, with its counts; nothing is installed before the built-ins are seeded", async () => {
    const r = await call("GET", "/api/skills/packs");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(await pack()).toMatchObject({ id: MANIFEST.id, title: MANIFEST.title, version: MANIFEST.version, author: MANIFEST.author, license: MANIFEST.license, upstream: MANIFEST.upstream, commit: MANIFEST.commit, skills: LISTED, installed: 0, enabled: 0 });
  });

  test("the skills it lists are the vendored ones and the local ones, so the adapter is counted too", async () => {
    expect(LISTED).toContain("pstack-treeboss");
    expect((await pack()).skills).toContain("pstack-treeboss");
  });

  test("seeding installs every listed skill, and the counts follow", async () => {
    seedBuiltinSkills();
    expect(await pack()).toMatchObject({ installed: LISTED.length, enabled: LISTED.length });
  });

  test("off turns off the pack's installed skills and nothing else; on turns them back on", async () => {
    seedBuiltinSkills();
    const off = await call("POST", "/api/skills/packs/pstack/enabled", { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ id: "pstack", installed: LISTED.length, enabled: 0 });
    for (const n of LISTED) expect(SkillStore.get(n)!.enabled).toBe(false);
    expect(SkillStore.get("design-critique")).toMatchObject({ enabled: true, source: BUILTIN_SOURCE });
    expect(await pack()).toMatchObject({ installed: LISTED.length, enabled: 0 });

    const on = await call("POST", "/api/skills/packs/pstack/enabled", { enabled: true });
    expect(on.body).toEqual({ id: "pstack", installed: LISTED.length, enabled: LISTED.length });
    for (const n of LISTED) expect(SkillStore.get(n)!.enabled).toBe(true);
  });

  test("an unknown pack is a 404 and a body without a boolean is a 400; nothing changes", async () => {
    seedBuiltinSkills();
    expect((await call("POST", "/api/skills/packs/nope/enabled", { enabled: false })).status).toBe(404);
    expect((await call("POST", "/api/skills/packs/pstack/enabled", { enabled: "no" })).status).toBe(400);
    expect((await call("POST", "/api/skills/packs/pstack/enabled", {})).status).toBe(400);
    expect(SkillStore.get("architect")!.enabled).toBe(true);
  });

  test("a skill of yours with a pack skill's name is not counted and is not switched", async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "trb-skill-"));
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: tdd\ndescription: mine\n---\nMine.\n");
    SkillStore.add(src);
    seedBuiltinSkills();
    expect(await pack()).toMatchObject({ installed: LISTED.length - 1, enabled: LISTED.length - 1 });
    await call("POST", "/api/skills/packs/pstack/enabled", { enabled: false });
    expect(SkillStore.get("tdd")).toMatchObject({ enabled: true, description: "mine" });
    expect(SkillStore.get("tdd")!.source).not.toBe(BUILTIN_SOURCE);
    expect(SkillStore.get("architect")!.enabled).toBe(false);
  });

  test("a pack skill you deleted is not switched back on by the pack", async () => {
    seedBuiltinSkills();
    SkillStore.remove("architect");
    expect(await pack()).toMatchObject({ installed: LISTED.length - 1 });
    await call("POST", "/api/skills/packs/pstack/enabled", { enabled: true });
    expect(SkillStore.get("architect")).toBeNull();
    expect(SkillStore.get("tdd")!.enabled).toBe(true);
  });
});

describe("skill packs from the command line", () => {
  /** A real `trb` process on the same home as this test: the skill commands edit the database directly, no daemon needed. */
  async function trb(args: string[]) {
    const proc = Bun.spawn(["bun", "run", MAIN, ...args], { cwd: os.tmpdir(), env: { ...process.env, NO_COLOR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  test("trb skill packs lists the pack; trb skill pack <id> on|off switches it", async () => {
    seedBuiltinSkills();
    const n = LISTED.length;
    const list = await trb(["skill", "packs"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`pstack\\s+${MANIFEST.version.replace(/\./g, "\\.")}\\s+MIT\\s+${n}/${n}`));

    const off = await trb(["skill", "pack", "pstack", "off"]);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain(`0 of ${n} skills off`);
    expect(SkillStore.get("architect")!.enabled).toBe(false);

    const on = await trb(["skill", "pack", "pstack", "on"]);
    expect(on.stdout).toContain(`${n} of ${n} skills on`);
    expect(SkillStore.get("architect")!.enabled).toBe(true);

    const unknown = await trb(["skill", "pack", "nope", "on"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No skill pack "nope"');
    expect((await trb(["skill", "pack", "pstack"])).code).toBe(1);
  });
});
