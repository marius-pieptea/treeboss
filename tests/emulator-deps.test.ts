/** The emulator's real Deps: a program really runs through an argv array, and its folders live under the trb home. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import { realDeps } from "../src/emulator/deps";
import { home } from "../src/paths";
import { makeDir } from "./helpers";

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.TRB_HOME;
  process.env.TRB_HOME = makeDir();
});
afterEach(() => {
  if (prev === undefined) delete process.env.TRB_HOME;
  else process.env.TRB_HOME = prev;
});

describe("realDeps", () => {
  test("exec.run returns the exit code and stdout bytes", async () => {
    const r = await realDeps().exec.run([process.execPath, "--version"], { timeoutMs: 20_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBeInstanceOf(Uint8Array);
    expect(r.stdout.byteLength).toBeGreaterThan(0);
  });

  test("exec.run reports a timeout as a failure", async () => {
    const r = await realDeps().exec.run([process.execPath, "-e", "setTimeout(()=>{}, 30000)"], { timeoutMs: 300 });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("timed out");
  });

  test("paths resolve under TRB_HOME", () => {
    const p = realDeps().paths;
    for (const dir of [p.root, p.avdHome, p.tmp]) expect(path.relative(home(), dir).startsWith("..")).toBe(false);
  });
});
