import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { packFileHashes, verifyPackFiles } from "../src/skills/packs";

const SCRIPT = path.resolve(import.meta.dir, "..", "scripts", "vendor-pstack.ts");
let tmp: string;
let checkout: string;
let pack: string;

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const git = (...args: string[]) => spawnSync("git", ["-C", checkout, ...args], { encoding: "utf-8", windowsHide: true });
const vendor = (...args: string[]) =>
  spawnSync("bun", [SCRIPT, ...args, "--pack", pack], { encoding: "utf-8", windowsHide: true, env: { ...process.env, TRB_PACKS_DIR: "" } });
const treeOf = (dir: string): Record<string, string> =>
  Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const f = path.join(e.parentPath, e.name);
        return [path.relative(dir, f).split(path.sep).join("/"), fs.readFileSync(f, "utf-8")];
      }),
  );

/** A cursor/plugins checkout with a pstack/ folder: two listed skills (one with an excluded file), one unlisted. */
function fakeCheckout(name = "pstack"): void {
  const src = path.join(checkout, "pstack");
  write(path.join(src, "plugin.json"), JSON.stringify({ name, version: "9.9.9" }));
  write(path.join(src, "LICENSE"), "MIT License\r\nCopyright (c) someone\r\n");
  write(path.join(src, "skills", "alpha", "SKILL.md"), "---\r\nname: alpha\r\n---\r\nbody\r\n");
  write(path.join(src, "skills", "alpha", "references", "r.md"), "ref\n");
  write(path.join(src, "skills", "beta", "SKILL.md"), "---\nname: beta\n---\n");
  write(path.join(src, "skills", "beta", "scripts", "test", "case.md"), "excluded\n");
  write(path.join(src, "skills", "newcomer", "SKILL.md"), "---\nname: newcomer\n---\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trb-vendor-"));
  checkout = path.join(tmp, "plugins");
  pack = path.join(tmp, "pack");
  fs.mkdirSync(checkout);
  write(
    path.join(pack, "pack.json"),
    JSON.stringify({ id: "pstack", title: "pstack", version: "0.0.0", author: "a", license: "MIT", upstream: "u", commit: "old", skills: ["alpha", "beta", "ghost"], local: ["mine"], exclude: ["beta/scripts/test/**"] }),
  );
  write(path.join(pack, "local", "mine", "SKILL.md"), "mine\n");
  write(path.join(pack, "skills", "stale", "SKILL.md"), "stale\n");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("scripts/vendor-pstack.ts", () => {
  test("copies the listed skills as LF, drops excluded files and unlisted skills, writes version, commit and hashes", () => {
    fakeCheckout();
    const r = vendor(checkout);
    expect(r.status).toBe(0);
    const head = git("rev-parse", "HEAD").stdout.trim();
    expect(r.stdout).toContain(`pstack 9.9.9 at ${head.slice(0, 7)}: 2 skills, 3 files (1 excluded), 0 executable`);
    const tree = treeOf(pack);
    expect(Object.keys(tree).sort()).toEqual(["LICENSE", "local/mine/SKILL.md", "pack.json", "skills/alpha/SKILL.md", "skills/alpha/references/r.md", "skills/beta/SKILL.md"]);
    expect(tree["skills/alpha/SKILL.md"]).toBe("---\nname: alpha\n---\nbody\n");
    expect(tree["LICENSE"]).toBe("MIT License\nCopyright (c) someone\n");
    const manifest = JSON.parse(tree["pack.json"]!);
    expect(manifest).toMatchObject({ version: "9.9.9", commit: head, skills: ["alpha", "beta", "ghost"], local: ["mine"], exclude: ["beta/scripts/test/**"] });
    expect(Object.keys(manifest.hashes).sort()).toEqual(["LICENSE", "skills/alpha/SKILL.md", "skills/alpha/references/r.md", "skills/beta/SKILL.md"]);
    expect(verifyPackFiles(pack, manifest)).toEqual([]);
  });

  test("warns about an upstream skill the list lacks and a listed skill gone upstream", () => {
    fakeCheckout();
    const r = vendor(checkout);
    expect(r.stderr).toContain("not shipped (add them to pack.json to ship): newcomer");
    expect(r.stderr).toContain("gone upstream (remove them from pack.json): ghost");
  });

  test("refuses a checkout that is not pstack and leaves the pack as it was", () => {
    fakeCheckout("something-else");
    const before = treeOf(pack);
    const r = vendor(checkout);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is for "something-else", not pstack');
    expect(treeOf(pack)).toEqual(before);
  });

  test("refuses without an argument, printing the usage line", () => {
    const r = vendor();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("usage: bun scripts/vendor-pstack.ts <path-to-cursor-plugins-checkout>");
  });

  test("a second run leaves the same tree", () => {
    fakeCheckout();
    vendor(checkout);
    const first = treeOf(pack);
    expect(vendor(checkout).status).toBe(0);
    expect(treeOf(pack)).toEqual(first);
  });

  test("--hashes-only rewrites only the hashes, from the files on disk", () => {
    write(path.join(pack, "skills", "alpha", "SKILL.md"), "a\r\n");
    const r = vendor("--hashes-only");
    expect(r.status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(pack, "pack.json"), "utf-8"));
    expect(manifest.commit).toBe("old");
    expect(manifest.hashes).toEqual(packFileHashes(pack));
    expect(manifest.hashes["skills/alpha/SKILL.md"]).toBe(new Bun.CryptoHasher("sha256").update("a\n").digest("hex"));
    expect(fs.readFileSync(path.join(pack, "skills", "stale", "SKILL.md"), "utf-8")).toBe("stale\n");
  });
});
