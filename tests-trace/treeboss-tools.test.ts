import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START treeboss-tools\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END treeboss-tools\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { createLead, getSession, interruptAll, setTurnRunner } from "../src/sessions/manager";
import type { TurnResult } from "../src/engines/runner";
import { buildRunMcpConfig } from "../src/mcp/store";
import { listAttached } from "../src/specs/attach";
import { readRoadmap } from "../src/roadmap/store";
import { TREEBOSS_TOOL_NAMES, executeTreebossTool, treebossToolDefs } from "../src/treeboss/tools";
import { makeDir, resetState } from "./helpers";

const result = (output = "ok"): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" });
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf-8");

beforeEach(() => {
  resetState();
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

/** Poll until `check` holds, or fail after `timeoutMs`. */
async function until(check: () => boolean, label: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

/** A settled session in a fresh project folder, with treeboss mode on or off. */
async function session(treeboss: boolean) {
  setTurnRunner(async () => result("ok"));
  const dir = makeDir();
  const s = createLead({ prompt: "plan the panel", engine: "fake", cwd: dir, treeboss });
  await until(() => getSession(s.id)!.status !== "running", "the first turn");
  return { id: s.id, dir };
}

describe("the tool list", () => {
  test("the three tools are the ones the rules name, and each has a schema", () => {
    expect(treebossToolDefs().map((t) => t.name)).toEqual([...TREEBOSS_TOOL_NAMES]);
    expect(TREEBOSS_TOOL_NAMES).toEqual(["spec_new", "spec_attach", "roadmap_propose"]);
    for (const t of treebossToolDefs()) expect(t.inputSchema).toMatchObject({ type: "object", required: expect.any(Array) });
  });

  test("the shim is told about them per run: the trb server carries TRB_TREEBOSS only for a session in treeboss mode", () => {
    const base = { sessionId: "s_x", subagents: false, daemonUrl: "http://127.0.0.1:1", token: "t" };
    expect(buildRunMcpConfig({ ...base, treeboss: true }).trb).toMatchObject({ type: "stdio", env: { TRB_TREEBOSS: "1" } });
    expect(buildRunMcpConfig({ ...base, treeboss: false }).trb).toBeUndefined();
    expect(buildRunMcpConfig({ ...base, treeboss: false, evidence: true }).trb).toMatchObject({ env: { TRB_TREEBOSS: "0" } });
    expect(buildRunMcpConfig({ ...base, treeboss: true, ask: true }).trb).toBeUndefined();
  });
});

describe("spec_new and spec_attach", () => {
  test("spec_new creates the feature folder the CLI would, and returns its path", async () => {
    const s = await session(true);
    const r = executeTreebossTool("spec_new", { name: "Add export", description: "Exports the list as CSV." }, s.id);
    expect(r.text).toContain("specs/001-add-export/spec.md");
    expect(read(s.dir, "specs/001-add-export/spec.md")).toContain("Exports the list as CSV.");
    // A second feature with the same name is refused, as the store refuses it for the CLI.
    expect(executeTreebossTool("spec_new", { name: "Add export" }, s.id).text).toMatch(/^Error: A feature named "add-export" already exists/);
    expect(executeTreebossTool("spec_new", { name: "  " }, s.id).text).toBe("Error: name is required.");
  });

  test("spec_attach attaches the spec to the calling session, so the gate's spec check passes", async () => {
    const s = await session(true);
    executeTreebossTool("spec_new", { name: "Panel" }, s.id);
    expect(listAttached(s.id)).toEqual([]);
    expect(executeTreebossTool("spec_attach", { path: "specs/001-panel/spec.md" }, s.id).text).toBe("Attached specs/001-panel/spec.md to this session.");
    expect(listAttached(s.id).map((a) => a.spec_path)).toEqual(["specs/001-panel/spec.md"]);
  });

  test("spec_attach names what is wrong with a path that is missing or outside the specs", async () => {
    const s = await session(true);
    expect(executeTreebossTool("spec_attach", { path: "specs/009-none/spec.md" }, s.id).text).toMatch(/^Error: specs\/009-none\/spec\.md does not exist/);
    expect(executeTreebossTool("spec_attach", {}, s.id).text).toMatch(/^Error: path is required/);
    expect(listAttached(s.id)).toEqual([]);
  });
});

describe("roadmap_propose", () => {
  test("creates ROADMAP.md when the project has none, and adds an unchecked item to its first lane", async () => {
    const s = await session(true);
    const r = executeTreebossTool("roadmap_propose", { title: "Panel", spec: "specs/001-panel", description: "A side panel." }, s.id);
    expect(fs.existsSync(path.join(s.dir, "ROADMAP.md"))).toBe(true);
    expect(r.text).toMatch(/^Proposed in Now of ROADMAP\.md:\n- \[ \] Panel \{#r1\} \(spec: specs\/001-panel\)/);
    const state = readRoadmap(s.dir);
    const item = state.lanes[0]!.items[0]!;
    expect(state.lanes[0]!.name).toBe("Now");
    expect(item).toMatchObject({ title: "Panel", done: false, spec: "specs/001-panel", lane: "Now" });
    expect(item.description).toBe("A side panel.");
  });

  test("an item goes to the lane named Proposed when there is one, not the first lane", async () => {
    const s = await session(true);
    write(s.dir, "ROADMAP.md", "# Roadmap\n\n## Now\n\n- [ ] Existing {#r1}\n\n## Proposed\n\n");
    executeTreebossTool("roadmap_propose", { title: "Search" }, s.id);
    const state = readRoadmap(s.dir);
    expect(state.lanes.find((l) => l.name === "Now")!.items.map((i) => i.title)).toEqual(["Existing"]);
    expect(state.lanes.find((l) => l.name === "Proposed")!.items.map((i) => i.title)).toEqual(["Search"]);
  });

  test("a roadmap with no lane gets a Proposed lane for the item", async () => {
    const s = await session(true);
    write(s.dir, "ROADMAP.md", "# Roadmap\n");
    executeTreebossTool("roadmap_propose", { title: "Search", docs: "docs/search.md" }, s.id);
    const state = readRoadmap(s.dir);
    expect(state.lanes.map((l) => l.name)).toEqual(["Proposed"]);
    expect(state.lanes[0]!.items[0]).toMatchObject({ title: "Search", docs: "docs/search.md", done: false });
  });

  test("a missing title is named, and nothing is written", async () => {
    const s = await session(true);
    expect(executeTreebossTool("roadmap_propose", { spec: "specs/001-x" }, s.id).text).toBe("Error: title is required.");
    expect(fs.existsSync(path.join(s.dir, "ROADMAP.md"))).toBe(false);
  });
});

describe("who may call them", () => {
  test("a session outside treeboss mode is refused, and nothing is created", async () => {
    const s = await session(false);
    for (const [name, args] of [
      ["spec_new", { name: "Panel" }],
      ["spec_attach", { path: "specs/001-panel/spec.md" }],
      ["roadmap_propose", { title: "Panel" }],
    ] as const) {
      expect(executeTreebossTool(name, { ...args }, s.id).text).toBe("Error: treeboss mode is off for this session.");
    }
    expect(fs.existsSync(path.join(s.dir, "specs"))).toBe(false);
    expect(fs.existsSync(path.join(s.dir, "ROADMAP.md"))).toBe(false);
  });

  test("an unknown name and an unknown session are errors the agent can read", async () => {
    const s = await session(true);
    expect(executeTreebossTool("spec_delete", {}, s.id).text).toBe('Error: unknown tool "spec_delete".');
    expect(executeTreebossTool("spec_new", { name: "x" }, "s_nope").text).toBe('Error: no session "s_nope".');
  });
});

describe("the daemon route", () => {
  const TOKEN = "treeboss-tools-token";
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
    setDaemonContext({ url: srv.url, token: TOKEN });
  });
  afterAll(() => {
    setDaemonContext(null);
    srv.stop();
  });

  test("the shim's tool call reaches the tools for the session it speaks for, and says so when the mode is off", async () => {
    const on = await session(true);
    const off = await session(false);
    const call = async (sessionId: string, name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${srv.url}/api/tools/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-trb-session": sessionId },
        body: JSON.stringify({ name, args }),
      });
      return { status: res.status, body: (await res.json()) as { text?: string } };
    };
    const made = await call(on.id, "spec_new", { name: "Panel" });
    expect(made).toMatchObject({ status: 200, body: { text: expect.stringContaining("specs/001-panel/spec.md") } });
    expect(await call(off.id, "spec_new", { name: "Panel" })).toMatchObject({ status: 200, body: { text: "Error: treeboss mode is off for this session." } });
    expect(fs.existsSync(path.join(off.dir, "specs"))).toBe(false);
    expect(listAttached(on.id).length).toBe(0);
  });
});
