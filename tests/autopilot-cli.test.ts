/** `trb autopilot …` and `trb schedule …`: a real CLI against a real daemon. */
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-autopilot-home-"));
  repo = makeRepo({
    "README.md": "# demo\n",
    "specs/001-demo/spec.md": "# Feature Specification: Demo\n",
    "specs/001-demo/tasks.md": "# Tasks\n\n## Phase 1\n\n- [ ] T001 Delete the old table [APPROVE]\n",
  });
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trb autopilot", () => {
  test("lists nothing at first, then start, show, ls, reject and a second stop show the run's state", async () => {
    let r = await trb(["autopilot", "ls"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no autopilot runs here");

    r = await trb(["autopilot", "start", "001-demo", "--approve-tagged", "--budget", "2"]);
    expect(r.code).toBe(0);
    const id = r.stdout.match(/ap_\w+/)![0];
    expect(r.stdout).toContain("autopilot on specs/001-demo");
    expect(r.stdout).toContain("budget $2");

    r = await trb(["autopilot", "show", id]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("awaiting approval");
    expect(r.stdout).toContain("T001 is tagged [APPROVE]");
    expect(r.stdout).toContain(`trb autopilot approve ${id}`);

    r = await trb(["autopilot", "ls"]);
    expect(r.stdout).toContain(id);
    expect(r.stdout).toContain("awaiting approval");

    const json = JSON.parse((await trb(["autopilot", "show", id, "--json"])).stdout);
    expect(json).toMatchObject({ id, status: "awaiting_approval", gate: { kind: "tagged" } });

    r = await trb(["autopilot", "start", "001-demo"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("already working");

    r = await trb(["autopilot", "reject", id]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${id}: stopped`);
    expect(r.stdout).toContain("Rejected");
    expect(fs.readFileSync(path.join(repo, "specs/001-demo/tasks.md"), "utf-8")).toContain("[ ] T001");

    r = await trb(["autopilot", "stop", id]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("already stopped");
  });

  test("a missing spec or id fails with a message, and an unknown subcommand prints usage", async () => {
    let r = await trb(["autopilot", "start", "999-none"]);
    expect(r.code).not.toBe(0);
    r = await trb(["autopilot", "show", "ap_nope"]);
    expect(r.code).not.toBe(0);
    r = await trb(["autopilot", "frobnicate"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Usage: trb autopilot");
  });
});

describe("trb schedule", () => {
  test("add, ls and rm a job; bad input is refused", async () => {
    let r = await trb(["schedule", "ls"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no scheduled jobs here");

    r = await trb(["schedule", "add", "Nightly", "checks", "--cron", "0 3 * * *", "--kind", "verify"]);
    expect(r.code).toBe(0);
    const id = r.stdout.match(/sc_\w+/)![0];
    expect(r.stdout).toContain("Nightly checks: next");

    r = await trb(["schedule", "ls"]);
    expect(r.stdout).toContain(id);
    expect(r.stdout).toContain("Nightly checks");
    expect(r.stdout).toContain("0 3 * * *");
    expect(r.stdout).toContain("never run");

    r = await trb(["schedule", "add", "Off", "--cron", "0 4 * * *", "--kind", "verify", "--disabled"]);
    expect(r.code).toBe(0);
    expect((await trb(["schedule", "ls"])).stdout).toContain("off");

    r = await trb(["schedule", "add", "Bad", "--cron", "not a cron", "--kind", "verify"]);
    expect(r.code).not.toBe(0);
    r = await trb(["schedule", "add", "NoKind", "--cron", "0 3 * * *"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Usage: trb schedule");

    r = await trb(["schedule", "rm", id]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`removed ${id}`);
    expect((await trb(["schedule", "ls"])).stdout).not.toContain("Nightly checks");
    expect((await trb(["schedule", "rm", id])).code).not.toBe(0);
  });
});
