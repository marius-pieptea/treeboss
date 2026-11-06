import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { db } from "../src/db";
import { MAX_SKILL_FILES, copyWalk, walkSkillDir } from "../src/skills/files";
import { cancelImportJob, getImportJob, scanSkills, startImport } from "../src/skills/import";
import { SkillStore, materializeSkills } from "../src/skills/store";
import { ENGINES } from "../src/engines/registry";
import { listDir, readFileSafe, writeFileSafe } from "../src/fs/files";
import { resolveRoot } from "../src/workspaces";
import { startServer } from "../src/daemon/server";
import { makeDir } from "./helpers";

beforeEach(() => {
  db().exec("DELETE FROM skills");
  // The rows are gone; so must their folders, or one test's skills show up in the next one's directory listing.
  const dir = path.join(process.env.TRB_HOME!, "skills");
  if (fs.existsSync(dir)) for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
});

const md = (name: string, desc = `skill ${name}`) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`;
function tree(files: Record<string, string>): string {
  const root = makeDir();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}
async function until<T>(fn: () => T | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("a skill is a whole folder", () => {
  test("every file at every depth is copied, with executable bits, and dependencies/VCS are left out and said so", () => {
    const root = tree({
      "SKILL.md": md("multi"),
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
      "references/deep/a/b/c.md": "deep",
      "assets/logo.bin": "\u0000\u0001binary",
      "node_modules/pkg/index.js": "dep",
      ".git/HEAD": "ref",
      ".DS_Store": "junk",
    });
    fs.chmodSync(path.join(root, "scripts/run.sh"), 0o755);
    const w = walkSkillDir(root);
    expect(w.files.map((f) => f.rel).sort()).toEqual(["SKILL.md", "assets/logo.bin", "references/deep/a/b/c.md", "scripts/run.sh"]);
    expect(w.skipped.join(" ")).toContain("node_modules");
    expect(w.skipped.join(" ")).toContain("version control");
    expect(w.skipped.join(" ")).not.toContain("DS_Store");
    const dest = path.join(makeDir(), "out");
    copyWalk(w, dest);
    expect(fs.readFileSync(path.join(dest, "references/deep/a/b/c.md"), "utf-8")).toBe("deep");
    expect(fs.statSync(path.join(dest, "scripts/run.sh")).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(dest, "node_modules"))).toBe(false);
  });

  test("a symlink loop is reported, not followed forever; a broken link is skipped", () => {
    const root = tree({ "SKILL.md": md("loopy"), "real/a.txt": "a" });
    fs.symlinkSync(root, path.join(root, "real/back-to-root"));
    fs.symlinkSync("/definitely/not/there", path.join(root, "dangling"));
    const w = walkSkillDir(root);
    expect(w.files.map((f) => f.rel).sort()).toEqual(["SKILL.md", "real/a.txt"]);
    expect(w.skipped.join(" ")).toContain("symlink loop");
    expect(w.skipped.join(" ")).toContain("broken link");
  });

  test("a folder that is really a repository is refused rather than copied", () => {
    const root = makeDir();
    fs.writeFileSync(path.join(root, "SKILL.md"), md("huge"));
    for (let i = 0; i <= MAX_SKILL_FILES; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), "x");
    expect(() => walkSkillDir(root)).toThrow(/repository, not a skill/);
  });

  test("an oversized single file is refused with its name", () => {
    const root = tree({ "SKILL.md": md("big") });
    fs.closeSync(fs.openSync(path.join(root, "model.bin"), "w"));
    fs.truncateSync(path.join(root, "model.bin"), 11 * 1024 * 1024);
    expect(() => walkSkillDir(root)).toThrow(/model\.bin is 11\.0 MB/);
  });

  test("materialising puts the whole folder where the engine looks, and takes it all back out", () => {
    const root = tree({ "SKILL.md": md("tooling"), "scripts/check.sh": "#!/bin/sh\n", "references/guide.md": "g" });
    fs.chmodSync(path.join(root, "scripts/check.sh"), 0o755);
    SkillStore.add(root);
    const cwd = makeDir();
    const m = materializeSkills(ENGINES.claude, cwd);
    const base = path.join(cwd, ".claude", "skills", "tooling");
    expect(fs.existsSync(path.join(base, "references/guide.md"))).toBe(true);
    expect(fs.statSync(path.join(base, "scripts/check.sh")).mode & 0o111).not.toBe(0);
    m.cleanup();
    expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
  });
});

describe("finding skills", () => {
  test("nested layouts are found; a skill's own subfolders are not searched; names are unique", () => {
    const root = tree({
      "top/SKILL.md": md("top"),
      "top/scripts/SKILL.md": md("not-a-skill-its-a-file-of-top"),
      "plugins/a/skills/inner/SKILL.md": md("inner"),
      "plugins/b/skills/inner/SKILL.md": md("inner"),
      "node_modules/x/SKILL.md": md("dep"),
      ".hidden/SKILL.md": md("hidden"),
      "no-skill/readme.md": "x",
    });
    const r = scanSkills(root);
    expect(r.skills.map((s) => s.name).sort()).toEqual(["inner", "top"]);
    expect(r.skills.find((s) => s.name === "inner")!.relDir).toBe(path.join("plugins", "a", "skills", "inner"));
    expect(r.duplicates).toEqual([path.join("plugins", "b", "skills", "inner")]);
    expect(r.skills.find((s) => s.name === "top")!.files).toBe(2); // SKILL.md and scripts/SKILL.md, which is just a file of top
  });

  test("the root may itself be a skill; counts, sizes and 'already imported' are reported", () => {
    const root = tree({ "SKILL.md": md("solo"), "a.txt": "12345" });
    SkillStore.add(root);
    const r = scanSkills(root);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]).toMatchObject({ name: "solo", relDir: ".", files: 2, exists: true });
    expect(r.skills[0].bytes).toBeGreaterThan(5);
  });

  test("a missing or non-directory path is a clear error", () => {
    expect(() => scanSkills("/definitely/not/here")).toThrow(/does not exist/);
    expect(() => scanSkills(path.join(tree({ "f.txt": "x" }), "f.txt"))).toThrow(/not a directory/);
  });

  test("the skill name comes from the frontmatter, else the folder", () => {
    const root = tree({ "a/SKILL.md": md("named-in-file"), "folder-name/SKILL.md": "no frontmatter at all" });
    expect(scanSkills(root).skills.map((s) => s.name).sort()).toEqual(["folder-name", "named-in-file"]);
  });
});

describe("importing with progress", () => {
  function many(n: number, filesEach = 3): string {
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      files[`s${i}/SKILL.md`] = md(`skill-${i}`);
      for (let f = 0; f < filesEach - 1; f++) files[`s${i}/refs/f${f}.md`] = "x".repeat(100);
    }
    return tree(files);
  }

  test("a job reports its total up front and advances to done, with a result per skill", async () => {
    const root = many(12);
    const job = startImport(root);
    expect(job).toMatchObject({ status: "running", total: 12, done: 0 });
    const seen: number[] = [];
    const finished = await until(() => {
      const j = getImportJob(job.id)!;
      if (seen.at(-1) !== j.done) seen.push(j.done);
      return j.status === "done" ? j : null;
    });
    expect(finished.results).toHaveLength(12);
    expect(finished.results.every((r) => r.status === "added" && r.files === 3)).toBe(true);
    expect(finished.done).toBe(12);
    expect(finished.doneBytes).toBe(finished.totalBytes);
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // never goes backwards
    expect(SkillStore.list()).toHaveLength(12);
    expect(fs.existsSync(path.join(SkillStore.get("skill-7")!.path, "refs", "f1.md"))).toBe(true);
  });

  test("while it runs, the current skill and its file count are visible", async () => {
    const root = many(2, 600);
    const job = startImport(root);
    const mid = await until(() => {
      const j = getImportJob(job.id)!;
      return j.current && j.current.filesDone > 0 && j.current.filesDone < j.current.filesTotal ? j : null;
    }, 15000);
    expect(mid.current).toMatchObject({ filesTotal: 600 });
    await until(() => getImportJob(job.id)!.status === "done", 30000);
  });

  test("existing skills are skipped unless overwrite is on; a replaced one reports as replaced", async () => {
    const root = many(2);
    const first = startImport(root);
    await until(() => (getImportJob(first.id)!.status === "done" ? true : null));
    const again = startImport(root);
    const r1 = await until(() => (getImportJob(again.id)!.status === "done" ? getImportJob(again.id)! : null));
    expect(r1.results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    const over = startImport(root, { overwrite: true });
    const r2 = await until(() => (getImportJob(over.id)!.status === "done" ? getImportJob(over.id)! : null));
    expect(r2.results.map((r) => r.status)).toEqual(["replaced", "replaced"]);
  });

  test("one bad skill fails alone and says why; the rest still import", async () => {
    const root = many(3);
    fs.closeSync(fs.openSync(path.join(root, "s1", "huge.bin"), "w"));
    fs.truncateSync(path.join(root, "s1", "huge.bin"), 11 * 1024 * 1024);
    const job = startImport(root);
    const done = await until(() => (getImportJob(job.id)!.status === "done" ? getImportJob(job.id)! : null));
    expect(done.results.map((r) => r.status)).toEqual(["added", "failed", "added"]);
    expect(done.results[1].reason).toContain("huge.bin");
    expect(SkillStore.get("skill-1")).toBeNull();
  });

  test("importing a chosen subset; an unknown name is refused before anything starts; an empty folder too", () => {
    const root = many(4);
    expect(() => startImport(root, { names: ["skill-1", "ghost"] })).toThrow(/Not found in .*ghost/);
    expect(() => startImport(makeDir())).toThrow(/No skills/);
    const job = startImport(root, { names: ["skill-2"] });
    expect(job.total).toBe(1);
    return until(() => (getImportJob(job.id)!.status === "done" ? true : null)); // a running job must not leak into the next test
  });

  test("cancelling stops after the current skill and never leaves half a skill on disk", async () => {
    const root = many(30, 40);
    const job = startImport(root);
    await until(() => getImportJob(job.id)!.done >= 1);
    expect(cancelImportJob(job.id)).toBe(true);
    const done = await until(() => (getImportJob(job.id)!.status !== "running" ? getImportJob(job.id)! : null));
    expect(done.status).toBe("cancelled");
    expect(done.done).toBeLessThan(30);
    for (const s of SkillStore.list()) expect(fs.readdirSync(path.join(s.path, "refs")).length).toBe(39); // every registered skill is complete
    const skillDirs = fs.readdirSync(path.join(process.env.TRB_HOME!, "skills"));
    expect(skillDirs.length).toBe(SkillStore.list().length); // no orphan folders from a cancelled copy
    expect(cancelImportJob(job.id)).toBe(false);
  });

  test("the synchronous CLI path finds nested skills and reports progress", () => {
    const root = tree({ "x/y/z/SKILL.md": md("deep-one"), "top/SKILL.md": md("top-one") });
    const lines: string[] = [];
    const r = SkillStore.importDir(root, { onProgress: (m) => lines.push(m) });
    expect(r.added.sort()).toEqual(["deep-one", "top-one"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[1\/2\] /);
  });
});

describe("editing any file of a skill", () => {
  test("a skill folder is a root for the file API: list, read, write, and the description follows SKILL.md", () => {
    const root = tree({ "SKILL.md": md("editable", "first description"), "scripts/run.sh": "echo 1\n" });
    SkillStore.add(root);
    const r = resolveRoot("k_editable");
    expect(r).toMatchObject({ kind: "skill", name: "editable" });
    return listDir(r.dir, "scripts").then(() => {
      expect(readFileSafe(r.dir, "scripts/run.sh")).toMatchObject({ content: "echo 1\n" });
      writeFileSafe(r.dir, "scripts/run.sh", "echo 2\n");
      writeFileSafe(r.dir, "SKILL.md", md("editable", "second description"));
      expect(SkillStore.list().find((s) => s.name === "editable")!.description).toBe("second description");
      expect(() => resolveRoot("k_ghost")).toThrow(/No skill/);
      expect(() => readFileSafe(r.dir, "../../etc/passwd")).toThrow();
    });
  });
});

describe("API", () => {
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: "t" });
  });
  afterAll(() => srv.stop());
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: "Bearer t", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as any };
  };

  test("scan -> start -> poll to completion; the files are editable through the fs API", async () => {
    const root = tree({ "a/SKILL.md": md("api-a"), "a/scripts/x.sh": "x", "b/SKILL.md": md("api-b") });
    const scan = await call("POST", "/api/skills/import/scan", { dir: root });
    expect(scan.body.skills.map((s: any) => s.name).sort()).toEqual(["api-a", "api-b"]);
    const start = await call("POST", "/api/skills/import/start", { dir: root, names: ["api-a"] });
    expect(start.status).toBe(202);
    const id = start.body.job.id;
    const done = await until(async () => null as any).catch(() => null); // (placeholder to keep the helper sync)
    void done;
    let job = start.body.job;
    for (let i = 0; i < 200 && job.status === "running"; i++) {
      await Bun.sleep(10);
      job = (await call("GET", `/api/skills/import/jobs/${id}`)).body.job;
    }
    expect(job).toMatchObject({ status: "done", total: 1, done: 1 });
    expect((await call("GET", "/api/fs/k_api-a/tree?path=scripts")).body.entries.map((e: any) => e.name)).toEqual(["x.sh"]);
    expect((await call("PUT", "/api/fs/k_api-a/file", { path: "scripts/x.sh", content: "y" })).status).toBe(200);
    expect((await call("GET", "/api/skills/import/jobs/ghost")).status).toBe(404);
    expect((await call("POST", "/api/skills/import/start", { dir: "/definitely/not/here" })).status).toBe(400);
  });
});
