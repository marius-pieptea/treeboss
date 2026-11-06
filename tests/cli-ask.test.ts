/** `trb ask`, `trb run --ask`, `trb send --mode ask`: a real CLI against a real daemon and the scripted engine. */
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-ask-home-"));
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ask from the CLI", () => {
  test("trb ask prints the answer, writes nothing, starts on the configured cheap model and reports its cost", async () => {
    expect((await trb(["config", "set", "ask_models", "fake=cheap-1"])).code).toBe(0);
    const cwd = makeDir();
    const run = await trb(["ask", "-e", "fake", "-C", cwd, "WRITE out.txt hi\nSAY the answer is 42"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("the answer is 42");
    expect(fs.existsSync(path.join(cwd, "out.txt"))).toBe(false);
    expect(run.stderr).toContain("cheap-1");
    expect(run.stderr).toMatch(/ask cost \$?0\.0/);
    expect((await trb(["plan", "last"])).stdout.trim()).toBe("ask");
  }, 60_000);

  test("run --ask works, send --mode ask flips a build session, and bad combinations are refused", async () => {
    const cwd = makeDir();
    expect((await trb(["run", "-e", "fake", "-C", cwd, "--ask", "SAY hello"])).code).toBe(0);
    const built = await trb(["run", "-e", "fake", "-C", cwd, "-d", "SAY build"]);
    expect(built.code).toBe(0);
    await Bun.sleep(400);
    expect((await trb(["send", "last", "-d", "--mode", "ask", "SAY again"])).code).toBe(0);
    await Bun.sleep(400);
    expect((await trb(["plan", "last"])).stdout.trim()).toBe("ask");
    expect((await trb(["run", "-e", "fake", "-C", cwd, "--ask", "--plan", "x"])).code).toBe(1);
    expect((await trb(["run", "-e", "fake", "-C", cwd, "--ask", "--goal", "g", "x"])).code).toBe(1);
    expect((await trb(["send", "last", "--mode", "yolo", "x"])).stderr).toContain('"build", "plan" or "ask"');
  }, 60_000);
});
