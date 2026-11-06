import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START specs-cli\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END specs-cli\n"); });
/** `trb spec …`: a real CLI against a real daemon and the scripted engine. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { makeRepo } from "./helpers";

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

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-spec-home-"));
  repo = makeRepo({ "README.md": "# demo\n" });
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trb spec", () => {
  test("ls on a bare project, then the whole workflow's first moves", async () => {
    let r = await trb(["spec", "ls"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("none (trb spec constitution init)");
    expect(r.stdout).toContain("no features yet");
    expect(fs.existsSync(path.join(repo, ".specify"))).toBe(false); // looking creates nothing

    r = await trb(["spec", "constitution", "init"]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(repo, ".specify/memory/constitution.md"))).toBe(true);
    expect((await trb(["spec", "constitution", "init"])).code).toBe(1);
    expect((await trb(["spec", "constitution"])).stdout).toContain("Constitution");

    r = await trb(["spec", "new", "Orders", "export", "--description", "Export orders as CSV"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("specs/001-orders-export");
    expect(fs.readFileSync(path.join(repo, "specs/001-orders-export/spec.md"), "utf-8")).toContain("Export orders as CSV");
    expect((await trb(["spec", "new", "orders export"])).code).toBe(1);
    expect((await trb(["spec", "new"])).code).toBe(1);

    r = await trb(["spec", "ls", "--json"]);
    const j = JSON.parse(r.stdout);
    expect(j.features.map((f: any) => f.id)).toEqual(["001-orders-export"]);

    r = await trb(["spec", "show", "1"]);
    expect(r.stdout).toContain("001-orders-export");
    expect(r.stdout).toContain("draft");
    expect((await trb(["spec", "show", "nope"])).code).toBe(1);
  }, 60_000);

  test("tasks lists phases and progress; attach and the steps need real prerequisites", async () => {
    fs.writeFileSync(path.join(repo, "specs/001-orders-export/plan.md"), "# plan\n");
    fs.writeFileSync(path.join(repo, "specs/001-orders-export/tasks.md"), "## Phase 1: Setup\n\n- [x] T001 Create src/a.ts\n- [ ] T002 [P] [US1] Add src/b.ts\n");
    let r = await trb(["spec", "tasks", "001"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Phase 1: Setup");
    expect(r.stdout).toContain("[x] T001");
    expect(r.stdout).toContain("[P] [US1] Add src/b.ts");
    expect(r.stdout).toContain("1/2");
    expect((await trb(["spec", "tasks", "999"])).code).toBe(1);

    const s = await trb(["run", "-e", "fake", "-C", repo, "-d", "SAY hello"]);
    expect(s.code).toBe(0);
    const id = s.stdout.trim().split(/\s+/).pop()!;
    r = await trb(["spec", "attach", id, "001", "--inline"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("attached specs/001-orders-export (inline)");
    expect((await trb(["spec", "attach", id, "README.md"])).code).toBe(1);

    r = await trb(["spec", "step", "specify", "001", "-e", "fake", "-d"]);
    expect(r.code).toBe(0);
    expect((await trb(["spec", "step", "bogus", "001", "-e", "fake", "-d"])).code).toBe(1);
  }, 60_000);

  test("implement starts a goal session; architecture starts a plan-mode one", async () => {
    let r = await trb(["spec", "implement", "001", "-e", "fake", "--max-turns", "1", "-d"]);
    expect(r.code).toBe(0);
    const id = r.stdout.trim().split(/\s+/).pop()!;
    expect(r.stderr).toContain("trb goal");
    const goal = await trb(["goal", id, "--json"]);
    expect(JSON.parse(goal.stdout).goal.check_cmd).toContain("tasks.md");

    r = await trb(["spec", "implement", "001", "--parallel", "-e", "fake", "--max-turns", "1", "-d"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("No Hydra pair with heads");

    r = await trb(["spec", "architecture", "001", "-t", "queues", "-e", "fake", "-d"]);
    expect(r.code).toBe(0);
    const arch = r.stdout.trim().split(/\s+/).pop()!;
    expect((await trb(["plan", arch])).stdout.trim()).toBe("plan");

    expect((await trb(["spec"])).code).toBe(1);
    expect((await trb(["spec", "sideways"])).code).toBe(1);
  }, 60_000);
});
