import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START title\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END title\n"); });
/** Session titles written by the agent: the `session_title` tool, its guards, and how a turn is wired for it. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { setSetting } from "../src/settings";
import { setDaemonContext } from "../src/sessions/context";
import { Hub, type HubEvent } from "../src/sessions/hub";
import { createLead, getSession, interruptAll, send, setTurnRunner } from "../src/sessions/manager";
import { TITLE_INSTRUCTION, cleanTitle, executeTitleTool, plainTitle, sessionTitle, titleToolDefs } from "../src/sessions/title";
import { makeDir, resetState, settled } from "./helpers";

const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" });

interface Seen {
  prompt: string;
  trb: Record<string, string> | null;
}

/** Stand in for the engine: record each turn's prompt and trb MCP env, and report a CLI session so later turns resume. */
function recordTurns(): Seen[] {
  const seen: Seen[] = [];
  setTurnRunner(async (o) => {
    const trb = o.mcp.trb?.type === "stdio" ? (o.mcp.trb.env ?? null) : null;
    seen.push({ prompt: o.prompt, trb });
    o.onSessionId?.("cli-1");
    return ok("done");
  });
  return seen;
}

const lead = (prompt: string, over: Record<string, unknown> = {}) => createLead({ prompt, engine: "fake", cwd: makeDir(), ...over } as any);
const title = (id: string) => getSession(id)!.title;

beforeEach(() => {
  resetState();
  setTurnRunner(null);
  setDaemonContext({ url: "http://127.0.0.1:1", token: "t" });
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
  setDaemonContext(null);
});

describe("title helpers", () => {
  test("a plain title is the prompt's first line, on one line, at most 100 characters", () => {
    expect(plainTitle("Fix   the list\nand more")).toBe("Fix the list");
    expect(plainTitle("x".repeat(300))).toHaveLength(100);
    expect(sessionTitle("Mine", "ignored")).toBe("Mine");
    expect(sessionTitle(null, "")).toBe("");
  });

  test("cleanTitle takes the first line, drops quotes and the final full stop", () => {
    expect(cleanTitle('"Fix session list ordering."\nThe model explains...')).toBe("Fix session list ordering");
    expect(cleanTitle("Add   the   Ollama\tclient")).toBe("Add the Ollama client");
    expect(cleanTitle("x".repeat(300))).toHaveLength(100);
  });

  test("cleanTitle returns null when nothing usable is left", () => {
    for (const raw of ["", "  \n  ", '"ok"', "."]) expect(cleanTitle(raw)).toBeNull();
  });

  test("the tool takes one required string, title", () => {
    const [def] = titleToolDefs();
    expect(def.name).toBe("session_title");
    expect(def.inputSchema.required).toEqual(["title"]);
  });
});

describe("the session_title tool", () => {
  async function fresh(over: Record<string, unknown> = {}) {
    setTurnRunner(async () => ok("done"));
    const s = lead("fix session list ordering, it uses created_at", over);
    await settled(s.id);
    return s;
  }

  test("replaces the plain title and tells the sidebar", async () => {
    const s = await fresh();
    const events: HubEvent[] = [];
    const off = Hub.subscribe((e) => events.push(e));
    const out = executeTitleTool("session_title", { title: '"Order session list by update time."' }, s.id);
    off();
    expect(out.text).toStartWith("Title set.");
    expect(title(s.id)).toBe("Order session list by update time");
    expect(events.some((e) => e.type === "state" && e.sessionId === s.id)).toBe(true);
  });

  test("works once: a second call changes nothing", async () => {
    const s = await fresh();
    executeTitleTool("session_title", { title: "First name" }, s.id);
    const again = executeTitleTool("session_title", { title: "Second name" }, s.id);
    expect(again.text).toContain('already has a title ("First name")');
    expect(again.text).not.toStartWith("Error");
    expect(title(s.id)).toBe("First name");
  });

  test("never overwrites an operator's rename", async () => {
    const s = await fresh();
    db().prepare("UPDATE sessions SET title = ? WHERE id = ?").run("Operator's name", s.id);
    const out = executeTitleTool("session_title", { title: "Agent's name" }, s.id);
    expect(out.text).toContain("already has a title");
    expect(title(s.id)).toBe("Operator's name");
  });

  test("an unusable title is an error the agent can fix, and the title stays plain", async () => {
    const s = await fresh();
    for (const bad of ["", "  ", '"a"', undefined, 42]) expect(executeTitleTool("session_title", { title: bad }, s.id).text).toStartWith("Error: give a title");
    expect(title(s.id)).toBe("fix session list ordering, it uses created_at");
  });

  test("only a lead is titled", async () => {
    const s = await fresh();
    db().prepare("UPDATE sessions SET depth = 1 WHERE id = ?").run(s.id);
    expect(executeTitleTool("session_title", { title: "A subagent title" }, s.id).text).toStartWith("Error: only the lead");
    expect(title(s.id)).toBe("fix session list ordering, it uses created_at");
  });

  test("an unknown session or tool is an error, not a throw", () => {
    expect(executeTitleTool("session_title", { title: "Whatever" }, "s_missing").text).toStartWith("Error:");
    expect(executeTitleTool("nope", { title: "Whatever" }, "s_missing").text).toStartWith("Error: unknown tool");
  });
});

describe("how a turn is wired for it", () => {
  test("a lead's first turn is asked once, and offered the tool on every turn", async () => {
    const seen = recordTurns();
    const s = lead("fix session list ordering");
    await settled(s.id);
    send({ operator: true }, s.id, "now the sidebar");
    await settled(s.id);
    expect(seen).toHaveLength(2);
    expect(seen[0].prompt).toContain(TITLE_INSTRUCTION);
    expect(seen[1].prompt).not.toContain(TITLE_INSTRUCTION);
    // The tool list stays the same across turns, so a resumed conversation's prompt cache is not disturbed.
    expect(seen[0].trb?.TRB_TITLE).toBe("1");
    expect(seen[1].trb?.TRB_TITLE).toBe("1");
  });

  test("the instruction is not sent once the session has been named", async () => {
    const seen = recordTurns();
    const s = lead("fix session list ordering");
    await settled(s.id);
    executeTitleTool("session_title", { title: "Order the session list" }, s.id);
    // A replayed (non-resumed) turn must not ask again.
    db().prepare("UPDATE sessions SET cli_session_id = NULL WHERE id = ?").run(s.id);
    send({ operator: true }, s.id, "again");
    await settled(s.id);
    expect(seen.at(-1)!.prompt).not.toContain(TITLE_INSTRUCTION);
  });

  test("an explicit title is kept and never asked for", async () => {
    const seen = recordTurns();
    const s = lead("fix session list ordering", { title: "My own title" });
    await settled(s.id);
    expect(seen[0].prompt).not.toContain(TITLE_INSTRUCTION);
    expect(title(s.id)).toBe("My own title");
  });

  test("session_titles off: no tool, no instruction", async () => {
    setSetting("session_titles", "off");
    // Evidence is on by default and would attach trb for its own tools; this test is about the title tool alone.
    setSetting("evidence", "off");
    const seen = recordTurns();
    const s = lead("fix session list ordering", { subagents: false });
    await settled(s.id);
    expect(seen[0].prompt).not.toContain(TITLE_INSTRUCTION);
    expect(seen[0].trb).toBeNull();
  });

  test("ask mode stays lean: no trb server, no instruction", async () => {
    const seen = recordTurns();
    const s = lead("what does the session list do?", { mode: "ask" });
    await settled(s.id);
    expect(seen[0].prompt).not.toContain(TITLE_INSTRUCTION);
    expect(seen[0].trb).toBeNull();
  });

  test("a lead that may not open subagents still gets the tool", async () => {
    const seen = recordTurns();
    const s = lead("fix session list ordering", { subagents: false });
    await settled(s.id);
    expect(seen[0].trb).toMatchObject({ TRB_TITLE: "1", TRB_SUBAGENTS: "0" });
    expect(seen[0].prompt).toContain(TITLE_INSTRUCTION);
  });

  test("a /compact slash command is left alone", async () => {
    const seen = recordTurns();
    const s = lead("fix session list ordering");
    await settled(s.id);
    send({ operator: true }, s.id, "/compact");
    await settled(s.id);
    expect(seen.at(-1)!.prompt.startsWith("/compact")).toBe(true);
  });
});

describe("over HTTP", () => {
  const TOKEN = "title-api-token";
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());

  test("the shim's tool call lands on the session it speaks for", async () => {
    setTurnRunner(async () => ok("done"));
    const s = lead("fix session list ordering");
    await settled(s.id);
    const res = await fetch(`${srv.url}/api/tools/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-trb-session": s.id },
      body: JSON.stringify({ name: "session_title", args: { title: "Order the session list" } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toStartWith("Title set.");
    expect(title(s.id)).toBe("Order the session list");
  });
});
