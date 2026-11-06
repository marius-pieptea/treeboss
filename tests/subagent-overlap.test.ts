import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { close, createLead, interruptAll, normalizeFiles, pathsOverlap, setTurnRunner, type TurnRunner } from "../src/sessions/manager";
import { executeSubagentTool, subagentToolDefs } from "../src/sessions/tools";
import { makeRepo, resetState, settled } from "./helpers";

/** A turn that succeeds at once. A brief that asks for WRITE m.txt also writes that file, so a worktree head has a change to report. */
const scripted: TurnRunner = async (opts) => {
  if (opts.prompt.includes("WRITE m.txt")) fs.writeFileSync(path.join(opts.cwd, "m.txt"), "merged\n");
  return { success: true, output: "ok", sessionId: null, resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" };
};

beforeEach(() => {
  resetState();
  db().exec("DELETE FROM command_receipts");
  setTurnRunner(scripted);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

const create = async (caller: { sessionId: string }, args: Record<string, unknown>) => JSON.parse(await executeSubagentTool("subagent_create", args, caller));

describe("normalizeFiles and pathsOverlap", () => {
  test("paths are normalized and duplicates, blanks and '.' dropped", () => {
    expect(normalizeFiles(["./src\\sessions/", "src/sessions", "", ".", " tests/a.ts "])).toEqual(["src/sessions", "tests/a.ts"]);
    expect(normalizeFiles("docs/README.md")).toEqual(["docs/README.md"]);
    expect(normalizeFiles(undefined)).toBeNull();
    expect(normalizeFiles([])).toBeNull();
  });

  test("a directory overlaps the files under it, but not a sibling that only shares a name prefix", () => {
    expect(pathsOverlap("src/sessions", "src/sessions/tools.ts")).toBe(true);
    expect(pathsOverlap("src/sessions/tools.ts", "src/sessions")).toBe(true);
    expect(pathsOverlap("src/sessions/tools.ts", "src/sessions/tools.ts")).toBe(true);
    expect(pathsOverlap("src/session", "src/sessions/tools.ts")).toBe(false);
    expect(pathsOverlap("src/a.ts", "src/b.ts")).toBe(false);
  });

  test("the tool definition explains files and says it is a warning", () => {
    const def = subagentToolDefs().find((d) => d.name === "subagent_create")!;
    expect(def.inputSchema.properties).toHaveProperty("files");
    expect(def.description).toContain("`files`");
    expect(def.description).toContain("warning, not a refusal");
  });
});

describe("overlapping heads", () => {
  test("a head on files another open head of the same lead already has gets a warning, and still opens", async () => {
    const l = await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeRepo() }).id);
    const caller = { sessionId: l.id };
    const first = await create(caller, { brief: "SAY one", title: "tools work", files: ["src/sessions/"] });
    expect(first).not.toHaveProperty("warnings");
    const second = await create(caller, { brief: "SAY two", title: "tools tests", files: ["src/sessions/tools.ts", "tests/x.ts"] });
    expect(second.status).toBe("running");
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toContain(first.id);
    expect(second.warnings[0]).toContain('"tools work"');
    expect(second.warnings[0]).toContain("src/sessions/tools.ts ~ src/sessions");
    expect(second.warnings[0]).toMatch(/merge that head first/i);
    expect(second.warnings[0]).toContain("subagent_send");
    const open = db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_id = ?").get(l.id) as { n: number };
    expect(open.n).toBe(2);
    await settled(first.id);
    await settled(second.id);
  }, 30_000);

  test("heads on disjoint files get no warning", async () => {
    const l = await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeRepo() }).id);
    const caller = { sessionId: l.id };
    const a = await create(caller, { brief: "SAY a", files: ["src/a.ts"] });
    const b = await create(caller, { brief: "SAY b", files: ["src/b.ts", "docs/"] });
    expect(b).not.toHaveProperty("warnings");
    await settled(a.id);
    await settled(b.id);
  }, 30_000);

  test("a head without files is never warned about, and does not warn others", async () => {
    const l = await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeRepo() }).id);
    const caller = { sessionId: l.id };
    const a = await create(caller, { brief: "SAY a", files: ["src/a.ts"] });
    const b = await create(caller, { brief: "SAY b" });
    expect(b).not.toHaveProperty("warnings");
    await settled(a.id);
    await settled(b.id);
  }, 30_000);

  test("a closed head, and a head that was merged, are not counted", async () => {
    const repo = makeRepo();
    const l = await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: repo }).id);
    const caller = { sessionId: l.id };
    const closed = await create(caller, { brief: "SAY closed", files: ["src/a.ts"] });
    await settled(closed.id);
    await close(caller, closed.id);
    const merged = await create(caller, { brief: "SAY merged", files: ["src/a.ts"] });
    await settled(merged.id);
    db().prepare("UPDATE sessions SET merged_at = CURRENT_TIMESTAMP WHERE id = ?").run(merged.id);
    const next = await create(caller, { brief: "SAY next", files: ["src/a.ts"] });
    expect(next).not.toHaveProperty("warnings");
    await settled(next.id);
  }, 30_000);

  test("a worktree head's actual changes count as its files, even when it declared none", async () => {
    const l = await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeRepo() }).id);
    const caller = { sessionId: l.id };
    const writer = await create(caller, { brief: "WRITE m.txt\nSAY wrote" });
    await settled(writer.id);
    const next = await create(caller, { brief: "SAY next", files: ["m.txt"] });
    expect(next.warnings).toHaveLength(1);
    expect(next.warnings[0]).toContain(writer.id);
    expect(next.warnings[0]).toContain("on m.txt");
    await settled(next.id);
  }, 30_000);

  test("a retried create returns the same warnings, and nothing is opened twice", async () => {
    const l = await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeRepo() }).id);
    const caller = { sessionId: l.id };
    const first = await create(caller, { brief: "SAY one", files: ["src/a.ts"] });
    await settled(first.id);
    const args = { brief: "SAY two", files: ["src/a.ts"], command_id: "cmd-overlap-1" };
    const once = await executeSubagentTool("subagent_create", args, caller);
    const again = await executeSubagentTool("subagent_create", args, caller);
    expect(again).toBe(once);
    expect(JSON.parse(once).warnings).toHaveLength(1);
    const open = db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_id = ?").get(l.id) as { n: number };
    expect(open.n).toBe(2);
    await settled(JSON.parse(once).id);
  }, 30_000);

  test("files are stored on the head, as normalized JSON", async () => {
    const l = await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd: makeRepo() }).id);
    const made = await create({ sessionId: l.id }, { brief: "SAY x", files: ["./src\\a.ts", "src/a.ts"] });
    const row = db().prepare("SELECT files_json FROM sessions WHERE id = ?").get(made.id) as { files_json: string };
    expect(JSON.parse(row.files_json)).toEqual(["src/a.ts"]);
    await settled(made.id);
  }, 30_000);
});
