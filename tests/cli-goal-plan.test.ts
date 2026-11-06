/** `trb run --plan`, `trb run --goal`, `trb goal`, `trb plan`: a real CLI against a real daemon and the scripted engine. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { makeDir } from "./helpers";

const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
let home: string;

async function trb(args: string[], opts: { cwd?: string } = {}) {
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
    cwd: opts.cwd ?? os.tmpdir(),
    env: { ...process.env, TRB_HOME: home, TRB_NO_AUTOSTART: "", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-gp-home-"));
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("plan mode from the CLI", () => {
  test("run --plan is read-only; plan approve builds; send --mode flips it", async () => {
    const cwd = makeDir();
    const run = await trb(["run", "-e", "fake", "-C", cwd, "--plan", "WRITE out.txt hi\nSAY the plan"]);
    expect(run.code).toBe(0);
    expect(fs.existsSync(path.join(cwd, "out.txt"))).toBe(false);
    expect((await trb(["plan", "last"])).stdout.trim()).toBe("plan");

    const approve = await trb(["plan", "last", "approve"]);
    expect(approve.code).toBe(0);
    expect(approve.stdout).toContain("plan approved");
    for (let i = 0; i < 100 && (await trb(["plan", "last"])).stdout.trim() !== "build"; i++) await Bun.sleep(50);
    expect((await trb(["plan", "last"])).stdout.trim()).toBe("build");

    expect((await trb(["send", "last", "-d", "--mode", "plan", "SAY again"])).code).toBe(0);
    await Bun.sleep(400);
    expect((await trb(["plan", "last"])).stdout.trim()).toBe("plan");
    expect((await trb(["plan", "last", "off"])).stdout).toContain("plan mode off");
    expect((await trb(["send", "last", "--mode", "yolo", "x"])).code).toBe(1);
    expect((await trb(["plan", "last", "sideways"])).code).toBe(1);
  }, 60_000);
});

describe("goal mode from the CLI", () => {
  test("run --goal follows every turn until the check passes", async () => {
    const cwd = makeDir();
    const run = await trb(["run", "-e", "fake", "-C", cwd, "--goal", "BASH echo x >> c.txt", "--check", "test $(wc -l < c.txt) -ge 3", "SAY begin"]);
    expect(run.code).toBe(0);
    expect(fs.readFileSync(path.join(cwd, "c.txt"), "utf-8").split("\n").filter(Boolean)).toHaveLength(3);
    expect(run.stderr).toContain("goal met");
    const shown = await trb(["goal", "last"]);
    expect(shown.stdout).toContain("met");
    expect(shown.stdout).toContain("3/12 turns");
  }, 60_000);

  test("goal flags need a goal; goal on a session sets, shows and stops it", async () => {
    expect((await trb(["run", "-e", "fake", "--check", "true", "SAY x"])).code).toBe(1);
    const cwd = makeDir();
    const id = (await trb(["run", "-e", "fake", "-C", cwd, "-d", "SLEEP 800"])).stdout.trim();
    const set = await trb(["goal", id, "keep going", "--check", "false", "--max-turns", "4"]);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("check: false");
    expect(set.stdout).toContain("0/4 turns");
    const stop = await trb(["goal", id, "stop"]);
    expect(stop.stdout).toContain("stopped");
    expect((await trb(["goal", id, "x", "--max-turns", "0"])).code).toBe(1);
    await trb(["interrupt", id]);
  }, 60_000);
});
