import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START cli-model\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END cli-model\n"); });
/** `trb model`: show and switch a session's model, against a real daemon and the scripted engine. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { makeDir } from "./helpers";

const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
let home: string;

async function trb(args: string[]) {
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
    cwd: os.tmpdir(),
    env: { ...process.env, TRB_HOME: home, TRB_NO_AUTOSTART: "", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-model-home-"));
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trb model", () => {
  test("shows, switches, and the next turn gets the new model", async () => {
    const run = await trb(["run", "-e", "fake", "-m", "alpha", "-C", makeDir(), "SAY hi"]);
    expect(run.code).toBe(0);
    expect((await trb(["model", "last"])).stdout).toContain("fake · alpha");

    const sw = await trb(["model", "last", "beta"]);
    expect(sw.code).toBe(0);
    expect(sw.stdout).toContain("fake · beta");
    expect(sw.stdout).toContain("applies to the next turn");
    expect(sw.stderr).toContain("without the cache");

    const send = await trb(["send", "last", "ECHO_ARGS"]);
    expect(send.code).toBe(0);
    expect(send.stdout + send.stderr).toContain("--model beta");

    expect((await trb(["model", "last", "default"])).stdout).toContain("fake · default");
    expect((await trb(["model", "last", "--effort", "high"])).stdout).toContain("effort high");
  });

  test("a bad effort and a missing session fail with a readable message", async () => {
    await trb(["run", "-e", "fake", "-C", makeDir(), "SAY hi"]);
    const bad = await trb(["model", "last", "--effort", "ludicrous"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/not one fake accepts/);
    expect((await trb(["model"])).code).not.toBe(0);
  });
});
