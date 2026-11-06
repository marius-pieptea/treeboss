import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START legacy-rename\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END legacy-rename\n"); });
import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { migrateLegacyHome } from "../src/paths";
import { findBlock, parseRules, spliceRules } from "../src/memory/block";

describe("pre-rename state", () => {
  // Explicit paths only: never the real home.
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "trb-mig-"));

  test("the legacy directory moves and occ.sqlite becomes trb.sqlite", () => {
    const root = tmp();
    const legacy = path.join(root, ".omni-code");
    const dir = path.join(root, ".treeboss");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "occ.sqlite"), "db");
    fs.writeFileSync(path.join(legacy, "token"), "t");
    migrateLegacyHome(dir, legacy);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "trb.sqlite"), "utf8")).toBe("db");
    expect(fs.readFileSync(path.join(dir, "token"), "utf8")).toBe("t");
  });

  test("an existing new home is never overwritten", () => {
    const root = tmp();
    const legacy = path.join(root, ".omni-code");
    const dir = path.join(root, ".treeboss");
    fs.mkdirSync(legacy);
    fs.mkdirSync(dir);
    migrateLegacyHome(dir, legacy);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  test("a live daemon in the old directory blocks the move", () => {
    const root = tmp();
    const legacy = path.join(root, ".omni-code");
    const dir = path.join(root, ".treeboss");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "daemon.pid"), String(process.pid));
    expect(() => migrateLegacyHome(dir, legacy)).toThrow(/still running/);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("memory blocks written with occ: markers are still read and upgraded in place", () => {
    const legacy = "# Notes\n\n<!-- occ:memory:start -->\n## Project rules\n- use bun\n<!-- occ:memory:end -->\n";
    expect(findBlock(legacy)).not.toBeNull();
    expect(parseRules(legacy)).toEqual(["use bun"]);
    const next = spliceRules(legacy, ["use bun", "no npm"]);
    expect(next).toContain("<!-- trb:memory:start -->");
    expect(next).not.toContain("occ:memory");
    expect(parseRules(next)).toEqual(["use bun", "no npm"]);
  });
});
