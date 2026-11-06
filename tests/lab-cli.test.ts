/** `trb lab …`: a real CLI against a real daemon. Starting a pass would launch a real engine, so these cover everything around it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { makeRepo } from "./helpers";

const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
let home: string;
let repo: string;

async function trb(args: string[], cwd = repo) {
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], { cwd, env: { ...process.env, TRB_HOME: home, TRB_NO_AUTOSTART: "", NO_COLOR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const finding = (title: string, extra = "") => `---\ntitle: ${title}\nlens: perf\nscope: src/alpha\nimpact: high\neffort: s\nstatus: new\nevidence:\n  - src/alpha/a.ts:1${extra}\n---\nWhy it matters.\n`;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-lab-home-"));
  repo = makeRepo({ "README.md": "# demo\n", "src/alpha/a.ts": "export const a = 1;\n", "src/beta/b.ts": "export const b = 2;\n" });
  fs.mkdirSync(path.join(repo, "lab/findings"), { recursive: true });
  fs.writeFileSync(path.join(repo, "lab/findings/alpha-slow.md"), finding("Cache the alpha lookup"));
  fs.writeFileSync(path.join(repo, "lab/findings/gone.md"), finding("Old idea").replace("src/alpha/a.ts:1", "src/alpha/deleted.ts:4"));
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trb lab", () => {
  test("show lists open findings, flags stale evidence, and filters", async () => {
    let r = await trb(["lab", "show"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("alpha-slow");
    expect(r.stdout).toContain("Cache the alpha lookup");
    expect(r.stdout).toContain("no longer exists: src/alpha/deleted.ts:4");
    r = await trb(["lab", "show", "--lens", "ui"]);
    expect(r.stdout).toContain("nothing matches");
    const json = JSON.parse((await trb(["lab", "show", "--json"])).stdout);
    expect(json.map((f: any) => f.id).sort()).toEqual(["alpha-slow", "gone"]);
  });

  test("a sweep plan lists the modules and starts nothing", async () => {
    const r = await trb(["lab", "sweep", "perf", "--plan"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("src/alpha");
    expect(r.stdout).toContain("src/beta");
    expect(r.stdout).toContain("tokens to read");
    expect((await trb(["lab", "sweeps"])).stdout).toContain("no sweeps yet");
  });

  test("roadmap hand-off, dismiss, reopen and rm", async () => {
    let r = await trb(["lab", "roadmap", "alpha-slow"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/alpha-slow is on the roadmap as r\d+/);
    expect(fs.readFileSync(path.join(repo, "ROADMAP.md"), "utf8")).toContain("Cache the alpha lookup");
    expect(fs.readFileSync(path.join(repo, "lab/findings/alpha-slow.md"), "utf8")).toContain("status: accepted");
    r = await trb(["lab", "dismiss", "gone"]);
    expect(r.stdout).toContain("gone dismissed");
    expect((await trb(["lab", "show"])).stdout).not.toContain("Old idea");
    expect((await trb(["lab", "show", "--status", "dismissed"])).stdout).toContain("Old idea");
    expect((await trb(["lab", "reopen", "gone"])).stdout).toContain("gone new");
    expect((await trb(["lab", "rm", "gone"])).stdout).toContain("removed gone");
    expect(fs.existsSync(path.join(repo, "lab/findings/gone.md"))).toBe(false);
  });

  test("bad input is refused with a clear message", async () => {
    let r = await trb(["lab", "run"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Usage: trb lab run");
    r = await trb(["lab", "run", "nonsense"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Unknown lens");
    r = await trb(["lab", "dismiss", "nope"]);
    expect(r.stderr).toContain("no finding");
    expect((await trb(["lab", "bogus"])).stderr).toContain("Usage: trb lab");
  });
});
