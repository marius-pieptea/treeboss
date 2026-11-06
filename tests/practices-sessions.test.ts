import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import type { TurnResult } from "../src/engines/runner";
import { practicesBrief, setPractices, START } from "../src/practices/store";
import { createChild, createLead, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { Workspaces } from "../src/workspaces";
import { makeDir, makeRepo, resetState, settled } from "./helpers";

const ok: TurnResult = { success: true, output: "ok", sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" };

const RULE = "Prefer a plain function to a class, factory or framework layer.";
const OTHER_RULE = "Replace nested conditionals with early returns.";

/** What an engine finds when a turn starts: its prompt, and the two files the CLIs read their rules from, in its working directory. */
interface Seen {
  cwd: string;
  prompt: string;
  agents: string | null;
  claude: string | null;
}

const text = (abs: string): string | null => (fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null);

/** Every turn's working directory, read while the turn runs (a worktree can be gone after it). */
function watch(): Seen[] {
  const seen: Seen[] = [];
  setTurnRunner(async (o) => {
    seen.push({ cwd: o.cwd, prompt: o.prompt, agents: text(path.join(o.cwd, "AGENTS.md")), claude: text(path.join(o.cwd, "CLAUDE.md")) });
    return ok;
  });
  return seen;
}

/** A git workspace with the KISS pack on. `tracked`: the repo already commits its own AGENTS.md, so the block is an uncommitted edit to it. */
function workspace(opts: { on?: boolean; off?: string[]; tracked?: boolean } = {}) {
  const dir = makeRepo({ "src/a.ts": "export const a = 1;\n", ...(opts.tracked ? { "AGENTS.md": "# Notes\n\nHand-written.\n" } : {}) });
  const id = Workspaces.open(dir).id;
  if (opts.on !== false) setPractices(id, { enabled: ["kiss"], ...(opts.off ? { off: { kiss: { rules: opts.off } } } : {}) });
  return { dir, id };
}

const lead = async (dir: string, over: { isolate?: boolean } = {}) => settled(createLead({ prompt: "go", engine: "fake", cwd: dir, ...over }).id);
const head = async (parentId: string, over: { isolate?: boolean } = {}) => settled(createChild({ caller: { operator: true }, parentId, brief: "do a part", ...over }).id);

beforeEach(() => {
  resetState();
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

describe("practices reach an agent that runs in a checkout", () => {
  test("a lead in the project folder reads the block from AGENTS.md and CLAUDE.md", async () => {
    const { dir } = workspace();
    const seen = watch();
    await lead(dir);
    for (const file of [seen[0]!.agents, seen[0]!.claude]) {
      expect(file).toContain(START);
      expect(file).toContain(RULE);
    }
  });

  test("a lead in its own worktree gets the block too: the uncommitted files are replayed into it", async () => {
    const { dir } = workspace();
    const seen = watch();
    await lead(dir, { isolate: true });
    expect(seen[0]!.cwd).not.toBe(dir);
    for (const file of [seen[0]!.agents, seen[0]!.claude]) {
      expect(file).toContain(START);
      expect(file).toContain(RULE);
    }
  });

  test("so does a lead in a repo that already tracks its AGENTS.md: the edit comes with the operator's own text", async () => {
    const { dir } = workspace({ tracked: true });
    const seen = watch();
    await lead(dir, { isolate: true });
    expect(seen[0]!.agents).toContain("Hand-written.");
    for (const file of [seen[0]!.agents, seen[0]!.claude]) {
      expect(file).toContain(START);
      expect(file).toContain(RULE);
    }
  });

  test("a subagent in a worktree gets the block from its files, and its brief does not say it again", async () => {
    const { dir } = workspace();
    const seen = watch();
    await head((await lead(dir)).id);
    const h = seen[1]!;
    expect(h.cwd).not.toBe(dir);
    for (const file of [h.agents, h.claude]) {
      expect(file).toContain(START);
      expect(file).toContain(RULE);
    }
    expect(h.prompt).not.toContain(RULE);
  });
});

describe("practices reach an agent that runs outside a checkout", () => {
  test("a subagent with no isolation has no rules file in its scratch folder, so its brief carries the rules", async () => {
    const { dir } = workspace();
    const seen = watch();
    await head((await lead(dir)).id, { isolate: false });
    const h = seen[1]!;
    expect(h.agents).toBeNull();
    expect(h.claude).toBeNull();
    expect(h.prompt).toContain("## Practice packs");
    expect(h.prompt).toContain("### KISS");
    expect(h.prompt).toContain(RULE);
  });

  test("so does one under a lead in a worktree: the rules are the project's, not the lead's checkout's", async () => {
    const { dir } = workspace();
    const seen = watch();
    await head((await lead(dir, { isolate: true })).id, { isolate: false });
    expect(seen[1]!.prompt).toContain(RULE);
  });

  test("a rule switched off in the workspace is not in the brief", async () => {
    const { dir } = workspace({ off: [RULE] });
    const seen = watch();
    await head((await lead(dir)).id, { isolate: false });
    expect(seen[1]!.prompt).toContain(OTHER_RULE);
    expect(seen[1]!.prompt).not.toContain(RULE);
  });

  test("with no pack on, the brief has no practices section", async () => {
    const { dir } = workspace({ on: false });
    const seen = watch();
    await head((await lead(dir)).id, { isolate: false });
    expect(seen[1]!.prompt).not.toContain("Practice packs");
  });

  test("a folder in no workspace has no brief", () => {
    expect(practicesBrief(makeDir())).toBe("");
  });
});
