/** `trb docs …`: a real CLI against a real daemon and the scripted engine. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { makeRepo, sh } from "./helpers";

const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
let home: string;
let repo: string;

async function trb(args: string[], cwd = repo) {
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
    cwd,
    env: { ...process.env, TRB_HOME: home, TRB_NO_AUTOSTART: "", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}
const commit = (msg: string) => sh(`git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm ${JSON.stringify(msg)} && git rev-parse HEAD`, repo);

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-docs-home-"));
  repo = makeRepo({ "README.md": "# demo\n", "src/a.ts": "a\n" });
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trb docs", () => {
  test("ls on a bare project creates nothing; init and new do, only when asked", async () => {
    let r = await trb(["docs", "ls"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no docs/ folder yet");
    expect(fs.existsSync(path.join(repo, "docs"))).toBe(false);

    r = await trb(["docs", "init"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("docs/index.md");
    expect((await trb(["docs", "init"])).stdout).toContain("already has pages");

    r = await trb(["docs", "new", "guides/setup", "-t", "Setup"]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(repo, "docs/guides/setup.md"), "utf-8")).toContain('title: "Setup"');
    expect((await trb(["docs", "new", "guides/setup"])).code).toBe(1);
    expect((await trb(["docs", "new"])).code).toBe(1);

    r = await trb(["docs", "new", "--adr", "Use SQLite"]);
    expect(r.stdout).toContain("docs/decisions/0001-use-sqlite.md");

    r = await trb(["docs", "ls", "--json"]);
    expect(JSON.parse(r.stdout).docs.pages.map((p: any) => p.path).sort()).toEqual(["docs/decisions/0001-use-sqlite.md", "docs/guides/setup.md", "docs/index.md"]);
  });

  test("stale and current follow the commits", async () => {
    const base = sh("git rev-parse HEAD", repo);
    fs.writeFileSync(path.join(repo, "docs/architecture.md"), `---\ntitle: Architecture\ncovers: [src/**]\ngenerated:\n  commit: ${base}\n  by: test\n---\n\n# Architecture\n`);
    commit("docs");
    let r = await trb(["docs", "stale"]);
    expect(r.stdout).toContain("up to date");
    fs.writeFileSync(path.join(repo, "src/a.ts"), "a2\n");
    const tip = commit("touch a");
    r = await trb(["docs", "stale"]);
    expect(r.stdout).toContain("drifting");
    expect(r.stdout).toContain("src/a.ts");
    expect(r.stderr).toContain("trb docs generate --stale");
    r = await trb(["docs", "ls"]);
    expect(r.stdout).toMatch(/docs\/architecture\.md\s+drifting/);

    r = await trb(["docs", "current", "docs/architecture.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(tip.slice(0, 8));
    expect((await trb(["docs", "stale"])).stdout).toContain("up to date");
    expect((await trb(["docs", "current", "docs/guides/setup.md"])).code).toBe(1); // no covers
  });

  test("attach puts a page on a session", async () => {
    const run = await trb(["run", "-e", "fake", "-d", "SAY hi"]);
    const id = run.stdout.trim().split(/\s+/)[0];
    expect(id).toMatch(/^s_/);
    const r = await trb(["docs", "attach", id, "docs/architecture.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("by reference");
    expect((await trb(["docs", "attach", id, "README.md"])).code).toBe(1);
    expect((await trb(["docs", "attach", id])).code).toBe(1);
  });

  test("generate -d starts a session that carries the contract", async () => {
    const r = await trb(["docs", "generate", "runbook", "-e", "fake", "-d"]);
    expect(r.code).toBe(0);
    const id = r.stdout.trim();
    expect(id).toMatch(/^s_/);
    expect(r.stderr).toContain("writing docs/runbook.md");
    const show = await trb(["docs", "generate", "refresh", "--json"]);
    expect(show.code).toBe(1); // refresh needs pages
    expect((await trb(["docs", "generate", "module"])).code).toBe(1); // module needs a topic
    expect((await trb(["docs", "generate", "bogus"])).code).toBe(1);
  });

  test("usage is printed for nothing and for nonsense", async () => {
    expect((await trb(["docs"])).code).toBe(1);
    expect((await trb(["docs", "nope"])).code).toBe(1);
  });
});
