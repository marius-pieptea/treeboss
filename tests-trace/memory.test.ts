import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START memory\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END memory\n"); });
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { END, START, parseRules, spliceRules } from "../src/memory/block";
import { detectCorrection } from "../src/memory/detect";
import { addRule, addRules, deleteRule, memoryView, readRules, updateRule } from "../src/memory/store";
import { Workspaces } from "../src/workspaces";
import { makeDir } from "./helpers";

const HAND = "# My project\n\nHand-written notes.\n\n- keep this bullet\n";

describe("managed block", () => {
  test("appends after hand-written text and leaves it byte for byte", () => {
    const out = spliceRules(HAND, ["We use bun, not npm."]);
    expect(out.startsWith(HAND)).toBe(true);
    expect(parseRules(out)).toEqual(["We use bun, not npm."]);
  });

  test("replaces in place and removing the last rule restores the original", () => {
    const one = spliceRules(HAND, ["a rule"]);
    const two = spliceRules(one, ["a rule", "another rule"]);
    expect(parseRules(two)).toEqual(["a rule", "another rule"]);
    expect(two.startsWith(HAND)).toBe(true);
    expect(spliceRules(two, [])).toBe(HAND);
  });

  test("text after the block is preserved", () => {
    const withBlock = `${HAND}\n${START}\n- x\n${END}\n\n## After\nkeep\n`;
    const out = spliceRules(withBlock, ["x", "y"]);
    expect(out.endsWith("\n\n## After\nkeep\n")).toBe(true);
    expect(parseRules(out)).toEqual(["x", "y"]);
  });

  test("keeps CRLF", () => {
    const out = spliceRules("# t\r\n\r\nbody\r\n", ["r"]);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("a damaged block is refused", () => {
    expect(() => spliceRules(`${START}\n- x\n`, ["y"])).toThrow(/damaged/);
    expect(() => parseRules(`${END}\n${START}\n`)).toThrow(/damaged/);
  });
});

describe("correction detection", () => {
  test.each([
    ["we use bun, not npm", "We use bun, not npm."],
    ["No, we use pnpm instead of npm here", "We use pnpm instead of npm here."],
    ["Please never edit files under generated/", "Never edit files under generated/."],
    ["from now on, write tests with vitest", "From now on, write tests with vitest."],
    ["Don't use default exports", "Don't use default exports."],
  ])("proposes for %s", (msg, rule) => {
    expect(detectCorrection(msg)?.text).toBe(rule);
  });

  test.each(["Can you fix the login bug?", "add a button to the header", "why do we use bun, not npm?", "```\nwe use bun, not npm\n```", "", "thanks!"])("does not propose for %j", (msg) => {
    expect(detectCorrection(msg)).toBeNull();
  });
});

describe("store", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeDir();
  });
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf-8");

  test("creates AGENTS.md and CLAUDE.md containing only the block", () => {
    addRule(dir, "We use bun, not npm.");
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      expect(read(f).startsWith(START)).toBe(true);
      expect(parseRules(read(f))).toEqual(["We use bun, not npm."]);
    }
  });

  test("never changes hand-written content in either file", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), HAND);
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Claude\nmine\n");
    const { rule } = addRule(dir, "Rule one.");
    addRule(dir, "Rule two.");
    updateRule(dir, rule.id, "Rule uno.");
    expect(read("AGENTS.md").startsWith(HAND)).toBe(true);
    expect(read("CLAUDE.md").startsWith("# Claude\nmine\n")).toBe(true);
    deleteRule(dir, readRules(dir)[0]!.id);
    deleteRule(dir, readRules(dir)[0]!.id);
    expect(read("AGENTS.md")).toBe(HAND);
    expect(read("CLAUDE.md")).toBe("# Claude\nmine\n");
  });

  test("a file that only held our block is removed with it", () => {
    const { rule } = addRule(dir, "Only rule.");
    deleteRule(dir, rule.id);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);
  });

  test("dedupes, edits, and reports", () => {
    expect(addRule(dir, "Same.").added).toBe(true);
    expect(addRule(dir, " same. ").added).toBe(false);
    expect(readRules(dir)).toHaveLength(1);
    expect(() => addRule(dir, "  ")).toThrow(/empty/);
    expect(() => addRule(dir, "x <!-- y")).toThrow(/comment/);
    expect(() => updateRule(dir, "nope", "z")).toThrow(/No such rule/);
    expect(addRules(dir, ["Same.", "Other."])).toBe(1);
  });

  test("a CLAUDE.md that imports AGENTS.md is left alone", () => {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "@AGENTS.md\n");
    addRule(dir, "A rule.");
    expect(read("CLAUDE.md")).toBe("@AGENTS.md\n");
    const v = memoryView(dir);
    expect(v.files[1]!.note).toMatch(/imports/);
    expect(v.rules).toHaveLength(1);
  });

  test("a CLAUDE.md symlinked to AGENTS.md is not written twice", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), HAND);
    fs.symlinkSync("AGENTS.md", path.join(dir, "CLAUDE.md"));
    addRule(dir, "A rule.");
    expect(parseRules(read("AGENTS.md"))).toEqual(["A rule."]);
    expect(read("AGENTS.md").match(/trb:memory:start/g)).toHaveLength(1);
  });

  test("a symlink that leaves the workspace is refused and nothing is written", () => {
    const outside = makeDir();
    fs.writeFileSync(path.join(outside, "target.md"), "outside\n");
    fs.symlinkSync(path.join(outside, "target.md"), path.join(dir, "AGENTS.md"));
    expect(() => addRule(dir, "A rule.")).toThrow(/leaves the workspace/);
    expect(fs.readFileSync(path.join(outside, "target.md"), "utf-8")).toBe("outside\n");
  });

  test("a damaged CLAUDE.md blocks the write before AGENTS.md changes", () => {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), `${START}\n- broken\n`);
    expect(() => addRule(dir, "A rule.")).toThrow(/damaged/);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
  });
});

describe("HTTP routes", () => {
  const TOKEN = "memory-test-token";
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());

  test("suggest, add, edit, delete", async () => {
    const dir = makeDir();
    const root = Workspaces.open(dir).id;
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json()) as any };
    };
    let r = await call("POST", `/api/memory/${root}/suggest`, { message: "we use bun, not npm" });
    expect(r.body.proposal.text).toBe("We use bun, not npm.");
    r = await call("POST", `/api/memory/${root}/rules`, { text: r.body.proposal.text });
    expect(r.status).toBe(201);
    const id = r.body.rule.id;
    // Saved already: no longer proposed.
    r = await call("POST", `/api/memory/${root}/suggest`, { message: "we use bun, not npm" });
    expect(r.body.proposal).toBeNull();
    r = await call("PATCH", `/api/memory/${root}/rules/${id}`, { text: "We use bun." });
    expect(r.body.memory.rules.map((x: any) => x.text)).toEqual(["We use bun."]);
    r = await call("POST", `/api/memory/${root}/rules`, { text: "" });
    expect(r.status).toBe(400);
    const newId = (await call("GET", `/api/memory/${root}`)).body.memory.rules[0].id;
    expect((await call("DELETE", `/api/memory/${root}/rules/${newId}`)).status).toBe(200);
    r = await call("GET", `/api/memory/${root}`);
    expect(r.body.memory.rules).toHaveLength(0);
  });
});
