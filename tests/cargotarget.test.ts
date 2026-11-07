import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { paths } from "../src/paths";
import { cargoTargetRoot, pruneSharedTargets, sharedCargoTarget } from "../src/git/cargotarget";

let tmp: string;
const prev = process.env.TRB_HOME;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cargo-"));
  process.env.TRB_HOME = tmp;
});
afterAll(() => {
  if (prev === undefined) delete process.env.TRB_HOME;
  else process.env.TRB_HOME = prev;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("sharedCargoTarget", () => {
  test("two worktrees of one repo get the same dir; another repo gets its own", () => {
    const a = sharedCargoTarget(path.join(paths.worktrees(), "app-1234abcd", "s1", "crates"), {}, true);
    const b = sharedCargoTarget(path.join(paths.worktrees(), "app-1234abcd", "s2"), {}, true);
    const c = sharedCargoTarget(path.join(paths.worktrees(), "other-99999999", "s1"), {}, true);
    expect(a).toBe(path.join(cargoTargetRoot(), "app-1234abcd"));
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
  test("leaves the build alone outside a worktree, when disabled, or when the operator set one", () => {
    expect(sharedCargoTarget(os.tmpdir(), {}, true)).toBeNull();
    expect(sharedCargoTarget(path.join(paths.worktrees(), "app-1234abcd", "s1"), {}, false)).toBeNull();
    expect(sharedCargoTarget(path.join(paths.worktrees(), "app-1234abcd", "s1"), { CARGO_TARGET_DIR: "D:\t" }, true)).toBeNull();
    expect(sharedCargoTarget(paths.worktrees(), {}, true)).toBeNull();
  });
});

describe("pruneSharedTargets", () => {
  test("drops an oversized dir only when no worktree of that repo is live", () => {
    const big = path.join(cargoTargetRoot(), "big-00000001");
    const busy = path.join(cargoTargetRoot(), "busy-00000002");
    const small = path.join(cargoTargetRoot(), "small-00000003");
    for (const d of [big, busy, small]) fs.mkdirSync(path.join(d, "debug"), { recursive: true });
    for (const d of [big, busy]) fs.writeFileSync(path.join(d, "debug", "x.rlib"), Buffer.alloc(4096));
    fs.writeFileSync(path.join(small, "debug", "x.rlib"), "a");
    fs.mkdirSync(path.join(paths.worktrees(), "busy-00000002", "s_live"), { recursive: true });

    expect(pruneSharedTargets(1024).sort()).toEqual(["big-00000001"]);
    expect(fs.existsSync(big)).toBe(false);
    expect(fs.existsSync(busy)).toBe(true);
    expect(fs.existsSync(small)).toBe(true);
    expect(pruneSharedTargets(0)).toEqual([]);
  });
});
