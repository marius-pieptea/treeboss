import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { paths } from "../src/paths";
import { autoCargoJobs, cargoEnv, cargoTargetRoot, isRustProject, pruneSharedTargets, rustBuildHint, sharedCargoTarget } from "../src/git/cargotarget";

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

describe("cargoEnv", () => {
  const wt = () => path.join(paths.worktrees(), "app-1234abcd", "s1");
  const on = { shareTarget: true, jobs: 0, leanDebug: true };
  test("a worktree gets the shared dir, lean debug and capped jobs", () => {
    const v = cargoEnv(wt(), {}, { ...on, jobs: 3 }, { agent: false });
    expect(v).toEqual({ CARGO_TARGET_DIR: path.join(cargoTargetRoot(), "app-1234abcd"), CARGO_PROFILE_DEV_DEBUG: "line-tables-only", CARGO_BUILD_JOBS: "3" });
  });
  test("the operator's own checkout: jobs only for agent turns, never lean debug", () => {
    expect(cargoEnv(os.tmpdir(), {}, on, { agent: false })).toEqual({});
    expect(cargoEnv(os.tmpdir(), {}, on, { agent: true })).toEqual({ CARGO_BUILD_JOBS: String(autoCargoJobs()) });
  });
  test("variables already set win, and settings switch each part off", () => {
    expect(cargoEnv(wt(), { CARGO_TARGET_DIR: "x", CARGO_BUILD_JOBS: "1", CARGO_PROFILE_DEV_DEBUG: "full" }, on, { agent: true })).toEqual({});
    expect(cargoEnv(wt(), {}, { shareTarget: false, jobs: 2, leanDebug: false }, { agent: true })).toEqual({ CARGO_BUILD_JOBS: "2" });
  });
});

describe("autoCargoJobs", () => {
  test("half the cores, one per 4 GB, at least 2", () => {
    expect(autoCargoJobs(24, 32 * 1024 ** 3)).toBe(8);
    expect(autoCargoJobs(8, 64 * 1024 ** 3)).toBe(4);
    expect(autoCargoJobs(2, 4 * 1024 ** 3)).toBe(2);
  });
});

describe("isRustProject / rustBuildHint", () => {
  test("finds Cargo.toml at the root or one level down", () => {
    const root = fs.mkdtempSync(path.join(tmp, "proj-"));
    expect(isRustProject(root)).toBe(false);
    fs.mkdirSync(path.join(root, "src-tauri"));
    fs.writeFileSync(path.join(root, "src-tauri", "Cargo.toml"), "");
    expect(isRustProject(root)).toBe(true);
  });
  test("forbids private target dirs and names what trb set", () => {
    const h = rustBuildHint({ CARGO_TARGET_DIR: "t", CARGO_BUILD_JOBS: "8" });
    expect(h).toContain("`CARGO_BUILD_JOBS`");
    expect(h).toContain("Never set `CARGO_TARGET_DIR`");
    expect(h).toContain("unset CARGO_TARGET_DIR");
    expect(rustBuildHint({})).not.toContain("unset CARGO_TARGET_DIR");
  });
});
